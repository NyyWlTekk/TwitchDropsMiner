// ==================== Active Drop & Campaign Rotation ====================

// --- 1. State Initialization ---
if (typeof state === 'undefined') {
    window.state = {};
}

if (!state.activeCampaignsQueue) state.activeCampaignsQueue = [];
if (state.campaignRotationIndex === undefined) state.campaignRotationIndex = 0;
if (!state.activeDropsQueue) state.activeDropsQueue = [];
if (state.dropRotationIndex === undefined) state.dropRotationIndex = 0;
if (!state.rotationTimer) state.rotationTimer = null;
if (!state.countdownTimer) state.countdownTimer = null;
if (!state.campaigns) state.campaigns = {};

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

    if (queueItem.drops) {
        const drops = Array.isArray(queueItem.drops) ? queueItem.drops : Object.values(queueItem.drops);
        return { campaign: queueItem, drops };
    }

    if (state.campaigns && queueItem.campaign_id) {
        const campaignsArray = Array.isArray(state.campaigns) ? state.campaigns : Object.values(state.campaigns);
        const found = campaignsArray.find(c => c && (c.id === queueItem.campaign_id || c.campaign_id === queueItem.campaign_id));
        if (found && found.drops) {
            const drops = Array.isArray(found.drops) ? found.drops : Object.values(found.drops);
            return { campaign: found, drops };
        }
    }

    return { campaign: queueItem, drops: [queueItem] };
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
 * Resolves drop reward/asset image URL
 */
function resolveDropRewardImageUrl(data, targetId = null) {
    let rewardImgUrl = data.image_url || data.reward_image_url || data.icon_url || data.benefit_icon_url ||
        data.reward?.image_url || data.reward?.icon_url || data.benefit?.image_url || data.benefits?.[0]?.image_url ||
        data.benefit_edges?.[0]?.node?.asset_url || data.benefit_edges?.[0]?.node?.image_url;

    if (!rewardImgUrl && targetId && state.campaigns && data.campaign_id) {
        const camp = state.campaigns[data.campaign_id] || 
            Object.values(state.campaigns).find(c => c && (c.id === data.campaign_id || c.campaign_id === data.campaign_id));
        
        if (camp && camp.drops) {
            const foundDrop = camp.drops.find(d => (d.id || d.drop_id) === targetId);
            if (foundDrop) {
                rewardImgUrl = foundDrop.image_url || foundDrop.reward_image_url || foundDrop.icon_url || 
                               foundDrop.benefit_icon_url || foundDrop.reward?.image_url || foundDrop.reward?.icon_url ||
                               foundDrop.image || foundDrop.thumbnail || foundDrop.url || foundDrop.benefits?.[0]?.image_url ||
                               foundDrop.benefits?.[0]?.icon_url || foundDrop.benefits?.[0]?.thumbnail ||
                               foundDrop.benefits?.[0]?.url || foundDrop.benefits?.[0]?.asset_url ||
                               foundDrop.benefit_edges?.[0]?.node?.image_url || foundDrop.benefit_edges?.[0]?.node?.asset_url;
            }
        }
    }
    return rewardImgUrl;
}

/**
 * Preloads queue images
 */
function preloadQueueImages(queue) {
    if (!Array.isArray(queue)) return;
    queue.forEach(dropItem => {
        if (dropItem && dropItem.image_url) {
            const img = new Image();
            img.src = dropItem.image_url;
        }
    });
}

// ==========================================
// 3. LOGIC SEPARATION HELPERS
// ==========================================

/**
 * Syncs progress for the active drop queue panel at the top.
 * Acts as a bridge between the main dispatcher and the display renderer.
 */
function syncActiveQueueProgress(data) {
    console.group("[SYNC_ACTIVE_PROGRESS]");
    console.log("[PROGRESS_MODULE] Processing active drop update:", data.drop_name || data.drop_id);

    // Call the core display updater function
    updateSingleDropDisplay(data, false);

    console.groupEnd();
    return true;
}

/**
 * [INFO] Unified entry point for updating drop progress in active queue and wanted tree simultaneously
 */
