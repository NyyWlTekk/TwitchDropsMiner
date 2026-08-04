///////////////////////////////////////////////////////////////////////////////
// WANTED QUEUE MODULE (OPTIMIZED & IN-PLACE DOM UPDATES)
///////////////////////////////////////////////////////////////////////////////

// ==================== 1. Core UI Rendering & Batching ====================

let wantedRenderDebounceTimer = null;
let lastRenderedTreeHash = '';

/**
 * Debounced queue rendering to batch rapid socket updates.
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

    if (wantedRenderDebounceTimer) return;

    wantedRenderDebounceTimer = setTimeout(() => {
        wantedRenderDebounceTimer = null;
        performRenderWantedItems(state.wantedItemsTree);
    }, 150);
}

/**
 * Smart DOM renderer with targeted node reconciliation.
 */
function performRenderWantedItems(tree) {
    const container = document.getElementById('wanted-items-list');
    if (!container) {
        console.warn('[WantedQueue] Element #wanted-items-list not found in DOM');
        return;
    }

    if (!tree || tree.length === 0) {
        lastRenderedTreeHash = 'empty';
        const emptyMsg = state.translations?.gui?.wanted?.none || 'No wanted drops queued...';
        container.replaceChildren(makeElement('p', { class: 'empty-message-small' }, emptyMsg));
        if (typeof updateOverallProgress === 'function') updateOverallProgress();
        return;
    }

    const activeDrop = state?.currentDrop || state?.current_drop;
    const activeDropId = activeDrop?.drop_id || activeDrop?.id || '';
    const activeCampId = activeDrop?.campaign_id || '';
    const isManual = !!(state?.manual_mode?.active || state?.is_manual);

    // Fast structural hash check
    const currentHash = `${tree.length}_${activeDropId}_${activeCampId}_${isManual}_` + 
        tree.map(g => `${g.game_name}:${(g.campaigns || []).length}`).join('|');

    if (currentHash === lastRenderedTreeHash && container.children.length > 0) {
        // Just update dynamic states in-place without rebuilding DOM structure
        updateAllCampaignStatesInDOM(tree);
        return;
    }
    lastRenderedTreeHash = currentHash;

    console.log(`[WantedQueue] Performing smart DOM update for ${tree.length} game group(s)`);
    
    // In-place reconciliation of Game Groups
    const existingGroups = new Map();
    Array.from(container.querySelectorAll('.wanted-game-group')).forEach(el => {
        if (el.dataset.gameName) existingGroups.set(el.dataset.gameName, el);
    });

    const fragment = document.createDocumentFragment();

    tree.forEach((gameGroup, index) => {
        const gameName = gameGroup.game_name || gameGroup.name || '';
        let groupEl = existingGroups.get(gameName);

        if (groupEl) {
            existingGroups.delete(gameName);
            updateGameGroupElement(groupEl, gameGroup, index);
        } else {
            groupEl = renderGameGroupElement(gameGroup, index);
        }
        fragment.appendChild(groupEl);
    });

    // Remove obsolete groups
    existingGroups.forEach(el => el.remove());

    if (container.children.length === 0 || container.querySelector('.empty-message-small')) {
        container.replaceChildren(fragment);
    } else {
        container.appendChild(fragment); // DOM reconciliation attaches existing reused nodes
    }

    if (typeof updateOverallProgress === 'function') updateOverallProgress();
}

// ==================== 2. DOM Builders & Components ====================

function evaluateCampaignMiningState(campaign, gameName) {
    if (!campaign) return { isActivelyMining: false, hasProgress: false, cardClasses: 'wanted-card' };

    const campaignId = campaign.campaign_id || campaign.id || '';
    const drops = campaign.drops || campaign.drop_list || campaign.items || [];
    const effectiveGameName = gameName || campaign.game_name || campaign.game || '';

    const isActivelyMining = checkIfCampaignIsActive(campaignId, drops, effectiveGameName);
    const hasProgress = checkIfCampaignHasProgress(drops, isActivelyMining);

    let cardClasses = 'wanted-card';
    if (isActivelyMining) cardClasses += ' is-mining';
    else if (hasProgress) cardClasses += ' in-progress';

    return { campaignId, drops, isActivelyMining, hasProgress, cardClasses };
}

