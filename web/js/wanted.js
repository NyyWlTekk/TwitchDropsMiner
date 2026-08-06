///////////////////////////////////////////////////////////////////////////////
// WANTED QUEUE MODULE (CLEAN & DIRECT RENDERING)
///////////////////////////////////////////////////////////////////////////////

/**
 * Main entry point for rendering the Wanted Queue.
 * Receives cleaned tree data and delegates to DOM renderer.
 */
function renderWantedItems(tree) {
    // 1. Always update global state if fresh data is provided
    if (tree) {
        state.wantedItemsTree = tree;
    }

    // 2. Fetch current tree from state if parameter was omitted
    const currentTree = tree || (typeof state !== 'undefined' ? state.wantedItemsTree : []);

    if (!currentTree || currentTree.length === 0) {
        console.log('[WantedUI] No items to render.');
    }

    // 3. Perform immediate DOM render
    if (typeof performRenderWantedItems === 'function') {
        performRenderWantedItems(currentTree);
    }
}

/**
 * Smart DOM renderer with clean node reconciliation for Game Groups.
 */
function performRenderWantedItems(tree) {
    const container = document.getElementById('wanted-items-list');
    if (!container) return;

    // 1. Zobrazení prázdného stavu
    if (!tree || tree.length === 0) {
        const emptyMsg = state?.translations?.gui?.wanted?.none || 'No wanted drops queued...';
        container.replaceChildren(makeElement('p', { class: 'empty-message-small' }, emptyMsg));
        if (typeof updateOverallProgress === 'function') updateOverallProgress();
        return;
    }

    // 2. Namapování stávajících DOM elementů podle názvu hry
    const existingGroups = new Map();
    container.querySelectorAll('.wanted-game-group').forEach(el => {
        if (el.dataset.gameName) {
            existingGroups.set(el.dataset.gameName, el);
        }
    });

    const fragment = document.createDocumentFragment();

    // 3. Procházení vyčištěného stromu a aktualizace / tvorba elementů
    tree.forEach((gameGroup, index) => {
        const gameName = gameGroup.game_name || gameGroup.name || 'Unknown Game';
        let groupEl = existingGroups.get(gameName);

        if (groupEl) {
            existingGroups.delete(gameName); // Označíme jako zachovaný
            if (typeof updateGameGroupElement === 'function') {
                updateGameGroupElement(groupEl, gameGroup, index);
            }
        } else if (typeof renderGameGroupElement === 'function') {
            groupEl = renderGameGroupElement(gameGroup, index);
        }

        if (groupEl) {
            fragment.appendChild(groupEl);
        }
    });

    // 4. Odstranění herních skupin, které už ve stromu nejsou
    existingGroups.forEach(el => el.remove());

    // 5. Atomické vložení do DOMu bez problikávání
    container.replaceChildren(fragment);

    // 6. Aktualizace celkového progresu
    if (typeof updateOverallProgress === 'function') {
        updateOverallProgress();
    }
}

// ==================== 2. DOM Builders & Components ====================

/**
 * Evaluates mining state and progress for a campaign and assigns all CSS class variants.
 */
function evaluateCampaignMiningState(campaign, gameName = '') {
    if (!campaign) {
        return { campaignId: '', cardClasses: 'wanted-card', drops: [], isActivelyMining: false, hasProgress: false, isReady: false };
    }

    const campaignId = String(campaign.id || campaign.campaign_id || '').trim();
    const drops = campaign.drops || campaign.drop_list || [];

    // 1. Zjistíme stavy z předpočítaných dat nebo logiky
    const isActivelyMining = Boolean(campaign.is_mining || campaign.active);
    
    // Zda je některý drop připraven k vyzvednutí
    const isReadyToClaim = drops.some(d => d.can_claim || (!d.is_claimed && Number(d.required_minutes) > 0 && Number(d.current_minutes) >= Number(d.required_minutes)));
    
    // Zda jsou všechny dropy v kampani hotové/vyzvednuté
    const totalDrops = drops.length;
    const claimedDrops = drops.filter(d => d.is_claimed).length;
    const isClaimed = totalDrops > 0 && claimedDrops === totalDrops;

    // Zda má kampaň rozpracovaný progress
    const hasProgress = drops.some(d => !d.is_claimed && (Number(d.progress) > 0 || Number(d.current_minutes) > 0));

    // Zda je kampaň expirovaná
    const isExpired = campaign.status === 'EXPIRED' || (campaign.ends_at && new Date(campaign.ends_at) < new Date());

    // 2. Sestavíme kompletní seznam tříd (pokryjeme VŠECHNY varianty z tvého CSS!)
    let classList = ['wanted-card'];

    if (isActivelyMining) {
        // Pokryje .wanted-card.is-mining i .wanted-card.active-mining + animace
        classList.push('is-mining', 'active-mining');
    } else if (isReadyToClaim) {
        // Pokryje .wanted-card.is-ready, .wanted-card.ready i .wanted-card.ready-to-claim
        classList.push('is-ready', 'ready', 'ready-to-claim');
    } else if (isClaimed) {
        // Pokryje .wanted-card.is-claimed i .wanted-card.completed
        classList.push('is-claimed', 'completed');
    } else if (hasProgress) {
        // Pokryje .wanted-card.in-progress
        classList.push('in-progress');
    } else if (isExpired) {
        // Pokryje .wanted-card.expired
        classList.push('expired');
    }

    // Přidáme i případný originální status z objektu (např. active, upcoming atd.)
    if (campaign.status) {
        classList.push(String(campaign.status).toLowerCase());
    }

    return {
        campaignId: campaignId,
        cardClasses: classList.join(' '),
        drops: drops,
        isActivelyMining: isActivelyMining,
        hasProgress: hasProgress,
        isReady: isReadyToClaim
    };
}