function syncAnyDropProgress(incomingIdStr, data) {
    if (!state) return;

    // [GUARD_CLAUSE] Ošetření zvrchu – pokud data chybí, jsou neplatná nebo jde o stav gathering, rovnou skončíme
    if (!data || typeof data !== 'object' || data.gathering || data.current_minutes === undefined) {
        console.warn(`[SYNC_ANY_DROP] Ignored incomplete, missing or gathering payload for ID: ${incomingIdStr}`, data);
        return;
    }

    console.group(`[SYNC_ANY_DROP] ID: ${incomingIdStr}`);
    console.log("Payload data:", data);

    // 1. Update active queue (top progress bars)
	if (Array.isArray(state.activeDropsQueue)) {
        const activeQueueDrop = state.activeDropsQueue.find(d => String(d.drop_id || d.id) === incomingIdStr);
        if (activeQueueDrop) {
            console.log("[SYNC_ACTIVE] Drop located in active queue:", activeQueueDrop);
            if (data.current_minutes !== undefined) activeQueueDrop.current_minutes = data.current_minutes;
            if (data.required_minutes !== undefined) activeQueueDrop.required_minutes = data.required_minutes;
            if (data.remaining_seconds !== undefined) activeQueueDrop.remaining_seconds = data.remaining_seconds;
            if (data.is_claimed !== undefined) activeQueueDrop.is_claimed = data.is_claimed;

            const reqMins = activeQueueDrop.required_minutes || 0;
            const currMins = activeQueueDrop.current_minutes || 0;

            if (reqMins > 0) {
                activeQueueDrop.progress = Math.min(100, (currMins / reqMins) * 100);
                activeQueueDrop.can_claim = currMins >= reqMins && !activeQueueDrop.is_claimed;
            }

            if (typeof renderAllProgressBars === 'function') {
                renderAllProgressBars(currMins, activeQueueDrop);
            }
        } else {
            console.log("[SYNC_ACTIVE] Drop NOT found in active queue.");
        }
    }

	// 2. Update wanted tree
    if (Array.isArray(state.wantedItemsTree)) {
        console.log("[SYNC_WANTED] Initializing syncWantedItemsProgress...");
        // [FIX] Pass a single object containing both the ID and the update data
        syncWantedItemsProgress({
            drop_id: incomingIdStr,
            ...data
        });
    }
    
    console.groupEnd();
}

/**
 * [INFO] Professional update drop in DOM helper with layout protection
 */
function updateDropInDOM(dropId, current, required, isItemClaimedFlag) {
    const selector = `.wanted-drop-item[data-drop-id="${dropId}"]`;
    const dropEl = document.querySelector(selector);
    
    // Strict guard clause: If the element isn't in DOM, abort silently. 
    // Do NOT trigger full tree renders from a leaf-node update function.
    if (!dropEl) {
        console.warn(`[DOM_WARN] Target element missing for drop ID [${dropId}]. Skipping update to prevent layout trashing.`);
        return;
    }

    const statusEl = dropEl.querySelector('.wanted-drop-status');
    if (!statusEl) {
        console.warn(`[DOM_WARN] Status sub-element missing within drop ID [${dropId}]. Validation failed.`);
        return;
    }

    // Process valid updates
    if (isItemClaimedFlag) {
        const label = state.translations?.gui?.wanted?.claimed || 'Claimed';
        statusEl.innerHTML = `<span class="status-tag tag-claimed">${typeof getStatusIconSVG === 'function' ? getStatusIconSVG('drop-claimed') : ''} ${label}</span>`;
    } else if (current >= required && required > 0) {
        const label = state.translations?.gui?.wanted?.ready || 'Ready to claim!';
        statusEl.innerHTML = `<span class="status-tag tag-ready">${typeof getStatusIconSVG === 'function' ? getStatusIconSVG('drop-ready') : ''} ${label}</span>`;
    } else if (required > 0) {
        statusEl.innerHTML = `<span class="status-tag tag-progress">${typeof getStatusIconSVG === 'function' ? getStatusIconSVG('drop-active') : ''} ${Math.round(current)} / ${required} min</span>`;
    }
    
    console.log(`[DOM_SUCCESS] Visual status synchronized correctly for drop ID: [${dropId}]`);
}

/**
 * Calculates total requirements for the overall progress bar from full inventory (state.campaigns)
 * to prevent percentages from dropping when completed campaigns disappear from the queueTree.
 */