function renderCampaignStatusIndicatorElement(isActivelyMining, hasProgress) {
    const t = state?.translations?.gui?.wanted;

    if (isActivelyMining) {
        const badgeEl = makeElement('span', { class: 'status-tag tag-mining' });
        badgeEl.innerHTML = `${getStatusIconSVG('drop-active')} ${t?.mining || 'Mining'}`;
        return badgeEl;
    }
    
    if (hasProgress) {
        const badgeEl = makeElement('span', { class: 'status-tag tag-in-progress' });
        badgeEl.innerHTML = `${getStatusIconSVG('drop-progress')} ${t?.in_progress || 'In Progress'}`;
        return badgeEl;
    }

    return null;
}

function renderGameGroupElement(gameGroup, index) {
    const gameName = gameGroup.game_name || gameGroup.name || '';
    const groupEl = makeElement('div', { class: 'wanted-game-group', 'data-game-name': gameName });

    let iconUrl = gameGroup.game_icon || gameGroup.icon || gameGroup.box_art_url;
    if (iconUrl) iconUrl = iconUrl.replace('{width}', '40').replace('{height}', '53');

    // Spočítej zbývající čas přímo z kampaní v objektu
    const campaigns = gameGroup.campaigns || gameGroup.campaign_list || [];
    const mins = calculateMaxRemainingTime(campaigns);
    const hours = Math.floor(mins / 60);
    const remainderMins = mins % 60;
    const timeText = hours > 0 ? `${hours}h ${remainderMins}m` : `${remainderMins}m`;

    const headerEl = makeElement('div', { class: 'wanted-game-header' }, '', h => {
        h.appendChild(makeElement('span', { class: 'wanted-game-index' }, `#${index + 1}`));
        if (iconUrl) h.appendChild(makeImageElement(iconUrl, gameName, 'wanted-game-icon'));
        h.appendChild(makeElement('span', { class: 'wanted-game-title' }, gameName));
        
        // Vložíme odhadovaný čas rovnou do nového badge!
        const badgeEl = makeElement('span', { class: 'wanted-game-time-badge', 'data-game-badge': gameName });
        badgeEl.innerHTML = `${getStatusIconSVG('active')} ${timeText}`;
        h.appendChild(badgeEl);
    });

    groupEl.appendChild(headerEl);

    const campaignListEl = makeElement('div', { class: 'wanted-campaign-list' });
    campaigns.forEach(campaign => {
        campaignListEl.appendChild(renderCampaignCardElement(campaign, gameName));
    });

    groupEl.appendChild(campaignListEl);

    return groupEl;
}

function updateGameGroupElement(groupEl, gameGroup, index) {
    const idxEl = groupEl.querySelector('.wanted-game-index');
    if (idxEl) idxEl.textContent = `#${index + 1}`;

    const campaignListEl = groupEl.querySelector('.wanted-campaign-list');
    if (campaignListEl) {
        const campaigns = gameGroup.campaigns || gameGroup.campaign_list || [];
        campaignListEl.replaceChildren(...campaigns.map(c => renderCampaignCardElement(c, gameGroup.game_name)));
    }

    updateGameGroupBadge(gameGroup.game_name, gameGroup.total_remaining_minutes);
}

function renderCampaignCardElement(campaign, gameName) {
    const campaignState = evaluateCampaignMiningState(campaign, gameName);

    return makeElement('div', {
        class: campaignState.cardClasses,
        'data-campaign-id': String(campaignState.campaignId)
    }, '', cardEl => {
        cardEl.appendChild(renderCampaignHeaderElement(campaign, campaignState.drops, campaignState));
        cardEl.appendChild(renderCampaignBodyElement(campaignState.drops, campaignState));
    });
}

function renderCampaignHeaderElement(campaign, drops, campaignState = null) {
    if (!campaign || typeof campaign !== 'object') return null;

    const claimedCount = calculateClaimedDropsCount(campaign, drops);
    const totalCount = campaign.total_drops_count || campaign.totalDropsCount || (drops ? drops.length : 0);
    const campaignName = campaign.name || campaign.campaign_name || 'Campaign';
    const campaignUrl = campaign.url || '#';
    const startsAt = campaign.starts_at || campaign.startsAt || '';
    const endsAt = campaign.ends_at || campaign.endsAt || '';

    return makeElement('div', { class: 'wanted-card-header' }, '', h => {
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
                if (statusBadge) row.appendChild(statusBadge);
            }
        });
        h.appendChild(titleRow);

        const dateText = formatCampaignDates(startsAt, endsAt);
        if (dateText) {
            const datesEl = makeElement('div', { class: 'wanted-campaign-dates' });
            datesEl.innerHTML = `${getStatusIconSVG('upcoming')} ${dateText}`;
            h.appendChild(datesEl);
        }
    });
}

