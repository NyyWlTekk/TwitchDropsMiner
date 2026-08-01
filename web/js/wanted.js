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
        fragment.appendChild(createGameGroupElement(gameGroup, index));
    });

    container.replaceChildren(fragment);
    if (typeof updateOverallProgress === 'function') updateOverallProgress();
}


// ==================== 2. DOM Builders & Components ====================

/**
 * Creates a game group DOM element containing its campaigns.
 */
function createGameGroupElement(gameGroup, index) {
    const groupEl = makeElement('div', { 
        class: 'wanted-game-group',
        'data-game-name': gameGroup.game_name 
    });

    let iconUrl = gameGroup.game_icon;
    if (iconUrl) {
        iconUrl = iconUrl.replace('{width}', '40').replace('{height}', '53');
    }

    const headerChildren = [makeElement('span', { class: 'wanted-game-index' }, `#${index + 1}`)];
    if (iconUrl) {
        headerChildren.push(makeImageElement(iconUrl, gameGroup.game_name, 'wanted-game-icon'));
    }
    headerChildren.push(makeElement('span', { class: 'wanted-game-title' }, gameGroup.game_name));

    if (gameGroup.total_remaining_minutes !== undefined) {
        const hours = Math.floor(gameGroup.total_remaining_minutes / 60);
        const mins = gameGroup.total_remaining_minutes % 60;
        const timeText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

        const badgeEl = makeElement('span', { 
            class: 'wanted-game-time-badge',
            'data-game-badge': gameGroup.game_name 
        });
        badgeEl.innerHTML = `${getStatusIconSVG('active')} ${timeText}`;
        headerChildren.push(badgeEl);
    }

    const headerEl = makeElement('div', { class: 'wanted-game-header' }, '', el => {
        headerChildren.forEach(child => el.appendChild(child));
    });
    groupEl.appendChild(headerEl);

    const campaignListEl = makeElement('div', { class: 'wanted-campaign-list' });
    const campaigns = gameGroup.campaigns || [];
    
    campaigns.forEach(campaign => {
        campaignListEl.appendChild(createCampaignCardElement(campaign, gameGroup.game_name));
    });

    groupEl.appendChild(campaignListEl);
    return groupEl;
}

/**
 * Creates a single campaign card element with its drop items using modular helpers.
 */
function createCampaignCardElement(campaign, gameName) {
    const campaignId = campaign.campaign_id || campaign.id || '';
    const drops = campaign.drops || [];

    const isActivelyMining = checkIfCampaignIsActive(campaignId, drops, gameName);
    const hasProgress = checkIfCampaignHasProgress(drops, isActivelyMining);

    let cardClasses = 'wanted-card';
    if (isActivelyMining) {
        cardClasses += ' active-mining';
    } else if (hasProgress) {
        cardClasses += ' in-progress';
    }

    return makeElement('div', {
        class: cardClasses,
        'data-campaign-id': String(campaignId)
    }, '', cardEl => {
        const headerEl = createCampaignHeaderElement(campaign, drops);
        const bodyEl = createCampaignBodyElement(drops);

        cardEl.appendChild(headerEl);
        cardEl.appendChild(bodyEl);
    });
}

/**
 * Creates the campaign card header element including titles, badges, and dates.
 */