function calculateOverallStats() {
    let stats = { totalCurrent: 0, totalRequired: 0, totalRemainingSecs: 0 };
    
    if (!state || !state.campaigns) return stats;

    const campaignsList = Array.isArray(state.campaigns) 
        ? state.campaigns 
        : Object.values(state.campaigns);

    if (campaignsList.length === 0) return stats;

    // Seskupíme kampaně podle her (game_name), aby zachovaly logiku jako queueTree
    const gamesMap = {};

    campaignsList.forEach(campaign => {
        if (!campaign) return;
        
        // Přeskočíme unlinked kampaně
        if (campaign.is_unlinked || campaign.status === 'unlinked' || campaign.linked === false) {
            return;
        }

        const gameKey = campaign.game_name || campaign.gameName || 'Unknown Game';
        if (!gamesMap[gameKey]) {
            gamesMap[gameKey] = { campaigns: [] };
        }
        gamesMap[gameKey].campaigns.push(campaign);
    });

    // Aplikujeme původní logiku výběru maxReq v rámci každé hrací skupiny
    Object.values(gamesMap).forEach(gameGroup => {
        if (!gameGroup.campaigns || !Array.isArray(gameGroup.campaigns)) return;
        let maxReq = 0, maxCur = 0, maxRemSecs = 0;

        gameGroup.campaigns.forEach(campaign => {
            if (!campaign || !campaign.drops || !Array.isArray(campaign.drops)) return;
            let campReq = 0, campCur = 0, campRemSecs = 0;

            campaign.drops.forEach(drop => {
                if (!drop) return;
                if (drop.is_unlinked || drop.status === 'unlinked') return;

                const req = Number(drop.required_minutes || drop.requiredMinutes || drop.duration || 0);
                let cur = Number(drop.current_minutes || drop.currentMinutes || 0);
                const isItemClaimedFlag = Boolean(drop.is_claimed || drop.claimed || drop.isClaimed);

                if (isItemClaimedFlag) cur = req;
                if (cur > req) cur = req;

                campReq += req;
                campCur += cur;
                campRemSecs += (isItemClaimedFlag ? 0 : Math.max(0, req - cur)) * 60;
            });

            if (campReq > maxReq) {
                maxReq = campReq;
                maxCur = campCur;
                maxRemSecs = campRemSecs;
            }
        });

        stats.totalRequired += maxReq;
        stats.totalCurrent += maxCur;
        stats.totalRemainingSecs += maxRemSecs;
    });

    return stats;
}

/**
 * Removes claimed campaigns from the active rotation queue
 */
function cleanupClaimedCampaigns() {
    if (!state.activeCampaignsQueue || !Array.isArray(state.activeCampaignsQueue)) return;
    
    state.activeCampaignsQueue = state.activeCampaignsQueue.filter(c => {
        if (isClaimed(c)) return false;
        let cDrops = extractCampaignDrops(c);
        if (cDrops.length === 0) return true;
        return cDrops.some(d => !isClaimed(d));
    });
}

/**
 * Maps and sanitizes drop objects for queue processing
 */