function renderCampaignBodyElement(drops, campaignState = null) {
    const dropContainer = makeElement('div', { class: 'wanted-drops-container' });

    const sortedDrops = [...(drops || [])].sort((a, b) => {
        const timeA = Number(a.required_minutes ?? a.requiredMinutes ?? a.required_time ?? 0);
        const timeB = Number(b.required_minutes ?? b.requiredMinutes ?? b.required_time ?? 0);
        return timeA - timeB;
    });

    sortedDrops.forEach((drop, index) => {
        dropContainer.appendChild(renderDropItemElement(drop, index + 1, campaignState));
    });

    return makeElement('div', { class: 'wanted-card-body' }, '', b => b.appendChild(dropContainer));
}

function renderDropItemElement(drop, index = 1, campaignState = null) {
    const rawUuid = getDropUniqueId(drop, index);
    const dropName = drop.name || drop.title || 'Drop';

    const isClaimed = Boolean(drop.is_claimed ?? drop.isClaimed ?? drop.claimed ?? false);
    const canClaim = Boolean(drop.can_claim ?? drop.canClaim ?? false);
    const required = Number(drop.required_minutes ?? drop.requiredMinutes ?? drop.required_time ?? 0);

    let current = isClaimed ? required : Math.round(Number(drop.current_minutes ?? drop.currentMinutes ?? drop.progress ?? 0));

    const activeDrop = state?.currentDrop || state?.current_drop;
    if (activeDrop && !isClaimed) {
        const activeDropId = String(activeDrop.drop_id || activeDrop.id || '').trim();
        if (activeDropId && activeDropId === String(rawUuid).trim()) {
            current = Math.round(Number(activeDrop.current_minutes ?? activeDrop.currentMinutes ?? activeDrop.progress ?? 0));
        }
    }

    return makeElement('div', {
        class: `wanted-drop-item ${isClaimed ? 'is-claimed' : ''}`,
        'data-wanted-drop-id': String(rawUuid),
        'data-drop-id': String(rawUuid),
        'data-drop-name': String(dropName).trim()
    }, '', el => {
        const infoEl = makeElement('div', { class: 'wanted-drop-info' }, '', info => {
            const displayName = index ? `Drop ${index}: ${dropName}` : dropName;
            info.appendChild(makeElement('span', { class: 'wanted-drop-name' }, displayName));

            const rawName = (dropName || '').toLowerCase().replace(/^\d+[\.\)]?\s*/, '').trim();
            const benefits = drop.benefits || drop.rewards || [];

            benefits.forEach(benefit => {
                if (!benefit) return;
                const benefitText = typeof benefit === 'string' ? benefit : (benefit.name || benefit.title || '');
                const cleanBenefit = benefitText.trim().toLowerCase();
                if (cleanBenefit && !rawName.includes(cleanBenefit) && cleanBenefit !== rawName) {
                    info.appendChild(makeElement('span', { class: 'wanted-benefit-pill' }, benefitText));
                }
            });
        });
        el.appendChild(infoEl);

        const statusEl = makeElement('div', { class: 'wanted-drop-status' });
        renderDropStatusHTML(statusEl, { isClaimed, canClaim, required, current });
        el.appendChild(statusEl);
    });
}

function renderDropStatusHTML(statusEl, { isClaimed, canClaim, required, current }) {
    if (isClaimed) {
        const label = state?.translations?.gui?.wanted?.claimed || 'Claimed';
        statusEl.innerHTML = `
            <span class="status-tag tag-claimed">${getStatusIconSVG('drop-claimed')} ${label} (100%)</span>
            ${required > 0 ? `<div class="wanted-drop-progress"><div class="wanted-drop-progress-bar bar-fill" style="width: 100%;"></div></div>` : ''}
        `;
    } else if (canClaim || (required > 0 && current >= required)) {
        const label = state?.translations?.gui?.wanted?.ready || 'Ready to claim!';
        statusEl.innerHTML = `
            <span class="status-tag tag-ready">${getStatusIconSVG('drop-ready')} ${label} (100%)</span>
            <div class="wanted-drop-progress"><div class="wanted-drop-progress-bar bar-fill" style="width: 100%;"></div></div>
        `;
    } else if (required > 0) {
        const pct = Math.min(100, Math.max(0, Math.round((current / required) * 100)));
        statusEl.innerHTML = `
            <span class="status-tag tag-progress wanted-drop-text">${getStatusIconSVG('drop-active')} ${current} / ${required} min</span>
            <div class="wanted-drop-progress">
                <div class="wanted-drop-progress-bar bar-fill" style="width: ${pct}%;"></div>
            </div>
        `;
    } else {
        statusEl.innerHTML = '';
    }
}

