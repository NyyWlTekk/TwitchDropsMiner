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
    const groupEl = makeElement('div', { class: 'wanted-game-group' });

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

    if (gameGroup.total_remaining_minutes) {
        const hours = Math.floor(gameGroup.total_remaining_minutes / 60);
        const mins = gameGroup.total_remaining_minutes % 60;
        const timeText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        console.log(`[CREATE_GAME_GROUP] Group time remaining badge text: ${timeText}`);

        const badgeEl = makeElement('span', { class: 'wanted-game-time-badge' });
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
 * Creates a single campaign card element with its drop items.
 */
function createCampaignCardElement(campaign) {
    const campaignId = campaign.campaign_id || campaign.id || '';
    console.group(`[CREATE_CAMPAIGN_CARD] Campaign ID: "${campaignId}", Name: "${campaign.name}"`);

    const element = makeElement('div', {
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
                console.log(`[CREATE_CAMPAIGN_CARD] Drop counts - claimed: ${claimedCount}, total: ${totalCount}`);
                
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
        const drops = campaign.drops || [];
        console.log(`[CREATE_CAMPAIGN_CARD] Creating ${drops.length} drop item elements.`);
        
        drops.forEach((drop, index) => {
            if (typeof createDropItemElement === 'function') {
                dropContainer.appendChild(createDropItemElement(drop, index + 1));
            }
        });

        const bodyEl = makeElement('div', { class: 'wanted-card-body' }, '', b => b.appendChild(dropContainer));

        cardEl.appendChild(headerEl);
        cardEl.appendChild(bodyEl);
    });

    console.groupEnd();
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

/**
 * [INFO] Creates an individual drop item element.
 */
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
            
            (drop.benefits || []).forEach(benefit => {
                info.appendChild(makeElement('span', { class: 'wanted-benefit-pill' }, benefit));
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
function syncWantedItemsProgress(arg1, arg2, arg3) {
    let data = arg3;
    if (!data || typeof data !== 'object') {
        if (arg2 && typeof arg2 === 'object') {
            data = arg2;
        } else if (arg1 && typeof arg1 === 'object') {
            data = arg1;
        }
    }

    console.group("[SYNC_WANTED_PROGRESS]");
    console.log("Normalized sync data payload:", data);

    if (!data || typeof data !== 'object') {
        console.warn("[SYNC_WANTED] Guard violation: Incoming data is empty or invalid after normalization:", { arg1, arg2, arg3 });
        console.groupEnd();
        return false;
    }

    if (data.gathering || data.current_minutes === undefined) {
        console.warn("[SYNC_WANTED] Ignoring data in gathering state or missing minutes:", data);
        console.groupEnd();
        return false;
    }

    // Safely initialize wantedItemsTree if it's not ready yet to prevent sync drops on early socket events
    if (!state.wantedItemsTree || !Array.isArray(state.wantedItemsTree)) {
        console.log("[SYNC_WANTED] state.wantedItemsTree not initialized yet. Initializing as empty array.");
        state.wantedItemsTree = [];
    }

    const sharedCurrentMins = Number(data.current_minutes) || 0;
    let treeUpdated = false;

    state.wantedItemsTree.forEach((gameGroup) => {
        if (!gameGroup.campaigns || !Array.isArray(gameGroup.campaigns)) return;

        gameGroup.campaigns.forEach((campaign) => {
            const campaignId = campaign.campaign_id || campaign.id;
            const isCampaignMatch = (data.campaign_id && campaignId === data.campaign_id) || 
                                   (data.campaign_name && campaign.name === data.campaign_name);
            
            if (!isCampaignMatch || !campaign.drops || !Array.isArray(campaign.drops)) return;

            console.log(`[CAMPAIGN_SYNC] Match found! Updating campaign: "${campaign.name}" (ID: ${campaignId}) with shared minutes: ${sharedCurrentMins}`);

            campaign.drops.forEach((drop, index) => {
                const reqMins = Number(drop.required_minutes) || 0;
                
                drop.current_minutes = sharedCurrentMins; 
                
                if (reqMins > 0) {
                    const effectiveMins = Math.min(sharedCurrentMins, reqMins);
                    drop.progress = Math.min(100, (effectiveMins / reqMins) * 100);
                    drop.can_claim = sharedCurrentMins >= reqMins && !drop.is_claimed;
                }

                const dropId = drop.drop_id || drop.id;
                if (data.is_claimed !== undefined && (dropId === data.drop_id || drop.name === data.drop_name)) {
                    drop.is_claimed = data.is_claimed;
                    console.log(`[CAMPAIGN_SYNC] Drop claim status updated for "${drop.name}": ${drop.is_claimed}`);
                }

                const targetDropId = getDropUniqueId(drop, index + 1);
                console.log(`[CAMPAIGN_SYNC] Syncing DOM element for drop index ${index + 1} [ID: ${targetDropId}] - Current: ${drop.current_minutes}, Required: ${reqMins}`);
                updateDropInDOM(targetDropId, drop.current_minutes, reqMins, drop.is_claimed);
            });

            campaign.claimed_drops_count = campaign.drops.filter(d => d.is_claimed).length;
            treeUpdated = true;
        });
    });

    console.log(`[SYNC_WANTED_PROGRESS] Synchronization complete. Tree updated flag: ${treeUpdated}`);
    console.groupEnd();
    return treeUpdated;
}
