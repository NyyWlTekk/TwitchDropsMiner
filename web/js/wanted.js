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

    // Complete Hash: Zahrnuje kompletně všechny proměnné, které ovlivňují HTML výstup
    const currentHash = `${campaign.id || campaignName}_${campaignUrl}_${claimedCount}_${totalCount}_${campaignState?.isActivelyMining}_${campaignState?.hasProgress}_${startsAt}_${endsAt}`;

    // Pokud existující hlavička má stejný hash, vracíme ji a ukončujeme re-render
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

    // Uložení nového hashu do elementu
    newHeader.dataset.hash = currentHash;

    // Pokud byl předán starý element spojený s DOMem, nahradíme ho
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
    const rawUuid = drop.id || drop.drop_id || (typeof getDropUniqueId === 'function' ? getDropUniqueId(drop, index) : `drop-${index}`);
    const textId = typeof getDropUniqueId === 'function' ? getDropUniqueId(drop, index) : rawUuid;

    const isClaimed = Boolean(drop.is_claimed ?? drop.isClaimed ?? drop.claimed ?? false);
    const canClaim = Boolean(drop.can_claim ?? drop.canClaim ?? false);
    
    // 1. Basic minutes extraction from drop object
    let current = Math.round(Number(drop.current_minutes ?? drop.currentMinutes ?? drop.current_time ?? drop.progress ?? 0));
    const required = Number(drop.required_minutes ?? drop.requiredMinutes ?? drop.required_time ?? drop.needed_minutes ?? drop.duration ?? drop.total_minutes ?? 0);

    // 2. Sync live time from active mining state (state.currentDrop)
    const activeDrop = state?.currentDrop || state?.current_drop;
    if (activeDrop && !isClaimed) {
        const activeDropId = activeDrop.drop_id || activeDrop.id;
        const activeCampaignId = activeDrop.campaign_id || activeDrop.parent_campaign_id || state?.currentDrop?.campaign_id;

        const dropId = drop.id || drop.drop_id;
        const dropCampaignId = drop.campaign_id || drop.parent_campaign_id || campaignState?.campaignId;

        const isDirectActiveDrop = dropId && activeDropId && String(dropId).trim() === String(activeDropId).trim();
        const isSameCampaign = (campaignState?.isActivelyMining) || (dropCampaignId && activeCampaignId && String(dropCampaignId).trim() === String(activeCampaignId).trim());

        // If active drop or campaign is currently mining, take higher live minutes from state
        if (isDirectActiveDrop || isSameCampaign) {
            const liveMinutes = Math.round(Number(activeDrop.current_minutes ?? activeDrop.currentMinutes ?? activeDrop.current_time ?? activeDrop.progress ?? 0));
            if (liveMinutes > current) {
                current = liveMinutes;
            }
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
 * Checks if a campaign is actively mining, with priority on exact ID matching from the state.
 */
function checkIfCampaignIsActive(campaignId, drops, gameName) {
    if (!campaignId && (!drops || drops.length === 0)) return false;

    // 1. Safely extract active IDs from state
    const activeDropId = state?.currentDrop?.drop_id || state?.currentDrop?.id || 
                         state?.current_drop?.drop_id || state?.current_drop?.id;
                         
    const activeCampaignId = state?.currentDrop?.campaign_id || state?.current_drop?.campaign_id;

    const hasSpecificActiveTarget = Boolean(activeCampaignId || activeDropId);

    // 2. Direct comparison by campaign ID
    if (activeCampaignId && campaignId && String(campaignId).trim() === String(activeCampaignId).trim()) {
        return true;
    }

    // 3. Direct comparison by drop ID inside drops array
    if (activeDropId && drops && drops.length > 0) {
        const hasMatchingDrop = drops.some(drop => {
            const dropId = drop.id || drop.drop_id;
            return dropId && String(dropId).trim() === String(activeDropId).trim();
        });
        if (hasMatchingDrop) {
            return true;
        }
    }

    // If a specific active campaign/drop exists in state but doesn't match this campaign,
    // do not fall back to game matching (another campaign in the same game is actively mining).
    if (hasSpecificActiveTarget) {
        return false;
    }

    // 4. Secondary fallback check by game name (only used when no specific active target ID exists in state)
    let currentWatchedGame = null;
    if (typeof getWatchedChannelObject === 'function') {
        const wObj = getWatchedChannelObject();
        if (wObj) currentWatchedGame = wObj.game_name || wObj.game || wObj.game_title;
    }
    if (!currentWatchedGame) {
        currentWatchedGame = state?.watchedChannel?.game || state?.currentChannel?.game || state?.watching_channel?.game;
    }

    if (currentWatchedGame && gameName) {
        return currentWatchedGame.trim().toLowerCase() === gameName.trim().toLowerCase();
    }

    return false;
}

/**
 * Checks if the campaign has any progress made while not actively mining.
 */
function checkIfCampaignHasProgress(drops, isActivelyMining) {
    if (isActivelyMining) return false;
    
    return drops.some(d => {
        // Bezpečné vytažení minut s fallbacky na různé formáty zápisu v API/datech
        const current = Math.round(
            d.current_minutes ?? d.currentMinutes ?? d.current_time ?? d.progress ?? 0
        );
        
        // Bezpečné ověření, zda je drop claimnutý
        const isClaimed = d.is_claimed ?? d.isClaimed ?? d.claimed ?? false;

        return current > 0 && !isClaimed;
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



// NEED REWORK

function getStatusIconSVG(statusClass) {
    const icons = {
        'completed': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
        'ready': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`,
        'drop-claimed': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
        'drop-ready': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`,
        'drop-expired': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`,
        'drop-active': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        'active': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        'upcoming': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        'expired': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`
    };
    return icons[statusClass] || '';
}
