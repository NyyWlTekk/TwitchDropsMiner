/////////////////////////////////////////////////////////////////
// WANTED QUEUE
/////////////////////////////////////////////////////////////////

// ==================== 1. Core UI Rendering ====================

let wantedRenderDebounceTimer = null;
let lastRenderedTreeHash = '';

/**
 * Debounced queue rendering to batch rapid socket and channel updates into a single frame.
 */
function renderWantedItems(tree, force = false) {
    if (tree) {
        state.wantedItemsTree = tree;
    }

    if (force) {
        if (wantedRenderDebounceTimer) {
            clearTimeout(wantedRenderDebounceTimer);
            wantedRenderDebounceTimer = null;
        }
        lastRenderedTreeHash = '';
        performRenderWantedItems(state.wantedItemsTree);
        return;
    }

    if (wantedRenderDebounceTimer) {
        clearTimeout(wantedRenderDebounceTimer);
    }

    wantedRenderDebounceTimer = setTimeout(() => {
        wantedRenderDebounceTimer = null;
        performRenderWantedItems(state.wantedItemsTree);
    }, 200);
}

/**
 * Internal direct DOM renderer with structural fingerprint guard to eliminate redundant DOM rebuilds.
 */
function performRenderWantedItems(tree) {
    const container = document.getElementById('wanted-items-list');
    if (!container) {
        console.warn('[WantedQueue] Element #wanted-items-list not found in DOM');
        return;
    }

    if (!tree || tree.length === 0) {
        lastRenderedTreeHash = 'empty';
        console.log('[WantedQueue] Queue is empty, rendering default empty message');
        const emptyMsg = state.translations?.gui?.wanted?.none || 'No wanted drops queued...';
        container.replaceChildren(makeElement('p', { class: 'empty-message-small' }, emptyMsg));
        if (typeof updateOverallProgress === 'function') updateOverallProgress();
        return;
    }

    // Generate lightweight fingerprint of the queue structure
    const currentHash = JSON.stringify(tree.map(g => ({
        name: g.game_name,
        cCount: (g.campaigns || []).length,
        rem: g.total_remaining_minutes,
        pActive: g.isParallelActive
    })));

    // Skip DOM destruction if the structure has not changed
    if (currentHash === lastRenderedTreeHash && container.children.length > 0) {
        return;
    }
    lastRenderedTreeHash = currentHash;

    console.log(`[WantedQueue] Rendering queue for ${tree.length} game group(s)`);
    const fragment = document.createDocumentFragment();

    tree.forEach((gameGroup, index) => {
        fragment.appendChild(renderGameGroupElement(gameGroup, index));
    });

    container.replaceChildren(fragment);
    if (typeof updateOverallProgress === 'function') updateOverallProgress();
}


// ==================== 2. DOM Builders & Components ====================

/**
 * Evaluates the mining state of a campaign and returns relevant status flags and CSS classes.
 */
function evaluateCampaignMiningState(campaign, gameName) {
    const campaignId = campaign.campaign_id || campaign.id || '';
    const drops = campaign.drops || campaign.drop_list || campaign.items || [];

    const isActivelyMining = checkIfCampaignIsActive(campaignId, drops, gameName);
    const hasProgress = checkIfCampaignHasProgress(drops, isActivelyMining);

    let cardClasses = 'wanted-card';
    if (isActivelyMining) {
        cardClasses += ' active-mining';
    } else if (hasProgress) {
        cardClasses += ' in-progress';
    }

    return {
        campaignId,
        drops,
        isActivelyMining,
        hasProgress,
        cardClasses
    };
}

/**
 * Creates a visual status badge/indicator element for active mining or progress state.
 */
function renderCampaignStatusIndicatorElement(isActivelyMining, hasProgress) {
    const t = state?.translations?.gui?.wanted;

    if (isActivelyMining) {
        const badgeEl = makeElement('span', { 
            class: 'status-tag tag-mining'
        });
        const label = t?.mining || 'Mining';
        badgeEl.innerHTML = `${getStatusIconSVG('drop-active')} ${label}`;
        return badgeEl;
    }
    
    if (hasProgress) {
        const badgeEl = makeElement('span', { 
            class: 'status-tag tag-in-progress'
        });
        const label = t?.in_progress || 'In Progress';
        badgeEl.innerHTML = `${getStatusIconSVG('drop-progress')} ${label}`;
        return badgeEl;
    }

    return null;
}