function mapDropsForQueue(drops, parentData) {
    return drops.map(d => {
        const dropImg = d.image_url || d.reward_image_url || d.icon_url || d.benefit_icon_url || 
                        d.reward?.image_url || d.benefit?.image_url || d.benefits?.[0]?.image_url || 
                        d.benefit_edges?.[0]?.node?.asset_url || parentData.image_url;

        const curMins = d.current_minutes !== undefined ? d.current_minutes : (parentData.current_minutes || 0);
        const reqMins = d.required_minutes || parentData.required_minutes || 1;

        return {
            ...parentData,
            drop_id: d.id || d.drop_id,
            drop_name: d.name || d.drop_name,
            image_url: dropImg,
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
    state.campaigns[campaignData.id] = campaignData;
    if (typeof renderInventory === 'function') renderInventory();
}

/**
 * Clears the current drop progress UI and resets related state.
 * @param {boolean} force - If true, bypasses cache checks and forces UI clearing.
 */
function clearDropProgress(force = false) {
    console.group("[UI] clearDropProgress() called");
    console.log(`[UI] Force parameter: ${force}`);

    // Check if we have cached drop data before hiding UI
    if (!force) {
        const cached = safeGetStorage('app_saved_current_drop');
        if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
            console.log("[UI] Cached drop found. Blocking clearDropProgress() to preserve cached drop display.");
            console.groupEnd();
            return;
        }
    } else {
        console.log("[UI] Force flag active. Removing cached drop from storage.");
        if (typeof safeRemoveStorage === 'function') {
            safeRemoveStorage('app_saved_current_drop');
        }
    }

    console.log("[UI] Resetting current drop state and UI elements.");
    state.currentDrop = null;
    dropTotalSeconds = 0;
    
    if (state.countdownTimer) {
        console.log("[UI] Clearing active countdown timer.");
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    
    if (noDropMessage) {
        noDropMessage.style.display = 'block';
        console.log("[UI] Displaying 'no-drop-message' element.");
    }
    if (dropInfo) {
        dropInfo.style.display = 'none';
        console.log("[UI] Hiding 'drop-info' element.");
    }

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = '0%';
        fill.textContent = '0%';
        console.log("[UI] Progress fill reset to 0%.");
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) {
        progressText.textContent = '0 / 0 min';
        console.log("[UI] Progress text reset to '0 / 0 min'.");
    }

    const timeEl = document.getElementById('progress-time');
    if (timeEl) {
        timeEl.textContent = 'Time remaining: 0:00';
        console.log("[UI] Time remaining reset to '0:00'.");
    }

    console.log("[UI] Drop progress successfully cleared.");
    console.groupEnd();
}

function updateRemainingTime(initialSeconds, currentData = null) {
    if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }

    const drop = currentData || state.currentDrop || {};
    const timeEl = document.getElementById('progress-time');
    
    if (timeEl) {
        const remaining = Math.max(0, Math.floor(initialSeconds));
        const reqSecs = Number(drop.required_minutes || 0) * 60;
        timeEl.textContent = `Time remaining: ${formatTime(remaining)} / ${formatTime(reqSecs)}`;
    }

    if (state.currentDrop) {
        state.currentDrop.remaining_seconds = Math.max(0, Math.floor(initialSeconds));
    }
}

function updateDropTitle(data) {
    const dropNameEl = document.getElementById('drop-name');
    if (!dropNameEl) return;

    // Vycházíme striktně z běžící fronty (live items)
    const validCampaigns = (state.activeCampaignsQueue || []).filter(c => {
        if (!c || isClaimed(c)) return false;
        const drops = extractCampaignDrops(c);
        return !drops || drops.length === 0 || drops.some(d => !isClaimed(d));
    });

    const queueLength = validCampaigns.length > 0 ? validCampaigns.length : 1;
    const currentIndex = (state.campaignRotationIndex !== undefined ? state.campaignRotationIndex : 0) + 1;
    const displayIndex = Math.min(currentIndex, queueLength);

    // Zobrazení se nyní řídí chráněným názvem hry z kroku 2
    const displayGameName = data.game_name || 'Drop';
    
    dropNameEl.textContent = `${displayGameName} (${displayIndex}/${queueLength})`;
}

function getCachedImage(url, alt, className, styles = {}) {
    if (!url) return null;
    
    if (imageCache.has(url)) {
        const cachedImg = imageCache.get(url).cloneNode(true);
        Object.assign(cachedImg.style, styles);
        return cachedImg;
    }

    const imgEl = document.createElement('img');
    imgEl.src = url;
    if (alt) imgEl.alt = alt;
    if (className) imgEl.className = className;
    Object.assign(imgEl.style, styles);

    imageCache.set(url, imgEl);
    return imgEl.cloneNode(true);
}

function renderDropGameHeader(data) {
    const dropGameEl = document.getElementById('drop-game');
    if (!dropGameEl) return;

    let boxArtUrl = data.game_box_art_url;
    if (!boxArtUrl && state.campaigns && data.campaign_id) {
        const foundCampaign = state.campaigns[data.campaign_id] ||
            Object.values(state.campaigns).find(c => c && (c.id === data.campaign_id || c.campaign_id === data.campaign_id));
        if (foundCampaign) {
            boxArtUrl = foundCampaign.game_box_art_url || foundCampaign.box_art_url || foundCampaign.art_url;
        }
    }

    dropGameEl.style.display = 'flex';
    dropGameEl.style.alignItems = 'center';
    dropGameEl.style.gap = '12px';
    dropGameEl.style.margin = '8px 0';

    const children = [];

    if (boxArtUrl && typeof getCachedImage === 'function') {
        const iconUrl = boxArtUrl.replace('{width}', '52').replace('{height}', '70');
        const imgEl = getCachedImage(iconUrl, data.game_name || '', 'game-icon', {
            width: '42px',
            height: '56px',
            borderRadius: '6px',
            objectFit: 'cover',
            flexShrink: '0'
        });
        if (imgEl) children.push(imgEl);
    }

    if (typeof makeElement === 'function') {
        const infoTextDiv = makeElement('div', { class: 'drop-game-text-info' });
        infoTextDiv.style.display = 'flex';
        infoTextDiv.style.flexDirection = 'column';
        infoTextDiv.style.justifyContent = 'center';

        const titleText = data.campaign_name || '';
        const subTextContent = data.drop_name || '';
        const subText = makeElement('span', { class: 'drop-sub-name' }, subTextContent);
        subText.style.fontSize = '0.9em';
        subText.style.opacity = '0.85';

        if (data.campaign_id) {
            const campaignUrl = `https://www.twitch.tv/drops/campaigns?dropID=${data.campaign_id}`;
            const linkEl = makeElement('a', { href: campaignUrl, target: '_blank', rel: 'noopener noreferrer', class: 'drop-campaign-link' }, titleText);
            infoTextDiv.appendChild(linkEl);
        } else {
            const titleEl = makeElement('span', { class: 'drop-campaign-title' }, titleText);
            infoTextDiv.appendChild(titleEl);
        }
        
        infoTextDiv.appendChild(subText);
        children.push(infoTextDiv);
    }

    dropGameEl.replaceChildren(...children);
}

function renderDropCardLayout(data, rewardImgUrl) {
    const currentDropLabel = document.getElementById('current-drop-label');
    if (!currentDropLabel) return;

    let activeDrops = [];
    const { drops } = getCampaignAndDrops(data);
    
    if (drops && drops.length > 0) activeDrops = drops.filter(d => !isClaimed(d));
    if (activeDrops.length === 0 && state.activeDropsQueue && state.activeDropsQueue.length > 0) activeDrops = state.activeDropsQueue;

    const dropQueueLen = activeDrops.length > 0 ? activeDrops.length : 1;
    let dropIdx = 1;
    
    if (activeDrops.length > 0) {
        const currentId = data.drop_id || data.id;
        const foundIdx = activeDrops.findIndex(d => (d.drop_id || d.id) === currentId);
        if (foundIdx !== -1) dropIdx = foundIdx + 1;
    }

    currentDropLabel.textContent = `⚡ Drop (${dropIdx}/${dropQueueLen}): ${data.drop_name || ''}`;
    let cardOuter = currentDropLabel.closest('.drop-card-container');

    if (!cardOuter) {
        const progressTime = document.getElementById('progress-time');
        const progressFill = document.getElementById('progress-fill');
        let parentSearch = currentDropLabel.parentElement;

        while (parentSearch && parentSearch !== document.body) {
            if ((progressTime && parentSearch.contains(progressTime)) || (progressFill && parentSearch.contains(progressFill))) {
                cardOuter = parentSearch;
                cardOuter.classList.add('drop-card-container');
                break;
            }
            parentSearch = parentSearch.parentElement;
        }
    }

    if (!cardOuter) return;

    let rightCol = cardOuter.querySelector('#drop-card-right-col');
    let leftImg = cardOuter.querySelector('#drop-card-left-img');

    if (!rightCol) {
        rightCol = document.createElement('div');
        rightCol.id = 'drop-card-right-col';
        rightCol.style.flex = '1';
        rightCol.style.display = 'flex';
        rightCol.style.flexDirection = 'column';
        rightCol.style.justifyContent = 'space-between';
        rightCol.style.gap = '6px';
        rightCol.style.minWidth = '0';

        while (cardOuter.firstChild) rightCol.appendChild(cardOuter.firstChild);

        cardOuter.style.display = 'flex';
        cardOuter.style.flexDirection = 'row';
        cardOuter.style.alignItems = 'stretch';
        cardOuter.style.gap = '12px';
        cardOuter.appendChild(rightCol);
    }

    if (rewardImgUrl && typeof getCachedImage === 'function') {
        const cachedRewardImg = getCachedImage(rewardImgUrl, data.drop_name || '', 'drop-reward-icon', {
            width: '72px',
            height: 'auto',
            maxHeight: '100%',
            alignSelf: 'center',
            objectFit: 'contain',
            borderRadius: '6px',
            flexShrink: '0',
            display: 'block'
        });

        if (cachedRewardImg) {
            cachedRewardImg.id = 'drop-card-left-img';
            if (!leftImg || leftImg !== cachedRewardImg) {
                if (leftImg && cardOuter.contains(leftImg)) {
                    leftImg.replaceWith(cachedRewardImg);
                } else {
                    cardOuter.insertBefore(cachedRewardImg, rightCol);
                }
            }
        }
    } else if (leftImg) {
        leftImg.remove();
    }
}

function renderAllProgressBars(currentMins, dropData) {
    const reqMins = dropData.required_minutes || 1;
    const dropPercentage = Math.min(100, Math.max(0, (currentMins / reqMins) * 100));

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = `${dropPercentage.toFixed(1)}%`;
        fill.textContent = `${Math.round(dropPercentage)}%`;
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) progressText.textContent = `${currentMins} / ${reqMins} min`;

    updateCampaignProgressData(dropData, currentMins);
    updateOverallProgress();
}

