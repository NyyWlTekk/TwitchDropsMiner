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

    // Helper to normalize drops structure and inject parent campaign ID into children
    const normalizeDrops = (dropsData, parentCampId) => {
        if (!dropsData) return [];
        const dropsArr = Array.isArray(dropsData) ? dropsData : Object.values(dropsData);
        
        return dropsArr.map(drop => {
            if (!drop || typeof drop !== 'object') return drop;
            const effectiveCampId = drop.campaign_id || drop.campaignId || parentCampId || '';
            return effectiveCampId ? { ...drop, campaign_id: effectiveCampId, campaignId: effectiveCampId } : drop;
        });
    };

    // Extract campaign ID with fallback for both camelCase and snake_case
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

        // 1. Direct O(1) lookup attempt if campaigns is an object keyed by ID
        if (!Array.isArray(campaigns) && campaigns[itemCampId]) {
            found = campaigns[itemCampId];
        } else {
            // 2. Fast iteration without allocating Object.values() array
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

    // Fallback: single drop item (ensure campaign ID is preserved)
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
 * Helper to extract image URL from any drop or reward object structure
 */
function extractUrlFromObject(obj) {
    if (!obj) return null;

    // Direct properties lookup
    let url = obj.image_url || obj.reward_image_url || obj.icon_url || obj.benefit_icon_url || 
              obj.image || obj.thumbnail || obj.url;
    if (url) return url;

    // Nested reward or benefit objects
    if (obj.reward) {
        url = obj.reward.image_url || obj.reward.icon_url;
        if (url) return url;
    }

    if (obj.benefit) {
        url = obj.benefit.image_url || obj.benefit.icon_url;
        if (url) return url;
    }

    // Benefits array fallback
    const benefits = obj.benefits;
    if (Array.isArray(benefits) && benefits.length > 0) {
        const b = benefits[0];
        if (b) {
            url = b.image_url || b.icon_url || b.thumbnail || b.url || b.asset_url;
            if (url) return url;
        }
    }

    // GraphQL / Edge structures
    const benefitEdges = obj.benefit_edges;
    if (Array.isArray(benefitEdges) && benefitEdges.length > 0) {
        const node = benefitEdges[0]?.node;
        if (node) {
            url = node.asset_url || node.image_url;
            if (url) return url;
        }
    }

    return null;
}

/**
 * Resolves drop reward/asset image URL accurately and efficiently
 */
function resolveDropRewardImageUrl(data, targetId = null) {
    if (!data) return null;

    // 1. Try resolving directly from the passed data object
    let rewardImgUrl = extractUrlFromObject(data);
    if (rewardImgUrl) return rewardImgUrl;

    // 2. Fallback lookup in state.campaigns if image is missing and IDs are provided
    const campId = data.campaign_id;
    if (targetId && state && state.campaigns && campId) {
        let camp = null;
        const campaigns = state.campaigns;

        // O(1) lookup attempt
        if (!Array.isArray(campaigns) && campaigns[campId]) {
            camp = campaigns[campId];
        } else if (Array.isArray(campaigns)) {
            for (let i = 0; i < campaigns.length; i++) {
                const c = campaigns[i];
                if (c && (c.id === campId || c.campaign_id === campId)) {
                    camp = c;
                    break;
                }
            }
        } else {
            for (const key in campaigns) {
                if (Object.prototype.hasOwnProperty.call(campaigns, key)) {
                    const c = campaigns[key];
                    if (c && (c.id === campId || c.campaign_id === campId)) {
                        camp = c;
                        break;
                    }
                }
            }
        }

        // Fast drop lookup inside campaign drops array
        if (camp && camp.drops && Array.isArray(camp.drops)) {
            const drops = camp.drops;
            const dropsLen = drops.length;
            for (let i = 0; i < dropsLen; i++) {
                const d = drops[i];
                if (d && (d.id === targetId || d.drop_id === targetId)) {
                    rewardImgUrl = extractUrlFromObject(d);
                    if (rewardImgUrl) break;
                }
            }
        }
    }

    return rewardImgUrl;
}

// Tracking Set to prevent re-instantiating images for already requested URLs
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

        // Mark URL as preloaded globally
        _preloadedUrls.add(url);

        // Populate global imageCache template if available
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
 * Unified entry point for updating drop progress in active queue and wanted tree simultaneously
 */
function syncAnyDropProgress(incomingIdStr, data) {
    if (!state) return;

    if (!data || typeof data !== 'object' || data.gathering || data.current_minutes === undefined) {
        return;
    }

    if (Array.isArray(state.activeDropsQueue)) {
        const activeQueueDrop = state.activeDropsQueue.find(d => String(d.drop_id || d.id) === incomingIdStr);
        if (activeQueueDrop) {
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
        }
    }

    if (Array.isArray(state.wantedItemsTree)) {
        if (typeof syncWantedItemsProgress === 'function') {
            syncWantedItemsProgress({
                drop_id: incomingIdStr,
                ...data
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

    // Fast grouping using Map to avoid Object.values allocation
    const gamesMap = new Map();
    const campaigns = state.campaigns;

    // Helper to process a single campaign entry
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

    // Iterate campaigns based on data type without creating array copies
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

    // Aggregate stats per game group
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

    // 1. Reset BOTH RAM state variants
    state.currentDrop = null;
    state.current_drop = null;
    state.activeDropsQueue = [];
    dropTotalSeconds = 0;
    
    if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }

    // 2. Reset progress bar UI elements
    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    
    if (noDropMessage) noDropMessage.style.display = 'block';
    if (dropInfo) dropInfo.style.display = 'none';

    // Clear game header and reward icon
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

    // 3. Clear active visual classes
    if (typeof clearWantedActiveState === 'function') {
        clearWantedActiveState();
    }

    // 4. Re-render wanted tree safely without triggering cascade clears
    if (typeof renderWantedItems === 'function' && Array.isArray(state.wantedItemsTree)) {
        renderWantedItems(state.wantedItemsTree);
    }
}

// společná funkce pro update času pro - WANTED A PROGRESS BARY

function updateRemainingTime(initialSeconds, currentData = null) {
    if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }

    const drop = currentData || state.currentDrop || state.current_drop || {};
    const timeEl = document.getElementById('progress-time');
    
    if (timeEl) {
        const remaining = Math.max(0, Math.floor(initialSeconds));
        const reqSecs = Number(drop.required_minutes || 0) * 60;
        timeEl.textContent = `Time remaining: ${formatTime(remaining)} / ${formatTime(reqSecs)}`;
    }

    if (state.currentDrop) state.currentDrop.remaining_seconds = Math.max(0, Math.floor(initialSeconds));
    if (state.current_drop) state.current_drop.remaining_seconds = Math.max(0, Math.floor(initialSeconds));

    if (typeof syncWantedItemsProgress === 'function') {
        const treeUpdated = syncWantedItemsProgress(drop);
        if (treeUpdated && typeof renderWantedItems === 'function' && Array.isArray(state.wantedItemsTree)) {
            renderWantedItems(state.wantedItemsTree);
        }
    }
}

function updateDropTitle(data) {
    const dropNameEl = document.getElementById('drop-name');
    if (!dropNameEl) return;

    const displayGameName = data.game_name || 'Drop';

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

// Fallback cache map if global imageCache is not defined in the scope
const _fallbackImageCache = (typeof imageCache !== 'undefined') ? imageCache : new Map();

/**
 * Helper to retrieve or create cached image DOM elements safely and efficiently
 */
function getCachedImage(url, alt, className, styles = {}) {
    if (!url) return null;

    // Use global imageCache if defined, otherwise fallback to local Map
    const cache = (typeof imageCache !== 'undefined') ? imageCache : _fallbackImageCache;

    // Retrieve base template image element from cache or create a new clean one
    let templateImg = cache.get(url);
    if (!templateImg) {
        templateImg = document.createElement('img');
        templateImg.src = url;
        cache.set(url, templateImg);
    }

    // Clone base template (false is faster as <img> elements have no child nodes)
    const imgEl = templateImg.cloneNode(false);

    // Apply specific attributes for this call
    if (alt) imgEl.alt = alt;
    if (className) imgEl.className = className;

    // Apply inline styles only if styles object is populated
    if (styles && typeof styles === 'object') {
        const styleKeys = Object.keys(styles);
        if (styleKeys.length > 0) {
            Object.assign(imgEl.style, styles);
        }
    }

    return imgEl;
}

/**
 * Resets and hides the header container when invalid or empty data is provided.
 */
function resetDropHeader(dropGameEl, reason = 'invalid or missing data') {
    if (lastDropHeaderHash !== 'empty') {
        console.log(`[DropHeader Debug] Resetting header due to: ${reason}`);
        dropGameEl.innerHTML = '';
        dropGameEl.style.display = 'none';
        lastDropHeaderHash = 'empty';
    }
}

/**
 * Extracts campaign information, title text, subtitle, and effective campaign ID.
 */
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
    const subTextContent = data.drop_name || data.dropName || '';

    return { foundCampaign, effectiveCampaignId, titleText, subTextContent };
}

/**
 * Extracts and builds the box art icon URL from data or fallback campaign.
 */
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

/**
 * Ensures cached DOM containers exist and are properly attached to the parent.
 */
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
        console.log('[DropHeader Debug] DOM element missing container! Invoking replaceChildren (DOM reset/rebuild).', {
            hasIconContainer: dropGameEl.contains(cachedIconContainer),
            hasInfoTextDiv: dropGameEl.contains(cachedInfoTextDiv)
        });
        dropGameEl.replaceChildren(cachedIconContainer, cachedInfoTextDiv);
    }
}

/**
 * Updates the game icon image element inside cachedIconContainer.
 */
function updateHeaderIcon(iconUrl) {
    let imgEl = cachedIconContainer.querySelector('img');
    if (iconUrl) {
        if (!imgEl) {
            console.log('[DropHeader Debug] <img> element missing inside cachedIconContainer. Creating new <img> tag.');
            imgEl = document.createElement('img');
            imgEl.className = 'game-icon';
            imgEl.style.width = '100%';
            imgEl.style.height = '100%';
            imgEl.style.objectFit = 'cover';
            imgEl.style.display = 'block';
            cachedIconContainer.appendChild(imgEl);
        }
        if (imgEl.src !== iconUrl) {
            console.log(`[DropHeader Debug] Image src updated from "${imgEl.src}" to "${iconUrl}"`);
            imgEl.src = iconUrl;
        }
    } else if (imgEl) {
        console.log('[DropHeader Debug] Removing <img> element because iconUrl is null.');
        imgEl.remove();
    }
}

/**
 * Updates the main title and link anchor node inside cachedInfoTextDiv.
 */
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

/**
 * Updates subtitle node inside cachedInfoTextDiv.
 */
function updateHeaderSubtitle(subTextContent) {
    let subText = cachedInfoTextDiv.querySelector('.drop-sub-name');
    if (!subText) {
        console.log('[DropHeader Debug] Subtitle node missing. Creating span.drop-sub-name.');
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

/**
 * Main render function for the drop game header.
 */
function renderDropGameHeader(data, force = false) {
    const dropGameEl = document.getElementById('drop-game');
    if (!dropGameEl) return;

    // 1. Data sanity check
    if (!data || typeof data !== 'object') {
        resetDropHeader(dropGameEl, 'invalid data object');
        return;
    }

    // 2. Resolve campaign details & titles
    const { foundCampaign, effectiveCampaignId, titleText, subTextContent } = resolveCampaignData(data);

    if (!titleText && !effectiveCampaignId) {
        resetDropHeader(dropGameEl, 'missing both titleText and effectiveCampaignId');
        return;
    }

    // 3. Extract icon image URL
    const iconUrl = extractIconUrl(data, foundCampaign);

    // 4. Ensure container structure is ready in DOM
    ensureHeaderContainers(dropGameEl);

    // 5. Hash Guard to prevent redundant updates
    const currentHash = `${effectiveCampaignId}_${titleText}_${subTextContent}_${iconUrl}`;
    if (!force && lastDropHeaderHash === currentHash) {
        return;
    }

    console.log(`[DropHeader Debug] Executing FULL UPDATE. force=${force}`, {
        oldHash: lastDropHeaderHash,
        newHash: currentHash
    });

    lastDropHeaderHash = currentHash;

    // 6. Update individual DOM components
    updateHeaderIcon(iconUrl);
    updateHeaderTitle(effectiveCampaignId, titleText);
    updateHeaderSubtitle(subTextContent);
}

/**
 * Resets the drop label text when invalid data is provided.
 */
function resetDropCardLayout(currentDropLabel, reason = 'invalid data') {
    if (lastDropCardLayoutHash !== 'empty') {
        console.log(`[DropCardLayout Debug] Resetting drop card layout due to: ${reason}`);
        currentDropLabel.textContent = '';
        lastDropCardLayoutHash = 'empty';
    }
}

/**
 * Computes active drop queue, sorts by required minutes, and calculates current index and queue length.
 */
function calculateDropQueueInfo(data, currentId) {
    let activeDrops = [];
    const { drops } = typeof getCampaignAndDrops === 'function' 
        ? getCampaignAndDrops(data) 
        : { drops: [] };
    
    if (drops && drops.length > 0) {
        activeDrops = drops.filter(d => typeof isClaimed === 'function' ? !isClaimed(d) : true);
    }
    if (activeDrops.length === 0 && Array.isArray(state?.activeDropsQueue) && state.activeDropsQueue.length > 0) {
        activeDrops = [...state.activeDropsQueue];
    }

    // Seřazení od nejmenšího času po největší
    const getDropMinutes = (d) => Number(d.required_minutes || d.total_minutes || d.requiredMinutes || 0);
    activeDrops.sort((a, b) => getDropMinutes(a) - getDropMinutes(b));

    const dropQueueLen = activeDrops.length > 0 ? activeDrops.length : 1;
    let dropIdx = 1;

    if (activeDrops.length > 0 && currentId) {
        const foundIdx = activeDrops.findIndex(d => (d.drop_id || d.id) === currentId);
        if (foundIdx !== -1) dropIdx = foundIdx + 1;
    }

    return { dropIdx, dropQueueLen };
}

/**
 * Finds or establishes the outer .drop-card-container element.
 */
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
                    console.log('[DropCardLayout Debug] Established new .drop-card-container parent.');
                    break;
                }
                parent = parent.parentElement;
            }
        }
    }
    return cardOuter;
}

