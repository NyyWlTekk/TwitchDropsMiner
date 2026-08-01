/////////////////////////////////////////////////////////////////
// WANTED QUEUE//////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////
// ==================== 1. Core UI Rendering ====================

function renderWantedItems(tree) {
    const container = document.getElementById('wanted-items-list');
    if (!container) {
        return;
    }

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
        campaignListEl.appendChild(createCampaignCardElement(campaign));
    });

    groupEl.appendChild(campaignListEl);
    return groupEl;
}

/**
 * [INFO] Creates a single campaign card element with its drop items using modular helpers.
 */
function createCampaignCardElement(campaign) {
    const campaignId = campaign.campaign_id || campaign.id || '';
    const drops = campaign.drops || [];
    
    const isActivelyMining = checkIfCampaignIsActive(campaignId, drops);
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
 * [INFO] Creates the campaign card header element including titles, badges, and dates.
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
 * [INFO] Creates the body element containing all drop items container.
 */
function createCampaignBodyElement(drops) {
    const dropContainer = makeElement('div', { class: 'wanted-drops-container' });
    drops.forEach((drop, index) => {
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
 * [INFO] Checks if the campaign is currently being actively mined (queues or fallback).
 */
function checkIfCampaignIsActive(campaignId, drops) {
    if (typeof state !== 'undefined' && Array.isArray(state.activeCampaignsQueue)) {
        const isActive = state.activeCampaignsQueue.some(c => {
            const cId = c.campaign_id || c.id;
            return cId && String(cId) === String(campaignId);
        });
        if (isActive) return true;
    }

    if (typeof state !== 'undefined' && Array.isArray(state.activeDropsQueue)) {
        const isActive = state.activeDropsQueue.some(ad => {
            const adCampId = ad.campaign_id || ad.parent_campaign_id;
            if (adCampId && String(adCampId) === String(campaignId)) return true;
            return drops.some(d => 
                (d.id && ad.id && String(d.id) === String(ad.id)) ||
                (d.drop_id && ad.drop_id && String(d.drop_id) === String(ad.drop_id))
            );
        });
        if (isActive) return true;
    }

    const currentDrop = (typeof state !== 'undefined' && state.currentDrop);
    if (currentDrop) {
        const dropCampaignId = currentDrop.campaign_id || currentDrop.parent_campaign_id;
        if (dropCampaignId && String(dropCampaignId) === String(campaignId)) {
            return true;
        } else if (drops.length > 0) {
            return drops.some(d => 
                (d.id && currentDrop.id && String(d.id) === String(currentDrop.id)) ||
                (d.drop_id && currentDrop.drop_id && String(d.drop_id) === String(currentDrop.drop_id))
            );
        }
    }

    return false;
}

/**
 * [INFO] Checks if the campaign has any progress made while not actively mining.
 */
function checkIfCampaignHasProgress(drops, isActivelyMining) {
    if (isActivelyMining) return false;
    return drops.some(d => {
        const current = Math.round(d.current_minutes || 0);
        return current > 0;
    });
}

/**
 * [INFO] Checks if parallel mining is active in the game group based on active queues.
 */
function checkParallelMiningState(gameGroup) {
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
 * [INFO] Calculates total claimed/finished drops count for a campaign.
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
 * [INFO] Calculates the maximum remaining time across uncompleted campaigns.
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
        const result = `${start.toLocaleDateString(undefined, formatOpts)} – ${end.toLocaleDateString(undefined, formatOpts)}`;
        return result;
    } catch (e) {
        return '';
    }
}

/**
 * [INFO] Generates a consistent unique ID for a drop item element.
 */
function getDropUniqueId(drop, index = 1) {
    const dropId = drop.drop_id || drop.id || `drop-${index}-${drop.name}`;
    return dropId;
}


// ==================== 5. Progress Synchronization ====================

/**
 * [INFO] Syncs progress for wanted items in the tree with fully modular helpers.
 */
function syncWantedItemsProgress(data) {
    data = normalizeSyncData(data);

    if (!state.wantedItemsTree || !Array.isArray(state.wantedItemsTree)) {
        state.wantedItemsTree = [];
    }

    const sharedCurrentMins = Number(data.current_minutes) || 0;
    let treeUpdated = false;

    state.wantedItemsTree.forEach((gameGroup) => {
        if (!gameGroup.campaigns || !Array.isArray(gameGroup.campaigns)) return;

        let groupHasChanges = false;

        gameGroup.campaigns.forEach((campaign) => {
            const updated = updateSingleCampaign(campaign, data, sharedCurrentMins);
            if (updated) {
                groupHasChanges = true;
                treeUpdated = true;
            }
        });

        if (groupHasChanges) {
            processGameGroupSync(gameGroup);
        }
    });

    return treeUpdated;
}

/**
 * [INFO] Normalizes incoming sync data (handles raw string drop IDs).
 */
function normalizeSyncData(data) {
    if (typeof data === 'string') {
        const dropId = data;
        
        const activeDrop = (state.activeDropsQueue || []).find(d => (d.drop_id || d.id) === dropId) ||
                           (state.currentDrop && (state.currentDrop.drop_id || state.currentDrop.id) === dropId ? state.currentDrop : null);
        
        return activeDrop ? { ...activeDrop } : { drop_id: dropId, current_minutes: activeDrop?.current_minutes || 0 };
    }
    return data;
}

/**
 * [INFO] Updates drops and stats for a single campaign if it matches the sync data.
 */
function updateSingleCampaign(campaign, data, sharedCurrentMins) {
    const campaignId = campaign.campaign_id || campaign.id;
    
    const hasMatchingDrop = (campaign.drops || []).some(d => {
        const dId = d.drop_id || d.id;
        return (data.drop_id && dId === data.drop_id) || (data.drop_name && d.name === data.drop_name);
    });

    const isCampaignMatch = (data.campaign_id && campaignId === data.campaign_id) || 
                           (data.campaign_name && campaign.name === data.campaign_name) ||
                           hasMatchingDrop;
    
    if (!isCampaignMatch || !campaign.drops || !Array.isArray(campaign.drops)) return false;

    let maxCampaignMins = sharedCurrentMins;
    campaign.drops.forEach(d => {
        const cur = Number(d.current_minutes) || 0;
        if (cur > maxCampaignMins) {
            maxCampaignMins = cur;
        }
    });

    campaign.drops.forEach((drop, index) => {
        const dropId = drop.drop_id || drop.id;
        const isMatchingDrop = (data.drop_id && dropId === data.drop_id) || 
                               (data.drop_name && drop.name === data.drop_name);

        const reqMins = Number(drop.required_minutes) || 0;
        
        drop.current_minutes = maxCampaignMins; 
        
        if (reqMins > 0) {
            const effectiveMins = Math.min(maxCampaignMins, reqMins);
            drop.progress = Math.min(100, (effectiveMins / reqMins) * 100);
            drop.can_claim = maxCampaignMins >= reqMins && !drop.is_claimed;
        }

        if (data.is_claimed !== undefined && isMatchingDrop) {
            drop.is_claimed = data.is_claimed;
        }
    });

    campaign.claimed_drops_count = campaign.drops.filter(d => d.is_claimed).length;
    return true;
}

/**
 * [INFO] Processes group-level changes, remaining times, parallel state and DOM re-renders.
 */
function processGameGroupSync(gameGroup) {
    const uncompletedCampaigns = gameGroup.campaigns.filter(c => {
        return (c.drops || []).some(d => !d.is_claimed);
    });

    const maxRemainingMins = calculateMaxRemainingTime(uncompletedCampaigns);
    const currentParallelState = checkParallelMiningState(gameGroup);
    
    const prevParallelState = gameGroup.isParallelActive || false;
    gameGroup.isParallelActive = currentParallelState;

    if (prevParallelState !== currentParallelState) {
        if (typeof renderWantedItems === 'function') {
            renderWantedItems(state.wantedItemsTree);
        }
    }

    gameGroup.total_remaining_minutes = maxRemainingMins;
    updateGameGroupBadge(gameGroup.game_name, maxRemainingMins);
}

/**
 * [INFO] Updates the game group time badge element in the DOM.
 */
function updateGameGroupBadge(gameName, totalRemainingMins) {
    const badgeEl = document.querySelector(`.wanted-game-group[data-game-name="${CSS.escape(gameName)}"] .wanted-game-time-badge`);
    if (badgeEl) {
        const hours = Math.floor(totalRemainingMins / 60);
        const mins = totalRemainingMins % 60;
        const timeText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        badgeEl.innerHTML = `${getStatusIconSVG('active')} ${timeText}`;
    }
}