/**
 * Generates status badge element for active mining, in-progress, or queued status.
 */
function renderCampaignStatusIndicatorElement(isActivelyMining, hasProgress, campaignState = null) {
    const t = state?.translations?.gui?.wanted;
    const iconGetter = typeof getStatusIconSVG === 'function' ? getStatusIconSVG : () => '';

    let statusClass = 'tag-queued';
    let label = t?.queued ?? 'Queued';
    let iconName = 'upcoming';

    if (isActivelyMining) {
        statusClass = 'tag-mining';
        label = t?.mining ?? 'Mining';
        iconName = 'active';
    } else if (hasProgress) {
        statusClass = 'tag-in-progress';
        label = t?.in_progress ?? 'In Progress';
        iconName = 'in-progress';
    }

    const badgeEl = makeElement('span', { class: `wanted-status-badge status-tag ${statusClass}` });
    const iconSvg = iconGetter(iconName);

    badgeEl.innerHTML = `${iconSvg} ${label}`.trim();
    return badgeEl;
}


/**
 * Renders a single Game Group container with index, header badge, and campaign cards.
 */
function renderGameGroupElement(gameGroup, index = 0) {
    if (!gameGroup || typeof gameGroup !== 'object') {
        return makeElement('div', { class: 'wanted-game-group' });
    }

    const gameName = gameGroup.game_name || gameGroup.name || 'Unknown Game';
    const campaigns = gameGroup.campaigns || gameGroup.campaign_list || [];

    // 1. Úprava URL ikony hry
    let iconUrl = gameGroup.game_icon || gameGroup.icon || gameGroup.box_art_url || '';
    if (typeof iconUrl === 'string' && iconUrl) {
        iconUrl = iconUrl.replace('{width}', '40').replace('{height}', '53');
    }

    // 2. Výpočet zbývajícího času
    const mins = typeof calculateMaxRemainingTime === 'function' 
        ? calculateMaxRemainingTime(campaigns) 
        : Number(gameGroup.total_remaining_minutes || 0);

    const safeMins = Math.max(0, isNaN(mins) ? 0 : mins);
    const hours = Math.floor(safeMins / 60);
    const remainderMins = safeMins % 60;
    const timeText = hours > 0 ? `${hours}h ${remainderMins}m` : `${remainderMins}m`;
    const iconGetter = typeof getStatusIconSVG === 'function' ? getStatusIconSVG : () => '';

    // 3. Vytvoření hlavního obalu a hlavičky
    const groupEl = makeElement('div', { class: 'wanted-game-group', 'data-game-name': gameName });

    const headerEl = makeElement('div', { class: 'wanted-game-header' }, '', h => {
        h.appendChild(makeElement('span', { class: 'wanted-game-index' }, `#${index + 1}`));
        
        if (iconUrl) {
            if (typeof makeImageElement === 'function') {
                h.appendChild(makeImageElement(iconUrl, gameName, 'wanted-game-icon'));
            } else {
                h.appendChild(makeElement('img', { src: iconUrl, alt: gameName, class: 'wanted-game-icon' }));
            }
        }

        h.appendChild(makeElement('span', { class: 'wanted-game-title' }, gameName));

        // Časový badge
        const badgeEl = makeElement('span', { class: 'wanted-game-time-badge', 'data-game-badge': gameName });
        badgeEl.innerHTML = `${iconGetter('active')} ${timeText}`.trim();
        h.appendChild(badgeEl);
    });

    groupEl.appendChild(headerEl);

    // 4. Generování jednotlivých karet kampaní
    const campaignListEl = makeElement('div', { class: 'wanted-campaign-list' });
    campaigns.forEach(campaign => {
        if (typeof renderCampaignCardElement === 'function') {
            campaignListEl.appendChild(renderCampaignCardElement(campaign, gameName));
        }
    });

    groupEl.appendChild(campaignListEl);

    return groupEl;
}

/**
 * Updates index, campaigns, and time badges for an existing game group DOM node.
 */