/**
 * Builds and attaches the right column structure inside cardOuter if missing.
 */
function ensureDropCardRightCol(cardOuter) {
    let rightCol = cardOuter.querySelector('#drop-card-right-col');
    if (!rightCol) {
        console.log('[DropCardLayout Debug] Creating #drop-card-right-col and restructuring layout to 2 columns.');
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
 * Resolves the left image element or placeholder element for the drop card.
 */
function resolveDropCardLeftImage(rawImgUrl, dropName) {
    let targetLeftEl = null;

    if (rawImgUrl && typeof getCachedImage === 'function') {
        targetLeftEl = getCachedImage(rawImgUrl, dropName, 'drop-reward-icon', {
            width: '72px',
            height: 'auto',
            maxHeight: '100%',
            alignSelf: 'center',
            objectFit: 'contain',
            borderRadius: '6px',
            flexShrink: '0',
            display: 'block'
        });
    }

    if (!targetLeftEl) {
        console.log('[DropCardLayout Debug] Image URL missing or getCachedImage unavailable. Creating placeholder.');
        targetLeftEl = document.createElement('div');
        targetLeftEl.className = 'image-placeholder';
    }

    targetLeftEl.id = 'drop-card-left-img';
    return targetLeftEl;
}

/**
 * Atomically swaps or appends the left image element in the DOM.
 */
function updateDropCardLeftImage(cardOuter, targetLeftEl, rightCol) {
    const existingLeftImg = cardOuter.querySelector('#drop-card-left-img');
    if (existingLeftImg !== targetLeftEl) {
        console.log('[DropCardLayout Debug] Swapping left image element in DOM.');
        if (existingLeftImg) {
            existingLeftImg.replaceWith(targetLeftEl);
        } else {
            cardOuter.insertBefore(targetLeftEl, rightCol);
        }
    }
}

let lastDropCardLayoutHash = null;

/**
 * Main render function for the drop card layout.
 */
function renderDropCardLayout(data, rewardImgUrl, force = false) {
    const currentDropLabel = document.getElementById('current-drop-label');
    if (!currentDropLabel) return;

    // 1. Data sanity check
    if (!data || typeof data !== 'object') {
        resetDropCardLayout(currentDropLabel, 'invalid data object');
        return;
    }

    const currentId = data.drop_id || data.id || '';
    const dropName = data.drop_name || '';
    const rawImgUrl = rewardImgUrl || '';

    // 2. Hash Guard
    const currentHash = `${currentId}_${dropName}_${rawImgUrl}`;
    if (!force && lastDropCardLayoutHash === currentHash) {
        return;
    }

    console.log(`[DropCardLayout Debug] Executing FULL UPDATE. force=${force}`, {
        oldHash: lastDropCardLayoutHash,
        newHash: currentHash
    });

    // 3. Compute queue position & update label
    const { dropIdx, dropQueueLen } = calculateDropQueueInfo(data, currentId);
    const newLabelText = `⚡ Drop (${dropIdx}/${dropQueueLen}): ${dropName}`;
    if (currentDropLabel.textContent !== newLabelText) {
        currentDropLabel.textContent = newLabelText;
    }

    // 4. Locate outer container
    const cardOuter = ensureDropCardOuterContainer(currentDropLabel);
    if (!cardOuter) {
        console.log('[DropCardLayout Debug] Could not locate or create card outer container.');
        return;
    }

    // 5. Build/Ensure right column layout
    const rightCol = ensureDropCardRightCol(cardOuter);

    // 6. Resolve and update left image element
    const targetLeftEl = resolveDropCardLeftImage(rawImgUrl, dropName);
    updateDropCardLeftImage(cardOuter, targetLeftEl, rightCol);

    // 7. Save successful render hash
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

function updateGameHeaderTimeBadge(groupIdx, remainingMinutes) {
    const groups = document.querySelectorAll('.wanted-game-group');
    if (!groups[groupIdx]) return;

    const badge = groups[groupIdx].querySelector('.wanted-game-time-badge');
    if (badge) {
        badge.textContent = remainingMinutes > 0 ? `${remainingMinutes} min` : 'Done';
    }
}

// ==========================================
// 5. CORE LOGIC & ROTATION
// ==========================================

/**
 * Updates the single active drop display with caching, queue matching, and DOM rendering.
 */
function updateSingleDropDisplay(data, isFromRotation = false) {
    const targetId = data.drop_id || data.id;

    const activeDrop = state.currentDrop || state.current_drop;
    if (activeDrop && (activeDrop.drop_id || activeDrop.id) === targetId) {
        data = { ...activeDrop, ...data };
    } else if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
        const queueItem = state.activeDropsQueue.find(d => (d.drop_id || d.id) === targetId);
        if (queueItem) data = { ...queueItem, ...data };
    }

    if (!isFromRotation && state.rotationTimer) {
        return;
    }

    const reqMins = Number(data.required_minutes ?? 0);
    const curMins = Number(data.current_minutes ?? 0);

    if (isClaimed(data) || (reqMins > 0 && curMins >= reqMins)) {
        logProgressOnce(`drop_finished_${targetId}`, `🎉 [DROP COMPLETE] Drop '${data.drop_name || targetId}' is claimed or finished. Removing from queue.`);
        if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
            const dropIdToClean = data.drop_id || data.id;
            state.activeDropsQueue = state.activeDropsQueue.filter(d => (d.drop_id || d.id) !== dropIdToClean);
        }
        startCombinedRotation(true);
        return;
    }

    // Direct replacement of both state variables
    state.currentDrop = data;
    state.current_drop = data;

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
}

function switchCampaignDisplay(data, isManualSwitch = false) {
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
        if (window._lastValidActiveCampaignsQueue && window._lastValidActiveCampaignsQueue.length > 0) {
            state.activeCampaignsQueue = window._lastValidActiveCampaignsQueue;
        }
    } else {
        window._lastValidActiveCampaignsQueue = state.activeCampaignsQueue;
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

    updateSingleDropDisplay(initialActiveDrop, dropChanged);
}

/**
 * Updates UI and state with incoming drop progress data.
 */
function updateDropProgress(dropData) {
    if (!dropData || typeof dropData !== 'object' || Object.keys(dropData).length === 0) {
        logProgressOnce('warn_empty_data', '⚠️ [UI UPDATE] Empty dropData received. Clearing drop UI.', true);
        if (typeof clearDropProgress === 'function') clearDropProgress();
        return;
    }

    const validDrop = dropData;
    const dropGame = validDrop.game_name || validDrop.game || validDrop.game_title;
    
    let watchedGame = null;
    if (typeof getWatchedChannelObject === 'function') {
        const watchedObj = getWatchedChannelObject();
        if (watchedObj) {
            watchedGame = watchedObj.game_name || watchedObj.game || watchedObj.game_title;
        }
    } else if (typeof state !== 'undefined' && state.watching_channel && state.channels) {
        let chObj = null;
        if (Array.isArray(state.channels)) {
            chObj = state.channels.find(c => 
                String(c.id) === String(state.watching_channel) || 
                c.name === state.watching_channel ||
                c.displayName === state.watching_channel
            );
        } else if (typeof state.channels === 'object') {
            chObj = state.channels[state.watching_channel] || state.channels[String(state.watching_channel)];
        }
        if (chObj) {
            watchedGame = chObj.game_name || chObj.game || chObj.game_title;
        }
    }

    // STRICT GUARD: Refuse rendering if watched channel is playing a different game
    if (watchedGame && dropGame && watchedGame.trim().toLowerCase() !== dropGame.trim().toLowerCase()) {
        logProgressOnce(
            `mismatch_${dropGame}_vs_${watchedGame}`,
            `🚨 [UI GUARD MISMATCH] Refusing to render drop for '${dropGame}' because watched channel plays '${watchedGame}'. Clearing drop UI.`,
            true
        );
        if (typeof clearDropProgress === 'function') clearDropProgress();
        return;
    }

    logProgressOnce(`render_${dropGame}`, `✅ [UI UPDATE] Rendering drop progress for '${dropGame || 'Unknown Game'}'`);

    // Process live mining queue
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

    // Save state (explicit copy into both variables)
    const incomingIdStr = String(validDrop.drop_id || validDrop.id);
    state.currentDrop = { ...validDrop };
    state.current_drop = { ...validDrop };

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'none';
    if (dropInfo) dropInfo.style.display = 'block';

    const campaignTitleEl = document.getElementById('campaign-title') || document.querySelector('.campaign-header-title');
    if (campaignTitleEl && dropGame) {
        campaignTitleEl.textContent = `${dropGame} (1/1)`;
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
    if (timeRemainingEl && (validDrop.current_minutes === undefined || validDrop.current_minutes === 0)) {
        if (!validDrop.time_remaining) {
            timeRemainingEl.style.display = 'none';
        } else {
            timeRemainingEl.style.display = 'block';
        }
    }

    if (typeof syncAnyDropProgress === 'function') {
        syncAnyDropProgress(incomingIdStr, validDrop);
    }

    if (typeof updateSingleDropDisplay === 'function') {
        updateSingleDropDisplay(validDrop, false);
    }

    if (typeof updateCampaignProgressData === 'function') {
        updateCampaignProgressData(validDrop, validDrop.current_minutes || 0);
    }

    if (typeof syncWantedItemsProgress === 'function') {
        const treeUpdated = syncWantedItemsProgress({
            drop_id: incomingIdStr,
            ...validDrop
        });
        if (treeUpdated && typeof renderWantedItems === 'function') {
            renderWantedItems(state.wantedItemsTree);
        }
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
    const targetDropId = data.drop_id || data.id;

    let totalCampaignCurrent = 0;
    let totalCampaignRequired = 0;

    if (state.campaigns && data.campaign_id) {
        // Direct lookup with fallback loop to avoid array allocations (Object.values)
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

            let maxCurrent = currentDropCurrent;
            let maxRequired = 0;
            let dropVisualIndex = 1;

            // Single pass iteration replacing multiple forEach, map, and findIndex calls
            for (let i = 0; i < dropsCount; i++) {
                const d = drops[i];
                const dId = d.drop_id || d.id;

                if (dId === targetDropId) {
                    d.current_minutes = currentDropCurrent;
                    dropVisualIndex = i + 1;
                }

                const curMins = Number(d.current_minutes) || 0;
                const reqMins = Number(d.required_minutes || d.duration || d.total_minutes) || 0;

                if (curMins > maxCurrent) maxCurrent = curMins;
                if (reqMins > maxRequired) maxRequired = reqMins;
            }

            totalCampaignCurrent = maxCurrent;
            totalCampaignRequired = dropsCount > 0 ? maxRequired : 0;

            // Update remaining drops in array
            for (let i = 0; i < dropsCount; i++) {
                drops[i].current_minutes = maxCurrent;
            }

            if (campaignTitle) {
                const newTitle = `${campName} • Drop ${dropVisualIndex}/${dropsCount}`;
                if (campaignTitle.textContent !== newTitle) {
                    campaignTitle.textContent = newTitle;
                }
            }
        }
    }

    if (totalCampaignRequired === 0) {
        totalCampaignCurrent = currentDropCurrent;
        totalCampaignRequired = Number(data.required_minutes || data.duration || data.total_minutes) || 0;
    }

    // Apply updates and minimize DOM mutations by checking current state
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
        if (campaignFill.style.width !== '0%') campaignFill.style.width = '0%';
        if (campaignFill.textContent !== '') campaignFill.textContent = '';
        if (campaignText.textContent !== '') campaignText.textContent = '';
    }

    // Re-render wanted queue items when progress updates
    if (typeof state !== 'undefined' && typeof state.wantedItemsTree !== 'undefined' && typeof renderWantedItems === 'function') {
        renderWantedItems(state.wantedItemsTree);
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
    let validCampaigns = state.activeCampaignsQueue || [];

    const activeDrop = state.currentDrop || state.current_drop;
    if (validCampaigns.length === 0 && activeDrop && activeDrop.campaign_id && state.campaigns) {
        const fallbackCamp = state.campaigns[activeDrop.campaign_id];
        if (fallbackCamp) validCampaigns = [fallbackCamp];
    }

    // Get currently watched game
    let watchedGame = null;
    if (typeof getWatchedChannelObject === 'function') {
        const wObj = getWatchedChannelObject();
        if (wObj) watchedGame = wObj.game_name || wObj.game || wObj.game_title;
    }

    // Filter out completed, ignored, or mismatched game campaigns from rotation
    validCampaigns = validCampaigns.filter(c => {
        if (!c || isClaimed(c)) return false;

        const gameName = c.game_name || c.game || c.gameName;
        
        // Skip ignored games
        if (typeof isGameIgnored === 'function' && isGameIgnored(gameName)) {
            return false;
        }

        // ROTATION GUARD: Do not start rotation for a game other than watched!
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

    switchCampaignDisplay(currentCampaign, false);

    if (activeDrops.length > 0) {
        if (state.dropRotationIndex === undefined || state.dropRotationIndex >= activeDrops.length || state.dropRotationIndex < 0) {
            state.dropRotationIndex = 0;
        }
        
        const currentDrop = activeDrops[state.dropRotationIndex];
        
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

let isExecutingRotation = false;

/**
 * Initializes drop rotation interval safely
 */
function startCombinedRotation(forceRestart = true) {
    if (state.rotationTimer && !forceRestart) return; 

    if (state.rotationTimer) {
        clearInterval(state.rotationTimer);
        state.rotationTimer = null;
    }

    logProgressOnce('rot_start', `🔄 [ROTATION] Combined rotation started (interval: 4000ms, forceRestart: ${forceRestart})`);
    state.rotationTimer = setInterval(executeRotationStep, 4000);
    
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
