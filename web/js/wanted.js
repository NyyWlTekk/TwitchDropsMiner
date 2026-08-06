///////////////////////////////////////////////////////////////////////////////
// WANTED QUEUE MODULE (CLEAN & DIRECT RENDERING)
///////////////////////////////////////////////////////////////////////////////

/**
 * Main entry point for rendering the Wanted Queue.
 * Updates state and performs DOM node reconciliation for Game Groups.
 */
function renderWantedItems(tree) {
    // 1. Aktualizace globálního stavu, pokud byla předána nová data
    if (tree) {
        state.wantedItemsTree = tree;
    }

    const currentTree = state?.wantedItemsTree || [];
    const container = document.getElementById('wanted-items-list');
    if (!container) return;

    // 2. Zobrazení prázdného stavu
    if (!currentTree.length) {
        console.log('[WantedUI] No items to render.');
        const emptyMsg = state?.translations?.gui?.wanted?.none || 'No wanted drops queued...';
        container.replaceChildren(makeElement('p', { class: 'empty-message-small' }, emptyMsg));
        if (typeof updateOverallProgress === 'function') updateOverallProgress();
        return;
    }

    // 3. Namapování stávajících DOM elementů podle názvu hry
    const existingGroups = new Map();
    container.querySelectorAll('.wanted-game-group').forEach(el => {
        if (el.dataset.gameName) {
            existingGroups.set(el.dataset.gameName, el);
        }
    });

    const fragment = document.createDocumentFragment();

    // 4. Aktualizace nebo vytvoření nových herních skupin
    currentTree.forEach((gameGroup, index) => {
        const gameName = gameGroup.game_name || gameGroup.name || 'Unknown Game';
        let groupEl = existingGroups.get(gameName);

        if (groupEl) {
            existingGroups.delete(gameName); // Zachováme v DOMu
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

    // 5. Odstranění herních skupin, které už ve stromu nejsou
    existingGroups.forEach(el => el.remove());

    // 6. Atomické vložení do DOMu bez problikávání
    container.replaceChildren(fragment);

    // 7. Aktualizace celkového progresu
    if (typeof updateOverallProgress === 'function') {
        updateOverallProgress();
    }
}

/////////////////////////////////////////////////////////////////////////
// ==================== 2. DOM Builders & Components ====================
/////////////////////////////////////////////////////////////////////////


////////////////////////////////////////////////////////
/////////// BARVY KAMPANÍ - AKTIVNÍ PRVKY/////////////
////////////////////////////////////////////////////

/**
 * Generates status badge element for active mining, in-progress, or queued status.
 * Directly consumes pre-extracted campaign state.
 */
function renderCampaignStatusIndicatorElement(campaign) {
    const t = state?.translations?.gui?.wanted;
    const iconGetter = typeof getStatusIconSVG === 'function' ? getStatusIconSVG : () => '';

    let statusClass = 'tag-queued';
    let label = t?.queued ?? 'Queued';
    let iconName = 'upcoming';

    if (campaign?.is_mining) {
        statusClass = 'tag-mining';
        label = t?.mining ?? 'Mining';
        iconName = 'active';
    } else if (campaign?.has_progress) {
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

    const gameName = gameGroup.game_name || 'Unknown Game';
    const campaigns = gameGroup.campaigns || [];
    const iconUrl = gameGroup.game_icon || '';

    // Čas v minutách už spočítala extractWantedItemsData
    const safeMins = Math.max(0, Number(gameGroup.total_remaining_minutes || 0));
    const hours = Math.floor(safeMins / 60);
    const remainderMins = safeMins % 60;
    const timeText = hours > 0 ? `${hours}h ${remainderMins}m` : `${remainderMins}m`;
    const iconGetter = typeof getStatusIconSVG === 'function' ? getStatusIconSVG : () => '';

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

    // Generování jednotlivých karet kampaní
    const campaignListEl = makeElement('div', { class: 'wanted-campaign-list' });
    campaigns.forEach(campaign => {
        if (typeof renderCampaignCardElement === 'function') {
            campaignListEl.appendChild(renderCampaignCardElement(campaign));
        }
    });

    groupEl.appendChild(campaignListEl);

    return groupEl;
}

/**
 * Updates the remaining time badge text and icon in DOM.
 */
 // helper for badges icons nad time --- need to do parallel/serial minig !!!
function updateGameGroupBadge(badgeElOrGameName, totalRemainingMins = 0) {
    let badgeEl = badgeElOrGameName;

    if (typeof badgeElOrGameName === 'string') {
        badgeEl = document.querySelector(`.wanted-game-group[data-game-name="${CSS.escape(badgeElOrGameName)}"] .wanted-game-time-badge`);
    }

    if (!badgeEl) return;

    const mins = Math.max(0, isNaN(totalRemainingMins) ? 0 : Number(totalRemainingMins));
    const hours = Math.floor(mins / 60);
    const remainderMins = mins % 60;
    const timeText = hours > 0 ? `${hours}h ${remainderMins}m` : `${remainderMins}m`;
    const icon = typeof getStatusIconSVG === 'function' ? getStatusIconSVG('active') : '';
    
    const newHTML = `${icon} ${timeText}`.trim();

    if (badgeEl.innerHTML !== newHTML) {
        badgeEl.innerHTML = newHTML;
    }
} ///// helpep ^^^^^ for bottom function

/**
 * Updates index, campaigns, and time badges for an existing game group DOM node.
 */
function updateGameGroupElement(groupEl, gameGroup, index = 0) {
    if (!groupEl || !gameGroup) return;

    const idxEl = groupEl.querySelector('.wanted-game-index');
    if (idxEl) {
        idxEl.textContent = `#${index + 1}`;
    }

    const campaignListEl = groupEl.querySelector('.wanted-campaign-list');
    if (campaignListEl) {
        const campaigns = Array.isArray(gameGroup.campaigns) ? gameGroup.campaigns : [];
        if (typeof renderCampaignCardElement === 'function') {
            campaignListEl.replaceChildren(
                ...campaigns.map(c => renderCampaignCardElement(c))
            );
        }
    }

    const badgeEl = groupEl.querySelector('.wanted-game-time-badge');
    if (badgeEl && typeof updateGameGroupBadge === 'function') {
        updateGameGroupBadge(badgeEl, gameGroup.total_remaining_minutes);
    }
}

/**
 * Creates a campaign card container element using pre-extracted data.
 */
function renderCampaignCardElement(campaign) {
    if (!campaign || typeof campaign !== 'object') {
        return makeElement('div', { class: 'wanted-campaign-card' });
    }

    // CSS třídy i ID kampaně jsou přímo v objektu z extractWantedItemsData
    return makeElement('div', {
        class: campaign.card_classes || 'wanted-campaign-card',
        'data-campaign-id': String(campaign.id || campaign.campaign_id || '')
    }, '', cardEl => {
        if (typeof renderCampaignHeaderElement === 'function') {
            const headerEl = renderCampaignHeaderElement(campaign);
            if (headerEl) cardEl.appendChild(headerEl);
        }

        if (typeof renderCampaignBodyElement === 'function') {
            const bodyEl = renderCampaignBodyElement(campaign);
            if (bodyEl) cardEl.appendChild(bodyEl);
        }
    });
}

/**
 * Formats campaign start and end ISO dates into a localized human-readable range.
 */
 // time helper
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
} // heleper ^^^ for bottom function

/**
 * Renders header for a campaign card with name, badges, and active dates.
 */
function renderCampaignHeaderElement(campaign) {
    if (!campaign || typeof campaign !== 'object') return null;

    const claimedCount = campaign.claimed_drops_count ?? 0;
    const totalCount = campaign.total_drops_count ?? 0;
    const campaignName = campaign.name || 'Campaign';
    const campaignUrl = campaign.url || '#';
    const iconGetter = typeof getStatusIconSVG === 'function' ? getStatusIconSVG : () => '';

    // Stav pro třídu záhlaví (mining / in-progress / queued)
    const statusClass = campaign.is_mining 
        ? 'mining' 
        : (campaign.has_progress ? 'in-progress' : 'queued');

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

        // 2. ŘÁDEK: Datum trvání kampaně
        if (typeof formatCampaignDates === 'function') {
            const dateText = formatCampaignDates(campaign.starts_at, campaign.ends_at);
            if (dateText) {
                const datesEl = makeElement('div', { class: 'wanted-campaign-dates' });
                datesEl.innerHTML = `${iconGetter('upcoming')} ${dateText}`.trim();
                h.appendChild(datesEl);
            }
        }

        // 3. ŘÁDEK: Status badge samostatně dole
        const statusBadge = typeof renderCampaignStatusIndicatorElement === 'function'
            ? renderCampaignStatusIndicatorElement(campaign)
            : makeElement('span', { class: `wanted-status-badge status-tag tag-${statusClass}` }, statusClass);

        if (statusBadge) {
            const statusRow = makeElement('div', { class: 'wanted-card-header-status-row' });
            statusRow.appendChild(statusBadge);
            h.appendChild(statusRow);
        }
    });
}

/**
 * Renders campaign body container containing drop items.
 */
function renderCampaignBodyElement(campaign) {
    if (!campaign || typeof campaign !== 'object') return null;

    const dropContainer = makeElement('div', { class: 'wanted-drops-container' });
    const drops = campaign.drops || [];

    // Dropy už jsou z extractWantedItemsData seřazené
    drops.forEach((drop, index) => {
        if (typeof renderDropItemElement === 'function') {
            dropContainer.appendChild(renderDropItemElement(drop, index + 1, campaign.id));
        }
    });

    return makeElement('div', { class: 'wanted-card-body' }, '', b => b.appendChild(dropContainer));
}

/**
 * Renders an individual drop item row with progress status, thumbnail images, and benefits.
 */
function renderDropItemElement(drop, index = 1, campaignId = '') {
    if (!drop) return makeElement('div', { class: 'wanted-drop-item' });

    const dropId = String(drop.id || drop.drop_id || `drop-${index}`).trim();
    const dropName = drop.name || 'Drop';
    const isClaimed = Boolean(drop.is_claimed);
    const canClaim = Boolean(drop.can_claim);
    const required = Number(drop.required_minutes || 0);

    let current = isClaimed 
        ? required 
        : Math.round(Number(drop.current_minutes || drop.progress || 0));

    // Synchronizace s živým dropem v globálním stavu (pokud existuje)
    const activeDrop = state?.currentDrop || state?.current_drop;
    if (activeDrop && !isClaimed) {
        const activeDropId = String(activeDrop.drop_id || activeDrop.id || '').trim();
        if (activeDropId && activeDropId === dropId) {
            current = Math.round(Number(activeDrop.current_minutes ?? activeDrop.progress ?? 0));
        }
    }

    const imageUrl = drop.image_url || null;

    return makeElement('div', {
        class: `wanted-drop-item ${isClaimed ? 'is-claimed' : ''} ${canClaim ? 'can-claim' : ''}`.trim(),
        'data-wanted-drop-id': dropId,
        'data-drop-id': dropId,
        'data-drop-name': String(dropName).trim(),
        'data-campaign-id': String(campaignId),
        'data-required-minutes': String(required)
    }, '', el => {
        
        // 1. Náhledový obrázek
        if (imageUrl) {
            const imgEl = makeElement('img', { 
                class: 'wanted-drop-image', 
                src: imageUrl, 
                alt: dropName,
                loading: 'lazy'
            });
            imgEl.onerror = () => { imgEl.style.display = 'none'; };
            el.appendChild(imgEl);
        }

        // 2. Informační blok (Název + Benefit pilulky)
        const infoEl = makeElement('div', { class: 'wanted-drop-info' }, '', info => {
            const displayName = index ? `Drop ${index}: ${dropName}` : dropName;
            info.appendChild(makeElement('span', { class: 'wanted-drop-name' }, displayName));

            const rawName = (dropName || '').toLowerCase().replace(/^\d+[\.\)]?\s*/, '').trim();
            const benefits = drop.benefits || [];

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
 * Consumes clean drop data originating from wantedTree / extractWantedItemsData.
 */
 // IKONY
function renderDropStatusHTML(statusEl, { isClaimed = false, canClaim = false, required = 0, current = 0 } = {}) {
    if (!statusEl) return;

    const t = state?.translations?.gui?.wanted;
    const iconGetter = typeof getStatusIconSVG === 'function' ? getStatusIconSVG : () => '';

    // Bezpečné ošetření čísel proti NaN a záporným hodnotám
    const safeRequired = Math.max(0, Number(required) || 0);
    const safeCurrent = Math.max(0, Number(current) || 0);

    if (isClaimed) {
        const label = t?.claimed || 'Claimed';
        statusEl.innerHTML = `
            <span class="status-tag tag-claimed">${iconGetter('completed')} ${label} (100%)</span>
            ${safeRequired > 0 ? '<div class="wanted-drop-progress"><div class="wanted-drop-progress-bar bar-fill" style="width: 100%;"></div></div>' : ''}
        `;
    } else if (canClaim || (safeRequired > 0 && safeCurrent >= safeRequired)) {
        const label = t?.ready || 'Ready to claim!';
        statusEl.innerHTML = `
            <span class="status-tag tag-ready">${iconGetter('ready')} ${label} (100%)</span>
            <div class="wanted-drop-progress"><div class="wanted-drop-progress-bar bar-fill" style="width: 100%;"></div></div>
        `;
    } else if (safeRequired > 0) {
        const rawPct = Math.round((safeCurrent / safeRequired) * 100);
        const pct = Math.min(100, Math.max(0, isNaN(rawPct) ? 0 : rawPct));

        statusEl.innerHTML = `
            <span class="status-tag tag-progress wanted-drop-text">${iconGetter('active')} ${safeCurrent} / ${safeRequired} min</span>
            <div class="wanted-drop-progress">
                <div class="wanted-drop-progress-bar bar-fill" style="width: ${pct}%;"></div>
            </div>
        `;
    } else {
        statusEl.innerHTML = '';
    }
}

/**
 * Generates a consistent unique identifier string for a drop item.
 */
function getDropUniqueId(drop, index = 1) {
    if (!drop || typeof drop !== 'object') return `drop-${index}`;
    return String(drop.id || drop.drop_id || drop.uuid || `drop-${index}`).trim();
}

////////////////////////////////////////////////////////
// ==================== ICON HELPER ====================
////////////////////////////////////////////////////////

/**
 * Returns inline SVG string corresponding to a status class or state.
 */
function getStatusIconSVG(statusClass) {
    if (!statusClass) return '';

    const key = String(statusClass).trim().toLowerCase();

    const svgCheck = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
    const svgBox = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`;
    const svgCross = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`;
    const svgClock = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`;

    const icons = {
        claimed: svgCheck, completed: svgCheck, 'drop-claimed': svgCheck,
        'can-claim': svgBox, ready: svgBox, 'drop-ready': svgBox,
        expired: svgCross, 'drop-expired': svgCross,
        active: svgClock, 'drop-active': svgClock, upcoming: svgClock, 'in-progress': svgClock
    };

    return icons[key] || '';
}