function updateGameGroupElement(groupEl, gameGroup, index = 0) {
    if (!groupEl || !gameGroup) return;

    const gameName = gameGroup.game_name || gameGroup.name || 'Unknown Game';

    const idxEl = groupEl.querySelector('.wanted-game-index');
    if (idxEl) {
        idxEl.textContent = `#${index + 1}`;
    }

    const campaignListEl = groupEl.querySelector('.wanted-campaign-list');
    if (campaignListEl) {
        const campaigns = gameGroup.campaigns || gameGroup.campaign_list || [];
        if (typeof renderCampaignCardElement === 'function') {
            campaignListEl.replaceChildren(
                ...campaigns.map(c => renderCampaignCardElement(c, gameName))
            );
        }
    }

    if (typeof updateGameGroupBadge === 'function') {
        updateGameGroupBadge(gameName, gameGroup.total_remaining_minutes);
    }
}

/**
 * Creates a campaign card container element.
 */
 // BARVY KAMPANÍ
function renderCampaignCardElement(campaign, gameName = '') {
    if (!campaign || typeof campaign !== 'object') {
        return makeElement('div', { class: 'wanted-campaign-card' });
    }

    const campaignState = typeof evaluateCampaignMiningState === 'function'
        ? evaluateCampaignMiningState(campaign, gameName)
        : {
            campaignId: campaign.id || campaign.campaign_id || '',
            cardClasses: `wanted-campaign-card ${campaign.status || ''}`.trim(),
            drops: campaign.drops || campaign.drop_list || [],
            isActivelyMining: Boolean(campaign.is_mining || campaign.active),
            hasProgress: Boolean(campaign.has_progress)
        };

    // Dynamic aggregation of classes for border and glow effects
    const rawClasses = String(campaignState.cardClasses || '').trim();
    const miningClass = campaignState.isActivelyMining ? 'is-mining mining' : '';
    // Prevent progress class from overriding active mining styles
    const progressClass = (!campaignState.isActivelyMining && campaignState.hasProgress) ? 'has-progress in-progress' : '';

    const combinedClasses = `wanted-campaign-card ${rawClasses} ${miningClass} ${progressClass}`.trim();
    // Remove duplicate spaces
    const finalCardClass = Array.from(new Set(combinedClasses.split(/\s+/))).join(' ');

    return makeElement('div', {
        class: finalCardClass,
        'data-campaign-id': String(campaignState.campaignId || campaign.id || '')
    }, '', cardEl => {
        if (typeof renderCampaignHeaderElement === 'function') {
            const headerEl = renderCampaignHeaderElement(campaign, campaignState.drops, campaignState);
            if (headerEl) cardEl.appendChild(headerEl);
        }

        if (typeof renderCampaignBodyElement === 'function') {
            const bodyEl = renderCampaignBodyElement(campaignState.drops, campaignState);
            if (bodyEl) cardEl.appendChild(bodyEl);
        }
    });
}

/**
 * Renders header for a campaign card with name, badges, and active dates.
 */
function renderCampaignHeaderElement(campaign, drops, campaignState = null) {
    if (!campaign || typeof campaign !== 'object') return null;

    const dropsList = drops ?? campaign.drops ?? campaign.drop_list ?? [];
    
    const claimedCount = campaign.claimed_drops_count ?? (
        typeof calculateClaimedDropsCount === 'function' 
            ? calculateClaimedDropsCount(campaign, dropsList) 
            : 0
    );
    
    const totalCount = Number(campaign.total_drops_count ?? dropsList.length ?? 0);
    const campaignName = campaign.name ?? campaign.title ?? 'Campaign';
    const campaignUrl = campaign.url ?? campaign.campaign_url ?? '#';
    const startsAt = campaign.starts_at ?? campaign.start_at ?? campaign.start_time ?? '';
    const endsAt = campaign.ends_at ?? campaign.end_at ?? campaign.end_time ?? '';
    const iconGetter = typeof getStatusIconSVG === 'function' ? getStatusIconSVG : () => '';

    // Určení třídy podle stavu kampaně
    const statusClass = campaignState?.isActivelyMining 
        ? 'mining' 
        : (campaignState?.hasProgress ? 'in-progress' : 'queued');

    return makeElement('div', { class: `wanted-card-header ${statusClass}` }, '', h => {
        // 1. ŘÁDEK: Název kampaně + (X/Y) odznak vpravo
        const titleRow = makeElement('div', { class: 'wanted-card-header-main' }, '', row => {
            row.appendChild(makeElement('a', {
                href: campaignUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'wanted-card-campaign-link',
                title: campaignName
            }, campaignName));

            row.appendChild(makeElement('span', { class: 'wanted-campaign-badge' }, `(${claimedCount}/${totalCount})`));
        });
        h.appendChild(titleRow);

        // 2. ŘÁDEK: Datum trvání kampaně (čistý řádek bez rušivých prvků)
        if (typeof formatCampaignDates === 'function') {
            const dateText = formatCampaignDates(startsAt, endsAt);
            if (dateText) {
                const datesEl = makeElement('div', { class: 'wanted-campaign-dates' });
                datesEl.innerHTML = `${iconGetter('upcoming')} ${dateText}`.trim();
                h.appendChild(datesEl);
            }
        }

        // 3. ŘÁDEK: Status badge samostatně úplně dole
        const statusBadge = typeof renderCampaignStatusIndicatorElement === 'function'
            ? renderCampaignStatusIndicatorElement(
                campaignState?.isActivelyMining, 
                campaignState?.hasProgress, 
                campaignState
            )
            : (campaignState ? makeElement('span', { class: `wanted-status-badge status-tag tag-${statusClass}` }, statusClass) : null);

        if (statusBadge) {
            const statusRow = makeElement('div', { class: 'wanted-card-header-status-row' });
            statusRow.appendChild(statusBadge);
            h.appendChild(statusRow);
        }
    });
}