/**
 * Creates a game group DOM element containing its campaigns.
 */
function renderGameGroupElement(gameGroup, index) {
    const gameName = gameGroup.game_name || gameGroup.name || '';
    const groupEl = makeElement('div', { 
        class: 'wanted-game-group',
        'data-game-name': gameName 
    });

    let iconUrl = gameGroup.game_icon || gameGroup.icon || gameGroup.box_art_url;
    if (iconUrl) {
        iconUrl = iconUrl.replace('{width}', '40').replace('{height}', '53');
    }

    const headerChildren = [makeElement('span', { class: 'wanted-game-index' }, `#${index + 1}`)];
    if (iconUrl) {
        headerChildren.push(makeImageElement(iconUrl, gameName, 'wanted-game-icon'));
    }
    headerChildren.push(makeElement('span', { class: 'wanted-game-title' }, gameName));

    if (gameGroup.total_remaining_minutes !== undefined) {
        const hours = Math.floor(gameGroup.total_remaining_minutes / 60);
        const mins = gameGroup.total_remaining_minutes % 60;
        const timeText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

        const badgeEl = makeElement('span', { 
            class: 'wanted-game-time-badge',
            'data-game-badge': gameName 
        });
        badgeEl.innerHTML = `${getStatusIconSVG('active')} ${timeText}`;
        headerChildren.push(badgeEl);
    }

    const headerEl = makeElement('div', { class: 'wanted-game-header' }, '', el => {
        headerChildren.forEach(child => el.appendChild(child));
    });
    groupEl.appendChild(headerEl);

    const campaignListEl = makeElement('div', { class: 'wanted-campaign-list' });
    const campaigns = gameGroup.campaigns || gameGroup.campaign_list || [];
    
    campaigns.forEach(campaign => {
        campaignListEl.appendChild(renderCampaignCardElement(campaign, gameName));
    });

    groupEl.appendChild(campaignListEl);
    return groupEl;
}

/**
 * Creates a single campaign card element with its drop items using modular helpers.
 */
function renderCampaignCardElement(campaign, gameName) {
    const campaignState = evaluateCampaignMiningState(campaign, gameName);

    return makeElement('div', {
        class: campaignState.cardClasses,
        'data-campaign-id': String(campaignState.campaignId)
    }, '', cardEl => {
        const headerEl = renderCampaignHeaderElement(campaign, campaignState.drops, campaignState);
        const bodyEl = renderCampaignBodyElement(campaignState.drops, campaignState);

        cardEl.appendChild(headerEl);
        cardEl.appendChild(bodyEl);
    });
}

/**
 * Updates or creates the campaign card header element including titles, badges, and dates.
 */
function renderCampaignHeaderElement(campaign, drops, campaignState = null, existingHeader = null) {
    if (!campaign || typeof campaign !== 'object') return null;

    const claimedCount = typeof calculateClaimedDropsCount === 'function' 
        ? calculateClaimedDropsCount(campaign, drops)
        : (drops || []).filter(d => Boolean(d.is_claimed ?? d.isClaimed ?? d.claimed)).length;
    
    const totalCount = campaign.total_drops_count || campaign.totalDropsCount || (drops ? drops.length : 0);
    const campaignName = campaign.name || campaign.campaign_name || 'Campaign';
    const campaignUrl = campaign.url || '#';
    const startsAt = campaign.starts_at || campaign.startsAt || '';
    const endsAt = campaign.ends_at || campaign.endsAt || '';

    // Complete Hash: Includes absolutely all variables that affect the HTML output
    const currentHash = `${campaign.id || campaignName}_${campaignUrl}_${claimedCount}_${totalCount}_${campaignState?.isActivelyMining}_${campaignState?.hasProgress}_${startsAt}_${endsAt}`;

    // If the existing header has the same hash, return it and stop the re-render
    if (existingHeader && existingHeader.dataset.hash === currentHash) {
        return existingHeader;
    }

    console.log(`[CampaignHeader Debug] Executing FULL UPDATE for header: ${campaignName}`);

    const newHeader = makeElement('div', { class: 'wanted-card-header' }, '', h => {
        const titleRow = makeElement('div', { class: 'wanted-card-header-main' }, '', row => {
            row.appendChild(makeElement('a', {
                href: campaignUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'wanted-card-campaign-link',
                title: campaignName
            }, campaignName));

            row.appendChild(makeElement('span', { class: 'wanted-campaign-badge' }, `(${claimedCount}/${totalCount})`));

            if (campaignState) {
                const statusBadge = renderCampaignStatusIndicatorElement(campaignState.isActivelyMining, campaignState.hasProgress);
                if (statusBadge) {
                    row.appendChild(statusBadge);
                }
            }
        });
        h.appendChild(titleRow);

        if (typeof formatCampaignDates === 'function') {
            const dateText = formatCampaignDates(startsAt, endsAt);
            if (dateText) {
                const datesEl = makeElement('div', { class: 'wanted-campaign-dates' });
                datesEl.innerHTML = `${getStatusIconSVG('upcoming')} ${dateText}`;
                h.appendChild(datesEl);
            }
        }
    });

    // Save the new hash to the element
    newHeader.dataset.hash = currentHash;

    // If an old element connected to the DOM was passed, replace it
    if (existingHeader && existingHeader.parentNode) {
        existingHeader.replaceWith(newHeader);
    }

    return newHeader;
}

