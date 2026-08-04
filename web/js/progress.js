////////////////////////////////////////////////////////////////////////////
// ==================== Active Drop & Campaign Rotation ====================
////////////////////////////////////////////////////////////////////////////

// --- 0. Throttled Logger Helper (prevents console spam) ---
const progressLogThrottleMap = new Map();
function logProgressOnce(key, message, isWarn = false) {
    const now = Date.now();
    const lastLog = progressLogThrottleMap.get(key) || 0;
    if (now - lastLog > 3000) {
        if (isWarn) {
            console.warn(`[THROTTLED] ${message}`);
        } else {
            console.log(`[THROTTLED] ${message}`);
        }
        progressLogThrottleMap.set(key, now);
    }
}

// --- 1. State Initialization ---
if (typeof state === 'undefined') {
    window.state = {};
}

if (!state.activeCampaignsQueue) state.activeCampaignsQueue = [];
if (state.campaignRotationIndex === undefined) state.campaignRotationIndex = 0;
if (!state.activeDropsQueue) state.activeDropsQueue = [];
if (state.dropRotationIndex === undefined) state.dropRotationIndex = 0;
if (!state.rotationTimer) state.rotationTimer = null;
if (!state.campaigns) state.campaigns = {};
if (!state._lastSyncedMinutes) state._lastSyncedMinutes = {};

let dropTotalSeconds = 0;

// ==========================================
// 2. DATA UTILITIES & HELPERS
// ==========================================

/**
 * Universal helper to check if a drop or campaign is claimed
 */
function isClaimed(item) {
    if (!item) return true;
    return item.is_claimed === true || 
           item.claimed === true || 
           item.isClaimed === true || 
           item.status === 'CLAIMED';
}

/**
 * Helper to retrieve campaign and its drops list accurately
 */
function getCampaignAndDrops(queueItem) {
    if (!queueItem) return { campaign: null, drops: [] };

    const normalizeDrops = (dropsData, parentCampId) => {
        if (!dropsData) return [];
        const dropsArr = Array.isArray(dropsData) ? dropsData : Object.values(dropsData);
        
        return dropsArr.map(drop => {
            if (!drop || typeof drop !== 'object') return drop;
            const effectiveCampId = drop.campaign_id || drop.campaignId || parentCampId || '';
            return effectiveCampId ? { ...drop, campaign_id: effectiveCampId, campaignId: effectiveCampId } : drop;
        });
    };

    const itemCampId = queueItem.campaign_id || queueItem.campaignId || queueItem.id || '';

    if (queueItem.drops) {
        return { 
            campaign: queueItem, 
            drops: normalizeDrops(queueItem.drops, itemCampId) 
        };
    }

    if (state && state.campaigns && itemCampId) {
        let found = null;
        const campaigns = state.campaigns;

        if (!Array.isArray(campaigns) && campaigns[itemCampId]) {
            found = campaigns[itemCampId];
        } else {
            if (Array.isArray(campaigns)) {
                for (let i = 0; i < campaigns.length; i++) {
                    const c = campaigns[i];
                    if (c && (c.id === itemCampId || c.campaign_id === itemCampId || c.campaignId === itemCampId)) {
                        found = c;
                        break;
                    }
                }
            } else {
                for (const key in campaigns) {
                    if (Object.prototype.hasOwnProperty.call(campaigns, key)) {
                        const c = campaigns[key];
                        if (c && (c.id === itemCampId || c.campaign_id === itemCampId || c.campaignId === itemCampId)) {
                            found = c;
                            break;
                        }
                    }
                }
            }
        }

        if (found && found.drops) {
            const resolvedCampId = found.id || found.campaign_id || found.campaignId || itemCampId;
            return { 
                campaign: found, 
                drops: normalizeDrops(found.drops, resolvedCampId) 
            };
        }
    }

    const normalizedFallback = itemCampId ? { ...queueItem, campaign_id: itemCampId, campaignId: itemCampId } : queueItem;
    return { campaign: queueItem, drops: [normalizedFallback] };
}

/**
 * Extracts drops array from campaign object or helper response
 */
function extractCampaignDrops(campaign) {
    let drops = [];
    const res = getCampaignAndDrops(campaign);
    
    if (res) {
        if (Array.isArray(res.drops)) drops = res.drops;
        else if (res.drops && typeof res.drops === 'object') drops = Object.values(res.drops);
        else if (Array.isArray(res)) drops = res;
    }

    if (drops.length === 0 && campaign.drops) {
        drops = Array.isArray(campaign.drops) ? campaign.drops : Object.values(campaign.drops);
    }
    return drops;
}

/**
 * Formats seconds into readable time
 */
function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return '0:00';

    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const remSecs = secs % 60;

    if (days > 0) {
        return `${days}d ${hours}h ${mins}m`;
    } else if (hours > 0) {
        return `${hours}h ${mins.toString().padStart(2, '0')}m`;
    } else {
        return `${mins}:${remSecs.toString().padStart(2, '0')}`;
    }
}

/**
 * Helper to extract image URL from any drop or reward object structure (supports snake_case and camelCase)
 */
function extractUrlFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;

    let url = obj.image_url || obj.imageUrl || 
              obj.reward_image_url || obj.rewardImageUrl || 
              obj.icon_url || obj.iconUrl || 
              obj.benefit_icon_url || obj.benefitIconUrl || 
              obj.asset_url || obj.assetUrl || 
              obj.box_art_url || obj.boxArtURL || obj.boxArtUrl ||
              obj.image || obj.thumbnail || obj.url;
    if (url) return url;

    if (obj.reward) {
        url = obj.reward.image_url || obj.reward.imageUrl || 
              obj.reward.icon_url || obj.reward.iconUrl || 
              obj.reward.asset_url || obj.reward.assetUrl;
        if (url) return url;
    }

    if (obj.benefit) {
        url = obj.benefit.image_url || obj.benefit.imageUrl || 
              obj.benefit.icon_url || obj.benefit.iconUrl || 
              obj.benefit.asset_url || obj.benefit.assetUrl;
        if (url) return url;
    }

    const benefits = obj.benefits;
    if (Array.isArray(benefits) && benefits.length > 0) {
        const b = benefits[0];
        if (b) {
            url = b.image_url || b.imageUrl || b.icon_url || b.iconUrl || b.thumbnail || b.url || b.asset_url || b.assetUrl;
            if (url) return url;
        }
    }

    const benefitEdges = obj.benefit_edges || obj.benefitEdges;
    if (Array.isArray(benefitEdges) && benefitEdges.length > 0) {
        const node = benefitEdges[0]?.node;
        if (node) {
            url = node.asset_url || node.assetUrl || node.image_url || node.imageUrl;
            if (url) return url;
        }
    }

    return null;
}