/**
 * Renders campaign body container containing sorted drop items.
 */
function renderCampaignBodyElement(drops, campaignState = null) {
    const dropContainer = makeElement('div', { class: 'wanted-drops-container' });

    // 1. Řazení dropů podle požadovaného času v minutách
    const sortedDrops = [...(drops || [])].sort((a, b) => {
        const timeA = Number(a.required_minutes ?? a.requiredMinutes ?? 0);
        const timeB = Number(b.required_minutes ?? b.requiredMinutes ?? 0);
        return timeA - timeB;
    });

    // 2. Vykreslení jednotlivých řádků dropů
    sortedDrops.forEach((drop, index) => {
        if (typeof renderDropItemElement === 'function') {
            dropContainer.appendChild(renderDropItemElement(drop, index + 1, campaignState));
        }
    });

    return makeElement('div', { class: 'wanted-card-body' }, '', b => b.appendChild(dropContainer));
}

/**
 * Renders an individual drop item row with progress status, thumbnail images, and benefits.
 */
function renderDropItemElement(drop, index = 1, campaignState = null) {
    if (!drop) return makeElement('div', { class: 'wanted-drop-item' });

    const rawUuid = typeof getDropUniqueId === 'function' 
        ? getDropUniqueId(drop, index) 
        : String(drop.id || drop.drop_id || `drop-${index}`).trim();
        
    const dropName = drop.name || drop.title || 'Drop';
    const campaignId = campaignState?.campaignId || drop.campaign_id || '';

    const isClaimed = Boolean(drop.is_claimed ?? drop.isClaimed ?? drop.claimed);
    const canClaim = Boolean(drop.can_claim ?? drop.canClaim);
    const required = Number(drop.required_minutes ?? drop.requiredMinutes ?? 0);

    let current = isClaimed 
        ? required 
        : Math.round(Number(drop.current_minutes ?? drop.progress ?? 0));

    // Synchronizace s právě aktivním živým dropem v globálním stavu
    const activeDrop = state?.currentDrop || state?.current_drop;
    if (activeDrop && !isClaimed) {
        const activeDropId = String(activeDrop.drop_id || activeDrop.id || '').trim();
        if (activeDropId && activeDropId === String(rawUuid).trim()) {
            current = Math.round(Number(activeDrop.current_minutes ?? activeDrop.progress ?? 0));
        }
    }

    // Vyhledání náhledu obrázku (přímo u dropu nebo v prvním benefitu)
    const imageUrl = drop.image_url || drop.preview_url || drop.box_art_url || drop.benefits?.[0]?.image_url || null;

    return makeElement('div', {
        class: `wanted-drop-item ${isClaimed ? 'is-claimed' : ''} ${canClaim ? 'can-claim' : ''}`,
        'data-wanted-drop-id': String(rawUuid),
        'data-drop-id': String(rawUuid),
        'data-drop-name': String(dropName).trim(),
        'data-campaign-id': String(campaignId),
        'data-required-minutes': String(required)
    }, '', el => {
        
        // 1. Náhledový obrázek (pokud existuje)
        if (imageUrl) {
            const imgEl = makeElement('img', { 
                class: 'wanted-drop-image', 
                src: imageUrl, 
                alt: dropName,
                loading: 'lazy'
            });
            imgEl.onerror = () => { imgEl.style.display = 'none'; }; // Schová poškozený obrázek
            el.appendChild(imgEl);
        }

        // 2. Informační blok (Název + Benefit pilulky)
        const infoEl = makeElement('div', { class: 'wanted-drop-info' }, '', info => {
            const displayName = index ? `Drop ${index}: ${dropName}` : dropName;
            info.appendChild(makeElement('span', { class: 'wanted-drop-name' }, displayName));

            const rawName = (dropName || '').toLowerCase().replace(/^\d+[\.\)]?\s*/, '').trim();
            const benefits = drop.benefits || drop.rewards || [];

            benefits.forEach(benefit => {
                if (!benefit) return;
                const benefitText = typeof benefit === 'string' 
                    ? benefit 
                    : (benefit.name || benefit.title || '');
                const cleanBenefit = benefitText.trim().toLowerCase();
                
                if (cleanBenefit && !rawName.includes(cleanBenefit) && cleanBenefit !== rawName) {
                    info.appendChild(makeElement('span', { class: 'wanted-benefit-pill' }, benefitText));
                }
            });
        });
        el.appendChild(infoEl);

        // 3. Stavový indikátor dropu
        const statusEl = makeElement('div', { class: 'wanted-drop-status' });
        if (typeof renderDropStatusHTML === 'function') {
            renderDropStatusHTML(statusEl, { isClaimed, canClaim, required, current });
        }
        el.appendChild(statusEl);
    });
}