function updateGameHeaderTimeBadge(groupIdx, remainingMinutes) {
    const groups = document.querySelectorAll('.wanted-game-group');
    if (!groups[groupIdx]) return;

    const badge = groups[groupIdx].querySelector('.wanted-game-time-badge');
    if (badge) {
        badge.textContent = remainingMinutes > 0 ? `${remainingMinutes} min` : 'Done';
    }
}

// ==========================================
// 5. CORE LOGIC & ROTATION (WITH MEMORY FALLBACK & LOGS)
// ==========================================

/**
 * Updates the single active drop display with caching, queue matching, and DOM rendering.
 */
function updateSingleDropDisplay(data, isFromRotation = false) {
    console.group("[UPDATE_SINGLE_DROP]");
    console.log("Raw incoming drop data:", data);

    // [CACHE_FALLBACK] Prevent blinking if data is temporarily missing during sync/fetching
    if (!data) {
        if (window._lastValidCurrentDrop) {
            console.warn("[CACHE_FALLBACK] Incoming drop data is empty. Restoring last valid drop from cache memory:", window._lastValidCurrentDrop);
            data = window._lastValidCurrentDrop;
        } else {
            console.warn("[CACHE_FALLBACK] No incoming drop data and no cached fallback available in memory.");
        }
    } else {
        window._lastValidCurrentDrop = data;
        console.log("[CACHE_MEMORY] Updated persistent cache memory with active drop:", data);
    }

    if (!data) {
        console.warn("[UPDATE_SINGLE_DROP] No data available to render. Aborting.");
        console.groupEnd();
        return;
    }

    const targetId = data.drop_id || data.id;

    if (state.currentDrop && (state.currentDrop.drop_id || state.currentDrop.id) === targetId) {
        data = { ...state.currentDrop, ...data };
    } else if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
        const queueItem = state.activeDropsQueue.find(d => (d.drop_id || d.id) === targetId);
        if (queueItem) data = { ...queueItem, ...data };
    }

    if (!isFromRotation && state.rotationTimer) {
        console.log("[UPDATE_SINGLE_DROP] Rotation timer active and not forced, skipping single drop refresh.");
        console.groupEnd();
        return;
    }

    const reqMins = Number(data.required_minutes ?? 0);
    const curMins = Number(data.current_minutes ?? 0);

    if (isClaimed(data) || (reqMins > 0 && curMins >= reqMins)) {
        console.log("[UPDATE_SINGLE_DROP] Drop is already claimed or completed, cleaning up and rotating.");
        if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
            const dropIdToClean = data.drop_id || data.id;
            state.activeDropsQueue = state.activeDropsQueue.filter(d => (d.drop_id || d.id) !== dropIdToClean);
        }
        startCombinedRotation(true);
        console.groupEnd();
        return;
    }

    state.currentDrop = data;

    let remSecs = data.remaining_seconds !== undefined && data.remaining_seconds !== null 
        ? Number(data.remaining_seconds) 
        : Math.max(0, (reqMins - curMins) * 60);

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

    console.log("[UPDATE_SINGLE_DROP] Successfully updated display for drop:", targetId);
    console.groupEnd();
}