// ==================== 3. State & Active Checks ====================

function checkIfCampaignIsActive(campaignId, drops, gameName) {
    if (!campaignId && (!drops || !drops.length)) return false;

    const campaignIdStr = campaignId ? String(campaignId).trim() : null;
    const watchedChannel = getWatchedChannelContext();
    const currentDrop = state?.currentDrop || state?.current_drop;

    if (watchedChannel) {
        const channelCampId = String(watchedChannel.campaign_id || watchedChannel.campaignId || '').trim();
        if (campaignIdStr && channelCampId && channelCampId === campaignIdStr) return true;

        const channelGame = watchedChannel.game_name || watchedChannel.game || watchedChannel.game_title;
        if (channelGame && gameName && channelGame.trim().toLowerCase() === gameName.trim().toLowerCase()) {
            const hasUnclaimed = drops && drops.some(d => !(d.is_claimed ?? d.isClaimed ?? d.claimed));
            return hasUnclaimed || drops.length === 0;
        }
        return false;
    }

    if (currentDrop) {
        const curCampId = String(currentDrop.campaign_id || currentDrop.parent_campaign_id || '').trim();
        if (campaignIdStr && curCampId && curCampId === campaignIdStr) return true;

        const curGameName = currentDrop.game_name || currentDrop.game || currentDrop.game_title;
        if (curGameName && gameName) {
            return curGameName.trim().toLowerCase() === gameName.trim().toLowerCase();
        }
    }

    return false;
}

function checkIfCampaignHasProgress(drops, isActivelyMining) {
    if (isActivelyMining || !Array.isArray(drops)) return false;
    return drops.some(d => {
        const current = Math.round(d.current_minutes ?? d.currentMinutes ?? d.progress ?? 0);
        const isClaimed = d.is_claimed ?? d.isClaimed ?? d.claimed ?? false;
        return current > 0 && !isClaimed;
    });
}

function updateAllCampaignStatesInDOM(tree) {
    tree.forEach(gameGroup => {
        const campaigns = gameGroup.campaigns || [];
        campaigns.forEach(campaign => {
            const campId = campaign.campaign_id || campaign.id;
            if (!campId) return;

            const cardEl = document.querySelector(`.wanted-card[data-campaign-id="${CSS.escape(String(campId))}"]`);
            if (!cardEl) return;

            const campaignState = evaluateCampaignMiningState(campaign, gameGroup.game_name);
            cardEl.className = campaignState.cardClasses;

            // Refresh header status badge
            const headerMain = cardEl.querySelector('.wanted-card-header-main');
            if (headerMain) {
                const oldTag = headerMain.querySelector('.status-tag');
                if (oldTag) oldTag.remove();

                const newTag = renderCampaignStatusIndicatorElement(campaignState.isActivelyMining, campaignState.hasProgress);
                if (newTag) headerMain.appendChild(newTag);
            }
        });

        if (gameGroup.game_name) {
            updateGameGroupBadge(gameGroup.game_name);
        }
    });
}

// ==================== 4. Direct Fast DOM Updates (Real-time Socket) ====================

/**
 * Direct targeted update of a single drop DOM node without rebuilding layout.
 */
function updateWantedDropDOMNode(dropIdentifier, currentMins, requiredMins, isClaimed = false, remainingSecs = null) {
    if (!dropIdentifier) return;

    let targetStr = String(dropIdentifier).trim();
    if ((targetStr.startsWith('"') && targetStr.endsWith('"')) || (targetStr.startsWith("'") && targetStr.endsWith("'"))) {
        targetStr = targetStr.slice(1, -1).trim();
    }

    const dropRow = document.querySelector(`[data-wanted-drop-id="${CSS.escape(targetStr)}"]`) 
                 || document.querySelector(`[data-drop-id="${CSS.escape(targetStr)}"]`)
                 || document.querySelector(`[data-drop-name="${CSS.escape(targetStr)}"]`);

    if (!dropRow) return;

    let effectiveMins = currentMins;
    if (remainingSecs !== null && remainingSecs !== undefined && requiredMins > 0) {
        effectiveMins = Math.max(0, requiredMins - Math.ceil(Number(remainingSecs) / 60));
    }

    const pct = isClaimed ? 100 : (requiredMins > 0 ? Math.min(100, Math.max(0, Math.round((effectiveMins / requiredMins) * 100))) : 0);

    // Update Text Node Directly
    const timeTextEl = dropRow.querySelector('.wanted-drop-text, .status-tag.tag-progress');
    if (timeTextEl && requiredMins > 0) {
        const newHTML = `${getStatusIconSVG('drop-active')} ${effectiveMins} / ${requiredMins} min`;
        if (timeTextEl.innerHTML !== newHTML) {
            timeTextEl.innerHTML = newHTML;
        }
    }

    // Update Progress Bar Directly
    const progressBarEl = dropRow.querySelector('.bar-fill, .wanted-drop-progress-bar');
    if (progressBarEl) {
        progressBarEl.style.width = `${pct}%`;
    }
}