/**
 * Renders status tags and progress bar HTML inside a given status container.
 */
function renderDropStatusHTML(statusEl, { isClaimed, canClaim, required, current }) {
    if (!statusEl) return;

    const t = state?.translations?.gui?.wanted;
    const iconGetter = typeof getStatusIconSVG === 'function' ? getStatusIconSVG : () => '';

    if (isClaimed) {
        const label = t?.claimed || 'Claimed';
        statusEl.innerHTML = `
            <span class="status-tag tag-claimed">${iconGetter('completed')} ${label} (100%)</span>
            ${required > 0 ? '<div class="wanted-drop-progress"><div class="wanted-drop-progress-bar bar-fill" style="width: 100%;"></div></div>' : ''}
        `;
    } else if (canClaim || (required > 0 && current >= required)) {
        const label = t?.ready || 'Ready to claim!';
        statusEl.innerHTML = `
            <span class="status-tag tag-ready">${iconGetter('ready')} ${label} (100%)</span>
            <div class="wanted-drop-progress"><div class="wanted-drop-progress-bar bar-fill" style="width: 100%;"></div></div>
        `;
    } else if (required > 0) {
        const pct = Math.min(100, Math.max(0, Math.round((current / required) * 100)));
        statusEl.innerHTML = `
            <span class="status-tag tag-progress wanted-drop-text">${iconGetter('active')} ${current} / ${required} min</span>
            <div class="wanted-drop-progress">
                <div class="wanted-drop-progress-bar bar-fill" style="width: ${pct}%;"></div>
            </div>
        `;
    } else {
        statusEl.innerHTML = '';
    }
}

// ==================== 3. State & Active Checks ====================

/**
 * Determines whether a campaign is actively being mined via watched channel or current drop state.
 */
function checkIfCampaignIsActive(campaignId, drops, gameName) {
    if (!campaignId && (!drops || !drops.length)) return false;

    const campaignIdStr = campaignId ? String(campaignId).trim() : null;
    const watchedChannel = typeof getWatchedChannelContext === 'function' ? getWatchedChannelContext() : null;
    const currentDrop = state?.currentDrop || state?.current_drop;

    // 1. Check against active channel stream context
    if (watchedChannel) {
        const channelCampId = String(watchedChannel.campaign_id || watchedChannel.campaignId || '').trim();
        if (campaignIdStr && channelCampId && channelCampId === campaignIdStr) {
            return true;
        }

        const channelGame = watchedChannel.game_name || watchedChannel.game || watchedChannel.game_title;
        if (channelGame && gameName && channelGame.trim().toLowerCase() === gameName.trim().toLowerCase()) {
            const hasUnclaimed = drops && drops.some(d => !d.is_claimed);
            return hasUnclaimed || drops.length === 0;
        }
        return false;
    }

    // 2. Check against active drop payload in global state
    if (currentDrop) {
        const curCampId = String(currentDrop.campaign_id || currentDrop.parent_campaign_id || '').trim();
        if (campaignIdStr && curCampId && curCampId === campaignIdStr) {
            return true;
        }

        const curGameName = currentDrop.game_name || currentDrop.game || currentDrop.game_title;
        if (curGameName && gameName) {
            return curGameName.trim().toLowerCase() === gameName.trim().toLowerCase();
        }
    }

    return false;
}

/**
 * Checks if an inactive campaign has any unclaimed progress made.
 */
function checkIfCampaignHasProgress(drops, isActivelyMining) {
    if (isActivelyMining || !Array.isArray(drops)) return false;

    return drops.some(d => {
        const current = Math.round(Number(d.current_minutes ?? 0));
        const isClaimed = Boolean(d.is_claimed);
        return current > 0 && !isClaimed;
    });
}

/**
 * wanted.js - Wanted Items Queue Management & Synchronization
 */

/**
 * Searches for a drop in state.wantedItemsTree or a specific node.
 * Fast iteration over structured tree (Game -> Campaign -> Drop) with campaign filter support.
 */
