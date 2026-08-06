////////////////////////////////////////////////////////////////////////////
// ==================== Active Drop & Campaign Rotation ====================
////////////////////////////////////////////////////////////////////////////

//////////////////////////
///// GLOBAL STATES //////
//////////////////////////

let lastDropHeaderHash = null;
let lastDropCardLayoutHash = null;
let cachedIconContainer = null;
let cachedInfoTextDiv = null;
let isExecutingRotation = false;
let dropTotalSeconds = 0;

// --- 1. State Initialization ---
if (typeof state === 'undefined') {
    window.state = {};
}

// Sjednocený výchozí stav za použití moderního JS syntaxe
state.activeCampaignsQueue = state.activeCampaignsQueue || [];
state.campaignRotationIndex = state.campaignRotationIndex ?? 0;
state.activeDropsQueue = state.activeDropsQueue || [];
state.dropRotationIndex = state.dropRotationIndex ?? 0;
state.rotationTimer = state.rotationTimer || null;
state.campaigns = state.campaigns || {};
state._lastSyncedMinutes = state._lastSyncedMinutes || {};

// ==========================================
// 2. DATA UTILITIES & HELPERS
// ==========================================

/**
 * Vrací aktivní drop ze sjednoceného state.
 */
function getSafeActiveDrop() {
    const drop = state.currentDrop || state.current_drop;
    return (drop && typeof drop === 'object') ? drop : null;
}

/**
 * Sjednocená kontrola, zda je drop/kampaň vybraná/vyzvednutá.
 */
function isClaimed(item) {
    if (!item) return true;
    return Boolean(item.is_claimed || item.claimed || item.isClaimed || item.status === 'CLAIMED');
}

/**
 * Čistý a rychlý helper pro vyhledání kampaně a jejího seznamu dropů.
 */
function getCampaignAndDrops(queueItem) {
    if (!queueItem) return { campaign: null, drops: [] };

    // Pokud už queueItem má přímo v sobě pole dropů
    if (Array.isArray(queueItem.drops)) {
        return { campaign: queueItem, drops: queueItem.drops };
    }

    const campId = queueItem.campaign_id || queueItem.campaignId || queueItem.id;
    const campaigns = state.campaigns;

    // Přímý vyhledávací dotaz bez hlubokých smyček
    const foundCamp = Array.isArray(campaigns) 
        ? campaigns.find(c => c && (c.id === campId || c.campaign_id === campId || c.campaignId === campId))
        : (campaigns[campId] || Object.values(campaigns).find(c => c && (c.id === campId || c.campaign_id === campId)));

    if (foundCamp && foundCamp.drops) {
        const dropsArr = Array.isArray(foundCamp.drops) 
            ? foundCamp.drops 
            : Object.values(foundCamp.drops);
        return { campaign: foundCamp, drops: dropsArr };
    }

    return { campaign: queueItem, drops: [queueItem] };
}

/**
 * Extracts drops array from campaign object or helper response
 */
function extractCampaignDrops(campaign) {
    return getCampaignAndDrops(campaign).drops;
}

/**
 * Formats seconds into readable time
 */
function formatTime(secs) {
    if (!secs || isNaN(secs) || secs < 0) return '0:00';

    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const remSecs = Math.floor(secs % 60);

    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
    return `${mins}:${String(remSecs).padStart(2, '0')}`;
}

/**
 * Helper to extract image URL from any drop or reward object structure (supports snake_case and camelCase)
 */
function extractUrlFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // 1. Přímé vlastnosti objektu
    let url = obj.image_url || obj.imageUrl || 
              obj.reward_image_url || obj.rewardImageUrl || 
              obj.icon_url || obj.iconUrl || 
              obj.benefit_icon_url || obj.benefitIconUrl || 
              obj.asset_url || obj.assetUrl || 
              obj.box_art_url || obj.boxArtURL || obj.boxArtUrl ||
              obj.image || obj.thumbnail || obj.url;
    if (url) return url;

    // 2. Vložený pod-objekt (reward / benefit)
    const sub = obj.reward || obj.benefit;
    if (sub) {
        url = sub.image_url || sub.imageUrl || sub.icon_url || sub.iconUrl || sub.asset_url || sub.assetUrl;
        if (url) return url;
    }

    // 3. Pole benefitů
    if (Array.isArray(obj.benefits) && obj.benefits.length > 0) {
        const b = obj.benefits[0];
        url = b?.image_url || b?.imageUrl || b?.icon_url || b?.iconUrl || b?.thumbnail || b?.url || b?.asset_url || b?.assetUrl;
        if (url) return url;
    }

    // 4. GraphQL hrany (benefit_edges / benefitEdges)
    const edgeNode = obj.benefit_edges?.[0]?.node || obj.benefitEdges?.[0]?.node;
    if (edgeNode) {
        return edgeNode.asset_url || edgeNode.assetUrl || edgeNode.image_url || edgeNode.imageUrl || null;
    }

    return null;
}

/**
 * Resolves drop reward/asset image URL accurately with campaign fallbacks
 */
function resolveDropRewardImageUrl(data, targetId = null) {
    if (!data) return null;

    // 1. Zkusíme vytáhnout URL přímo z předaného objektu
    let rewardImgUrl = extractUrlFromObject(data);
    if (rewardImgUrl) return rewardImgUrl;

    // 2. Použijeme náš sjednocený helper pro získání kampaně a jejích dropů
    const { campaign, drops } = getCampaignAndDrops(data);

    // 3. Pokud máme targetId, zkusíme najít konkrétní drop v poli dropů
    if (targetId && Array.isArray(drops)) {
        const targetDrop = drops.find(d => d && (d.id === targetId || d.drop_id === targetId || d.dropId === targetId));
        if (targetDrop) {
            rewardImgUrl = extractUrlFromObject(targetDrop);
        }
    }

    // 4. Fallback na obrázek samotné kampaně
    return rewardImgUrl || (campaign ? extractUrlFromObject(campaign) : null);
}

const _preloadedUrls = new Set();

/**
 * Preloads queue images efficiently without redundant network requests
 */
function preloadQueueImages(queue) {
    if (!Array.isArray(queue) || queue.length === 0) return;

    const cache = (typeof imageCache !== 'undefined') ? imageCache : null;

    for (const dropItem of queue) {
        if (!dropItem) continue;

        const url = extractUrlFromObject(dropItem) || dropItem.image_url || dropItem.imageUrl;
        if (!url || _preloadedUrls.has(url)) continue;

        _preloadedUrls.add(url);

        const img = new Image();
        img.src = url;

        if (cache && !cache.has(url)) {
            cache.set(url, img);
        }
    }
}

/**
 * Unified entry point for updating active drop progress and syncing UI.
 */