function switchCampaignDisplay(data, isManualSwitch = true) {
    console.group("[SWITCH_CAMPAIGN]");
    console.log("Switching campaign data:", data);

    // [EXPIRATION & COMPLETION SAFETY CHECK]
    if (data) {
        const now = Date.now();
        
        // 1. Kontrola, jestli data/kampaň/drop neexpiroval (podle ends_at)
        if (data.ends_at) {
            const endTime = new Date(data.ends_at).getTime();
            if (endTime <= now) {
                console.log("[UI] Campaign/Drop has expired. Forcing clearDropProgress().");
                clearDropProgress(true);
                console.groupEnd();
                return;
            }
        }

        // 2. Kontrola, jestli už není drop plně odtěžený
        if (data.current_minutes !== undefined && data.required_minutes !== undefined) {
            if (data.current_minutes >= data.required_minutes && data.required_minutes > 0) {
                console.log("[UI] Drop is already fully completed. Forcing clearDropProgress().");
                clearDropProgress(true);
                console.groupEnd();
                return;
            }
        }
    }

    cleanupClaimedCampaigns();

    // [CACHE_FALLBACK] Protect queue against temporary empty states
    if (!state.activeCampaignsQueue || state.activeCampaignsQueue.length === 0) {
        if (window._lastValidActiveCampaignsQueue && window._lastValidActiveCampaignsQueue.length > 0) {
            console.warn("[CACHE_FALLBACK] activeCampaignsQueue is empty. Restoring from cache memory.");
            state.activeCampaignsQueue = window._lastValidActiveCampaignsQueue;
        }
    } else {
        window._lastValidActiveCampaignsQueue = state.activeCampaignsQueue;
    }

    const previousDropId = state.currentDrop ? (state.currentDrop.drop_id || state.currentDrop.id) : null;
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
            const idx = state.activeDropsQueue.findIndex(d => (d.drop_id || d.id) === data.drop_id);
            if (idx !== -1) state.dropRotationIndex = idx;
            startCombinedRotation(true);
        }
    } else {
        state.activeDropsQueue = [data];
    }

    preloadQueueImages(state.activeDropsQueue);

    const initialActiveDrop = state.activeDropsQueue[state.dropRotationIndex] || state.activeDropsQueue[0] || data;
    const newDropId = initialActiveDrop ? (initialActiveDrop.drop_id || initialActiveDrop.id) : null;
    const dropChanged = !previousDropId || !newDropId || previousDropId !== newDropId;

    updateSingleDropDisplay(initialActiveDrop, dropChanged);
    console.groupEnd();
}