/**
 * Resolves drop reward/asset image URL accurately with campaign fallbacks
 */
function resolveDropRewardImageUrl(data, targetId = null) {
    if (!data) return null;

    let rewardImgUrl = extractUrlFromObject(data);
    if (rewardImgUrl) return rewardImgUrl;

    const campId = data.campaign_id || data.campaignId;
    if (state && state.campaigns && campId) {
        let camp = null;
        const campaigns = state.campaigns;

        if (!Array.isArray(campaigns) && campaigns[campId]) {
            camp = campaigns[campId];
        } else if (Array.isArray(campaigns)) {
            camp = campaigns.find(c => c && (c.id === campId || c.campaign_id === campId || c.campaignId === campId));
        } else {
            for (const key in campaigns) {
                if (Object.prototype.hasOwnProperty.call(campaigns, key)) {
                    const c = campaigns[key];
                    if (c && (c.id === campId || c.campaign_id === campId || c.campaignId === campId)) {
                        camp = c;
                        break;
                    }
                }
            }
        }

        if (camp && camp.drops && Array.isArray(camp.drops) && targetId) {
            const drops = camp.drops;
            for (let i = 0; i < drops.length; i++) {
                const d = drops[i];
                if (d && (d.id === targetId || d.drop_id === targetId || d.dropId === targetId)) {
                    rewardImgUrl = extractUrlFromObject(d);
                    if (rewardImgUrl) break;
                }
            }
        }

        // Fallback to campaign box art / image if drop image is missing
        if (!rewardImgUrl && camp) {
            rewardImgUrl = extractUrlFromObject(camp);
        }
    }

    return rewardImgUrl;
}

const _preloadedUrls = new Set();

/**
 * Preloads queue images efficiently without redundant network requests
 */
function preloadQueueImages(queue) {
    if (!Array.isArray(queue) || queue.length === 0) return;

    const cache = (typeof imageCache !== 'undefined') ? imageCache : null;
    const len = queue.length;

    for (let i = 0; i < len; i++) {
        const dropItem = queue[i];
        if (!dropItem) continue;

        const url = dropItem.image_url || dropItem.imageUrl;
        if (!url || _preloadedUrls.has(url)) continue;

        _preloadedUrls.add(url);

        if (cache) {
            if (!cache.has(url)) {
                const imgEl = document.createElement('img');
                imgEl.src = url;
                cache.set(url, imgEl);
            }
        } else {
            const img = new Image();
            img.src = url;
        }
    }
}

// ==========================================
// 3. LOGIC SEPARATION HELPERS
// ==========================================

/**
 * Unified entry point for updating drop progress in active queue and wanted tree simultaneously.
 */
function syncAnyDropProgress(incomingIdStr, data) {
    if (!state || !data || typeof data !== 'object') return;

    const targetIdStr = String(incomingIdStr);
    const currMins = data.current_minutes !== undefined ? data.current_minutes : data.currentMinutes;
    const reqMins = data.required_minutes !== undefined ? data.required_minutes : data.requiredMinutes;
    const remSecs = data.remaining_seconds !== undefined ? data.remaining_seconds : data.remainingSeconds;

    if (currMins === undefined && remSecs === undefined) return;

    let targetCampaignId = data.campaign_id || data.campaignId;

    if (!targetCampaignId && Array.isArray(state.activeDropsQueue)) {
        const found = state.activeDropsQueue.find(d => String(d.drop_id || d.id) === targetIdStr);
        if (found) targetCampaignId = found.campaign_id || found.campaignId;
    }

    if (Array.isArray(state.activeDropsQueue)) {
        state.activeDropsQueue.forEach(activeQueueDrop => {
            const dropId = String(activeQueueDrop.drop_id || activeQueueDrop.id);
            const dropCampaignId = activeQueueDrop.campaign_id || activeQueueDrop.campaignId;

            const isSameDrop = dropId === targetIdStr;
            const isSameCampaign = targetCampaignId && dropCampaignId && String(targetCampaignId) === String(dropCampaignId);

            if (isSameDrop || isSameCampaign) {
                if (currMins !== undefined) activeQueueDrop.current_minutes = currMins;

                if (isSameDrop && reqMins !== undefined) {
                    activeQueueDrop.required_minutes = reqMins;
                }

                const dropReq = Number(activeQueueDrop.required_minutes || activeQueueDrop.requiredMinutes || 0);
                const dropCur = Number(activeQueueDrop.current_minutes || 0);

                if (dropReq > 0) {
                    const calculatedRemSecs = Math.max(0, (dropReq - dropCur) * 60);
                    activeQueueDrop.remaining_seconds = isSameDrop && remSecs !== undefined ? remSecs : calculatedRemSecs;
                    activeQueueDrop.progress = Math.min(100, (dropCur / dropReq) * 100);
                    activeQueueDrop.can_claim = dropCur >= dropReq && !activeQueueDrop.is_claimed;
                }

                if (isSameDrop && data.is_claimed !== undefined) {
                    activeQueueDrop.is_claimed = data.is_claimed;
                }

                if (!state.liveDropsCache) state.liveDropsCache = {};
                state.liveDropsCache[dropId] = {
                    ...(state.liveDropsCache[dropId] || {}),
                    current_minutes: activeQueueDrop.current_minutes,
                    required_minutes: activeQueueDrop.required_minutes,
                    remaining_seconds: activeQueueDrop.remaining_seconds,
                    progress: activeQueueDrop.progress,
                    can_claim: activeQueueDrop.can_claim
                };

                if (typeof renderAllProgressBars === 'function') {
                    renderAllProgressBars(dropCur, activeQueueDrop);
                }
            }
        });
    }

    if (Array.isArray(state.wantedItemsTree)) {
        if (typeof syncWantedItemsProgress === 'function') {
            syncWantedItemsProgress({
                drop_id: targetIdStr,
                campaign_id: targetCampaignId,
                ...data,
                current_minutes: currMins,
                remaining_seconds: remSecs
            });
        } else {
            console.warn("[SYNC_WANTED] syncWantedItemsProgress function is not defined yet, skipping update.");
        }
    }
}

/**
 * Calculates total requirements for the overall progress bar from full inventory (state.campaigns)
 */