function syncAnyDropProgress(incomingIdStr, data) {
    if (!state || !data || typeof data !== 'object') return;

    const targetIdStr = String(incomingIdStr);
    const currMins = data.current_minutes ?? data.currentMinutes;
    const reqMins = data.required_minutes ?? data.requiredMinutes;
    const remSecs = data.remaining_seconds ?? data.remainingSeconds;

    if (currMins === undefined && remSecs === undefined) return;

    // Direct update for target drop in active queue
    if (Array.isArray(state.activeDropsQueue)) {
        const activeDrop = state.activeDropsQueue.find(
            d => String(d.drop_id || d.id) === targetIdStr
        );

        if (activeDrop) {
            if (currMins !== undefined) activeDrop.current_minutes = currMins;
            if (reqMins !== undefined) activeDrop.required_minutes = reqMins;
            if (remSecs !== undefined) activeDrop.remaining_seconds = remSecs;
            if (data.is_claimed !== undefined) activeDrop.is_claimed = data.is_claimed;

            const dropReq = Number(activeDrop.required_minutes || 0);
            const dropCur = Number(activeDrop.current_minutes || 0);

            if (dropReq > 0) {
                activeDrop.progress = Math.min(100, (dropCur / dropReq) * 100);
                activeDrop.can_claim = dropCur >= dropReq && !activeDrop.is_claimed;
            }

            // Update live drops cache
            state.liveDropsCache = state.liveDropsCache || {};
            state.liveDropsCache[targetIdStr] = {
                ...state.liveDropsCache[targetIdStr],
                current_minutes: activeDrop.current_minutes,
                required_minutes: activeDrop.required_minutes,
                remaining_seconds: activeDrop.remaining_seconds,
                progress: activeDrop.progress,
                can_claim: activeDrop.can_claim
            };

            if (typeof renderAllProgressBars === 'function') {
                renderAllProgressBars(dropCur, activeDrop);
            }
        }
    }

    // Sync progress to wanted items tree
    if (typeof syncWantedItemsProgress === 'function') {
        syncWantedItemsProgress({
            drop_id: targetIdStr,
            ...data,
            current_minutes: currMins,
            remaining_seconds: remSecs
        });
    }
}

function calculateOverallStats() {
    try {
        console.group('[calculateOverallStats] Execution triggered');

        // Fetch target tree strictly from state or window fallbacks
        const tree = (typeof state !== 'undefined' 
            ? (state.wantedGamesTree || state.wantedItemsTree) 
            : window.wantedGamesTree) || [];

        console.log('[calculateOverallStats] Raw tree data:', tree);

        if (!Array.isArray(tree)) {
            console.warn('[calculateOverallStats] Target tree is not an array:', typeof tree, tree);
            console.groupEnd();
            return { totalRequired: 0, totalCurrent: 0, totalRemainingSecs: 0 };
        }

        let totalCurrentMins = 0;
        let totalRequiredMins = 0;
        let totalRemainingMins = 0;

        // Iterate strictly through games -> campaigns -> drops
        tree.forEach((game) => {
            if (!game) return;

            totalRemainingMins += Number(game.total_remaining_minutes || 0);

            const campaigns = game.campaigns || [];
            campaigns.forEach((campaign) => {
                if (!campaign) return;

                const drops = campaign.drops || [];
                drops.forEach((drop) => {
                    if (!drop || drop.is_claimed) return;

                    totalCurrentMins += Number(drop.current_minutes || 0);
                    totalRequiredMins += Number(drop.required_minutes || 0);
                });
            });
        });

        console.log('[calculateOverallStats] Calculated metrics:', {
            totalCurrentMins,
            totalRequiredMins,
            totalRemainingMins
        });

        console.groupEnd();

        // Return unified data structure for consumers
        return {
            totalCurrent: totalCurrentMins,
            totalRequired: totalRequiredMins,
            totalRemainingSecs: totalRemainingMins * 60
        };
    } catch (err) {
        console.error('[calculateOverallStats] Unhandled exception occurred:', err);
        console.groupEnd();
        return { totalRequired: 0, totalCurrent: 0, totalRemainingSecs: 0 };
    }
}

/**
 * Updates overall global progress across all wanted items.
 */
function updateOverallProgress() {
    try {
        const overallFill = document.getElementById('overall-progress-fill');
        const overallText = document.getElementById('overall-progress-text');
        if (!overallFill || !overallText) return;

        const queueTree = state?.wantedGamesTree ?? state?.wantedItemsTree ?? state?._lastValidWantedTree ?? [];

        if (!Array.isArray(queueTree) || queueTree.length === 0) {
            overallFill.style.width = '0%';
            overallFill.textContent = '';
            overallText.textContent = '0% (0 / 0 min)';

            const overallTimeEl = document.getElementById('overall-progress-time');
            if (overallTimeEl) overallTimeEl.textContent = 'Total remaining time: 0m';
            return;
        }

        if (state && typeof state === 'object') {
            state._lastValidWantedTree = queueTree;
        }

        const stats = typeof calculateOverallStats === 'function'
            ? calculateOverallStats()
            : { totalRequired: 0, totalCurrent: 0, totalRemainingSecs: 0 };

        if (stats.totalRequired > 0) {
            const percentage = Math.min(100, Math.round((stats.totalCurrent / stats.totalRequired) * 100));
            overallFill.style.width = `${percentage}%`;
            overallFill.textContent = percentage > 5 ? `${percentage}%` : '';
            overallText.textContent = `${percentage}% (${stats.totalCurrent} / ${stats.totalRequired} min)`;
        } else {
            overallFill.style.width = '0%';
            overallFill.textContent = '';
            overallText.textContent = '0% (0 / 0 min)';
        }

        let overallTimeEl = document.getElementById('overall-progress-time');
        if (!overallTimeEl) {
            const parent = overallText.parentElement;
            if (parent) {
                overallTimeEl = document.createElement('div');
                overallTimeEl.id = 'overall-progress-time';
                overallTimeEl.style.fontSize = '0.85em';
                overallTimeEl.style.opacity = '0.8';
                overallTimeEl.style.marginTop = '4px';
                parent.appendChild(overallTimeEl);
            }
        }

        if (overallTimeEl) {
            const timeText = typeof formatTime === 'function' 
                ? formatTime(stats.totalRemainingSecs ?? 0)
                : `${Math.ceil((stats.totalRemainingSecs ?? 0) / 60)}m`;
            overallTimeEl.textContent = `Zbývá celkem: ${timeText}`;
        }
    } catch (e) {
        console.error('Error updating overall progress:', e);
    }
}

/**
 * Removes claimed campaigns from the active rotation queue
 */
function cleanupClaimedCampaigns() {
    if (!Array.isArray(state?.activeCampaignsQueue)) return;

    const initialLen = state.activeCampaignsQueue.length;
    
    state.activeCampaignsQueue = state.activeCampaignsQueue.filter(c => {
        if (isClaimed(c)) return false;
        const cDrops = extractCampaignDrops(c);
        return cDrops.length === 0 || cDrops.some(d => !isClaimed(d));
    });

    const removedCount = initialLen - state.activeCampaignsQueue.length;
}

/**
 * Maps and sanitizes drop objects for queue processing
 */
function mapDropsForQueue(drops, parentData = {}) {
    if (!Array.isArray(drops)) return [];

    return drops.map(d => {
        const dropId = d.id || d.drop_id || d.dropId;
        const cached = state.liveDropsCache?.[String(dropId)];

        const dropImg = extractUrlFromObject(d) || extractUrlFromObject(parentData);
        const dropName = d.name || d.drop_name || d.title || d.dropName || 'Drop';

        // Přednost mají živá data ze socketové keše (liveDropsCache)
        const curMins = cached?.current_minutes ?? d.current_minutes ?? d.currentMinutes ?? parentData.current_minutes ?? 0;
        const reqMins = cached?.required_minutes ?? d.required_minutes ?? d.requiredMinutes ?? parentData.required_minutes ?? 1;
        const remSecs = cached?.remaining_seconds ?? d.remaining_seconds ?? d.remainingSeconds ?? Math.max(0, (reqMins - curMins) * 60);

        return {
            ...parentData,
            drop_id: dropId,
            drop_name: dropName,
            name: dropName,
            image_url: dropImg,
            imageUrl: dropImg,
            current_minutes: curMins,
            required_minutes: reqMins,
            remaining_seconds: remSecs,
            is_claimed: isClaimed(d) || Boolean(cached?.is_claimed)
        };
    });
}

// ==========================================
// 4. INVENTORY & DOM MANAGEMENT
// ==========================================