function updateDropProgress(dropData) {
    let validDrop = dropData;

    if (!validDrop || typeof validDrop !== 'object' || Object.keys(validDrop).length === 0) {
        const cached = safeGetStorage('app_saved_current_drop');
        if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
            validDrop = cached;
        } else {
            if (typeof clearDropProgress === 'function') clearDropProgress();
            return;
        }
    } else {
        safeSetStorage('app_saved_current_drop', validDrop);
    }

    // Track live mining campaigns for rotation
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

    const incomingIdStr = String(validDrop.drop_id || validDrop.id);
    if (!state.currentDrop) state.currentDrop = {};
    Object.assign(state.currentDrop, validDrop);

    syncAnyDropProgress(incomingIdStr, validDrop);

    // Strictly update visually using only this single drop
    updateSingleDropDisplay(validDrop, false);
    updateCampaignProgressData(validDrop, validDrop.current_minutes || 0);

	// [FIX] Pass a single object containing both the ID and the validDrop data
    const treeUpdated = syncWantedItemsProgress({
        drop_id: incomingIdStr,
        ...validDrop
    });
    if (treeUpdated && typeof renderWantedItems === 'function') {
        renderWantedItems(state.wantedItemsTree);
    }
}

function updateCampaignProgressData(data, liveCurrentMins) {
    const campaignFill = document.getElementById('campaign-progress-fill');
    const campaignText = document.getElementById('campaign-progress-text');
    const campaignTitle = document.getElementById('campaign-progress-title');

    if (!campaignFill || !campaignText || !data) return;

    const currentDropCurrent = liveCurrentMins !== undefined ? liveCurrentMins : (Number(data.current_minutes) || 0);
    const targetDropId = data.drop_id || data.id;

    let totalCampaignCurrent = 0;
    let totalCampaignRequired = 0;

    if (campaignTitle && state.campaigns && data.campaign_id) {
        const campaign = state.campaigns[data.campaign_id] || 
            Object.values(state.campaigns).find(c => c && (c.id === data.campaign_id || c.campaign_id === data.campaign_id));
            
        if (campaign) {
            const drops = extractCampaignDrops(campaign);
            const campName = campaign.name || campaign.campaign_name || 'Campaign';
            let dropVisualIndex = 1;
            
            drops.forEach((d, index) => {
                // Update exact drop minutes internally if it's the active one
                if ((d.drop_id || d.id) === targetDropId) {
                    d.current_minutes = currentDropCurrent;
                    dropVisualIndex = index + 1;
                }
            });
            
            // Take the maximum value from the drops set instead of summing them up
            totalCampaignCurrent = drops.length > 0 ? Math.max(...drops.map(d => Number(d.current_minutes) || 0)) : 0;
            totalCampaignRequired = drops.length > 0 ? Math.max(...drops.map(d => Number(d.required_minutes) || 0)) : 0;
            
            campaignTitle.textContent = `${campName} • Drop ${dropVisualIndex}/${drops.length}`;
        }
    }

    // Fallback if campaign drops couldn't be evaluated from state
    if (totalCampaignRequired === 0) {
        totalCampaignCurrent = currentDropCurrent;
        totalCampaignRequired = Number(data.required_minutes) || 0;
    }

    if (totalCampaignRequired > 0) {
        const percentage = Math.min(100, Math.round((totalCampaignCurrent / totalCampaignRequired) * 100));
        campaignFill.style.width = `${percentage}%`;
        campaignFill.textContent = `${percentage}%`;
        campaignText.textContent = `${totalCampaignCurrent} / ${totalCampaignRequired} min`;
    } else {
        campaignFill.style.width = '0%';
        campaignFill.textContent = '0%';
        campaignText.textContent = `${totalCampaignCurrent} / 0 min`;
    }
}