function calculateOverallStats() {
    const stats = { totalCurrent: 0, totalRequired: 0, totalRemainingSecs: 0 };
    
    if (!state || !state.campaigns) return stats;

    const gamesMap = new Map();
    const campaigns = state.campaigns;

    const registerCampaign = (campaign) => {
        if (!campaign) return;
        if (campaign.is_unlinked || campaign.status === 'unlinked' || campaign.linked === false) {
            return;
        }

        const gameKey = campaign.game_name || campaign.gameName || 'Unknown Game';
        let group = gamesMap.get(gameKey);
        if (!group) {
            group = [];
            gamesMap.set(gameKey, group);
        }
        group.push(campaign);
    };

    if (Array.isArray(campaigns)) {
        for (let i = 0; i < campaigns.length; i++) {
            registerCampaign(campaigns[i]);
        }
    } else {
        for (const key in campaigns) {
            if (Object.prototype.hasOwnProperty.call(campaigns, key)) {
                registerCampaign(campaigns[key]);
            }
        }
    }

    if (gamesMap.size === 0) return stats;

    for (const campaignList of gamesMap.values()) {
        let maxReq = 0;
        let maxCur = 0;
        let maxRemSecs = 0;

        for (let i = 0; i < campaignList.length; i++) {
            const campaign = campaignList[i];
            const drops = campaign.drops;
            if (!drops || !Array.isArray(drops)) continue;

            let campReq = 0;
            let campCur = 0;
            let campRemSecs = 0;

            for (let j = 0; j < drops.length; j++) {
                const drop = drops[j];
                if (!drop || drop.is_unlinked || drop.status === 'unlinked') continue;

                const req = Number(drop.required_minutes || drop.requiredMinutes || drop.duration) || 0;
                let cur = Number(drop.current_minutes || drop.currentMinutes) || 0;
                const isClaimed = Boolean(drop.is_claimed || drop.claimed || drop.isClaimed);

                if (isClaimed || cur > req) {
                    cur = req;
                }

                campReq += req;
                campCur += cur;
                campRemSecs += isClaimed ? 0 : Math.max(0, req - cur) * 60;
            }

            if (campReq > maxReq) {
                maxReq = campReq;
                maxCur = campCur;
                maxRemSecs = campRemSecs;
            }
        }

        stats.totalRequired += maxReq;
        stats.totalCurrent += maxCur;
        stats.totalRemainingSecs += maxRemSecs;
    }

    return stats;
}

/**
 * Removes claimed campaigns from the active rotation queue
 */
function cleanupClaimedCampaigns() {
    if (!state.activeCampaignsQueue || !Array.isArray(state.activeCampaignsQueue)) return;
    
    const initialLen = state.activeCampaignsQueue.length;
    state.activeCampaignsQueue = state.activeCampaignsQueue.filter(c => {
        if (isClaimed(c)) return false;
        let cDrops = extractCampaignDrops(c);
        if (cDrops.length === 0) return true;
        return cDrops.some(d => !isClaimed(d));
    });

    if (state.activeCampaignsQueue.length < initialLen) {
        logProgressOnce('camp_cleanup', `🧹 [CAMPAIGN] Cleaned up ${initialLen - state.activeCampaignsQueue.length} claimed/finished campaign(s) from queue.`);
    }
}

/**
 * Maps and sanitizes drop objects for queue processing
 */
function mapDropsForQueue(drops, parentData) {
    return drops.map(d => {
        const dropImg = extractUrlFromObject(d) || extractUrlFromObject(parentData);

        const curMins = d.current_minutes !== undefined ? d.current_minutes : (parentData.current_minutes || 0);
        const reqMins = d.required_minutes || parentData.required_minutes || 1;
        const dropName = d.name || d.drop_name || d.title || d.dropName || 'Drop';

        return {
            ...parentData,
            drop_id: d.id || d.drop_id,
            drop_name: dropName,
            name: dropName,
            image_url: dropImg,
            imageUrl: dropImg,
            current_minutes: curMins,
            required_minutes: reqMins,
            remaining_seconds: d.remaining_seconds !== undefined ? d.remaining_seconds : Math.max(0, (reqMins - curMins) * 60)
        };
    });
}

// ==========================================
// 4. INVENTORY & DOM MANAGEMENT
// ==========================================

function addCampaign(campaignData) {
    if (!campaignData || !campaignData.id) return;
    state.campaigns[campaignData.id] = campaignData;
    logProgressOnce(`camp_added_${campaignData.id}`, `➕ [CAMPAIGN] Added or updated campaign: '${campaignData.name || campaignData.id}'`);
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

    if (activeWantedElements.length > 0) {
        activeWantedElements.forEach(el => {
            el.classList.remove('active-mining', 'in-progress', 'active', 'is-active', 'mining');
        });
    }
}

/**
 * Clears the current drop progress UI and resets related state.
 */
function clearDropProgress() {
    logProgressOnce('ui_clear_executed', '🧹 [UI CLEAR] Executing clearDropProgress() - resetting RAM state and UI');

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

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    
    if (noDropMessage) noDropMessage.style.display = 'block';
    if (dropInfo) dropInfo.style.display = 'none';

    const dropGameEl = document.getElementById('drop-game');
    if (dropGameEl) {
        dropGameEl.innerHTML = '';
        dropGameEl.style.display = 'none';
    }

    const leftImg = document.getElementById('drop-card-left-img');
    if (leftImg) {
        leftImg.remove();
    }

    const currentDropLabel = document.getElementById('current-drop-label');
    if (currentDropLabel) {
        currentDropLabel.textContent = '';
    }

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = '0%';
        fill.textContent = '0%';
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) progressText.textContent = '0 / 0 min';

    const timeEl = document.getElementById('progress-time');
    if (timeEl) timeEl.textContent = 'Time remaining: 0:00';

    if (typeof clearWantedActiveState === 'function') {
        clearWantedActiveState();
    }

    if (typeof renderWantedItems === 'function' && Array.isArray(state.wantedItemsTree)) {
        renderWantedItems(state.wantedItemsTree);
    }
}