/**
 * Creates the body element containing all drop items container.
 */
function renderCampaignBodyElement(drops, campaignState = null) {
    const dropContainer = makeElement('div', { class: 'wanted-drops-container' });

    const sortedDrops = [...(drops || [])].sort((a, b) => {
        const timeA = Number(a.required_minutes ?? a.requiredMinutes ?? a.required_time ?? a.needed_minutes ?? a.duration ?? a.total_minutes ?? 0);
        const timeB = Number(b.required_minutes ?? b.requiredMinutes ?? b.required_time ?? b.needed_minutes ?? b.duration ?? b.total_minutes ?? 0);
        return timeA - timeB;
    });

    sortedDrops.forEach((drop, index) => {
        if (typeof renderDropItemElement === 'function') {
            dropContainer.appendChild(renderDropItemElement(drop, index + 1, campaignState));
        }
    });

    return makeElement('div', { class: 'wanted-card-body' }, '', b => b.appendChild(dropContainer));
}

/**
 * Creates an individual drop item element with state sync for active mining progress.
 */
function renderDropItemElement(drop, index = 1, campaignState = null) {
    // 1. More rigorous ID extraction to avoid fallback to drop-1
    const rawUuid = drop.id || drop.drop_id || drop.uuid || drop.benefit_id || 
                    (typeof getDropUniqueId === 'function' ? getDropUniqueId(drop, index) : `drop-${index}`);
    
    const textId = typeof getDropUniqueId === 'function' ? getDropUniqueId(drop, index) : rawUuid;

    const isClaimed = Boolean(drop.is_claimed ?? drop.isClaimed ?? drop.claimed ?? false);
    const canClaim = Boolean(drop.can_claim ?? drop.canClaim ?? false);
    
    // Base minutes from the drop object
    let current = Math.round(Number(drop.current_minutes ?? drop.currentMinutes ?? drop.current_time ?? drop.progress ?? 0));
    const required = Number(drop.required_minutes ?? drop.requiredMinutes ?? drop.required_time ?? drop.needed_minutes ?? drop.duration ?? drop.total_minutes ?? 0);

    // 2. Fix for live time synchronization (ONLY for the specific active drop!)
    const activeDrop = state?.currentDrop || state?.current_drop;
    if (activeDrop && !isClaimed) {
        const activeDropId = String(activeDrop.drop_id || activeDrop.id || '').trim();
        const dropId = String(rawUuid).trim();

        const isDirectActiveDrop = activeDropId && dropId && activeDropId === dropId;

        // We sync live time exclusively for the drop that is actually being mined!
        if (isDirectActiveDrop) {
            const liveMinutes = Math.round(Number(activeDrop.current_minutes ?? activeDrop.currentMinutes ?? activeDrop.current_time ?? activeDrop.progress ?? 0));
            current = liveMinutes;
        }
    }

    const element = makeElement('div', {
        class: `wanted-drop-item ${isClaimed ? 'is-claimed' : ''}`,
        'data-drop-id': String(rawUuid),
        'data-text-id': String(textId)
    }, '', el => {
        const infoEl = makeElement('div', { class: 'wanted-drop-info' }, '', info => {
            const dropName = drop.name || drop.title || 'Drop';
            const displayName = index ? `Drop ${index}: ${dropName}` : dropName;
            info.appendChild(makeElement('span', { class: 'wanted-drop-name' }, displayName));

            const rawName = (dropName || '').toLowerCase();
            const normalizedDropName = rawName.replace(/^\d+[\.\)]?\s*/, '').trim();

            const benefits = drop.benefits || drop.rewards || [];
            benefits.forEach(benefit => {
                if (benefit) {
                    const benefitText = typeof benefit === 'string' ? benefit : (benefit.name || benefit.title || '');
                    const cleanBenefit = benefitText.trim().toLowerCase();
                    if (cleanBenefit && !normalizedDropName.includes(cleanBenefit) && cleanBenefit !== normalizedDropName) {
                        info.appendChild(makeElement('span', { class: 'wanted-benefit-pill' }, benefitText));
                    }
                }
            });
        });
        el.appendChild(infoEl);

        const statusEl = makeElement('div', { class: 'wanted-drop-status' });

        if (isClaimed) {
            const label = state?.translations?.gui?.wanted?.claimed || 'Claimed';
            statusEl.innerHTML = `<span class="status-tag tag-claimed">${getStatusIconSVG('drop-claimed')} ${label}</span>`;
        } else if (canClaim || (required > 0 && current >= required)) {
            const label = state?.translations?.gui?.wanted?.ready || 'Ready to claim!';
            statusEl.innerHTML = `<span class="status-tag tag-ready">${getStatusIconSVG('drop-ready')} ${label}</span>`;
        } else if (required > 0) {
            const progressPercent = Math.min(100, Math.max(0, Math.round((current / required) * 100)));
            statusEl.innerHTML = `
                <span class="status-tag tag-progress">${getStatusIconSVG('drop-active')} ${current} / ${required} min</span>
                <div class="wanted-drop-progress">
                    <div class="wanted-drop-progress-bar" style="width: ${progressPercent}%;"></div>
                </div>
            `;
        }
        el.appendChild(statusEl);
    });

    return element;
}