function addCampaign(campaignData) {
    if (!campaignData?.id) return;

    state.campaigns = state.campaigns || {};
    state.campaigns[campaignData.id] = campaignData;

    if (typeof renderInventory === 'function') renderInventory();
}

/**
 * Clears active states and borders from Wanted Queue items without resetting the queue itself.
 */
function clearWantedActiveState() {
    const activeWantedElements = document.querySelectorAll(
        '.wanted-card.active-mining, .wanted-card.in-progress, .wanted-card.active, .wanted-card.is-active, ' +
        '.wanted-item.active-mining, .wanted-item.in-progress, .wanted-item.active, .wanted-item.is-active'
    );

    activeWantedElements.forEach(el => {
        el.classList.remove('active-mining', 'in-progress', 'active', 'is-active', 'mining');
    });
}

/**
 * Clears the current drop progress UI and resets related state.
 */
function clearDropProgress() {

    // Reset core state
    state.currentDrop = null;
    state.current_drop = null;
    state.activeDropsQueue = [];
    dropTotalSeconds = 0;

    // Reset layout hashes and cached DOM elements to force clean rebuild on next render pass
    lastDropHeaderHash = null;
    lastDropCardLayoutHash = null;
    cachedIconContainer = null;
    cachedInfoTextDiv = null;

    // Direct & safe UI resetting via optional chaining
    const noDropMessage = document.getElementById('no-drop-message');
    if (noDropMessage) noDropMessage.style.display = 'block';

    const dropInfo = document.getElementById('drop-info');
    if (dropInfo) dropInfo.style.display = 'none';

    const dropGameEl = document.getElementById('drop-game');
    if (dropGameEl) {
        dropGameEl.innerHTML = '';
        dropGameEl.style.display = 'none';
    }

    document.getElementById('drop-card-left-img')?.remove();

    const currentDropLabel = document.getElementById('current-drop-label');
    if (currentDropLabel) currentDropLabel.textContent = '';

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = '0%';
        fill.textContent = '0%';
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) progressText.textContent = '0 / 0 min';

    const timeEl = document.getElementById('progress-time');
    if (timeEl) timeEl.textContent = 'Time remaining: 0:00';

    clearWantedActiveState();

    if (typeof renderWantedItems === 'function' && Array.isArray(state.wantedItemsTree)) {
        renderWantedItems(state.wantedItemsTree);
    }
}

// ==========================================
// 4. INVENTORY & DOM MANAGEMENT
// ==========================================

function addCampaign(campaignData) {
    if (!campaignData?.id) return;

    state.campaigns = state.campaigns || {};
    state.campaigns[campaignData.id] = campaignData;

    if (typeof renderInventory === 'function') renderInventory();
}

/**
 * Clears active states and borders from Wanted Queue items without resetting the queue itself.
 */
function clearWantedActiveState() {
    const activeWantedElements = document.querySelectorAll(
        '.wanted-card.active-mining, .wanted-card.in-progress, .wanted-card.active, .wanted-card.is-active, ' +
        '.wanted-item.active-mining, .wanted-item.in-progress, .wanted-item.active, .wanted-item.is-active'
    );

    activeWantedElements.forEach(el => {
        el.classList.remove('active-mining', 'in-progress', 'active', 'is-active', 'mining');
    });
}

/**
 * Clears the current drop progress UI and resets related state.
 */
function clearDropProgress() {
    // Reset core state
    state.currentDrop = null;
    state.current_drop = null;
    state.activeDropsQueue = [];
    dropTotalSeconds = 0;

    // Reset layout hashes and cached DOM elements to force clean rebuild on next render pass
    lastDropHeaderHash = null;
    lastDropCardLayoutHash = null;
    cachedIconContainer = null;
    cachedInfoTextDiv = null;

    // Direct & safe UI resetting via optional chaining
    const noDropMessage = document.getElementById('no-drop-message');
    if (noDropMessage) noDropMessage.style.display = 'block';

    const dropInfo = document.getElementById('drop-info');
    if (dropInfo) dropInfo.style.display = 'none';

    const dropGameEl = document.getElementById('drop-game');
    if (dropGameEl) {
        dropGameEl.innerHTML = '';
        dropGameEl.style.display = 'none';
    }

    document.getElementById('drop-card-left-img')?.remove();

    const currentDropLabel = document.getElementById('current-drop-label');
    if (currentDropLabel) currentDropLabel.textContent = '';

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = '0%';
        fill.textContent = '0%';
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) progressText.textContent = '0 / 0 min';

    const timeEl = document.getElementById('progress-time');
    if (timeEl) timeEl.textContent = 'Time remaining: 0:00';

    clearWantedActiveState();

    if (typeof renderWantedItems === 'function' && Array.isArray(state.wantedItemsTree)) {
        renderWantedItems(state.wantedItemsTree);
    }
}

/**
 * Extracts and formats game box art/icon URL with resolution placeholders replaced
 */
function extractIconUrl(data, foundCampaign) {
    const extractBoxArt = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        const g = obj.game ?? {};

        return obj.game_box_art_url || obj.gameBoxArtURL || obj.gameBoxArtUrl ||
               obj.game_icon || obj.gameIcon || obj.box_art_url || obj.boxArtURL || obj.boxArtUrl ||
               obj.icon_url || obj.iconURL || obj.iconUrl || obj.image_url || obj.imageUrl ||
               g.box_art_url || g.boxArtURL || g.boxArtUrl || g.icon_url || g.iconURL || g.image_url || null;
    };

    const rawBoxArt = extractBoxArt(data) || extractBoxArt(foundCampaign);
    return rawBoxArt ? rawBoxArt.replace('{width}', '52').replace('{height}', '70') : null;
}

/**
 * Ensures cached header containers exist and are attached to the drop game element
 */
function ensureHeaderContainers(dropGameEl) {
    if (!dropGameEl) return;

    Object.assign(dropGameEl.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        margin: '8px 0'
    });

    if (!cachedIconContainer) {
        console.log('[DropHeader Debug] Creating cachedIconContainer for the first time.');
        cachedIconContainer = document.createElement('div');
        cachedIconContainer.className = 'game-icon-container';
        Object.assign(cachedIconContainer.style, {
            width: '42px',
            height: '56px',
            minWidth: '42px',
            minHeight: '56px',
            flexShrink: '0',
            borderRadius: '6px',
            overflow: 'hidden',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            border: '1px dashed rgba(255, 255, 255, 0.15)'
        });
    }

    if (!cachedInfoTextDiv) {
        console.log('[DropHeader Debug] Creating cachedInfoTextDiv for the first time.');
        cachedInfoTextDiv = document.createElement('div');
        cachedInfoTextDiv.className = 'drop-game-text-info';
        Object.assign(cachedInfoTextDiv.style, {
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center'
        });
    }

    if (!dropGameEl.contains(cachedIconContainer) || !dropGameEl.contains(cachedInfoTextDiv)) {
        dropGameEl.replaceChildren(cachedIconContainer, cachedInfoTextDiv);
    }
}

/**
 * Updates campaign header icon with fallback placeholder support
 */