function updateRemainingTime(initialSeconds, currentData = null) {
    const drop = currentData || state.currentDrop || state.current_drop || {};
    if (!drop) return;

    const remaining = Math.max(0, Math.floor(initialSeconds));
    const reqSecs = Number(drop.required_minutes || drop.requiredMinutes || 0) * 60;

    const timeEl = document.getElementById('progress-time');
    if (timeEl && typeof formatTime === 'function') {
        timeEl.textContent = `Time remaining: ${formatTime(remaining)} / ${formatTime(reqSecs)}`;
    }

    const elapsedSeconds = reqSecs > 0 ? Math.max(0, reqSecs - remaining) : 0;
    const currentMinutes = Math.floor(elapsedSeconds / 60);

    drop.remaining_seconds = remaining;
    drop.current_minutes = currentMinutes;

    if (state.currentDrop) {
        state.currentDrop.remaining_seconds = remaining;
        state.currentDrop.current_minutes = currentMinutes;
    }
    if (state.current_drop) {
        state.current_drop.remaining_seconds = remaining;
        state.current_drop.current_minutes = currentMinutes;
    }

    if (typeof syncWantedItemsProgress === 'function') {
        const dropId = drop.id || drop.drop_id;
        if (!state._lastSyncedMinutes) state._lastSyncedMinutes = {};
        
        if (dropId && state._lastSyncedMinutes[dropId] !== currentMinutes) {
            state._lastSyncedMinutes[dropId] = currentMinutes;
            syncWantedItemsProgress(drop);
        }
    }
}

function updateDropTitle(data) {
    const dropNameEl = document.getElementById('drop-name');
    if (!dropNameEl) return;

    const displayGameName = data.game_name || data.gameName || 'Drop';

    const validCampaigns = (state.activeCampaignsQueue || []).filter(c => {
        if (!c || isClaimed(c)) return false;
        
        const cGameName = c.game_name || c.gameName || 'Drop';
        if (cGameName !== displayGameName) return false;
        
        const drops = extractCampaignDrops(c);
        return !drops || drops.length === 0 || drops.some(d => !isClaimed(d));
    });

    const queueLength = validCampaigns.length > 0 ? validCampaigns.length : 1;
    
    let displayIndex = 1;
    if (data.campaign_id) {
        const foundIndex = validCampaigns.findIndex(c => (c.id === data.campaign_id || c.campaign_id === data.campaign_id));
        if (foundIndex !== -1) {
            displayIndex = foundIndex + 1;
        }
    }

    dropNameEl.textContent = `${displayGameName} (${displayIndex}/${queueLength})`;
}

const _fallbackImageCache = (typeof imageCache !== 'undefined') ? imageCache : new Map();

function resetDropHeader(dropGameEl, reason = 'invalid or missing data') {
    if (lastDropHeaderHash !== 'empty') {
        console.log(`[DropHeader Debug] Resetting header due to: ${reason}`);
        dropGameEl.innerHTML = '';
        dropGameEl.style.display = 'none';
        lastDropHeaderHash = 'empty';
    }
}

function resolveCampaignData(data) {
    const rawCampaignId = data.campaign_id || data.campaignId || '';
    let foundCampaign = (state?.campaigns && rawCampaignId) ? state.campaigns[rawCampaignId] : null;

    if (!foundCampaign && state?.campaigns) {
        const gId = (data.game_id || data.gameId) ? String(data.game_id || data.gameId) : null;
        const gName = (data.game_name || data.gameName || data.game || '').trim().toLowerCase();
        
        const campList = Array.isArray(state.campaigns) ? state.campaigns : Object.values(state.campaigns);
        foundCampaign = campList.find(c => {
            if (!c) return false;
            const cGameId = c.game_id || c.gameId || c.game?.id;
            const cGameName = c.game_name || c.gameName || (typeof c.game === 'string' ? c.game : c.game?.name);
            return (gId && cGameId && String(cGameId) === gId) ||
                   (gName && cGameName && String(cGameName).trim().toLowerCase() === gName);
        });
    }

    const effectiveCampaignId = rawCampaignId || foundCampaign?.id || foundCampaign?.campaign_id || '';
    const titleText = data.campaign_name || data.campaignName || data.game_name || data.gameName || data.game || 
                      foundCampaign?.campaign_name || foundCampaign?.campaignName || foundCampaign?.game_name || foundCampaign?.gameName || '';
    const subTextContent = data.drop_name || data.dropName || data.name || data.title || '';

    return { foundCampaign, effectiveCampaignId, titleText, subTextContent };
}

function extractIconUrl(data, foundCampaign) {
    const extractBoxArt = (obj) => {
        if (!obj) return null;
        const g = (typeof obj.game === 'object' && obj.game !== null) ? obj.game : {};
        return obj.game_box_art_url || obj.gameBoxArtURL || obj.gameBoxArtUrl ||
               obj.game_icon || obj.gameIcon || obj.box_art_url || obj.boxArtURL || obj.boxArtUrl ||
               obj.icon_url || obj.iconURL || obj.iconUrl || obj.image_url || obj.imageUrl ||
               g.box_art_url || g.boxArtURL || g.boxArtUrl || g.icon_url || g.iconURL || g.image_url;
    };

    const rawBoxArt = extractBoxArt(data) || extractBoxArt(foundCampaign) || '';
    return rawBoxArt ? rawBoxArt.replace('{width}', '52').replace('{height}', '70') : null;
}

function ensureHeaderContainers(dropGameEl) {
    dropGameEl.style.display = 'flex';
    dropGameEl.style.alignItems = 'center';
    dropGameEl.style.gap = '12px';
    dropGameEl.style.margin = '8px 0';

    if (!cachedIconContainer) {
        console.log('[DropHeader Debug] Creating cachedIconContainer for the first time.');
        cachedIconContainer = document.createElement('div');
        cachedIconContainer.className = 'game-icon-container';
        cachedIconContainer.style.width = '42px';
        cachedIconContainer.style.height = '56px';
        cachedIconContainer.style.minWidth = '42px';
        cachedIconContainer.style.minHeight = '56px';
        cachedIconContainer.style.flexShrink = '0';
        cachedIconContainer.style.borderRadius = '6px';
        cachedIconContainer.style.overflow = 'hidden';
        cachedIconContainer.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
        cachedIconContainer.style.border = '1px dashed rgba(255, 255, 255, 0.15)';
    }

    if (!cachedInfoTextDiv) {
        console.log('[DropHeader Debug] Creating cachedInfoTextDiv for the first time.');
        cachedInfoTextDiv = document.createElement('div');
        cachedInfoTextDiv.className = 'drop-game-text-info';
        cachedInfoTextDiv.style.display = 'flex';
        cachedInfoTextDiv.style.flexDirection = 'column';
        cachedInfoTextDiv.style.justifyContent = 'center';
    }

    if (!dropGameEl.contains(cachedIconContainer) || !dropGameEl.contains(cachedInfoTextDiv)) {
        dropGameEl.replaceChildren(cachedIconContainer, cachedInfoTextDiv);
    }
}