// ==================== 3. State & Active Checks ====================

/**
 * Checks if a campaign is actively mining, taking into account single active drop,
 * active queues (parallel mining), and current watched channel.
 */
function checkIfCampaignIsActive(campaignId, drops, gameName) {
    if (!campaignId && (!drops || !drops.length)) return false;

    const campaignIdStr = campaignId ? String(campaignId).trim() : null;

    // 1. Collect ALL active Campaign IDs and Drop IDs from state & active queues
    const activeCampaignIds = new Set();
    const activeDropIds = new Set();

    const currentDrop = state?.currentDrop || state?.current_drop;
    if (currentDrop) {
        if (currentDrop.campaign_id) activeCampaignIds.add(String(currentDrop.campaign_id).trim());
        if (currentDrop.parent_campaign_id) activeCampaignIds.add(String(currentDrop.parent_campaign_id).trim());
        if (currentDrop.id) activeDropIds.add(String(currentDrop.id).trim());
        if (currentDrop.drop_id) activeDropIds.add(String(currentDrop.drop_id).trim());
    }

    const campaignQueue = state?.activeCampaignsQueue || state?.active_campaigns_queue || [];
    if (Array.isArray(campaignQueue)) {
        campaignQueue.forEach(ac => {
            const acId = ac.campaign_id || ac.id;
            if (acId) activeCampaignIds.add(String(acId).trim());
        });
    }

    const dropQueue = state?.activeDropsQueue || state?.active_drops_queue || [];
    if (Array.isArray(dropQueue)) {
        dropQueue.forEach(ad => {
            const adCampId = ad.campaign_id || ad.parent_campaign_id;
            if (adCampId) activeCampaignIds.add(String(adCampId).trim());

            const adDropId = ad.drop_id || ad.id;
            if (adDropId) activeDropIds.add(String(adDropId).trim());
        });
    }

    // 2. Direct match by campaign ID
    if (campaignIdStr && activeCampaignIds.has(campaignIdStr)) {
        return true;
    }

    // 3. Direct match by drop ID inside drops array
    if (drops && drops.length > 0 && activeDropIds.size > 0) {
        const hasMatchingDrop = drops.some(drop => {
            const dropId = drop.id || drop.drop_id;
            return dropId && activeDropIds.has(String(dropId).trim());
        });
        if (hasMatchingDrop) {
            return true;
        }
    }

    // 4. Secondary check against watched channel
    let watchedChannel = null;
    if (typeof getWatchedChannelObject === 'function') {
        watchedChannel = getWatchedChannelObject();
    }
    if (!watchedChannel) {
        watchedChannel = state?.watchedChannel || state?.currentChannel || state?.watching_channel;
    }

    if (watchedChannel) {
        // Match by campaign ID attached to watched channel
        const channelCampId = watchedChannel.campaign_id || watchedChannel.campaignId;
        if (campaignIdStr && channelCampId && String(channelCampId).trim() === campaignIdStr) {
            return true;
        }

        // Match by game name if channel is currently being watched
        const channelGame = watchedChannel.game_name || watchedChannel.game || watchedChannel.game_title;
        if (channelGame && gameName) {
            const isSameGame = channelGame.trim().toLowerCase() === gameName.trim().toLowerCase();
            // FIX: In manual mode, state.isMining is false. 
            // We just verify if the user is currently watching the game stream.
            if (isSameGame) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Checks if the campaign has any progress made while not actively mining.
 */
function checkIfCampaignHasProgress(drops, isActivelyMining) {
    if (isActivelyMining) return false;
    
    return drops.some(d => {
        // Safe extraction of minutes with fallbacks to different formats in API/data
        const current = Math.round(
            d.current_minutes ?? d.currentMinutes ?? d.current_time ?? d.progress ?? 0
        );
        
        // Safe check whether the drop is claimed
        const isClaimed = d.is_claimed ?? d.isClaimed ?? d.claimed ?? false;

        return current > 0 && !isClaimed;
    });
}

/**
 * Checks if parallel mining is active in the game group based on active queues.
 */
function checkParallelMiningState(gameGroup) {
    if (!gameGroup || !Array.isArray(gameGroup.campaigns)) return false;

    // Retrieve active queues with fallbacks for both naming conventions
    const activeCampaigns = state?.activeCampaignsQueue || state?.active_campaigns_queue || [];
    const activeDrops = state?.activeDropsQueue || state?.active_drops_queue || [];

    const activeCampaignsInGroup = gameGroup.campaigns.filter(c => {
        const cId = c.campaign_id || c.id;
        if (!cId) return false;

        const cleanCId = String(cId).trim();

        // 1. Check if campaign exists in active campaigns queue
        const isInActiveQueue = activeCampaigns.some(ac => {
            const acId = ac.campaign_id || ac.id;
            return acId && String(acId).trim() === cleanCId;
        });

        // 2. Check if any active drop in queue belongs to this campaign
        const hasActiveDrop = activeDrops.some(ad => {
            const adCampId = ad.campaign_id || ad.parent_campaign_id;
            if (adCampId && String(adCampId).trim() === cleanCId) return true;

            const adDropId = ad.drop_id || ad.id;
            return adDropId && (c.drops || []).some(d => {
                const dId = d.drop_id || d.id;
                return dId && String(dId).trim() === String(adDropId).trim();
            });
        });

        return isInActiveQueue || hasActiveDrop;
    });

    return activeCampaignsInGroup.length > 1;
}


// ==================== 4. Calculations & Formatting Helpers ====================

/**
 * Calculates total claimed/finished drops count for a campaign.
 */
function calculateClaimedDropsCount(campaign, drops) {
    const totalCount = campaign.total_drops_count || drops.length;
    const completedOutsideArray = Math.max(0, totalCount - drops.length);

    const finishedInArray = drops.filter(d => {
        const isClaimed = d.is_claimed === true || d.is_claimed === 1 || d.is_claimed === 'true' || d.is_claimed === '1';
        const canClaim = d.can_claim === true || d.can_claim === 1;
        const current = Math.round(d.current_minutes || 0);
        const required = d.required_minutes || 0;
        return isClaimed || canClaim || (required > 0 && current >= required);
    }).length;

    return completedOutsideArray + finishedInArray;
}

/**
 * Calculates the maximum remaining time across uncompleted campaigns.
 */
function calculateMaxRemainingTime(uncompletedCampaigns) {
    if (uncompletedCampaigns.length === 0) return 0;

    const campaignInfoList = uncompletedCampaigns.map(c => {
        const uncompletedDrops = (c.drops || []).filter(d => !d.is_claimed);
        const maxRequired = uncompletedDrops.length > 0 
            ? Math.max(...uncompletedDrops.map(d => Number(d.required_minutes) || 0)) 
            : 0;
        const currentMins = uncompletedDrops.length > 0 ? (Number(uncompletedDrops[0].current_minutes) || 0) : 0;

        return Math.max(0, maxRequired - currentMins);
    });

    return Math.max(...campaignInfoList, 0);
}

function formatCampaignDates(startIso, endIso) {
    if (!startIso || !endIso) {
        return '';
    }

    try {
        const start = new Date(startIso);
        const end = new Date(endIso);
        const formatOpts = { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' };
        return `${start.toLocaleDateString(undefined, formatOpts)} – ${end.toLocaleDateString(undefined, formatOpts)}`;
    } catch (e) {
        console.error('[WantedQueue] Failed to format campaign dates:', e);
        return '';
    }
}

/**
 * Generates a consistent unique ID for a drop item element.
 */
function getDropUniqueId(drop, index = 1) {
    return String(drop.id || drop.drop_id || drop.uuid || `drop-${index}`).trim();
}


// ==================== 5. Progress Synchronization ====================

/**
 * Updates a specific drop status in the DOM directly if target element is found.
 */
function updateDropStatusInDOM(dropId, currentMins, requiredMins, isClaimed) {
    if (!dropId) {
        return false;
    }

    const rawId = String(dropId).trim();
    const escapedId = CSS.escape(rawId);
    
    // Try finding by data-drop-id or data-text-id
    let dropEl = document.querySelector(`.wanted-drop-item[data-drop-id="${escapedId}"]`);
    if (!dropEl) {
        dropEl = document.querySelector(`.wanted-drop-item[data-text-id="${escapedId}"]`);
    }

    // FIX: If the element does not exist in the DOM (e.g. hidden campaign), silently return false 
    // and DO NOT SPAM console.warn, which could trigger fallback re-renders.
    if (!dropEl) {
        return false;
    }

    const statusEl = dropEl.querySelector('.wanted-drop-status');
    if (!statusEl) {
        return false;
    }

    currentMins = Math.round(currentMins || 0);
    requiredMins = Number(requiredMins) || 0;

    let newHTML = '';
    if (isClaimed) {
        const label = state.translations?.gui?.wanted?.claimed || 'Claimed';
        newHTML = `<span class="status-tag tag-claimed">${getStatusIconSVG('drop-claimed')} ${label}</span>`;
    } else if (requiredMins > 0 && currentMins >= requiredMins) {
        const label = state.translations?.gui?.wanted?.ready || 'Ready to claim!';
        newHTML = `<span class="status-tag tag-ready">${getStatusIconSVG('drop-ready')} ${label}</span>`;
    } else if (requiredMins > 0) {
        const progressPercent = Math.min(100, Math.max(0, Math.round((currentMins / requiredMins) * 100)));
        newHTML = `
            <span class="status-tag tag-progress">${getStatusIconSVG('drop-active')} ${currentMins} / ${requiredMins} min</span>
            <div class="wanted-drop-progress">
                <div class="wanted-drop-progress-bar" style="width: ${progressPercent}%;"></div>
            </div>
        `;
    }

    // Direct DOM update only if content actually changed
    if (statusEl.innerHTML.trim() !== newHTML.trim()) {
        statusEl.innerHTML = newHTML;
    }
    return true;
}

/**
 * Optimized progress sync for wanted items.
 */
function syncWantedItemsProgress(data) {
    data = normalizeSyncData(data);

    if (!state.wantedItemsTree || !Array.isArray(state.wantedItemsTree)) {
        state.wantedItemsTree = [];
    }

    // FIX: Allow sharedCurrentMins to be undefined if no progress data was given
    const sharedCurrentMins = data.current_minutes !== undefined ? Number(data.current_minutes) : undefined;
    let anyDomUpdated = false;

    const activeGameName = data.game_name || state.currentDrop?.game_name || state.current_drop?.game_name;
    const targetDropId = data.drop_id || data.id || data.uuid;

    state.wantedItemsTree.forEach((gameGroup) => {
        if (!gameGroup.campaigns || !Array.isArray(gameGroup.campaigns)) return;

        const isThisGameActive = activeGameName && gameGroup.game_name === activeGameName;

        gameGroup.campaigns.forEach((campaign) => {
            // Update state tree structure
            updateSingleCampaign(campaign, data, sharedCurrentMins);

            if (targetDropId) {
                const targetIdStr = String(targetDropId).trim();
                const matchedDrop = campaign.drops?.find(d => 
                    String(d.id || d.drop_id || d.uuid || '').trim() === targetIdStr ||
                    (data.drop_name && d.name === data.drop_name)
                );

                if (matchedDrop) {
                    const domDropId = getDropUniqueId(matchedDrop);
                    
                    // Use updated minutes from the object, fallback to shared if valid, otherwise preserve old
                    let currentMins = matchedDrop.current_minutes ?? matchedDrop.currentMinutes;
                    if (currentMins === undefined && sharedCurrentMins !== undefined) {
                        currentMins = sharedCurrentMins;
                    }
                    currentMins = Number(currentMins || 0);

                    const reqMins = Number(matchedDrop.required_minutes || matchedDrop.requiredMinutes || 0);
                    const isClaimed = Boolean(matchedDrop.is_claimed ?? matchedDrop.claimed ?? false);

                    if (updateDropStatusInDOM(domDropId, currentMins, reqMins, isClaimed)) {
                        anyDomUpdated = true;
                    }
                }
            }
        });

        const currentParallelState = isThisGameActive ? checkParallelMiningState(gameGroup) : false;
        gameGroup.isParallelActive = currentParallelState;

        processGameGroupSync(gameGroup);
    });

    const container = document.getElementById('wanted-items-list');
    if (!anyDomUpdated && container && container.children.length === 0 && state.wantedItemsTree.length > 0) {
        renderWantedItems(state.wantedItemsTree, true);
    }

    return anyDomUpdated;
}

/**
 * Normalizes incoming sync data (handles raw string drop IDs).
 */
function normalizeSyncData(data) {
    if (typeof data === 'string') {
        const dropId = data;

        // 1. Check active queues first
        let activeDrop = (state.activeDropsQueue || []).find(d => String(d.drop_id || d.id) === String(dropId)) ||
                         ((state.currentDrop && String(state.currentDrop.drop_id || state.currentDrop.id) === String(dropId)) ? state.currentDrop : null);

        // 2. Fallback to existing tree to avoid wiping progress to 0 in manual mode
        if (!activeDrop && state.wantedItemsTree) {
            for (const group of state.wantedItemsTree) {
                for (const camp of (group.campaigns || [])) {
                    const found = (camp.drops || []).find(d => String(d.id || d.drop_id || d.uuid) === String(dropId));
                    if (found) {
                        activeDrop = found;
                        break;
                    }
                }
                if (activeDrop) break;
            }
        }

        // FIX: Do not fallback to 0 if not found, let it be undefined so it won't overwrite progress
        const currentMins = activeDrop && activeDrop.current_minutes !== undefined 
            ? Number(activeDrop.current_minutes) 
            : undefined;
            
        return activeDrop ? { ...activeDrop, current_minutes: currentMins } : { drop_id: dropId, current_minutes: currentMins };
    }
    return data;
}

/**
 * Updates drops and stats for a single campaign and synchronizes progress across its drops.
 */
function updateSingleCampaign(campaign, data, sharedCurrentMins) {
    const campaignId = campaign.campaign_id || campaign.id;

    const hasMatchingDrop = (campaign.drops || []).some(d => {
        const dId = d.drop_id || d.id;
        return (data.drop_id && String(dId) === String(data.drop_id)) || (data.drop_name && d.name === data.drop_name);
    });

    const isCampaignMatch = (data.campaign_id && String(campaignId) === String(data.campaign_id)) || hasMatchingDrop;

    if (!isCampaignMatch || !campaign.drops || !Array.isArray(campaign.drops)) return false;

    let dropChanged = false;

    campaign.drops.forEach((drop) => {
        const dropId = drop.drop_id || drop.id;
        const isMatchingDrop = (data.drop_id && String(dropId) === String(data.drop_id)) || 
                               (data.drop_name && drop.name === data.drop_name);

        const reqMins = Number(drop.required_minutes) || 0;

        if (isMatchingDrop) {
            // FIX: Only apply sharedCurrentMins if it was actually provided in sync data!
            if (sharedCurrentMins !== undefined && !Number.isNaN(sharedCurrentMins)) {
                if (drop.current_minutes !== sharedCurrentMins) {
                    dropChanged = true;
                }
                drop.current_minutes = sharedCurrentMins;

                if (reqMins > 0) {
                    const effectiveMins = Math.min(sharedCurrentMins, reqMins);
                    drop.progress = Math.min(100, (effectiveMins / reqMins) * 100);
                    drop.can_claim = sharedCurrentMins >= reqMins && !drop.is_claimed;
                }
            }

            if (data.is_claimed !== undefined && drop.is_claimed !== data.is_claimed) {
                drop.is_claimed = data.is_claimed;
                dropChanged = true;
            }
        } else if (drop.is_claimed) {
            if (drop.current_minutes !== reqMins) {
                drop.current_minutes = reqMins;
                drop.progress = 100;
                dropChanged = true;
            }
        }
    });

    campaign.claimed_drops_count = campaign.drops.filter(d => d.is_claimed).length;
    return dropChanged;
}

/**
 * Updates drops and stats for a single campaign and synchronizes progress across its drops.
 */
function updateSingleCampaign(campaign, data, sharedCurrentMins) {
    const campaignId = campaign.campaign_id || campaign.id;

    const hasMatchingDrop = (campaign.drops || []).some(d => {
        const dId = d.drop_id || d.id;
        return (data.drop_id && String(dId) === String(data.drop_id)) || (data.drop_name && d.name === data.drop_name);
    });

    const isCampaignMatch = (data.campaign_id && String(campaignId) === String(data.campaign_id)) || hasMatchingDrop;

    if (!isCampaignMatch || !campaign.drops || !Array.isArray(campaign.drops)) return false;

    let dropChanged = false;

    campaign.drops.forEach((drop) => {
        const dropId = drop.drop_id || drop.id;
        const isMatchingDrop = (data.drop_id && String(dropId) === String(data.drop_id)) || 
                               (data.drop_name && drop.name === data.drop_name);

        const reqMins = Number(drop.required_minutes) || 0;

        if (isMatchingDrop) {
            if (drop.current_minutes !== sharedCurrentMins || (data.is_claimed !== undefined && drop.is_claimed !== data.is_claimed)) {
                dropChanged = true;
            }

            drop.current_minutes = sharedCurrentMins;

            if (reqMins > 0) {
                const effectiveMins = Math.min(sharedCurrentMins, reqMins);
                drop.progress = Math.min(100, (effectiveMins / reqMins) * 100);
                drop.can_claim = sharedCurrentMins >= reqMins && !drop.is_claimed;
            }

            if (data.is_claimed !== undefined) {
                drop.is_claimed = data.is_claimed;
            }
        } else if (drop.is_claimed) {
            drop.current_minutes = reqMins;
            drop.progress = 100;
        }
    });

    campaign.claimed_drops_count = campaign.drops.filter(d => d.is_claimed).length;
    return dropChanged;
}

/**
 * Single merged process function - handles game group sync without loop log spam.
 */
function processGameGroupSync(gameGroup) {
    const uncompletedCampaigns = gameGroup.campaigns.filter(c => {
        return (c.drops || []).some(d => !d.is_claimed);
    });

    const maxRemainingMins = calculateMaxRemainingTime(uncompletedCampaigns);
    const currentParallelState = checkParallelMiningState(gameGroup);

    const prevParallelState = gameGroup.isParallelActive || false;
    gameGroup.isParallelActive = currentParallelState;

    if (gameGroup.total_remaining_minutes !== maxRemainingMins) {
        gameGroup.total_remaining_minutes = maxRemainingMins;
        updateGameGroupBadge(gameGroup.game_name, maxRemainingMins);
    }

    return prevParallelState !== currentParallelState;
}

/**
 * Updates the game group time badge element in the DOM only if HTML value changes.
 */
function updateGameGroupBadge(gameName, totalRemainingMins) {
    const badgeEl = document.querySelector(`.wanted-game-group[data-game-name="${CSS.escape(gameName)}"] .wanted-game-time-badge`);
    if (badgeEl) {
        const hours = Math.floor(totalRemainingMins / 60);
        const mins = totalRemainingMins % 60;
        const timeText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        const newHTML = `${getStatusIconSVG('active')} ${timeText}`;

        if (badgeEl.innerHTML !== newHTML) {
            badgeEl.innerHTML = newHTML;
        }
    }
}

// ==================== 6. Icons & Assets ====================

/**
 * Returns consistent SVG assets mapped by status class.
 */
function getStatusIconSVG(statusClass) {
    const svgCheck = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
    const svgBox = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`;
    const svgCross = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`;
    const svgClock = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`;

    const icons = {
        'completed': svgCheck,
        'drop-claimed': svgCheck,
        'ready': svgBox,
        'drop-ready': svgBox,
        'drop-expired': svgCross,
        'expired': svgCross,
        'drop-active': svgClock,
        'active': svgClock,
        'upcoming': svgClock
    };
    
    return icons[statusClass] || '';
}