function findDropDeep(node, targetId, targetName, targetCampId = null) {
    const tree = node || state?.wantedItemsTree;
    if (!tree || typeof tree !== 'object') return null;

    const cleanTargetId = targetId ? String(targetId).trim().toLowerCase() : null;
    const cleanTargetName = targetName ? String(targetName).trim().toLowerCase() : null;
    const cleanCampId = targetCampId ? String(targetCampId).trim().toLowerCase() : null;

    if (!cleanTargetId && !cleanTargetName) return null;

    // Helper matcher for individual drop objects
    const matchesDrop = (drop) => {
        if (!drop || typeof drop !== 'object') return false;

        const dropId = String(drop.id || drop.drop_id || drop.uuid || '').trim().toLowerCase();
        if (cleanTargetId && dropId && dropId === cleanTargetId) {
            return true;
        }

        const dropName = String(drop.name || drop.drop_name || '').trim().toLowerCase();
        if (!cleanTargetId && cleanTargetName && dropName.includes(cleanTargetName)) {
            return true;
        }

        return false;
    };

    // 1. Direct match if a single drop object was passed in directly
    if (matchesDrop(tree)) return tree;

    // 2. Structured traversal: Games -> Campaigns -> Drops
    const games = Array.isArray(tree) ? tree : Object.values(tree);

    for (const game of games) {
        if (!game || typeof game !== 'object') continue;
        const campaigns = game.campaigns || game.campaign_list || [];

        for (const campaign of campaigns) {
            if (!campaign || typeof campaign !== 'object') continue;

            // Filter by campaign ID if requested
            const campId = String(campaign.id || campaign.campaign_id || '').trim().toLowerCase();
            if (cleanCampId && campId && campId !== cleanCampId) {
                continue;
            }

            const drops = campaign.drops || campaign.time_based_drops || [];
            for (const drop of drops) {
                if (matchesDrop(drop)) {
                    return drop;
                }
            }
        }
    }

    return null;
}

/**
 * Helper function to quickly verify if a drop is queued in Wanted Queue.
 */
function isDropInWantedQueue(dropId, dropName, campaignId = null) {
    const tree = state?.wantedItemsTree || window?.state?.wantedItemsTree;
    if (!tree) return false;

    return Boolean(findDropDeep(tree, dropId, dropName, campaignId));
}

/**
 * wanted.js - Wanted Items Queue Management & Synchronization
 */

/**
 * Main handler for full campaign payload events.
 * Directly replaces campaign data in memory state and triggers UI re-render.
 *
 * @param {Object} campaignPayload - Full campaign state object from server/WebSocket
 */
function syncCampaignOverview(campaignPayload) {
    if (!campaignPayload || typeof campaignPayload !== 'object') {
        console.warn('[WantedSync] Invalid campaign payload received:', campaignPayload);
        return;
    }

    const campId = String(campaignPayload.id || campaignPayload.campaign_id || '').trim().toLowerCase();
    if (!campId) {
        console.warn('[WantedSync] Campaign payload missing valid ID:', campaignPayload);
        return;
    }

    const tree = state?.wantedItemsTree || window?.state?.wantedItemsTree;
    if (!tree) {
        console.warn('[WantedSync] state.wantedItemsTree is not initialized.');
        return;
    }

    // 1. Locate target campaign in memory tree (Games -> Campaigns)
    let targetCampaign = null;
    const games = Array.isArray(tree) ? tree : Object.values(tree);

    for (const game of games) {
        if (!game || typeof game !== 'object') continue;
        const campaigns = game.campaigns || game.campaign_list || [];

        targetCampaign = campaigns.find(c => {
            const id = String(c?.id || c?.campaign_id || '').trim().toLowerCase();
            return id === campId;
        });

        if (targetCampaign) break;
    }

    if (!targetCampaign) {
        console.debug(`[WantedSync] Campaign "${campId}" not found in local state.`);
        return;
    }

    // 2. Direct assignment of full campaign and drops data
    const incomingDrops = campaignPayload.time_based_drops || campaignPayload.drops || [];

    if (campaignPayload.status) targetCampaign.status = campaignPayload.status;
    if (campaignPayload.allow_claim !== undefined) targetCampaign.allow_claim = campaignPayload.allow_claim;

    if (Array.isArray(incomingDrops)) {
        targetCampaign.drops = incomingDrops;
        targetCampaign.time_based_drops = incomingDrops; // Keep backward compatibility
    }

    console.log(`[WantedSync] Campaign "${campId}" state successfully re-assigned.`);

    // 3. Trigger clean UI re-render
    if (typeof renderWantedItems === 'function') {
        renderWantedItems();
    } else if (typeof renderCampaignDOMNode === 'function') {
        renderCampaignDOMNode(targetCampaign);
    }
}

/**
 * Fast lookup helper for drop objects within state structure.
 */