/**
 * Updates campaign header icon with placeholder support
 */
function updateHeaderIcon(iconUrl) {
    let imgEl = cachedIconContainer.querySelector('img');
    let placeholderEl = cachedIconContainer.querySelector('.campaign-icon-placeholder');

    if (iconUrl) {
        if (!imgEl) {
            imgEl = document.createElement('img');
            imgEl.className = 'game-icon';
            imgEl.style.width = '100%';
            imgEl.style.height = '100%';
            imgEl.style.objectFit = 'cover';
            imgEl.style.display = 'block';
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
            placeholderEl.style.width = '100%';
            placeholderEl.style.height = '100%';
            placeholderEl.style.display = 'flex';
            placeholderEl.style.alignItems = 'center';
            placeholderEl.style.justifyContent = 'center';
            placeholderEl.style.fontSize = '18px';
            placeholderEl.style.color = 'rgba(255, 255, 255, 0.4)';
            placeholderEl.innerHTML = '🎮';
            cachedIconContainer.appendChild(placeholderEl);
        }
        placeholderEl.style.display = 'flex';
    }
}

function updateHeaderTitle(effectiveCampaignId, titleText) {
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
        titleNode.style.pointerEvents = 'auto';
        titleNode.style.textDecoration = 'underline';
    } else {
        titleNode.removeAttribute('href');
        titleNode.style.pointerEvents = 'none';
        titleNode.style.textDecoration = 'none';
    }

    if (titleNode.textContent !== titleText) {
        titleNode.textContent = titleText;
    }
}

function updateHeaderSubtitle(subTextContent) {
    let subText = cachedInfoTextDiv.querySelector('.drop-sub-name');
    if (!subText) {
        subText = document.createElement('span');
        subText.className = 'drop-sub-name';
        subText.style.fontSize = '0.9em';
        subText.style.opacity = '0.85';
        cachedInfoTextDiv.appendChild(subText);
    }
    if (subText.textContent !== subTextContent) {
        subText.textContent = subTextContent;
    }
}

let lastDropHeaderHash = null;
let cachedIconContainer = null;
let cachedInfoTextDiv = null;

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

function resetDropCardLayout(currentDropLabel, reason = 'invalid data') {
    if (lastDropCardLayoutHash !== 'empty') {
        currentDropLabel.textContent = '';
        lastDropCardLayoutHash = 'empty';
    }
}

/**
 * Calculates current drop index and queue length for the active campaign display.
 */
function calculateDropQueueInfo(data, currentId) {
    let activeDrops = [];
    const { drops } = typeof getCampaignAndDrops === 'function' 
        ? getCampaignAndDrops(data) 
        : { drops: [] };
    
    if (Array.isArray(drops) && drops.length > 0) {
        activeDrops = drops.filter(d => typeof isClaimed === 'function' ? !isClaimed(d) : true);
    }

    if (activeDrops.length === 0 && Array.isArray(state?.activeDropsQueue) && state.activeDropsQueue.length > 0) {
        activeDrops = state.activeDropsQueue;
    }

    const getDropMinutes = (d) => Number(d.required_minutes || d.total_minutes || d.requiredMinutes || 0);
    const sortedDrops = activeDrops.slice().sort((a, b) => getDropMinutes(a) - getDropMinutes(b));

    const dropQueueLen = sortedDrops.length > 0 ? sortedDrops.length : 1;
    let dropIdx = 1;

    if (sortedDrops.length > 0 && currentId !== undefined && currentId !== null) {
        const targetIdStr = String(currentId);
        const foundIdx = sortedDrops.findIndex(d => String(d.drop_id || d.id || '') === targetIdStr);
        if (foundIdx !== -1) {
            dropIdx = foundIdx + 1;
        }
    }

    return { dropIdx, dropQueueLen };
}

function ensureDropCardOuterContainer(currentDropLabel) {
    let cardOuter = currentDropLabel.closest('.drop-card-container');

    if (!cardOuter) {
        const progressTime = document.getElementById('progress-time');
        const progressFill = document.getElementById('progress-fill');
        const targetElement = progressTime || progressFill;

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

function ensureDropCardRightCol(cardOuter) {
    let rightCol = cardOuter.querySelector('#drop-card-right-col');
    if (!rightCol) {
        rightCol = document.createElement('div');
        rightCol.id = 'drop-card-right-col';
        rightCol.style.flex = '1';
        rightCol.style.display = 'flex';
        rightCol.style.flexDirection = 'column';
        rightCol.style.justifyContent = 'space-between';
        rightCol.style.gap = '6px';
        rightCol.style.minWidth = '0';

        rightCol.append(...cardOuter.childNodes);

        cardOuter.style.display = 'flex';
        cardOuter.style.flexDirection = 'row';
        cardOuter.style.alignItems = 'stretch';
        cardOuter.style.gap = '12px';
        cardOuter.appendChild(rightCol);
    }
    return rightCol;
}

/**
 * Resolves left drop card image element with placeholder fallback
 */
function resolveDropCardLeftImage(rawImgUrl, dropName) {
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
            const placeholder = document.createElement('div');
            placeholder.id = 'drop-card-left-img';
            placeholder.className = 'image-placeholder drop-reward-placeholder';
            placeholder.style.width = '72px';
            placeholder.style.height = '72px';
            placeholder.style.borderRadius = '6px';
            placeholder.style.display = 'flex';
            placeholder.style.alignItems = 'center';
            placeholder.style.justifyContent = 'center';
            placeholder.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
            placeholder.style.border = '1px dashed rgba(255, 255, 255, 0.2)';
            placeholder.style.fontSize = '24px';
            placeholder.innerHTML = '🎁';
            if (this.parentNode) {
                this.parentNode.replaceChild(placeholder, this);
            }
        };

        targetLeftEl = imgEl;
    }

    if (!targetLeftEl) {
        targetLeftEl = document.createElement('div');
        targetLeftEl.className = 'image-placeholder drop-reward-placeholder';
        targetLeftEl.style.width = '72px';
        targetLeftEl.style.height = '72px';
        targetLeftEl.style.borderRadius = '6px';
        targetLeftEl.style.display = 'flex';
        targetLeftEl.style.alignItems = 'center';
        targetLeftEl.style.justifyContent = 'center';
        targetLeftEl.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
        targetLeftEl.style.border = '1px dashed rgba(255, 255, 255, 0.2)';
        targetLeftEl.style.fontSize = '24px';
        targetLeftEl.innerHTML = '🎁';
    }

    targetLeftEl.id = 'drop-card-left-img';
    return targetLeftEl;
}