function updateHeaderIcon(iconUrl) {
    if (!cachedIconContainer) return;

    let imgEl = cachedIconContainer.querySelector('img');
    let placeholderEl = cachedIconContainer.querySelector('.campaign-icon-placeholder');

    if (iconUrl) {
        if (!imgEl) {
            imgEl = document.createElement('img');
            imgEl.className = 'game-icon';
            Object.assign(imgEl.style, {
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block'
            });
            imgEl.onerror = () => {
                imgEl.style.display = 'none';
                if (placeholderEl) placeholderEl.style.display = 'flex';
            };
            cachedIconContainer.appendChild(imgEl);
        }
        imgEl.src = iconUrl;
        imgEl.style.display = 'block';
        if (placeholderEl) placeholderEl.style.display = 'none';
    } else {
        if (imgEl) imgEl.style.display = 'none';
        if (!placeholderEl) {
            placeholderEl = document.createElement('div');
            placeholderEl.className = 'campaign-icon-placeholder';
            Object.assign(placeholderEl.style, {
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '18px',
                color: 'rgba(255, 255, 255, 0.4)'
            });
            placeholderEl.textContent = '🎮';
            cachedIconContainer.appendChild(placeholderEl);
        }
        placeholderEl.style.display = 'flex';
    }
}

/**
 * Updates or creates the campaign title element within the cached info container
 */
function updateHeaderTitle(effectiveCampaignId, titleText = '') {
    if (!cachedInfoTextDiv) return;

    let titleNode = cachedInfoTextDiv.querySelector('.drop-campaign-title');

    if (!titleNode) {
        titleNode = document.createElement('a');
        titleNode.className = 'drop-campaign-title drop-campaign-link';
        titleNode.target = '_blank';
        titleNode.rel = 'noopener noreferrer';
        cachedInfoTextDiv.prepend(titleNode);
    }

    if (effectiveCampaignId) {
        const targetUrl = `https://www.twitch.tv/drops/campaigns?dropID=${effectiveCampaignId}`;
        if (titleNode.href !== targetUrl) {
            titleNode.href = targetUrl;
        }
        Object.assign(titleNode.style, {
            pointerEvents: 'auto',
            textDecoration: 'underline'
        });
    } else {
        titleNode.removeAttribute('href');
        Object.assign(titleNode.style, {
            pointerEvents: 'none',
            textDecoration: 'none'
        });
    }

    if (titleNode.textContent !== titleText) {
        titleNode.textContent = titleText;
    }
}

/**
 * Updates or creates the drop subtitle element within the cached info container
 */
function updateHeaderSubtitle(subTextContent = '') {
    if (!cachedInfoTextDiv) return;

    let subText = cachedInfoTextDiv.querySelector('.drop-sub-name');
    if (!subText) {
        subText = document.createElement('span');
        subText.className = 'drop-sub-name';
        Object.assign(subText.style, {
            fontSize: '0.9em',
            opacity: '0.85'
        });
        cachedInfoTextDiv.appendChild(subText);
    }

    if (subText.textContent !== subTextContent) {
        subText.textContent = subTextContent;
    }
}

/**
 * Resolves campaign metadata (foundCampaign, effectiveCampaignId, titleText, subTextContent) from raw data
 */
function resolveCampaignData(data) {
    if (!data || typeof data !== 'object') {
        return { foundCampaign: null, effectiveCampaignId: null, titleText: '', subTextContent: '' };
    }

    const foundCampaign = data.campaign || data.foundCampaign || (state?.campaigns && data.campaign_id ? state.campaigns[data.campaign_id] : null);
    
    const effectiveCampaignId = data.campaign_id ?? data.campaignId ?? data.effectiveCampaignId ?? foundCampaign?.id ?? data.id ?? null;
    
    const titleText = data.game_name ?? data.gameName ?? data.game ?? foundCampaign?.game?.name ?? foundCampaign?.name ?? data.title ?? data.name ?? '';
    
    const subTextContent = data.drop_name ?? data.dropName ?? data.subTextContent ?? data.name ?? '';

    return { foundCampaign, effectiveCampaignId, titleText, subTextContent };
}

/**
 * Renders or updates the drop game header with campaign details and caching
 */
function renderDropGameHeader(data, force = false) {
    const dropGameEl = document.getElementById('drop-game');
    if (!dropGameEl) return;

    if (!data || typeof data !== 'object') {
        resetDropHeader(dropGameEl, 'invalid data object');
        return;
    }

    const { foundCampaign, effectiveCampaignId, titleText, subTextContent } = resolveCampaignData(data);

    if (!titleText && !effectiveCampaignId) {
        resetDropHeader(dropGameEl, 'missing both titleText and effectiveCampaignId');
        return;
    }

    const iconUrl = extractIconUrl(data, foundCampaign);

    ensureHeaderContainers(dropGameEl);

    const currentHash = `${effectiveCampaignId}_${titleText}_${subTextContent}_${iconUrl}`;
    if (!force && lastDropHeaderHash === currentHash) {
        return;
    }

    lastDropHeaderHash = currentHash;

    updateHeaderIcon(iconUrl);
    updateHeaderTitle(effectiveCampaignId, titleText);
    updateHeaderSubtitle(subTextContent);
}

/**
 * Resets the drop card layout label if not already empty
 */
function resetDropCardLayout(currentDropLabel, reason = 'invalid data') {
    if (!currentDropLabel) return;

    if (lastDropCardLayoutHash !== 'empty') {
        currentDropLabel.textContent = '';
        lastDropCardLayoutHash = 'empty';
    }
}

/**
 * Calculates current drop index and queue length for the active campaign display
 */
function calculateDropQueueInfo(data, currentId) {
    let activeDrops = [];

    const { drops } = typeof getCampaignAndDrops === 'function'
        ? getCampaignAndDrops(data)
        : { drops: [] };

    if (Array.isArray(drops) && drops.length > 0) {
        activeDrops = drops.filter(d => (typeof isClaimed === 'function' ? !isClaimed(d) : true));
    }

    if (activeDrops.length === 0 && Array.isArray(state?.activeDropsQueue)) {
        activeDrops = state.activeDropsQueue;
    }

    const getDropMinutes = (d) => Number(d?.required_minutes ?? d?.total_minutes ?? d?.requiredMinutes ?? 0);
    const sortedDrops = [...activeDrops].sort((a, b) => getDropMinutes(a) - getDropMinutes(b));

    const dropQueueLen = sortedDrops.length || 1;
    let dropIdx = 1;

    if (sortedDrops.length > 0 && currentId != null) {
        const targetIdStr = String(currentId);
        const foundIdx = sortedDrops.findIndex(d => String(d?.drop_id ?? d?.id ?? d?.dropId ?? '') === targetIdStr);
        if (foundIdx !== -1) {
            dropIdx = foundIdx + 1;
        }
    }

    return { dropIdx, dropQueueLen };
}

/**
 * Ensures and returns the outer card container element for drop display
 */
function ensureDropCardOuterContainer(currentDropLabel) {
    if (!currentDropLabel) return null;

    let cardOuter = currentDropLabel.closest('.drop-card-container');

    if (!cardOuter) {
        const targetElement = document.getElementById('progress-time') || document.getElementById('progress-fill');

        if (targetElement) {
            let parent = currentDropLabel.parentElement;
            while (parent && parent !== document.body) {
                if (parent.contains(targetElement)) {
                    cardOuter = parent;
                    cardOuter.classList.add('drop-card-container');
                    break;
                }
                parent = parent.parentElement;
            }
        }
    }

    return cardOuter;
}

/**
 * Helper function to create a fallback reward placeholder element
 */
function createRewardPlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.id = 'drop-card-left-img';
    placeholder.className = 'image-placeholder drop-reward-placeholder';
    Object.assign(placeholder.style, {
        width: '72px',
        height: '72px',
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.05)',
        border: '1px dashed rgba(255, 255, 255, 0.2)',
        fontSize: '24px'
    });
    placeholder.textContent = '🎁';
    return placeholder;
}

/**
 * Ensures and returns the right column container inside the drop card layout
 */
