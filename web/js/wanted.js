// ==================== Wanted Items Rendering ====================

function formatCampaignDates(startIso, endIso) {
    console.group("[FORMAT_CAMPAIGN_DATES]");
    console.log("Input startIso:", startIso, "endIso:", endIso);
    
    if (!startIso || !endIso) {
        console.warn("[FORMAT_CAMPAIGN_DATES] Missing start or end ISO date string. Returning empty string.");
        console.groupEnd();
        return '';
    }
    
    try {
        const start = new Date(startIso);
        const end = new Date(endIso);
        const formatOpts = { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' };
        const result = `${start.toLocaleDateString(undefined, formatOpts)} – ${end.toLocaleDateString(undefined, formatOpts)}`;
        console.log("[FORMAT_CAMPAIGN_DATES] Successfully formatted dates:", result);
        console.groupEnd();
        return result;
    } catch (e) {
        console.error("[FORMAT_CAMPAIGN_DATES] Failed to parse dates:", e);
        console.groupEnd();
        return '';
    }
}

function renderWantedItems(tree) {
    console.group("[RENDER_WANTED_ITEMS]");
    console.log("Received tree data structure:", tree);
    
    const container = document.getElementById('wanted-items-list');
    if (!container) {
        console.warn("[RENDER_WANTED_ITEMS] Target container element 'wanted-items-list' not found in DOM.");
        console.groupEnd();
        return;
    }

    state.wantedItemsTree = tree || [];

    if (!tree || tree.length === 0) {
        console.log("[RENDER_WANTED_ITEMS] Tree is empty or null. Rendering empty message.");
        const emptyMsg = state.translations.gui?.wanted?.none || 'No wanted drops queued...';
        container.replaceChildren(makeElement('p', { class: 'empty-message-small' }, emptyMsg));
        updateOverallProgress();
        console.groupEnd();
        return;
    }

    console.log(`[RENDER_WANTED_ITEMS] Building document fragment for ${tree.length} game groups.`);
    const fragment = document.createDocumentFragment();

    tree.forEach((gameGroup, index) => {
        fragment.appendChild(createGameGroupElement(gameGroup, index));
    });

    container.replaceChildren(fragment);
    updateOverallProgress();
    console.log("[RENDER_WANTED_ITEMS] Successfully rendered wanted items list into DOM.");
    console.groupEnd();
}

/**
 * Creates a game group DOM element containing its campaigns.
 */
function createGameGroupElement(gameGroup, index) {
    console.group(`[CREATE_GAME_GROUP] Index: ${index}, Game: "${gameGroup.game_name}"`);
    const groupEl = makeElement('div', { 
        class: 'wanted-game-group',
        'data-game-name': gameGroup.game_name 
    });

    let iconUrl = gameGroup.game_icon;
    if (iconUrl) {
        iconUrl = iconUrl.replace('{width}', '40').replace('{height}', '53');
        console.log("[CREATE_GAME_GROUP] Processed game icon URL:", iconUrl);
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
        console.log(`[CREATE_GAME_GROUP] Group time remaining badge text: ${timeText}`);

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
    console.log(`[CREATE_GAME_GROUP] Rendering ${campaigns.length} campaigns for this game group.`);
    
    campaigns.forEach(campaign => {
        campaignListEl.appendChild(createCampaignCardElement(campaign));
    });

    groupEl.appendChild(campaignListEl);
    console.groupEnd();
    return groupEl;
}

/**
 * [INFO] Creates a single campaign card element with its drop items.
 */
function createCampaignCardElement(campaign) {
    const campaignId = campaign.campaign_id || campaign.id || '';
    
    const drops = campaign.drops || [];
    
    // 1. Zjištění, zda se tato kampaň aktuálně těží
    let isActivelyMining = false;
    const currentDrop = (typeof state !== 'undefined' && state.currentDrop) || safeGetStorage('app_saved_current_drop');
    if (currentDrop) {
        const dropCampaignId = currentDrop.campaign_id || currentDrop.parent_campaign_id;
        if (dropCampaignId && String(dropCampaignId) === String(campaignId)) {
            isActivelyMining = true;
        } else if (drops.length > 0) {
            isActivelyMining = drops.some(d => 
                (d.id && currentDrop.id && String(d.id) === String(currentDrop.id)) ||
                (d.drop_id && currentDrop.drop_id && String(d.drop_id) === String(currentDrop.drop_id))
            );
        }
    }

    // 2. Zjištění, zda má kampaň nějaký rozpracovaný progress (a netěží se zrovna teď)
    let hasProgress = false;
    if (!isActivelyMining) {
        hasProgress = drops.some(d => {
            const current = Math.round(d.current_minutes || 0);
            return current > 0;
        });
    }

    // Sestavení tříd pro kartu
    let cardClasses = 'wanted-card';
    if (isActivelyMining) {
        cardClasses += ' active-mining';
    } else if (hasProgress) {
        cardClasses += ' in-progress';
    }

    const element = makeElement('div', {
        class: cardClasses,
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

                const totalCount = campaign.total_drops_count || drops.length;
                const completedOutsideArray = Math.max(0, totalCount - drops.length);
                
                const finishedInArray = drops.filter(d => {
                    const isClaimed = d.is_claimed === true || d.is_claimed === 1 || d.is_claimed === 'true' || d.is_claimed === '1';
                    const canClaim = d.can_claim === true || d.can_claim === 1;
                    const current = Math.round(d.current_minutes || 0);
                    const required = d.required_minutes || 0;
                    return isClaimed || canClaim || (required > 0 && current >= required);
                }).length;
                
                const claimedCount = completedOutsideArray + finishedInArray;
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
        drops.forEach((drop, index) => {
            if (typeof createDropItemElement === 'function') {
                dropContainer.appendChild(createDropItemElement(drop, index + 1));
            }
        });

        const bodyEl = makeElement('div', { class: 'wanted-card-body' }, '', b => b.appendChild(dropContainer));

        cardEl.appendChild(headerEl);
        cardEl.appendChild(bodyEl);
    });

    return element;
}

/**
 * [INFO] Generates a consistent unique ID for a drop item element.
 */
function getDropUniqueId(drop, index = 1) {
    const dropId = drop.drop_id || drop.id || `drop-${index}-${drop.name}`;
    console.log(`[GET_DROP_ID] Resolved unique ID for drop "${drop.name}": ${dropId}`);
    return dropId;
}

function createDropItemElement(drop, index = 1) {
    const dropId = getDropUniqueId(drop, index);
    console.group(`[CREATE_DROP_ITEM] Index: ${index}, Drop ID: "${dropId}", Name: "${drop.name}"`);

    const element = makeElement('div', {
        class: `wanted-drop-item ${drop.is_claimed ? 'is-claimed' : ''}`,
        'data-drop-id': String(dropId)
    }, '', el => {
        const infoEl = makeElement('div', { class: 'wanted-drop-info' }, '', info => {
            const displayName = index ? `Drop ${index}: ${drop.name}` : drop.name;
            info.appendChild(makeElement('span', { class: 'wanted-drop-name' }, displayName));
            
            const rawName = (drop.name || '').toLowerCase();
			// Normalizace názvu – oříznutí úvodních čísel a symbolů (např. "1. ")
			const normalizedDropName = rawName.replace(/^\d+[\.\)]?\s*/, '').trim();

			(drop.benefits || []).forEach(benefit => {
				if (benefit) {
					const cleanBenefit = benefit.trim().toLowerCase();
					// Přeskočí benefit, pokud se shoduje nebo je obsažen v normalizovaném názvu
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
        console.log(`[CREATE_DROP_ITEM] Metrics - current: ${current}m, required: ${required}m, claimed: ${!!drop.is_claimed}`);

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

    console.groupEnd();
    return element;
}

/**
 * [INFO] Syncs progress for wanted items in the tree with automatic initialization and safe matching.
 */
function syncWantedItemsProgress(data) {
    console.group("[SYNC_WANTED_PROGRESS]");

    // [FIX] Handle case where data is passed simply as a primitive string ID
    if (typeof data === 'string') {
        const dropId = data;
        console.log("[SYNC_WANTED] Received data is a raw string ID, resolving drop info:", dropId);
        
        const activeDrop = (state.activeDropsQueue || []).find(d => (d.drop_id || d.id) === dropId) ||
                           (state.currentDrop && (state.currentDrop.drop_id || state.currentDrop.id) === dropId ? state.currentDrop : null);
        
        data = activeDrop ? { ...activeDrop } : { drop_id: dropId, current_minutes: activeDrop?.current_minutes || 0 };
    }

    console.log("Aktuální wantedItemsTree:", state.wantedItemsTree);
    const dropIdToFind = data.drop_id || data.id || data.current_drop_id;
    console.log("Hledám drop ID:", dropIdToFind);
    console.log("Celý objekt data přicházející do wanted.js:", JSON.stringify(data, null, 2));

    // Safely initialize wantedItemsTree if it's not ready yet to prevent sync drops on early socket events
    if (!state.wantedItemsTree || !Array.isArray(state.wantedItemsTree)) {
        console.log("[SYNC_WANTED] state.wantedItemsTree not initialized yet. Initializing as empty array.");
        state.wantedItemsTree = [];
    }

    const sharedCurrentMins = Number(data.current_minutes) || 0;
    let treeUpdated = false;

    state.wantedItemsTree.forEach((gameGroup) => {
        if (!gameGroup.campaigns || !Array.isArray(gameGroup.campaigns)) return;

        let groupHasChanges = false;

        gameGroup.campaigns.forEach((campaign) => {
            const campaignId = campaign.campaign_id || campaign.id;
            
            // [ROTATION FIX] Verify if the campaign matches by ID/name OR if it contains the currently rotated drop
            const hasMatchingDrop = (campaign.drops || []).some(d => {
                const dId = d.drop_id || d.id;
                return (data.drop_id && dId === data.drop_id) || (data.drop_name && d.name === data.drop_name);
            });

            const isCampaignMatch = (data.campaign_id && campaignId === data.campaign_id) || 
                                   (data.campaign_name && campaign.name === data.campaign_name) ||
                                   hasMatchingDrop;
            
            if (!isCampaignMatch || !campaign.drops || !Array.isArray(campaign.drops)) return;

            console.log(`[CAMPAIGN_SYNC] Match found! Updating campaign: "${campaign.name}" (ID: ${campaignId}) with shared minutes: ${sharedCurrentMins}`);

            campaign.drops.forEach((drop, index) => {
                const dropId = drop.drop_id || drop.id;
                const isMatchingDrop = (data.drop_id && dropId === data.drop_id) || 
                                       (data.drop_name && drop.name === data.drop_name);
                
                const isCampaignWideUpdate = !data.drop_id && !data.drop_name;

                // Apply current_minutes ONLY to the specific drop being reported (or all if campaign-wide)
                if (isMatchingDrop || isCampaignWideUpdate) {
                    const reqMins = Number(drop.required_minutes) || 0;
                    drop.current_minutes = sharedCurrentMins; 
                    
                    if (reqMins > 0) {
                        const effectiveMins = Math.min(sharedCurrentMins, reqMins);
                        drop.progress = Math.min(100, (effectiveMins / reqMins) * 100);
                        drop.can_claim = sharedCurrentMins >= reqMins && !drop.is_claimed;
                    }
                }

                if (data.is_claimed !== undefined && isMatchingDrop) {
                    drop.is_claimed = data.is_claimed;
                    console.log(`[CAMPAIGN_SYNC] Drop claim status updated for "${drop.name}": ${drop.is_claimed}`);
                }

                const targetDropId = getDropUniqueId(drop, index + 1);
                const reqMinsForDom = Number(drop.required_minutes) || 0;
                console.log(`[CAMPAIGN_SYNC] Syncing DOM element for drop index ${index + 1} [ID: ${targetDropId}] - Current: ${drop.current_minutes}, Required: ${reqMinsForDom}`);
                updateDropInDOM(targetDropId, drop.current_minutes, reqMinsForDom, drop.is_claimed);
            });

            campaign.claimed_drops_count = campaign.drops.filter(d => d.is_claimed).length;
            groupHasChanges = true;
            treeUpdated = true;
        });

		// If anything updated in this group, calculate total remaining time dynamically (sum vs max)
        if (groupHasChanges) {
            const uncompletedCampaigns = gameGroup.campaigns.filter(c => {
                return (c.drops || []).some(d => !d.is_claimed);
            });

            let totalRemainingMins = 0;

            if (uncompletedCampaigns.length > 0) {
                const campaignInfoList = uncompletedCampaigns.map(c => {
                    let campRem = 0;
                    let hasStarted = false;
                    (c.drops || []).forEach(d => {
                        if (!d.is_claimed) {
                            const req = Number(d.required_minutes) || 0;
                            const cur = Number(d.current_minutes) || 0;
                            campRem += Math.max(0, req - cur);
                            if (cur > 0) hasStarted = true;
                        }
                    });
                    return { remaining: campRem, hasStarted };
                });

                // Zjistíme, kolik kampaní už reálně začalo těžit (má current_minutes > 0)
                const startedCount = campaignInfoList.filter(item => item.hasStarted).length;

                if (uncompletedCampaigns.length > 1 && startedCount > 1) {
                    totalRemainingMins = Math.max(...campaignInfoList.map(item => item.remaining));
                } else {
                    totalRemainingMins = campaignInfoList.reduce((sum, item) => sum + item.remaining, 0);
                }
            }

            gameGroup.total_remaining_minutes = totalRemainingMins;

            const badgeEl = document.querySelector(`.wanted-game-group[data-game-name="${CSS.escape(gameGroup.game_name)}"] .wanted-game-time-badge`);
            if (badgeEl) {
                const hours = Math.floor(totalRemainingMins / 60);
                const mins = totalRemainingMins % 60;
                const timeText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
                badgeEl.innerHTML = `${getStatusIconSVG('active')} ${timeText}`;
            }
        }
    });

    console.log(`[SYNC_WANTED_PROGRESS] Synchronization complete. Tree updated flag: ${treeUpdated}`);
    console.groupEnd();
    return treeUpdated;
}