function updateDropCardLeftImage(cardOuter, targetLeftEl, rightCol) {
    const existingLeftImg = cardOuter.querySelector('#drop-card-left-img');
    if (existingLeftImg !== targetLeftEl) {
        if (existingLeftImg) {
            existingLeftImg.replaceWith(targetLeftEl);
        } else {
            cardOuter.insertBefore(targetLeftEl, rightCol);
        }
    }
}

let lastDropCardLayoutHash = null;

function renderDropCardLayout(data, rewardImgUrl, force = false) {
    const currentDropLabel = document.getElementById('current-drop-label');
    if (!currentDropLabel) return;

    if (!data || typeof data !== 'object') {
        resetDropCardLayout(currentDropLabel, 'invalid data object');
        return;
    }

    const currentId = data.drop_id || data.id || '';
    const dropName = data.drop_name || data.dropName || data.name || data.title || 'Drop';
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

function renderAllProgressBars(currentMins, dropData) {
    if (!dropData) return;

    const current = Number(currentMins) || 0;
    const reqMins = Number(dropData.required_minutes || dropData.total_minutes) || 1;
    
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
    const gameName = typeof target === 'string' ? target : (target?.name || target?.game_name || 'Unknown Game');
    
    const groupEl = document.querySelector(`[data-game-name="${CSS.escape(gameName)}"]`)
                 || document.querySelector(`[data-game-id="${CSS.escape(gameName)}"]`);

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
    let groupEl = null;

    if (typeof groupTarget === 'string') {
        const targetStr = groupTarget.trim();
        groupEl = document.querySelector(`[data-game-group-id="${CSS.escape(targetStr)}"]`) 
               || document.querySelector(`[data-game-name="${CSS.escape(targetStr)}"]`);
    } else if (typeof groupTarget === 'number') {
        const groups = document.querySelectorAll('.wanted-game-group');
        groupEl = groups[groupTarget];
    }

    if (!groupEl) return;

    const badge = groupEl.querySelector('.wanted-game-time-badge');
    if (!badge) return;

    let formattedText = 'Done';
    const totalMins = Number(remainingMinutes || 0);

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
    if (!data) return;
    const targetId = data.drop_id || data.id;

    const activeDrop = state.currentDrop || state.current_drop;
    const activeId = activeDrop ? (activeDrop.drop_id || activeDrop.id) : null;
    const isCurrentDrop = activeId && String(activeId) === String(targetId);

    if (!isFromRotation && activeId && !isCurrentDrop) {
        return;
    }

    if (activeDrop && isCurrentDrop) {
        data = { ...activeDrop, ...data };
    } else if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
        const queueItem = state.activeDropsQueue.find(d => (d.drop_id || d.id) === targetId);
        if (queueItem) data = { ...queueItem, ...data };
    }

    if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
        const freshQueueItem = state.activeDropsQueue.find(d => (d.drop_id || d.id) === targetId);
        if (freshQueueItem && freshQueueItem.current_minutes !== undefined) {
            data.current_minutes = freshQueueItem.current_minutes;
            data.currentMinutes = freshQueueItem.current_minutes;
        }
    }

    if (activeDrop && activeDrop.current_minutes !== undefined && !data.is_claimed) {
        const isSameContext = (data.campaign_id && activeDrop.campaign_id && String(data.campaign_id) === String(activeDrop.campaign_id)) ||
                              (data.game_name && activeDrop.game_name && data.game_name === activeDrop.game_name);
        
        if (isSameContext) {
            const liveMins = Math.max(Number(data.current_minutes || 0), Number(activeDrop.current_minutes));
            data.current_minutes = liveMins;
            data.currentMinutes = liveMins;
        }
    }

    const reqMins = Number(data.required_minutes ?? data.requiredMinutes ?? 0);
    const curMins = Number(data.current_minutes ?? data.currentMinutes ?? 0);

    if (isClaimed(data) || (reqMins > 0 && curMins >= reqMins)) {
        logProgressOnce(`drop_finished_${targetId}`, `🎉 [DROP COMPLETE] Drop '${data.drop_name || targetId}' is claimed or finished. Removing from queue.`);
        if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
            const dropIdToClean = data.drop_id || data.id;
            state.activeDropsQueue = state.activeDropsQueue.filter(d => (d.drop_id || d.id) !== dropIdToClean);
        }
        startCombinedRotation(true);
        return;
    }

    let remSecs;
    if (data.remaining_seconds !== undefined && data.remaining_seconds !== null && !isFromRotation) {
        remSecs = Number(data.remaining_seconds);
    } else if (isCurrentDrop && activeDrop?.remaining_seconds !== undefined && activeDrop?.remaining_seconds !== null && !isFromRotation) {
        remSecs = activeDrop.remaining_seconds;
    } else {
        remSecs = Math.max(0, (reqMins - curMins) * 60);
    }

    data.remaining_seconds = remSecs;

    if (typeof debugTime === 'function') {
        debugTime('2. DISPLAY_UPDATE', data);
    }
    
    state.currentDrop = data;
    state.current_drop = data;

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'none';
    if (dropInfo) dropInfo.style.display = 'block';

    const rewardImgUrl = resolveDropRewardImageUrl(data, targetId);

    updateDropTitle(data);
    renderDropGameHeader(data);
    renderDropCardLayout(data, rewardImgUrl);

    renderAllProgressBars(curMins, data);
    updateRemainingTime(remSecs, data);
}