function updateOverallProgress() {
    try {
        const overallFill = document.getElementById('overall-progress-fill');
        const overallText = document.getElementById('overall-progress-text');
        if (!overallFill || !overallText) return;

        const queueTree = state.wantedItemsTree || window._lastValidWantedTree || [];

        if (!queueTree || queueTree.length === 0) {
            overallFill.style.width = '0%';
            overallFill.textContent = '';
            overallText.textContent = '0% (0 / 0 min)';
            
            const overallTimeEl = document.getElementById('overall-progress-time');
            if (overallTimeEl) overallTimeEl.textContent = 'Total remaining time: 0m';
            return;
        }

        window._lastValidWantedTree = queueTree;
        const stats = calculateOverallStats(queueTree);

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
 * Executes a single tick of rotation process
 */
function executeRotationStep() {
    // Používáme POUZE dynamicky vybudovanou frontu (už žádných 1/25)
    let validCampaigns = state.activeCampaignsQueue || [];

    // Fallback pokud se fronta ještě nestihla naplnit
    if (validCampaigns.length === 0 && state.currentDrop && state.currentDrop.campaign_id && state.campaigns) {
        const fallbackCamp = state.campaigns[state.currentDrop.campaign_id];
        if (fallbackCamp) validCampaigns = [fallbackCamp];
    }

    validCampaigns = validCampaigns.filter(c => {
        if (!c || isClaimed(c)) return false;
        const drops = extractCampaignDrops(c);
        return !drops || drops.length === 0 || drops.some(d => !isClaimed(d));
    });

    if (validCampaigns.length === 0) return;

    if (state.campaignRotationIndex === undefined || state.campaignRotationIndex >= validCampaigns.length || state.campaignRotationIndex < 0) {
        state.campaignRotationIndex = 0;
        state.dropRotationIndex = 0;
    }

    const currentCampaign = validCampaigns[state.campaignRotationIndex];
    let drops = extractCampaignDrops(currentCampaign);
    const activeDrops = drops.filter(d => !isClaimed(d));

    switchCampaignDisplay(currentCampaign, false);

    if (activeDrops.length > 0) {
        if (state.dropRotationIndex === undefined || state.dropRotationIndex >= activeDrops.length || state.dropRotationIndex < 0) {
            state.dropRotationIndex = 0;
        }
        
        const currentDrop = activeDrops[state.dropRotationIndex];
        
        // KRITICKÝ FIX: Napevno svážeme data dropu s daty právě rotující kampaně.
        // Tím zabráníme tomu, aby SMITE drop načetl Overwatch progress bar.
        currentDrop.campaign_id = currentCampaign.id || currentCampaign.campaign_id;
        currentDrop.campaign_name = currentCampaign.name || currentCampaign.campaign_name;
        currentDrop.game_name = currentCampaign.game_name || currentCampaign.gameName;
        
        updateSingleDropDisplay(currentDrop, true);

        state.dropRotationIndex++;
        if (state.dropRotationIndex >= activeDrops.length) {
            state.dropRotationIndex = 0;
            state.campaignRotationIndex++;
        }
    } else {
        state.campaignRotationIndex++;
    }

    if (state.campaignRotationIndex >= validCampaigns.length) {
        state.campaignRotationIndex = 0;
    }
}

/**
 * Initializes drop rotation interval
 */
function startCombinedRotation(forceRestart = true) {
    if (state.rotationTimer && !forceRestart) return; 

    if (state.rotationTimer) {
        clearInterval(state.rotationTimer);
        state.rotationTimer = null;
    }

    state.rotationTimer = setInterval(executeRotationStep, 4000);
    executeRotationStep();
}

