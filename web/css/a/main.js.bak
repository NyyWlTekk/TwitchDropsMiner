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
 * [INFO] Unified entry point for updating drop progress in active queue and wanted tree simultaneously
 */
function syncAnyDropProgress(incomingIdStr, data) {
    console.group(`[SYNC_ANY_DROP] ID: ${incomingIdStr}`);
    console.log("Payload data:", data);

    // 1. Update active queue (top progress bars)
    if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
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
    } else {
        console.warn("[SYNC_ACTIVE] state.activeDropsQueue is not a valid array.");
    }

    // 2. Update wanted tree
    if (state.wantedItemsTree && Array.isArray(state.wantedItemsTree)) {
        console.log("[SYNC_WANTED] Initializing syncWantedItemsProgress...");
        syncWantedItemsProgress(incomingIdStr, data);
    } else {
        console.warn("[SYNC_WANTED] state.wantedItemsTree is missing or not a valid array.");
    }
    
    console.groupEnd();
}

/**
 * [INFO] Syncs wanted items tree data and updates game badges matching by drop name
 */
function syncWantedItemsProgress(incomingIdStr, data) {
    if (!state.wantedItemsTree || !Array.isArray(state.wantedItemsTree)) {
        console.warn("[WANTED_TREE] state.wantedItemsTree is invalid:", state.wantedItemsTree);
        return false;
    }
    
    let treeUpdated = false;
    const incomingDropName = data.drop_name || data.name;
    let loggedSample = false;

    state.wantedItemsTree.forEach((gameGroup, groupIdx) => {
        if (!gameGroup.campaigns || !Array.isArray(gameGroup.campaigns)) return;

        let groupHasUpdate = false;

        gameGroup.campaigns.forEach((campaign, campIdx) => {
            if (!campaign.drops || !Array.isArray(campaign.drops)) return;

            campaign.drops.forEach((drop, dropIdx) => {
                if (!loggedSample) {
                    console.log("[WANTED_SAMPLE] Tree drop object reference:", drop);
                    loggedSample = true;
                }

                const isMatch = incomingDropName && drop.name === incomingDropName;

                if (isMatch) {
                    drop.drop_id = incomingIdStr;
                    console.log(`[WANTED_TREE] MATCH FOUND! Campaign: "${campaign.name}"`, drop);

                    if (data.current_minutes !== undefined) drop.current_minutes = data.current_minutes;
                    if (data.required_minutes !== undefined) drop.required_minutes = data.required_minutes;
                    if (data.is_claimed !== undefined) drop.is_claimed = data.is_claimed;

                    const reqMins = drop.required_minutes || 0;
                    const currMins = drop.current_minutes || 0;

                    if (reqMins > 0) {
                        drop.progress = Math.min(100, (currMins / reqMins) * 100);
                        drop.can_claim = currMins >= reqMins && !drop.is_claimed;
                    }

                    campaign.claimed_drops_count = campaign.drops.filter(d => d.is_claimed).length;
                    
                    updateDropInDOM(incomingIdStr, currMins, reqMins, drop.is_claimed);

                    treeUpdated = true;
                    groupHasUpdate = true;
                }
            });
        });

        if (groupHasUpdate) {
            let maxRemainingForGame = 0;
            gameGroup.campaigns.forEach(c => {
                if (c.drops) {
                    c.drops.forEach(d => {
                        if (!d.is_claimed) {
                            const rem = Math.max(0, (d.required_minutes || 0) - (d.current_minutes || 0));
                            if (rem > maxRemainingForGame) maxRemainingForGame = rem;
                        }
                    });
                }
            });
            gameGroup.total_remaining_minutes = maxRemainingForGame;
            updateGameHeaderTimeBadge(groupIdx, maxRemainingForGame);
        }
    });

    return treeUpdated;
}

/**
 * [INFO] Professional update drop in DOM helper with preserved logs and auto-recovery fallback
 */