function switchCampaignDisplay(data, isManualSwitch = false, shouldUpdateDisplay = true) {
    if (data) {
        const now = Date.now();
        
        if (data.ends_at) {
            const endTime = new Date(data.ends_at).getTime();
            if (endTime <= now) {
                logProgressOnce(`camp_expired_${data.id}`, `⏳ [CAMPAIGN EXPIRED] Campaign '${data.name || data.id}' has ended. Clearing UI.`, true);
                clearDropProgress();
                return;
            }
        }

        if (data.current_minutes !== undefined && data.required_minutes !== undefined) {
            if (data.current_minutes >= data.required_minutes && data.required_minutes > 0) {
                logProgressOnce(`camp_done_${data.id}`, `✅ [CAMPAIGN DONE] Campaign '${data.name || data.id}' is completed. Clearing UI.`);
                clearDropProgress();
                return;
            }
        }
    }

    cleanupClaimedCampaigns();

    if (!state.activeCampaignsQueue || state.activeCampaignsQueue.length === 0) {
        if (state._lastValidActiveCampaignsQueue && state._lastValidActiveCampaignsQueue.length > 0) {
            state.activeCampaignsQueue = state._lastValidActiveCampaignsQueue;
        }
    } else {
        state._lastValidActiveCampaignsQueue = state.activeCampaignsQueue;
    }

    const activeDrop = state.currentDrop || state.current_drop;
    const previousDropId = activeDrop ? (activeDrop.drop_id || activeDrop.id) : null;
    const { drops } = getCampaignAndDrops(data);

    if (drops.length > 0) {
        if (data.drop_id) {
            const targetDrop = drops.find(d => (d.id || d.drop_id) === data.drop_id);
            if (targetDrop) {
                if (data.current_minutes !== undefined) targetDrop.current_minutes = data.current_minutes;
                if (data.required_minutes !== undefined) targetDrop.required_minutes = data.required_minutes;
                if (data.remaining_seconds !== undefined) targetDrop.remaining_seconds = data.remaining_seconds;
                if (data.is_claimed !== undefined) targetDrop.is_claimed = data.is_claimed;
            }
        }

        const unclaimedDrops = drops.filter(d => !isClaimed(d));
        const targetDrops = unclaimedDrops.length > 0 ? unclaimedDrops : drops;
        state.activeDropsQueue = mapDropsForQueue(targetDrops, data);

        if (isManualSwitch) {
            logProgressOnce('manual_switch', `👆 [CAMPAIGN SWITCH] Manual switch triggered for '${data.name || data.id}'`);
            const idx = state.activeDropsQueue.findIndex(d => (d.drop_id || d.id) === data.drop_id);
            if (idx !== -1) state.dropRotationIndex = idx;
            
            setTimeout(() => {
                if (typeof startCombinedRotation === 'function') {
                    startCombinedRotation(true);
                }
            }, 0);
        }
    } else {
        state.activeDropsQueue = [data];
    }

    preloadQueueImages(state.activeDropsQueue);

    const initialActiveDrop = state.activeDropsQueue[state.dropRotationIndex] || state.activeDropsQueue[0] || data;
    const newDropId = initialActiveDrop ? (initialActiveDrop.drop_id || initialActiveDrop.id) : null;
    const dropChanged = !previousDropId || !newDropId || previousDropId !== newDropId;

    if (shouldUpdateDisplay) {
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
        logProgressOnce('warn_empty_data', '⚠️ [UI UPDATE] Empty dropData received. Clearing drop UI.', true);
        if (typeof clearDropProgress === 'function') clearDropProgress();
        return;
    }

    const validDrop = dropData;
    const dropGame = validDrop.game_name || validDrop.game || validDrop.game_title;

    logProgressOnce(`render_${dropGame}`, `✅ [UI UPDATE] Rendering drop progress for '${dropGame || 'Unknown Game'}'`);

    if (!state.liveMiningQueue) state.liveMiningQueue = [];
    const activeCampId = validDrop.campaign_id;
    
    if (activeCampId && state.campaigns && state.campaigns[activeCampId]) {
        if (!state.liveMiningQueue.includes(activeCampId)) {
            state.liveMiningQueue.push(activeCampId);
        }
    }

    if (state.campaigns) {
        state.liveMiningQueue = state.liveMiningQueue.filter(cid => {
            const camp = state.campaigns[cid];
            if (!camp || isClaimed(camp)) return false;
            const drops = extractCampaignDrops(camp);
            return drops.some(d => !isClaimed(d));
        });
        state.activeCampaignsQueue = state.liveMiningQueue.map(cid => state.campaigns[cid]).filter(Boolean);
    }

    const incomingIdStr = String(validDrop.drop_id || validDrop.id || '');
    const currentMins = Math.round(Number(validDrop.current_minutes ?? validDrop.currentMinutes ?? validDrop.progress ?? 0));
    const reqMins = Number(validDrop.required_minutes ?? validDrop.requiredMinutes ?? 0);
    const remSecs = validDrop.remaining_seconds !== undefined 
        ? Number(validDrop.remaining_seconds) 
        : Math.max(0, (reqMins - currentMins) * 60);

    validDrop.current_minutes = currentMins;
    validDrop.remaining_seconds = remSecs;

    state.currentDrop = { ...validDrop };
    state.current_drop = { ...validDrop };

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
        dropGameEl.textContent = dropGame || '';
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

function updateCampaignProgressData(data, liveCurrentMins) {
    const campaignFill = document.getElementById('campaign-progress-fill');
    const campaignText = document.getElementById('campaign-progress-text');
    const campaignTitle = document.getElementById('campaign-progress-title');

    if (!campaignFill || !campaignText || !data) return;

    const cardContainer = campaignFill.closest('.secondary-progress-card') || 
                          campaignFill.closest('.drop-card-container') || 
                          campaignFill.parentElement?.parentElement;

    const currentDropCurrent = liveCurrentMins !== undefined ? liveCurrentMins : (Number(data.current_minutes) || 0);
    const targetDropId = String(data.drop_id || data.id || '');

    let totalCampaignCurrent = currentDropCurrent;
    let totalCampaignRequired = 0;

    if (state.campaigns && data.campaign_id) {
        let campaign = state.campaigns[data.campaign_id];
        if (!campaign) {
            for (const key in state.campaigns) {
                const c = state.campaigns[key];
                if (c && (c.id === data.campaign_id || c.campaign_id === data.campaign_id)) {
                    campaign = c;
                    break;
                }
            }
        }

        if (campaign) {
            const drops = extractCampaignDrops(campaign);
            const campName = campaign.name || campaign.campaign_name || 'Campaign';
            const dropsCount = drops.length;

            let dropVisualIndex = 1;
            let maxCampaignRequired = 0;

            for (let i = 0; i < dropsCount; i++) {
                const d = drops[i];
                const dId = String(d.drop_id || d.id || '');

                if (dId === targetDropId) {
                    d.current_minutes = currentDropCurrent;
                    dropVisualIndex = i + 1;
                }

                const dReq = Number(d.required_minutes || d.requiredMinutes || d.duration || 0);
                if (dReq > maxCampaignRequired) {
                    maxCampaignRequired = dReq;
                }
            }

            totalCampaignRequired = maxCampaignRequired > 0 
                ? maxCampaignRequired 
                : (Number(campaign.total_minutes || campaign.required_minutes) || 0);

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
        totalCampaignRequired = Number(data.required_minutes || data.duration || data.total_minutes) || 0;
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
    } else {
        if (cardContainer && cardContainer.style.display !== 'none') {
            cardContainer.style.display = 'none';
        }
    }
}

function updateOverallProgress() {
    try {
        const overallFill = document.getElementById('overall-progress-fill');
        const overallText = document.getElementById('overall-progress-text');
        if (!overallFill || !overallText) return;

        const queueTree = state.wantedItemsTree || state._lastValidWantedTree || [];

        if (!queueTree || queueTree.length === 0) {
            overallFill.style.width = '0%';
            overallFill.textContent = '';
            overallText.textContent = '0% (0 / 0 min)';
            
            const overallTimeEl = document.getElementById('overall-progress-time');
            if (overallTimeEl) overallTimeEl.textContent = 'Total remaining time: 0m';
            return;
        }

        state._lastValidWantedTree = queueTree;
        const stats = calculateOverallStats();

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
            overallTimeEl.textContent = `Total remaining time: ${formatTime(stats.totalRemainingSecs)}`;
        }
    } catch (e) {
        console.error('Error updating overall progress:', e);
    }
}

/**
 * Helper to safely retrieve drop ID from any object
 */
function getDropId(drop) {
    if (!drop) return null;
    return drop.drop_id || drop.id || drop.dropId || null;
}

/**
 * Executes a single tick of rotation process
 */
function executeRotationStep() {
    let validCampaigns = state.activeCampaignsQueue || [];

    const activeDrop = state.currentDrop || state.current_drop;
    if (validCampaigns.length === 0 && activeDrop && activeDrop.campaign_id && state.campaigns) {
        const fallbackCamp = state.campaigns[activeDrop.campaign_id];
        if (fallbackCamp) validCampaigns = [fallbackCamp];
    }

    let watchedGame = null;
    if (typeof getWatchedChannelObject === 'function') {
        const wObj = getWatchedChannelObject();
        if (wObj) watchedGame = wObj.game_name || wObj.game || wObj.game_title;
    }

    validCampaigns = validCampaigns.filter(c => {
        if (!c || isClaimed(c)) return false;

        const gameName = c.game_name || c.game || c.gameName;
        
        if (typeof isGameIgnored === 'function' && isGameIgnored(gameName)) {
            return false;
        }

        if (watchedGame && gameName) {
            if (watchedGame.trim().toLowerCase() !== gameName.trim().toLowerCase()) {
                logProgressOnce(
                    `rot_skip_${gameName}_${watchedGame}`,
                    `ℹ️ [ROTATION GUARD] Skipping '${gameName}' campaign (Watching '${watchedGame}')`
                );
                return false;
            }
        }

        const drops = extractCampaignDrops(c);
        return !drops || drops.length === 0 || drops.some(d => !isClaimed(d));
    });

    if (validCampaigns.length === 0) {
        logProgressOnce('rotation_empty', 'ℹ️ [ROTATION] No valid non-ignored campaigns available for rotation.');
        return;
    }

    if (state.campaignRotationIndex === undefined || state.campaignRotationIndex >= validCampaigns.length || state.campaignRotationIndex < 0) {
        state.campaignRotationIndex = 0;
        state.dropRotationIndex = 0;
    }

    const currentCampaign = validCampaigns[state.campaignRotationIndex];
    let drops = extractCampaignDrops(currentCampaign);
    const activeDrops = drops.filter(d => !isClaimed(d));

    if (activeDrops.length > 0) {
        if (state.dropRotationIndex === undefined || state.dropRotationIndex >= activeDrops.length || state.dropRotationIndex < 0) {
            state.dropRotationIndex = 0;
        }
        
        const currentDrop = activeDrops[state.dropRotationIndex];
        
        currentDrop.campaign_id = currentCampaign.id || currentCampaign.campaign_id;
        currentDrop.campaign_name = currentCampaign.name || currentCampaign.campaign_name;
        currentDrop.game_name = currentCampaign.game_name || currentCampaign.gameName;
        currentDrop.drop_name = currentDrop.name || currentDrop.drop_name || currentDrop.title || currentDrop.dropName || 'Drop';

        const currentId = String(getDropId(currentDrop) || '');

        const liveData = (state.liveDropsCache && state.liveDropsCache[currentId]) || null;

        if (liveData) {
            if (liveData.current_minutes !== undefined) currentDrop.current_minutes = liveData.current_minutes;
            if (liveData.remaining_seconds !== undefined) currentDrop.remaining_seconds = liveData.remaining_seconds;
            if (liveData.required_minutes !== undefined) currentDrop.required_minutes = liveData.required_minutes;
            if (liveData.progress !== undefined) currentDrop.progress = liveData.progress;

            if (liveData.name && !currentDrop.name) currentDrop.name = liveData.name;
            if (liveData.title && !currentDrop.title) currentDrop.title = liveData.title;
            if (liveData.drop_name && !currentDrop.drop_name) currentDrop.drop_name = liveData.drop_name;
        }

        const existingDrop = state.currentDrop || state.current_drop;
        const existingId = getDropId(existingDrop);
        const hasChanged = !existingId || String(existingId) !== currentId;

        switchCampaignDisplay(currentCampaign, false, false);
        updateSingleDropDisplay(currentDrop, hasChanged);

        state.dropRotationIndex++;
        if (state.dropRotationIndex >= activeDrops.length) {
            state.dropRotationIndex = 0;
            state.campaignRotationIndex++;
        }
    } else {
        switchCampaignDisplay(currentCampaign, false, true);
        state.campaignRotationIndex++;
    }

    if (state.campaignRotationIndex >= validCampaigns.length) {
        state.campaignRotationIndex = 0;
    }
}

let isExecutingRotation = false;

/**
 * Initializes drop rotation interval safely with concurrency locks
 */
function startCombinedRotation(forceRestart = true) {
    if (state.rotationTimer && !forceRestart) return; 

    if (state.rotationTimer) {
        clearInterval(state.rotationTimer);
        state.rotationTimer = null;
    }

    logProgressOnce('rot_start', `🔄 [ROTATION] Combined rotation started (interval: 4000ms, forceRestart: ${forceRestart})`);
    
    state.rotationTimer = setInterval(() => {
        if (isExecutingRotation) return;
        isExecutingRotation = true;
        try {
            executeRotationStep();
        } finally {
            isExecutingRotation = false;
        }
    }, 4000);
    
    if (document.querySelectorAll('.wanted-drop-item').length > 0) {
        if (!isExecutingRotation) {
            setTimeout(() => {
                isExecutingRotation = true;
                try {
                    executeRotationStep();
                } finally {
                    isExecutingRotation = false;
                }
            }, 0);
        }
    }
}