function findDropDeep(node, targetId, targetName, targetCampId = null) {
    const tree = node || state?.wantedItemsTree;
    if (!tree || typeof tree !== 'object') return null;

    const cleanTargetId = targetId ? String(targetId).trim().toLowerCase() : null;
    const cleanTargetName = targetName ? String(targetName).trim().toLowerCase() : null;
    const cleanCampId = targetCampId ? String(targetCampId).trim().toLowerCase() : null;

    if (!cleanTargetId && !cleanTargetName) return null;

    const games = Array.isArray(tree) ? tree : Object.values(tree);

    for (const game of games) {
        if (!game || typeof game !== 'object') continue;
        const campaigns = game.campaigns || game.campaign_list || [];

        for (const campaign of campaigns) {
            if (!campaign || typeof campaign !== 'object') continue;

            const campId = String(campaign.id || campaign.campaign_id || '').trim().toLowerCase();
            if (cleanCampId && campId && campId !== cleanCampId) continue;

            const drops = campaign.drops || campaign.time_based_drops || [];
            for (const drop of drops) {
                if (!drop || typeof drop !== 'object') continue;

                const dropId = String(drop.id || drop.drop_id || drop.uuid || '').trim().toLowerCase();
                if (cleanTargetId && dropId && dropId === cleanTargetId) return drop;

                const dropName = String(drop.name || drop.drop_name || '').trim().toLowerCase();
                if (!cleanTargetId && cleanTargetName && dropName.includes(cleanTargetName)) return drop;
            }
        }
    }

    return null;
}

/**
 * Helper to check if a drop is present in Wanted Queue.
 */
function isDropInWantedQueue(dropId, dropName, campaignId = null) {
    const tree = state?.wantedItemsTree || window?.state?.wantedItemsTree;
    if (!tree) return false;

    return Boolean(findDropDeep(tree, dropId, dropName, campaignId));
}

/**
 * Cleans up fully claimed campaigns from local state tree
 * (unless it belongs to the currently active watched game).
 */
function cleanupInactiveCampaigns() {
    const tree = state?.wantedItemsTree;
    if (!Array.isArray(tree)) return;

    const watchedChannel = typeof getWatchedChannelContext === 'function' ? getWatchedChannelContext() : null;
    const activeGameName = watchedChannel?.game_name || watchedChannel?.game || null;

    // 1. Filter campaigns in each game group
    state.wantedItemsTree = tree.map(gameGroup => {
        if (!Array.isArray(gameGroup.campaigns)) return gameGroup;

        const isCurrentGame = activeGameName && 
            gameGroup.game_name && 
            gameGroup.game_name.trim().toLowerCase() === activeGameName.trim().toLowerCase();

        const filteredCampaigns = gameGroup.campaigns.filter(campaign => {
            const drops = campaign.drops || campaign.items || [];
            const allClaimed = drops.length > 0 && drops.every(d => Boolean(d.is_claimed ?? d.isClaimed ?? d.claimed));

            // Keep campaign if it's not fully claimed OR if it's the active game
            return !allClaimed || isCurrentGame;
        });

        return {
            ...gameGroup,
            campaigns: filteredCampaigns
        };
    }).filter(gameGroup => Array.isArray(gameGroup.campaigns) && gameGroup.campaigns.length > 0);

    // 2. Trigger fresh UI render reflecting clean state
    if (typeof renderWantedItems === 'function') {
        renderWantedItems();
    }
}

/// ==================== 5. Helpers & Calculations ====================

/**
 * Calculates the total count of completed/claimed drops for a campaign.
 * Handles cases where Twitch/backend omits already finished drops from the array.
 */
function calculateClaimedDropsCount(campaign, drops) {
    if (!campaign && !drops) return 0;

    const dropList = Array.isArray(drops) ? drops : (campaign?.drops || []);
    const totalCount = Number(campaign?.total_drops_count ?? dropList.length);
    
    // Drops that are finished and already stripped from the active array by server
    const completedOutsideArray = Math.max(0, totalCount - dropList.length);

    // Drops in current array that are completed or ready to claim
    const finishedInArray = dropList.filter(d => {
        if (!d) return false;
        const isClaimed = Boolean(d.is_claimed || d.claimed || d.status === 'CLAIMED');
        const canClaim = Boolean(d.can_claim);
        const current = Number(d.current_minutes ?? d.currMins ?? 0);
        const required = Number(d.required_minutes ?? 0);

        return isClaimed || canClaim || (required > 0 && current >= required);
    }).length;

    return completedOutsideArray + finishedInArray;
}

/**
 * Calculates total remaining watching time across campaigns.
 * Supports both serial (sequential) and parallel drop farming.
 */