function updateDropInDOM(dropId, current, required, isItemClaimedFlag) {
    const selector = `.wanted-drop-item[data-drop-id="${dropId}"]`;
    let dropEl = document.querySelector(selector);
    
    console.log(`[DOM_UPDATE] Target selector: "${selector}" -> Resolved:`, !!dropEl);
    
    if (!dropEl) {
        // Automatic recovery fallback if DOM elements are not yet rendered
        if (typeof state !== 'undefined' && state.wantedItemsTree && typeof renderWantedItems === 'function') {
            console.log(`[DOM_RECOVERY] Wanted items container missing. Triggering immediate render fallback for drop ID: [${dropId}]`);
            renderWantedItems(state.wantedItemsTree);
            dropEl = document.querySelector(selector);
        }
    }

    if (!dropEl) {
        console.warn(`[DOM_WARN] Element for drop ID [${dropId}] not found in current DOM after recovery attempt.`);
        return;
    }

    const statusEl = dropEl.querySelector('.wanted-drop-status');
    if (!statusEl) {
        console.warn(`[DOM_WARN] Sub-element .wanted-drop-status not found inside drop ID [${dropId}].`);
        return;
    }

    if (isItemClaimedFlag) {
        const label = state.translations?.gui?.wanted?.claimed || 'Claimed';
        statusEl.innerHTML = `<span class="status-tag tag-claimed">${typeof getStatusIconSVG === 'function' ? getStatusIconSVG('drop-claimed') : ''} ${label}</span>`;
    } else if (current >= required && required > 0) {
        const label = state.translations?.gui?.wanted?.ready || 'Ready to claim!';
        statusEl.innerHTML = `<span class="status-tag tag-ready">${typeof getStatusIconSVG === 'function' ? getStatusIconSVG('drop-ready') : ''} ${label}</span>`;
    } else if (required > 0) {
        statusEl.innerHTML = `<span class="status-tag tag-progress">${typeof getStatusIconSVG === 'function' ? getStatusIconSVG('drop-active') : ''} ${Math.round(current)} / ${required} min</span>`;
    }
    console.log(`[DOM_SUCCESS] DOM successfully updated for drop ID: [${dropId}]`);
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

function clearInventory() {
    state.campaigns = {};
    if (typeof renderInventory === 'function') renderInventory();
}

function clearDropProgress() {
    state.currentDrop = null;
    dropTotalSeconds = 0;
    
    if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'block';
    if (dropInfo) dropInfo.style.display = 'none';

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = '0%';
        fill.textContent = '0%';
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) progressText.textContent = '0 / 0 min';

    const timeEl = document.getElementById('progress-time');
    if (timeEl) timeEl.textContent = 'Time remaining: 0:00';
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

    const rawQueue = state.activeCampaignsQueue || [];
    const validCampaigns = rawQueue.filter(c => {
        if (isClaimed(c)) return false;
        const { drops } = getCampaignAndDrops(c);
        return drops.length === 0 || drops.some(d => !isClaimed(d));
    });

    const queueLength = validCampaigns.length > 0 ? validCampaigns.length : 1;
    const currentIndex = (state.campaignRotationIndex !== undefined ? state.campaignRotationIndex : 0) + 1;

    dropNameEl.textContent = `${data.game_name || ''} (${currentIndex}/${queueLength})`;
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

function updateDropProgress(data) {
    if (!data) return;
    const incomingIdStr = String(data.drop_id || data.id);

    if (!state.currentDrop) state.currentDrop = {};
    Object.assign(state.currentDrop, data);

    syncAnyDropProgress(incomingIdStr, data);

    const currentActiveDrop = (state.activeDropsQueue && state.activeDropsQueue.length > 0) 
        ? (state.activeDropsQueue[state.dropRotationIndex] || state.activeDropsQueue[0]) 
        : data;

    updateSingleDropDisplay(currentActiveDrop, false);
    updateCampaignProgressData(currentActiveDrop, data.current_minutes || currentActiveDrop.current_minutes || 0);

    const treeUpdated = syncWantedItemsProgress(incomingIdStr, data);
    if (treeUpdated && typeof renderWantedItems === 'function') {
        renderWantedItems(state.wantedItemsTree);
    }
}

function updateCampaignProgressData(data, liveCurrentMins) {
    const campaignFill = document.getElementById('campaign-progress-fill');
    const campaignText = document.getElementById('campaign-progress-text');
    const campaignTitle = document.getElementById('campaign-progress-title');

    if (!campaignFill || !campaignText) return;

    if (!data || !data.campaign_id || !state.campaigns) {
        campaignFill.style.width = '0%';
        campaignFill.textContent = '0%';
        campaignText.textContent = '0 / 0 min';
        return;
    }

    const { campaign, drops } = getCampaignAndDrops(data);

    if (!campaign || drops.length === 0) {
        campaignFill.style.width = '0%';
        campaignFill.textContent = '0%';
        campaignText.textContent = `${liveCurrentMins} / ${data.required_minutes || 0} min`;
        return;
    }

    let maxReq = 0;
    let maxCur = 0;
    let currentIndex = 1;
    const targetDropId = data.drop_id || data.id;

    drops.forEach((d, index) => {
        const dropId = d.drop_id || d.id;
        if (dropId === targetDropId) {
            d.current_minutes = liveCurrentMins;
            currentIndex = index + 1;
        }

        const cur = Number(d.current_minutes) || 0;
        const req = Number(d.required_minutes) || 0;

        if (req > maxReq) {
            maxReq = req;
            maxCur = cur;
        }
    });

    if (liveCurrentMins > maxCur) maxCur = liveCurrentMins;

    if (campaignTitle && campaign.name) {
        campaignTitle.textContent = `${campaign.name} • Drop ${currentIndex}/${drops.length}`;
    }

    if (maxReq > 0) {
        const percentage = Math.min(100, Math.round((maxCur / maxReq) * 100));
        campaignFill.style.width = `${percentage}%`;
        campaignFill.textContent = `${percentage}%`;
        campaignText.textContent = `${maxCur} / ${maxReq} min`;
    } else {
        campaignFill.style.width = '0%';
        campaignFill.textContent = '0%';
        campaignText.textContent = '0 / 0 min';
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
    const rawQueue = state.activeCampaignsQueue || [];
    let validCampaigns = rawQueue.filter(c => {
        if (isClaimed(c)) return false;
        const { drops } = getCampaignAndDrops(c);
        if (drops.length === 0) return true;
        return drops.some(d => !isClaimed(d));
    });

    if (validCampaigns.length === 0 && state.currentDrop) {
        validCampaigns = [state.currentDrop];
    }

    if (validCampaigns.length === 0) return;

    if (state.campaignRotationIndex === undefined || state.campaignRotationIndex >= validCampaigns.length || state.campaignRotationIndex < 0) {
        state.campaignRotationIndex = 0;
        state.dropRotationIndex = 0;
    }

    const currentCampaign = validCampaigns[state.campaignRotationIndex];
    let drops = extractCampaignDrops(currentCampaign);

    if (drops.length === 0 && state.activeDropsQueue && state.activeDropsQueue.length > 0) {
        drops = state.activeDropsQueue;
    }

    const activeDrops = drops.filter(d => !isClaimed(d));
    const dropsToDisplay = activeDrops.length > 0 ? activeDrops : [currentCampaign];

    if (state.dropRotationIndex === undefined || state.dropRotationIndex >= dropsToDisplay.length || state.dropRotationIndex < 0) {
        state.dropRotationIndex = 0;
    }

    const currentDrop = dropsToDisplay[state.dropRotationIndex];

    switchCampaignDisplay(currentCampaign, false); 
    updateSingleDropDisplay(currentDrop, true);

    state.dropRotationIndex++;

    if (state.dropRotationIndex >= dropsToDisplay.length) {
        state.dropRotationIndex = 0;
        state.campaignRotationIndex++;
        if (state.campaignRotationIndex >= validCampaigns.length) state.campaignRotationIndex = 0;
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

// ==================== Wanted Items Rendering ====================

function formatCampaignDates(startIso, endIso) {
    if (!startIso || !endIso) return '';
    try {
        const start = new Date(startIso);
        const end = new Date(endIso);
        const formatOpts = { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' };
        return `${start.toLocaleDateString(undefined, formatOpts)} – ${end.toLocaleDateString(undefined, formatOpts)}`;
    } catch (e) {
        return '';
    }
}

function renderWantedItems(tree) {
    const container = document.getElementById('wanted-items-list');
    if (!container) return;

    state.wantedItemsTree = tree || [];

    if (!tree || tree.length === 0) {
        const emptyMsg = state.translations.gui?.wanted?.none || 'No wanted drops queued...';
        container.replaceChildren(makeElement('p', { class: 'empty-message-small' }, emptyMsg));
        updateOverallProgress();
        return;
    }

    const fragment = document.createDocumentFragment();

    tree.forEach((gameGroup, index) => {
        fragment.appendChild(createGameGroupElement(gameGroup, index));
    });

    container.replaceChildren(fragment);
    updateOverallProgress();
}

/**
 * Creates a game group DOM element containing its campaigns.
 */
function createGameGroupElement(gameGroup, index) {
    const groupEl = makeElement('div', { class: 'wanted-game-group' });

    let iconUrl = gameGroup.game_icon;
    if (iconUrl) {
        iconUrl = iconUrl.replace('{width}', '40').replace('{height}', '53');
    }

    const headerChildren = [makeElement('span', { class: 'wanted-game-index' }, `#${index + 1}`)];
    if (iconUrl) {
        headerChildren.push(makeImageElement(iconUrl, gameGroup.game_name, 'wanted-game-icon'));
    }
    headerChildren.push(makeElement('span', { class: 'wanted-game-title' }, gameGroup.game_name));

    if (gameGroup.total_remaining_minutes) {
        const hours = Math.floor(gameGroup.total_remaining_minutes / 60);
        const mins = gameGroup.total_remaining_minutes % 60;
        const timeText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

        const badgeEl = makeElement('span', { class: 'wanted-game-time-badge' });
        badgeEl.innerHTML = `${getStatusIconSVG('active')} ${timeText}`;
        headerChildren.push(badgeEl);
    }

    const headerEl = makeElement('div', { class: 'wanted-game-header' }, '', el => {
        headerChildren.forEach(child => el.appendChild(child));
    });
    groupEl.appendChild(headerEl);

    const campaignListEl = makeElement('div', { class: 'wanted-campaign-list' });
    (gameGroup.campaigns || []).forEach(campaign => {
        campaignListEl.appendChild(createCampaignCardElement(campaign));
    });

    groupEl.appendChild(campaignListEl);
    return groupEl;
}

/**
 * Creates a single campaign card element with its drop items.
 */
function createCampaignCardElement(campaign) {
    const campaignId = campaign.campaign_id || campaign.id || '';

    return makeElement('div', {
        class: 'wanted-card',
        'data-campaign-id': String(campaignId)
    }, '', cardEl => {
        const headerEl = makeElement('div', { class: 'wanted-card-header' }, '', h => {
            const titleRow = makeElement('div', { class: 'wanted-card-header-main' }, '', row => {
                row.appendChild(makeElement('a', {
                    href: campaign.url || '#',
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    class: 'wanted-card-campaign-link',
                    title: campaign.name || 'Campaign'
                }, campaign.name || 'Campaign'));

                const drops = campaign.drops || [];
                const claimedCount = campaign.claimed_drops_count ?? drops.filter(d => d.is_claimed).length;
                const totalCount = campaign.total_drops_count ?? drops.length;
                row.appendChild(makeElement('span', { class: 'wanted-campaign-badge' }, `(${claimedCount}/${totalCount})`));
            });
            h.appendChild(titleRow);

            if (typeof formatCampaignDates === 'function') {
                const dateText = formatCampaignDates(campaign.starts_at, campaign.ends_at);
                if (dateText) {
                    const datesEl = makeElement('div', { class: 'wanted-campaign-dates' });
                    datesEl.innerHTML = `${getStatusIconSVG('upcoming')} ${dateText}`;
                    h.appendChild(datesEl);
                }
            }
        });

        const dropContainer = makeElement('div', { class: 'wanted-drops-container' });
        (campaign.drops || []).forEach(drop => {
            if (typeof createDropItemElement === 'function') {
                dropContainer.appendChild(createDropItemElement(drop));
            }
        });

        const bodyEl = makeElement('div', { class: 'wanted-card-body' }, '', b => b.appendChild(dropContainer));

        cardEl.appendChild(headerEl);
        cardEl.appendChild(bodyEl);
    });
}

/**
 * Creates an individual drop item element.
 */
function createDropItemElement(drop) {
    const dropId = drop.drop_id || drop.id || drop.name;

    return makeElement('div', {
        class: `wanted-drop-item ${drop.is_claimed ? 'is-claimed' : ''}`,
        'data-drop-id': String(dropId)
    }, '', el => {
        const infoEl = makeElement('div', { class: 'wanted-drop-info' }, '', info => {
            info.appendChild(makeElement('span', { class: 'wanted-drop-name' }, drop.name));
            (drop.benefits || []).forEach(benefit => {
                info.appendChild(makeElement('span', { class: 'wanted-benefit-pill' }, benefit));
            });
        });
        el.appendChild(infoEl);

        const statusEl = makeElement('div', { class: 'wanted-drop-status' });
        const current = Math.round(drop.current_minutes || 0);
        const required = drop.required_minutes || 0;

        if (drop.is_claimed) {
            const label = state.translations?.gui?.wanted?.claimed || 'Claimed';
            statusEl.innerHTML = `<span class="status-tag tag-claimed">${getStatusIconSVG('drop-claimed')} ${label}</span>`;
        } else if (drop.can_claim || (required > 0 && current >= required)) {
            const label = state.translations?.gui?.wanted?.ready || 'Ready to claim!';
            statusEl.innerHTML = `<span class="status-tag tag-ready">${getStatusIconSVG('drop-ready')} ${label}</span>`;
        } else if (required > 0) {
            statusEl.innerHTML = `<span class="status-tag tag-progress">${getStatusIconSVG('drop-active')} ${current} / ${required} min</span>`;
        }
        el.appendChild(statusEl);
    });
}