function ensureDropCardRightCol(cardOuter) {
    if (!cardOuter) return null;

    let rightCol = cardOuter.querySelector('#drop-card-right-col');
    if (!rightCol) {
        rightCol = document.createElement('div');
        rightCol.id = 'drop-card-right-col';
        Object.assign(rightCol.style, {
            flex: '1',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: '6px',
            minWidth: '0'
        });

        rightCol.append(...cardOuter.childNodes);

        Object.assign(cardOuter.style, {
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'stretch',
            gap: '12px'
        });
        cardOuter.appendChild(rightCol);
    }
    return rightCol;
}

/**
 * Resolves left drop card image element with placeholder fallback
 */
function resolveDropCardLeftImage(rawImgUrl, dropName = 'Drop Reward') {
    let targetLeftEl = null;

    if (rawImgUrl) {
        const cache = (typeof imageCache !== 'undefined') ? imageCache : _fallbackImageCache;

        let templateImg = cache.get(rawImgUrl);
        if (!templateImg) {
            templateImg = document.createElement('img');
            templateImg.src = rawImgUrl;
            cache.set(rawImgUrl, templateImg);
        }

        const imgEl = templateImg.cloneNode(false);
        imgEl.alt = dropName || 'Drop Reward';
        imgEl.className = 'drop-reward-icon';
        Object.assign(imgEl.style, {
            width: '72px',
            height: '72px',
            maxHeight: '100%',
            alignSelf: 'center',
            objectFit: 'contain',
            borderRadius: '6px',
            flexShrink: '0',
            display: 'block'
        });

        // Error fallback to placeholder if image fails to load
        imgEl.onerror = function() {
            const placeholder = createRewardPlaceholder();
            if (this.parentNode) {
                this.parentNode.replaceChild(placeholder, this);
            }
        };

        targetLeftEl = imgEl;
    }

    if (!targetLeftEl) {
        targetLeftEl = createRewardPlaceholder();
    }

    targetLeftEl.id = 'drop-card-left-img';
    return targetLeftEl;
}

/**
 * Updates or inserts the left image element inside the card outer container
 */
function updateDropCardLeftImage(cardOuter, targetLeftEl, rightCol) {
    if (!cardOuter || !targetLeftEl) return;

    const existingLeftImg = cardOuter.querySelector('#drop-card-left-img');
    if (existingLeftImg !== targetLeftEl) {
        if (existingLeftImg) {
            existingLeftImg.replaceWith(targetLeftEl);
        } else if (rightCol) {
            cardOuter.insertBefore(targetLeftEl, rightCol);
        } else {
            cardOuter.prepend(targetLeftEl);
        }
    }
}

/**
 * Renders the layout and reward image for the current drop card
 */
function renderDropCardLayout(data, rewardImgUrl, force = false) {
    const currentDropLabel = document.getElementById('current-drop-label');
    if (!currentDropLabel) return;

    if (!data || typeof data !== 'object') {
        resetDropCardLayout(currentDropLabel, 'invalid data object');
        return;
    }

    const currentId = data.drop_id ?? data.id ?? data.dropId ?? '';
    const dropName = data.drop_name ?? data.dropName ?? data.name ?? data.title ?? 'Drop';
    const rawImgUrl = rewardImgUrl || '';

    const currentHash = `${currentId}_${dropName}_${rawImgUrl}`;
    if (!force && lastDropCardLayoutHash === currentHash) {
        return;
    }

    const { dropIdx, dropQueueLen } = calculateDropQueueInfo(data, currentId);
    const newLabelText = `⚡ Drop (${dropIdx}/${dropQueueLen}): ${dropName}`;
    if (currentDropLabel.textContent !== newLabelText) {
        currentDropLabel.textContent = newLabelText;
    }

    const cardOuter = ensureDropCardOuterContainer(currentDropLabel);
    if (!cardOuter) return;

    const rightCol = ensureDropCardRightCol(cardOuter);
    const targetLeftEl = resolveDropCardLeftImage(rawImgUrl, dropName);
    updateDropCardLeftImage(cardOuter, targetLeftEl, rightCol);

    lastDropCardLayoutHash = currentHash;
}

/**
 * Updates UI progress bars and text according to active drop progress
 */
function renderAllProgressBars(currentMins, dropData) {
    if (!dropData || typeof dropData !== 'object') return;

    const current = Number(currentMins) || 0;
    const reqMins = Number(dropData.required_minutes ?? dropData.total_minutes ?? dropData.requiredMinutes ?? 1) || 1;

    const dropPercentage = Math.min(100, Math.max(0, (current / reqMins) * 100));

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = `${dropPercentage.toFixed(1)}%`;
        fill.textContent = `${Math.round(dropPercentage)}%`;
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) {
        progressText.textContent = `${current} / ${reqMins} min`;
    }

    if (typeof updateCampaignProgressData === 'function') {
        updateCampaignProgressData(dropData, current);
    }
    if (typeof updateOverallProgress === 'function') {
        updateOverallProgress();
    }
}

/**
 * Comprehensive debug logger and DOM updater for Wanted Queue time badges.
 */
function updateGameHeaderTimeBadgeDebug(target, remainingSeconds, callerSource = 'UNKNOWN') {
    const gameName = typeof target === 'string' ? target : (target?.name ?? target?.game_name ?? target?.gameName ?? 'Unknown Game');

    const escapedName = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(gameName) : gameName;
    const groupEl = document.querySelector(`[data-game-name="${escapedName}"]`)
                 || document.querySelector(`[data-game-id="${escapedName}"]`);

    if (!groupEl) {
        console.warn(`[BADGE_DEBUG] ❌ Target DOM group not found for: '${gameName}' (Caller: ${callerSource})`);
        return;
    }

    const badgeEl = groupEl.querySelector('.wanted-game-time-badge, .campaign-badge-time');
    if (!badgeEl) {
        console.warn(`[BADGE_DEBUG] ❌ Badge DOM element missing inside group: '${gameName}'`);
        return;
    }

    const remSecs = Number(remainingSeconds || 0);
    const totalMins = Math.ceil(remSecs / 60);
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    const newText = totalMins > 0 ? `${hours}h ${mins}m` : 'Done';

    const oldText = badgeEl.textContent.trim();
    const hasChanged = oldText !== newText;

    const statusIcon = hasChanged ? '🔄 [WRITE]' : '⏭️ [SKIP]';
    console.groupCollapsed(`[BADGE_DEBUG] ${statusIcon} '${gameName}' ➔ ${newText} (${callerSource})`);

    console.table({
        'Game Target': gameName,
        'Trigger Source': callerSource,
        'Raw Seconds': remSecs,
        'Calculated Mins': totalMins,
        'Previous Value': oldText,
        'New Value': newText,
        'DOM Updated': hasChanged
    });

    if (hasChanged) {
        badgeEl.textContent = newText;
        console.log(`✅ DOM text updated from "${oldText}" to "${newText}"`);
    } else {
        console.log(`ℹ️ Values match ("${oldText}"). DOM write skipped to preserve performance.`);
    }

    console.groupEnd();
}

/**
 * Updates game group header badge using group identifier or index, formatted into "Xh Ym".
 */