function calculateMaxRemainingTime(uncompletedCampaigns, isParallel = false) {
    if (!Array.isArray(uncompletedCampaigns) || uncompletedCampaigns.length === 0) return 0;

    const campaignRemainingTimes = uncompletedCampaigns.map(c => {
        if (!c) return 0;
        const drops = c.drops || c.drop_list || c.items || c.time_based_drops || [];

        const uncompletedDrops = drops.filter(d => {
            if (!d) return false;
            return !Boolean(d.is_claimed || d.claimed || d.status === 'CLAIMED');
        });

        if (uncompletedDrops.length === 0) return 0;

        // Find highest required time among remaining drops
        const requiredMinutesList = uncompletedDrops.map(d => Number(d.required_minutes ?? d.requiredMinutes ?? 0));
        const maxRequired = requiredMinutesList.length > 0 ? Math.max(...requiredMinutesList) : 0;

        // Current progress of the active drop
        const currentMins = Number(uncompletedDrops[0].current_minutes ?? uncompletedDrops[0].progress ?? 0);

        return Math.max(0, maxRequired - Math.round(currentMins));
    });

    if (campaignRemainingTimes.length === 0) return 0;

    if (isParallel) {
        // Parallel farming: limited by the single longest campaign
        return Math.max(...campaignRemainingTimes, 0);
    } else {
        // Serial farming: sum of remaining times across all campaigns
        return campaignRemainingTimes.reduce((acc, curr) => acc + curr, 0);
    }
}

// ==================== 6. UI Helpers & Context ====================

/**
 * Updates the remaining time badge for a specific game group in DOM.
 */
function updateGameGroupBadge(gameName, totalRemainingMins = null) {
    if (!gameName) return;

    let mins = Number(totalRemainingMins);

    if (totalRemainingMins === null || totalRemainingMins === undefined || isNaN(mins)) {
        const cleanName = String(gameName).trim().toLowerCase();
        const tree = state?.wantedItemsTree;
        const games = Array.isArray(tree) ? tree : Object.values(tree || {});
        
        const gameGroup = games.find(g => {
            const name = String(g.game_name || g.name || g.game || '').trim().toLowerCase();
            return name === cleanName;
        });

        const campaigns = gameGroup?.campaigns || gameGroup?.campaign_list || [];
        mins = typeof calculateMaxRemainingTime === 'function' ? calculateMaxRemainingTime(campaigns) : 0;
    }

    mins = Math.max(0, isNaN(mins) ? 0 : mins);

    const badgeEl = document.querySelector(`.wanted-game-group[data-game-name="${CSS.escape(gameName)}"] .wanted-game-time-badge`);
    if (badgeEl) {
        const hours = Math.floor(mins / 60);
        const remainderMins = mins % 60;
        const timeText = hours > 0 ? `${hours}h ${remainderMins}m` : `${remainderMins}m`;
        const icon = typeof getStatusIconSVG === 'function' ? getStatusIconSVG('active') : '';
        const newHTML = `${icon} ${timeText}`.trim();

        if (badgeEl.innerHTML !== newHTML) {
            badgeEl.innerHTML = newHTML;
        }
    }
}

/**
 * Formats campaign start and end ISO dates into a localized human-readable range.
 */
function formatCampaignDates(startIso, endIso) {
    if (!startIso || !endIso) return '';
    try {
        const start = new Date(startIso);
        const end = new Date(endIso);

        // Guard against "Invalid Date"
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return '';

        const formatOpts = { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' };
        return `${start.toLocaleDateString(undefined, formatOpts)} – ${end.toLocaleDateString(undefined, formatOpts)}`;
    } catch (e) {
        return '';
    }
}

/**
 * Generates a consistent unique identifier string for a drop item.
 */
function getDropUniqueId(drop, index = 1) {
    if (!drop || typeof drop !== 'object') return `drop-${index}`;
    return String(drop.id || drop.drop_id || drop.uuid || `drop-${index}`).trim();
}

/**
 * Resolves the currently watched channel object from state or getter helper.
 */
function getWatchedChannelContext() {
    if (typeof getWatchedChannelObject === 'function') {
        const channel = getWatchedChannelObject();
        if (channel) return channel;
    }
    
    const ch = state?.watchedChannel || state?.currentChannel || state?.watching_channel;
    
    if (typeof ch === 'string' && state?.channels) {
        const chList = Array.isArray(state.channels) ? state.channels : Object.values(state.channels);
        const cleanCh = ch.trim().toLowerCase();
        
        const found = chList.find(c => {
            if (!c) return false;
            const id = String(c.id || c.username || c.name || c.displayName || '').trim().toLowerCase();
            return id === cleanCh;
        });
        
        if (found) return found;
    }
    
    return ch && typeof ch === 'object' ? ch : null;
}
// ==================== 6. Icons & Assets ====================

/**
 * Returns inline SVG string corresponding to a status class or state.
 */
function getStatusIconSVG(statusClass) {
    if (!statusClass) return '';

    // Case-insensitive lookup without trailing spaces
    const key = String(statusClass).trim().toLowerCase();

    const svgCheck = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
    const svgBox = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`;
    const svgCross = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`;
    const svgClock = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`;

    const icons = {
        'completed': svgCheck,
        'drop-claimed': svgCheck,
        'claimed': svgCheck,
        'ready': svgBox,
        'drop-ready': svgBox,
        'can-claim': svgBox,
        'drop-expired': svgCross,
        'expired': svgCross,
        'drop-active': svgClock,
        'active': svgClock,
        'upcoming': svgClock,
        'in-progress': svgClock
    };

    return icons[key] || '';
}