/**
 * Unified progress sync: updates state memory & applies fast in-place DOM updates.
 */
function syncWantedItemsProgress(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (!Array.isArray(state?.wantedItemsTree)) return;

    const targetCampId = String(payload.campaign_id || payload.campaignId || '');
    const targetDropId = String(payload.drop_id || payload.id || '');
    const targetDropName = String(payload.drop_name || payload.name || '').trim();

    const remSecs = payload.remaining_seconds !== undefined ? payload.remaining_seconds : payload.remainingSeconds;
    let currMins = payload.current_minutes !== undefined ? payload.current_minutes : payload.currentMinutes;

    const watchedChannel = getWatchedChannelContext();
    const activeGameName = watchedChannel?.game_name || watchedChannel?.game || payload.game_name || payload.game || '';

    state.wantedItemsTree.forEach((gameGroup) => {
        const campaigns = gameGroup.campaigns || gameGroup.campaign_list || [];
        let groupUpdated = false;

        const isMatchingGameGroup = activeGameName && 
            gameGroup.game_name && 
            gameGroup.game_name.trim().toLowerCase() === activeGameName.trim().toLowerCase();

        campaigns.forEach((campaign) => {
            const campId = String(campaign.id || campaign.campaign_id || '');
            const drops = campaign.drops || campaign.items || [];
            
            const matchesCampaign = (targetCampId && campId === targetCampId) || 
                                    isMatchingGameGroup || 
                                    drops.some(d => targetDropName && String(d.name || '').trim() === targetDropName);

            if (matchesCampaign) {
                drops.forEach((drop) => {
                    const dropName = String(drop.name || '').trim();
                    const dropId = String(drop.id || drop.drop_id || drop.uuid || '').trim();

                    const isTargetDrop = (targetDropId && dropId === targetDropId) || 
                                         (targetDropName && dropName === targetDropName) ||
                                         (!targetDropId && !targetDropName && isMatchingGameGroup);

                    const dropReq = Number(drop.required_minutes || drop.requiredMinutes || 0);

                    if (!drop.is_claimed && isTargetDrop) {
                        let effectiveCurrMins = currMins;
                        if (remSecs !== undefined && remSecs !== null && dropReq > 0) {
                            effectiveCurrMins = Math.max(0, dropReq - Math.ceil(Number(remSecs) / 60));
                        }

                        if (effectiveCurrMins !== undefined && !isNaN(effectiveCurrMins)) {
                            drop.current_minutes = effectiveCurrMins;

                            const domKey = dropId || dropName;
                            if (domKey) {
                                updateWantedDropDOMNode(domKey, effectiveCurrMins, dropReq, drop.is_claimed, remSecs);
                                groupUpdated = true;
                            }
                        }
                    }
                });
            }
        });

        if (groupUpdated && gameGroup.game_name) {
            updateGameGroupBadge(gameGroup.game_name);
        }
    });
}

function cleanupInactiveCampaigns() {
    if (!Array.isArray(state?.wantedItemsTree)) return;

    const watchedChannel = getWatchedChannelContext();
    const activeGameName = watchedChannel?.game_name || watchedChannel?.game || null;

    state.wantedItemsTree.forEach((gameGroup) => {
        if (!gameGroup.campaigns) return;

        gameGroup.campaigns = gameGroup.campaigns.filter(campaign => {
            const drops = campaign.drops || campaign.items || [];
            const allClaimed = drops.length > 0 && drops.every(d => Boolean(d.is_claimed ?? d.isClaimed ?? d.claimed));
            const isCurrentGame = activeGameName && 
                gameGroup.game_name && 
                gameGroup.game_name.trim().toLowerCase() === activeGameName.trim().toLowerCase();
                
            return !allClaimed || isCurrentGame;
        });

        if (gameGroup.game_name) {
            updateGameGroupBadge(gameGroup.game_name);
        }
    });

    state.wantedItemsTree = state.wantedItemsTree.filter(gameGroup => Array.isArray(gameGroup.campaigns) && gameGroup.campaigns.length > 0);
}