function updateGameHeaderTimeBadge(groupTarget, remainingMinutes) {
    if (groupTarget == null) return;

    let groupEl = null;

    if (typeof groupTarget === 'string') {
        const targetStr = groupTarget.trim();
        const escapedStr = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(targetStr) : targetStr;
        
        groupEl = document.querySelector(`[data-game-group-id="${escapedStr}"]`) 
               || document.querySelector(`[data-game-name="${escapedStr}"]`);
    } else if (typeof groupTarget === 'number' && groupTarget >= 0) {
        const groups = document.querySelectorAll('.wanted-game-group');
        groupEl = groups[groupTarget];
    }

    const badge = groupEl?.querySelector('.wanted-game-time-badge');
    if (!badge) return;

    const totalMins = Math.max(0, Number(remainingMinutes ?? 0));
    let formattedText = 'Done';

    if (totalMins > 0) {
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        formattedText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    if (badge.textContent !== formattedText) {
        badge.textContent = formattedText;
    }
}
// ==========================================
// 5. CORE LOGIC & ROTATION
// ==========================================

/**
 * Updates the single active drop display with caching, queue matching, and DOM rendering.
 */
function updateSingleDropDisplay(data, isFromRotation = false) {
    if (!data || typeof data !== 'object') return;

    const targetId = data.drop_id ?? data.id ?? data.dropId;
    if (!targetId) return;

    const activeDrop = typeof getSafeActiveDrop === 'function' ? getSafeActiveDrop() : null;
    const activeId = activeDrop ? (activeDrop.drop_id ?? activeDrop.id ?? activeDrop.dropId) : null;
    const isCurrentDrop = activeId != null && String(activeId) === String(targetId);

    // Skip update if event is not from rotation and doesn't match active drop
    if (!isFromRotation && activeId != null && !isCurrentDrop) {
        return;
    }

    const dropsQueue = Array.isArray(state?.activeDropsQueue) ? state.activeDropsQueue : [];

    // Merge active drop or queue item state into incoming data
    if (activeDrop && isCurrentDrop) {
        data = { ...activeDrop, ...data };
    } else if (dropsQueue.length > 0) {
        const queueItem = dropsQueue.find(d => (d?.drop_id ?? d?.id ?? d?.dropId) === targetId);
        if (queueItem) {
            data = { ...queueItem, ...data };
        }
    }

    // Sync fresh minutes from active queue if available
    const freshQueueItem = dropsQueue.find(d => (d?.drop_id ?? d?.id ?? d?.dropId) === targetId);
    if (freshQueueItem?.current_minutes !== undefined) {
        data.current_minutes = freshQueueItem.current_minutes;
        data.currentMinutes = freshQueueItem.current_minutes;
    }

    // Keep highest accumulated minute count if running in same context
    if (activeDrop?.current_minutes !== undefined && !data.is_claimed) {
        const isSameContext = (data.campaign_id && activeDrop.campaign_id && String(data.campaign_id) === String(activeDrop.campaign_id)) ||
                              (data.game_name && activeDrop.game_name && data.game_name === activeDrop.game_name);

        if (isSameContext) {
            const liveMins = Math.max(Number(data.current_minutes || 0), Number(activeDrop.current_minutes));
            data.current_minutes = liveMins;
            data.currentMinutes = liveMins;
        }
    }

    const reqMins = Number(data.required_minutes ?? data.requiredMinutes ?? data.total_minutes ?? 0);
    const curMins = Number(data.current_minutes ?? data.currentMinutes ?? 0);

    const isDropClaimed = typeof isClaimed === 'function' ? isClaimed(data) : Boolean(data.is_claimed);

    // If completed or claimed, clean queue and trigger rotation
    if (isDropClaimed || (reqMins > 0 && curMins >= reqMins)) {
        if (Array.isArray(state?.activeDropsQueue)) {
            state.activeDropsQueue = state.activeDropsQueue.filter(d => (d?.drop_id ?? d?.id ?? d?.dropId) !== targetId);
        }
        if (typeof startCombinedRotation === 'function') {
            startCombinedRotation(true);
        }
        return;
    }

    // Determine remaining time in seconds
    let remSecs;
    if (data.remaining_seconds != null && !isFromRotation) {
        remSecs = Number(data.remaining_seconds);
    } else if (isCurrentDrop && activeDrop?.remaining_seconds != null && !isFromRotation) {
        remSecs = Number(activeDrop.remaining_seconds);
    } else {
        remSecs = Math.max(0, (reqMins - curMins) * 60);
    }

    data.remaining_seconds = remSecs;

    if (typeof debugTime === 'function') {
        debugTime('2. DISPLAY_UPDATE', data);
    }

    // Update global state references
    if (state && typeof state === 'object') {
        state.currentDrop = data;
        state.current_drop = data;
    }

    // Toggle DOM container visibility
    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'none';
    if (dropInfo) dropInfo.style.display = 'block';

    // Render components and layout safely
    const rewardImgUrl = typeof resolveDropRewardImageUrl === 'function' 
        ? resolveDropRewardImageUrl(data, targetId) 
        : '';

    if (typeof updateDropTitle === 'function') updateDropTitle(data);
    if (typeof renderDropGameHeader === 'function') renderDropGameHeader(data);
    if (typeof renderDropCardLayout === 'function') renderDropCardLayout(data, rewardImgUrl);
    if (typeof renderAllProgressBars === 'function') renderAllProgressBars(curMins, data);
    if (typeof updateRemainingTime === 'function') updateRemainingTime(remSecs, data);
}

/**
 * Switches current campaign display, filters active drops queue, and triggers UI updates.
 */
function switchCampaignDisplay(data, isManualSwitch = false, shouldUpdateDisplay = true) {
    if (data && typeof data === 'object') {
        const now = Date.now();

        // Check if campaign has already expired
        if (data.ends_at) {
            const endTime = new Date(data.ends_at).getTime();
            if (!isNaN(endTime) && endTime <= now) {
                if (typeof clearDropProgress === 'function') {
                    clearDropProgress();
                }
                return;
            }
        }

        // Check if campaign is already completed
        const curMins = data.current_minutes ?? data.currentMinutes;
        const reqMins = data.required_minutes ?? data.requiredMinutes;
        if (curMins !== undefined && reqMins !== undefined && reqMins > 0 && curMins >= reqMins) {
            if (typeof clearDropProgress === 'function') {
                clearDropProgress();
            }
            return;
        }
    }

    if (typeof cleanupClaimedCampaigns === 'function') {
        cleanupClaimedCampaigns();
    }

    // Restore last valid active campaigns queue if current is empty
    if (!Array.isArray(state?.activeCampaignsQueue) || state.activeCampaignsQueue.length === 0) {
        if (Array.isArray(state?._lastValidActiveCampaignsQueue) && state._lastValidActiveCampaignsQueue.length > 0) {
            state.activeCampaignsQueue = state._lastValidActiveCampaignsQueue;
        }
    } else if (state && typeof state === 'object') {
        state._lastValidActiveCampaignsQueue = state.activeCampaignsQueue;
    }

    const activeDrop = typeof getSafeActiveDrop === 'function' ? getSafeActiveDrop() : null;
    const previousDropId = activeDrop ? (activeDrop.drop_id ?? activeDrop.id ?? activeDrop.dropId) : null;

    const { drops = [] } = typeof getCampaignAndDrops === 'function'
        ? getCampaignAndDrops(data)
        : { drops: [] };

    if (drops.length > 0) {
        const targetDropId = data?.drop_id ?? data?.dropId;

        if (targetDropId) {
            const targetDrop = drops.find(d => (d?.id ?? d?.drop_id ?? d?.dropId) === targetDropId);
            if (targetDrop) {
                if (data.current_minutes !== undefined) targetDrop.current_minutes = data.current_minutes;
                if (data.required_minutes !== undefined) targetDrop.required_minutes = data.required_minutes;
                if (data.remaining_seconds !== undefined) targetDrop.remaining_seconds = data.remaining_seconds;
                if (data.is_claimed !== undefined) targetDrop.is_claimed = data.is_claimed;
            }
        }

        const unclaimedDrops = drops.filter(d => (typeof isClaimed === 'function' ? !isClaimed(d) : !d.is_claimed));
        const targetDrops = unclaimedDrops.length > 0 ? unclaimedDrops : drops;

        if (state && typeof state === 'object') {
            state.activeDropsQueue = typeof mapDropsForQueue === 'function'
                ? mapDropsForQueue(targetDrops, data)
                : targetDrops;
        }

        if (isManualSwitch) {

            const activeQueue = state?.activeDropsQueue ?? [];
            const idx = activeQueue.findIndex(d => (d?.drop_id ?? d?.id ?? d?.dropId) === targetDropId);
            if (idx !== -1 && state) {
                state.dropRotationIndex = idx;
            }

            setTimeout(() => {
                if (typeof startCombinedRotation === 'function') {
                    startCombinedRotation(true);
                }
            }, 0);
        }
    } else if (state && typeof state === 'object') {
        state.activeDropsQueue = data ? [data] : [];
    }

    if (typeof preloadQueueImages === 'function' && Array.isArray(state?.activeDropsQueue)) {
        preloadQueueImages(state.activeDropsQueue);
    }

    const rotationIdx = state?.dropRotationIndex ?? 0;
    const initialActiveDrop = state?.activeDropsQueue?.[rotationIdx]
        ?? state?.activeDropsQueue?.[0]
        ?? data;

    const newDropId = initialActiveDrop ? (initialActiveDrop.drop_id ?? initialActiveDrop.id ?? initialActiveDrop.dropId) : null;
    const dropChanged = !previousDropId || !newDropId || String(previousDropId) !== String(newDropId);

    if (shouldUpdateDisplay && typeof updateSingleDropDisplay === 'function') {
        updateSingleDropDisplay(initialActiveDrop, dropChanged);
    }
}

/**
 * Updates UI and state with incoming drop progress data from tick/socket
 */
function updateDropProgress(dropData) {
    if (typeof debugTime === 'function') {
        debugTime('1. INCOMING_TICK', dropData);
    }

    if (!dropData || typeof dropData !== 'object' || Object.keys(dropData).length === 0) {
        if (typeof clearDropProgress === 'function') {
            clearDropProgress();
        }
        return;
    }

    const validDrop = dropData;
    const dropGame = validDrop.game_name ?? validDrop.game ?? validDrop.game_title ?? validDrop.gameName ?? '';

    // Initialize live mining queue safely
    if (!Array.isArray(state?.liveMiningQueue)) {
        if (state && typeof state === 'object') {
            state.liveMiningQueue = [];
        }
    }

    const activeCampId = validDrop.campaign_id ?? validDrop.campaignId;

    if (activeCampId && state?.campaigns?.[activeCampId]) {
        if (!state.liveMiningQueue.includes(activeCampId)) {
            state.liveMiningQueue.push(activeCampId);
        }
    }

    // Filter active campaigns and refresh active queue
    if (state?.campaigns) {
        state.liveMiningQueue = state.liveMiningQueue.filter(cid => {
            const camp = state.campaigns[cid];
            if (!camp || (typeof isClaimed === 'function' ? isClaimed(camp) : camp.is_claimed)) return false;

            const drops = typeof extractCampaignDrops === 'function' 
                ? extractCampaignDrops(camp) 
                : (camp.drops ?? []);

            return drops.some(d => (typeof isClaimed === 'function' ? !isClaimed(d) : !d.is_claimed));
        });

        state.activeCampaignsQueue = state.liveMiningQueue
            .map(cid => state.campaigns[cid])
            .filter(Boolean);
    }

    const incomingIdStr = String(validDrop.drop_id ?? validDrop.id ?? validDrop.dropId ?? '');
    const currentMins = Math.round(Number(validDrop.current_minutes ?? validDrop.currentMinutes ?? validDrop.progress ?? 0));
    const reqMins = Number(validDrop.required_minutes ?? validDrop.requiredMinutes ?? validDrop.total_minutes ?? 0);

    const remSecs = validDrop.remaining_seconds != null
        ? Number(validDrop.remaining_seconds)
        : Math.max(0, (reqMins - currentMins) * 60);

    validDrop.current_minutes = currentMins;
    validDrop.remaining_seconds = remSecs;

    if (state && typeof state === 'object') {
        state.currentDrop = { ...validDrop };
        state.current_drop = { ...validDrop };
    }

    // DOM Elements toggling and text updates
    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'none';
    if (dropInfo) dropInfo.style.display = 'block';

    const campaignTitleEl = document.getElementById('campaign-title') || document.querySelector('.campaign-header-title');
    if (campaignTitleEl && dropGame) {
        campaignTitleEl.textContent = dropGame;
    }

    const dropGameEl = document.getElementById('drop-game');
    if (dropGameEl) {
        dropGameEl.textContent = dropGame;
        dropGameEl.style.display = 'none';
    }

    const secondaryProgressBars = document.querySelectorAll('.secondary-progress-card, #fallback-drop-card');
    secondaryProgressBars.forEach(card => {
        card.style.display = 'none';
    });

    const timeRemainingEl = document.getElementById('progress-time');
    if (timeRemainingEl) {
        timeRemainingEl.style.display = 'block';
    }

    // Trigger updates across UI sync functions
    if (typeof syncAnyDropProgress === 'function') {
        syncAnyDropProgress(incomingIdStr, validDrop);
    } else if (typeof renderAllProgressBars === 'function') {
        renderAllProgressBars(currentMins, validDrop);
    }

    if (typeof updateSingleDropDisplay === 'function') {
        updateSingleDropDisplay(validDrop, false);
    }

    if (typeof updateCampaignProgressData === 'function') {
        updateCampaignProgressData(validDrop, currentMins);
    }
}

/**
 * Updates campaign progress bar and info based on current drop progress.
 */
function updateCampaignProgressData(data, liveCurrentMins) {
    const campaignFill = document.getElementById('campaign-progress-fill');
    const campaignText = document.getElementById('campaign-progress-text');
    const campaignTitle = document.getElementById('campaign-progress-title');

    if (!campaignFill || !campaignText || !data) return;

    const cardContainer = campaignFill.closest('.secondary-progress-card') ?? 
                          campaignFill.closest('.drop-card-container') ?? 
                          campaignFill.parentElement?.parentElement;

    const currentDropCurrent = liveCurrentMins ?? Number(data.current_minutes ?? data.currentMinutes ?? 0);
    const targetDropId = String(data.drop_id ?? data.id ?? data.dropId ?? '');
    const campId = data.campaign_id ?? data.campaignId;

    let totalCampaignCurrent = currentDropCurrent;
    let totalCampaignRequired = 0;

    if (state?.campaigns && campId) {
        let campaign = state.campaigns[campId];
        if (!campaign && typeof state.campaigns === 'object') {
            campaign = Object.values(state.campaigns).find(
                c => c && (c.id === campId || c.campaign_id === campId || c.campaignId === campId)
            );
        }

        if (campaign) {
            const drops = typeof extractCampaignDrops === 'function' 
                ? extractCampaignDrops(campaign) 
                : (campaign.drops ?? []);

            const campName = campaign.name ?? campaign.campaign_name ?? campaign.campaignName ?? 'Campaign';
            const dropsCount = drops.length;

            let dropVisualIndex = 1;
            let maxCampaignRequired = 0;

            drops.forEach((d, i) => {
                if (!d) return;
                const dId = String(d.drop_id ?? d.id ?? d.dropId ?? '');

                if (dId === targetDropId) {
                    d.current_minutes = currentDropCurrent;
                    dropVisualIndex = i + 1;
                }

                const dReq = Number(d.required_minutes ?? d.requiredMinutes ?? d.duration ?? 0);
                if (dReq > maxCampaignRequired) {
                    maxCampaignRequired = dReq;
                }
            });

            totalCampaignRequired = maxCampaignRequired > 0 
                ? maxCampaignRequired 
                : Number(campaign.total_minutes ?? campaign.required_minutes ?? campaign.requiredMinutes ?? 0);

            totalCampaignCurrent = currentDropCurrent;

            if (campaignTitle) {
                const newTitle = `${campName} • Drop ${dropVisualIndex}/${dropsCount}`;
                if (campaignTitle.textContent !== newTitle) {
                    campaignTitle.textContent = newTitle;
                }
            }
        }
    }

    if (totalCampaignRequired === 0) {
        totalCampaignRequired = Number(data.required_minutes ?? data.requiredMinutes ?? data.duration ?? data.total_minutes ?? 0);
    }

    if (totalCampaignRequired > 0) {
        if (cardContainer && cardContainer.style.display !== 'block') {
            cardContainer.style.display = 'block';
        }

        const percentage = Math.min(100, Math.round((totalCampaignCurrent / totalCampaignRequired) * 100));
        const newWidth = `${percentage}%`;
        const newFillText = percentage > 0 ? `${percentage}%` : '';
        const newProgressText = `${totalCampaignCurrent} / ${totalCampaignRequired} min`;

        if (campaignFill.style.width !== newWidth) campaignFill.style.width = newWidth;
        if (campaignFill.textContent !== newFillText) campaignFill.textContent = newFillText;
        if (campaignText.textContent !== newProgressText) campaignText.textContent = newProgressText;
    } else if (cardContainer && cardContainer.style.display !== 'none') {
        cardContainer.style.display = 'none';
    }
}

/**
 * Helper to safely retrieve drop ID from any object
 */
function getDropId(drop) {
    return drop?.drop_id ?? drop?.id ?? drop?.dropId ?? null;
}

/**
 * Executes a single tick of rotation process
 */
function executeRotationStep() {
    let validCampaigns = state?.activeCampaignsQueue ?? [];

    const activeDrop = typeof getSafeActiveDrop === 'function' ? getSafeActiveDrop() : null;
    if (validCampaigns.length === 0 && activeDrop?.campaign_id && state?.campaigns) {
        const fallbackCamp = state.campaigns[activeDrop.campaign_id];
        if (fallbackCamp) validCampaigns = [fallbackCamp];
    }

    let watchedGame = null;
    if (typeof getWatchedChannelObject === 'function') {
        const wObj = getWatchedChannelObject();
        if (wObj) watchedGame = wObj.game_name ?? wObj.game ?? wObj.game_title ?? null;
    }

    validCampaigns = validCampaigns.filter(c => {
        if (!c || (typeof isClaimed === 'function' ? isClaimed(c) : c.is_claimed)) return false;

        const gameName = c.game_name ?? c.game ?? c.gameName;

        if (typeof isGameIgnored === 'function' && isGameIgnored(gameName)) {
            return false;
        }

        if (watchedGame && gameName) {
            if (watchedGame.trim().toLowerCase() !== gameName.trim().toLowerCase()) {
                return false;
            }
        }

        const drops = typeof extractCampaignDrops === 'function' 
            ? extractCampaignDrops(c) 
            : (c.drops ?? []);

        return !drops || drops.length === 0 || drops.some(d => (typeof isClaimed === 'function' ? !isClaimed(d) : !d.is_claimed));
    });

    if (validCampaigns.length === 0) {
        return;
    }

    if (!state || typeof state !== 'object') return;

    if (state.campaignRotationIndex == null || state.campaignRotationIndex >= validCampaigns.length || state.campaignRotationIndex < 0) {
        state.campaignRotationIndex = 0;
        state.dropRotationIndex = 0;
    }

    const currentCampaign = validCampaigns[state.campaignRotationIndex];
    const drops = typeof extractCampaignDrops === 'function' 
        ? extractCampaignDrops(currentCampaign) 
        : (currentCampaign?.drops ?? []);

    const activeDrops = drops.filter(d => (typeof isClaimed === 'function' ? !isClaimed(d) : !d?.is_claimed));

    if (activeDrops.length > 0) {
        if (state.dropRotationIndex == null || state.dropRotationIndex >= activeDrops.length || state.dropRotationIndex < 0) {
            state.dropRotationIndex = 0;
        }

        const currentDrop = activeDrops[state.dropRotationIndex];

        currentDrop.campaign_id = currentCampaign.id ?? currentCampaign.campaign_id ?? currentCampaign.campaignId;
        currentDrop.campaign_name = currentCampaign.name ?? currentCampaign.campaign_name ?? currentCampaign.campaignName;
        currentDrop.game_name = currentCampaign.game_name ?? currentCampaign.game ?? currentCampaign.gameName;
        currentDrop.drop_name = currentDrop.name ?? currentDrop.drop_name ?? currentDrop.title ?? currentDrop.dropName ?? 'Drop';

        const currentId = String(getDropId(currentDrop) ?? '');
        const liveData = state.liveDropsCache?.[currentId] ?? null;

        if (liveData) {
            if (liveData.current_minutes != null) currentDrop.current_minutes = liveData.current_minutes;
            if (liveData.remaining_seconds != null) currentDrop.remaining_seconds = liveData.remaining_seconds;
            if (liveData.required_minutes != null) currentDrop.required_minutes = liveData.required_minutes;
            if (liveData.progress != null) currentDrop.progress = liveData.progress;

            if (liveData.name && !currentDrop.name) currentDrop.name = liveData.name;
            if (liveData.title && !currentDrop.title) currentDrop.title = liveData.title;
            if (liveData.drop_name && !currentDrop.drop_name) currentDrop.drop_name = liveData.drop_name;
        }

        const existingDrop = typeof getSafeActiveDrop === 'function' ? getSafeActiveDrop() : null;
        const existingId = getDropId(existingDrop);
        const hasChanged = !existingId || String(existingId) !== currentId;

        if (typeof switchCampaignDisplay === 'function') {
            switchCampaignDisplay(currentCampaign, false, false);
        }
        if (typeof updateSingleDropDisplay === 'function') {
            updateSingleDropDisplay(currentDrop, hasChanged);
        }

        state.dropRotationIndex++;
        if (state.dropRotationIndex >= activeDrops.length) {
            state.dropRotationIndex = 0;
            state.campaignRotationIndex++;
        }
    } else {
        if (typeof switchCampaignDisplay === 'function') {
            switchCampaignDisplay(currentCampaign, false, true);
        }
        state.campaignRotationIndex++;
    }

    if (state.campaignRotationIndex >= validCampaigns.length) {
        state.campaignRotationIndex = 0;
    }
}

/**
 * Safely executes a single rotation step with concurrency locking and error handling.
 */
function runRotationStepSafely() {
    if (isExecutingRotation) return;
    isExecutingRotation = true;

    try {
        if (typeof executeRotationStep === 'function') {
            executeRotationStep();
        }
    } catch (e) {
        console.error('Error during rotation execution:', e);
    } finally {
        isExecutingRotation = false;
    }
}

/**
 * Initializes drop rotation interval safely with concurrency locks.
 */
function startCombinedRotation(forceRestart = true) {
    if (!state || typeof state !== 'object') return;

    if (state.rotationTimer && !forceRestart) return;

    if (state.rotationTimer) {
        clearInterval(state.rotationTimer);
        state.rotationTimer = null;
    }

    state.rotationTimer = setInterval(runRotationStepSafely, 4000);

    // Immediate execution if items exist in the DOM
    if (document.querySelector('.wanted-drop-item') !== null) {
        setTimeout(runRotationStepSafely, 0);
    }
}