function createCampaignHeaderElement(campaign, drops) {
    return makeElement('div', { class: 'wanted-card-header' }, '', h => {
        const titleRow = makeElement('div', { class: 'wanted-card-header-main' }, '', row => {
            row.appendChild(makeElement('a', {
                href: campaign.url || '#',
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'wanted-card-campaign-link',
                title: campaign.name || 'Campaign'
            }, campaign.name || 'Campaign'));

            const claimedCount = calculateClaimedDropsCount(campaign, drops);
            const totalCount = campaign.total_drops_count || drops.length;
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
}

/**
 * Creates the body element containing all drop items container.
 */
function createCampaignBodyElement(drops) {
    const dropContainer = makeElement('div', { class: 'wanted-drops-container' });

    // Seřazení dropů vzestupně podle požadovaného času (minut)
    const sortedDrops = [...(drops || [])].sort((a, b) => {
        const timeA = a.required_minutes ?? a.requiredMinutes ?? a.required_time ?? a.needed_minutes ?? 0;
        const timeB = b.required_minutes ?? b.requiredMinutes ?? b.required_time ?? b.needed_minutes ?? 0;
        return timeA - timeB;
    });

    sortedDrops.forEach((drop, index) => {
        if (typeof createDropItemElement === 'function') {
            dropContainer.appendChild(createDropItemElement(drop, index + 1));
        }
    });

    return makeElement('div', { class: 'wanted-card-body' }, '', b => b.appendChild(dropContainer));
}

function createDropItemElement(drop, index = 1) {
    const rawUuid = drop.id || drop.drop_id || getDropUniqueId(drop, index);
    const textId = getDropUniqueId(drop, index);

    const element = makeElement('div', {
        class: `wanted-drop-item ${drop.is_claimed ? 'is-claimed' : ''}`,
        'data-drop-id': String(rawUuid),
        'data-text-id': String(textId)
    }, '', el => {
        const infoEl = makeElement('div', { class: 'wanted-drop-info' }, '', info => {
            const displayName = index ? `Drop ${index}: ${drop.name}` : drop.name;
            info.appendChild(makeElement('span', { class: 'wanted-drop-name' }, displayName));

            const rawName = (drop.name || '').toLowerCase();
            const normalizedDropName = rawName.replace(/^\d+[\.\)]?\s*/, '').trim();

            (drop.benefits || []).forEach(benefit => {
                if (benefit) {
                    const cleanBenefit = benefit.trim().toLowerCase();
                    if (cleanBenefit && !normalizedDropName.includes(cleanBenefit) && cleanBenefit !== normalizedDropName) {
                        info.appendChild(makeElement('span', { class: 'wanted-benefit-pill' }, benefit));
                    }
                }
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

    return element;
}


// ==================== 3. State & Active Checks ====================

/**
 * Checks if a campaign is actively mining, with strict validation against the currently watched game.
 */
function checkIfCampaignIsActive(campaignId, drops, gameName) {
    let currentWatchedGame = null;

    if (typeof getWatchedChannelObject === 'function') {
        const wObj = getWatchedChannelObject();
        if (wObj) currentWatchedGame = wObj.game_name || wObj.game || wObj.game_title;
    }

    if (!currentWatchedGame) {
        currentWatchedGame = state.watchedChannel?.game || state.currentChannel?.game || state.watching_channel?.game;
    }

    if (currentWatchedGame && gameName && currentWatchedGame.trim().toLowerCase() !== gameName.trim().toLowerCase()) {
        return false;
    }

    const activeDropId = state.currentDrop?.drop_id || state.currentDrop?.id || state.current_drop?.drop_id || state.current_drop?.id;
    const activeCampaignId = state.currentDrop?.campaign_id || state.current_drop?.campaign_id;

    if (!activeDropId && !activeCampaignId) {
        return false;
    }

    const hasActiveDrop = drops.some(drop => {
        const dropId = drop.id || drop.drop_id;
        return dropId && activeDropId && String(dropId) === String(activeDropId);
    });

    return hasActiveDrop || (activeCampaignId && String(campaignId) === String(activeCampaignId));
}

/**
 * Checks if the campaign has any progress made while not actively mining.
 */
function checkIfCampaignHasProgress(drops, isActivelyMining) {
    if (isActivelyMining) return false;
    return drops.some(d => {
        const current = Math.round(d.current_minutes || 0);
        return current > 0 && !d.is_claimed;
    });
}

/**
 * Checks if parallel mining is active in the game group based on active queues.
 */
function checkParallelMiningState(gameGroup) {
    if (!gameGroup || !gameGroup.campaigns) return false;

    const activeCampaignsInGroup = gameGroup.campaigns.filter(c => {
        const cId = c.campaign_id || c.id;
        const isInActiveQueue = (state.activeCampaignsQueue || []).some(ac => String(ac.campaign_id || ac.id) === String(cId));
        const hasActiveDrop = (state.activeDropsQueue || []).some(ad => {
            const adCampId = ad.campaign_id || ad.parent_campaign_id;
            if (adCampId && String(adCampId) === String(cId)) return true;
            return (c.drops || []).some(d => String(d.drop_id || d.id) === String(ad.drop_id || ad.id));
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
    return drop.drop_id || drop.id || `drop-${index}-${drop.name}`;
}


// ==================== 5. Progress Synchronization ====================

/**
 * Updates a specific drop status in the DOM directly if target element is found.
 */
function updateDropStatusInDOM(dropId, currentMins, requiredMins, isClaimed) {
    if (!dropId) return false;

    const escapedId = CSS.escape(String(dropId));
    let dropEl = document.querySelector(`.wanted-drop-item[data-drop-id="${escapedId}"]`);
    if (!dropEl) {
        dropEl = document.querySelector(`.wanted-drop-item[data-text-id="${escapedId}"]`);
    }
    if (!dropEl) return false;

    const statusEl = dropEl.querySelector('.wanted-drop-status');
    if (!statusEl) return false;

    currentMins = Math.round(currentMins || 0);
    requiredMins = requiredMins || 0;

    let newHTML = '';
    if (isClaimed) {
        const label = state.translations?.gui?.wanted?.claimed || 'Claimed';
        newHTML = `<span class="status-tag tag-claimed">${getStatusIconSVG('drop-claimed')} ${label}</span>`;
    } else if (requiredMins > 0 && currentMins >= requiredMins) {
        const label = state.translations?.gui?.wanted?.ready || 'Ready to claim!';
        newHTML = `<span class="status-tag tag-ready">${getStatusIconSVG('drop-ready')} ${label}</span>`;
    } else if (requiredMins > 0) {
        newHTML = `<span class="status-tag tag-progress">${getStatusIconSVG('drop-active')} ${currentMins} / ${requiredMins} min</span>`;
    }

    if (statusEl.innerHTML !== newHTML) {
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

    const sharedCurrentMins = Number(data.current_minutes) || 0;
    let anyDomUpdated = false;

    const activeGameName = data.game_name || state.currentDrop?.game_name || state.current_drop?.game_name;
    const targetDropId = data.drop_id || data.id;

    state.wantedItemsTree.forEach((gameGroup) => {
        if (!gameGroup.campaigns || !Array.isArray(gameGroup.campaigns)) return;

        const isThisGameActive = activeGameName && gameGroup.game_name === activeGameName;

        gameGroup.campaigns.forEach((campaign) => {
            const updated = updateSingleCampaign(campaign, data, sharedCurrentMins);
            if (updated && targetDropId) {
                const matchedDrop = campaign.drops?.find(d => 
                    String(d.drop_id || d.id || '') === String(targetDropId) ||
                    (data.drop_name && d.name === data.drop_name)
                );

                if (matchedDrop) {
                    const domDropId = matchedDrop.drop_id || matchedDrop.id || targetDropId;
                    if (updateDropStatusInDOM(domDropId, sharedCurrentMins, matchedDrop.required_minutes, matchedDrop.is_claimed)) {
                        anyDomUpdated = true;
                    }
                }
            }
        });

        const currentParallelState = isThisGameActive ? checkParallelMiningState(gameGroup) : false;
        gameGroup.isParallelActive = currentParallelState;

        processGameGroupSync(gameGroup);
    });

    // Schedule debounced render if needed (will be skipped automatically if tree hash hasn't structurally changed)
    renderWantedItems(state.wantedItemsTree);

    return anyDomUpdated;
}

/**
 * Normalizes incoming sync data (handles raw string drop IDs).
 */
function normalizeSyncData(data) {
    if (typeof data === 'string') {
        const dropId = data;

        const activeDrop = (state.activeDropsQueue || []).find(d => String(d.drop_id || d.id) === String(dropId)) ||
                           ((state.currentDrop && String(state.currentDrop.drop_id || state.currentDrop.id) === String(dropId)) ? state.currentDrop : null);

        return activeDrop ? { ...activeDrop } : { drop_id: dropId, current_minutes: activeDrop?.current_minutes || 0 };
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