// ==================== 5. Helpers & Calculations ====================

function calculateClaimedDropsCount(campaign, drops) {
    const totalCount = campaign.total_drops_count || (drops ? drops.length : 0);
    const completedOutsideArray = Math.max(0, totalCount - (drops ? drops.length : 0));

    const finishedInArray = (drops || []).filter(d => {
        const isClaimed = d.is_claimed === true || d.is_claimed === 1 || d.is_claimed === 'true';
        const canClaim = d.can_claim === true || d.can_claim === 1;
        const current = Math.round(d.current_minutes || 0);
        const required = d.required_minutes || 0;
        return isClaimed || canClaim || (required > 0 && current >= required);
    }).length;

    return completedOutsideArray + finishedInArray;
}

function calculateMaxRemainingTime(uncompletedCampaigns, isParallel = false) {
    if (!Array.isArray(uncompletedCampaigns) || uncompletedCampaigns.length === 0) return 0;

    const campaignInfoList = uncompletedCampaigns.map(c => {
        const drops = c.drops || c.drop_list || c.items || [];
        
        const uncompletedDrops = drops.filter(d => {
            const isClaimed = Boolean(d.is_claimed ?? d.isClaimed ?? d.claimed ?? false);
            return !isClaimed;
        });

        if (uncompletedDrops.length === 0) return 0;

        const maxRequired = Math.max(...uncompletedDrops.map(d => Number(d.required_minutes ?? d.requiredMinutes ?? d.required_time ?? 0)));
        const currentMins = Number(uncompletedDrops[0].current_minutes ?? uncompletedDrops[0].currentMinutes ?? uncompletedDrops[0].progress ?? 0);

        return Math.max(0, maxRequired - Math.round(currentMins));
    });

    if (isParallel) {
        // Při paralelním těžení platí nejdelší čas
        return Math.max(...campaignInfoList, 0);
    } else {
        // Při sériovém těžení (jedna po druhé) se časy sečítají
        return campaignInfoList.reduce((acc, curr) => acc + curr, 0);
    }
}

function updateGameGroupBadge(gameName, totalRemainingMins = null) {
    if (!gameName) return;

    let mins = Number(totalRemainingMins);

    if (totalRemainingMins === null || totalRemainingMins === undefined || isNaN(mins)) {
        const gameGroup = state?.wantedItemsTree?.find(g => (g.game_name || g.name) === gameName);
        const campaigns = gameGroup?.campaigns || gameGroup?.campaign_list || [];
        mins = calculateMaxRemainingTime(campaigns);
    }

    mins = Math.max(0, isNaN(mins) ? 0 : mins);

    const badgeEl = document.querySelector(`.wanted-game-group[data-game-name="${CSS.escape(gameName)}"] .wanted-game-time-badge`);
    if (badgeEl) {
        const hours = Math.floor(mins / 60);
        const remainderMins = mins % 60;
        const timeText = hours > 0 ? `${hours}h ${remainderMins}m` : `${remainderMins}m`;
        const newHTML = `${getStatusIconSVG('active')} ${timeText}`;

        if (badgeEl.innerHTML !== newHTML) {
            badgeEl.innerHTML = newHTML;
        }
    }
}

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

function getDropUniqueId(drop, index = 1) {
    return String(drop.id || drop.drop_id || drop.uuid || `drop-${index}`).trim();
}

function getWatchedChannelContext() {
    if (typeof getWatchedChannelObject === 'function') {
        const channel = getWatchedChannelObject();
        if (channel) return channel;
    }
    const ch = state?.watchedChannel || state?.currentChannel || state?.watching_channel;
    if (typeof ch === 'string' && state?.channels) {
        const chList = Array.isArray(state.channels) ? state.channels : Object.values(state.channels);
        const found = chList.find(c => String(c.id || c.username || c.name || c.displayName) === String(ch));
        if (found) return found;
    }
    return typeof ch === 'object' ? ch : null;
}

// ==================== 6. Icons & Assets ====================

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
