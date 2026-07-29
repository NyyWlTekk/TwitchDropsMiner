// ==================== Inventory Filtering ====================

function sortCampaigns(campaigns) {

    const now = Date.now();
    return [...campaigns].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        
        // Active: Sort by ending soonest
        if (a.active) {
            const dateA = a.ends_at ? new Date(a.ends_at).getTime() : Infinity;
            const dateB = b.ends_at ? new Date(b.ends_at).getTime() : Infinity;
            return dateA - dateB;
        }
        
        const statusA = getCampaignStatus(a, now);
        const statusB = getCampaignStatus(b, now);
        
        // Upcoming: Prioritize over expired/finished
        if (statusA.isUpcoming !== statusB.isUpcoming) {
            return statusA.isUpcoming ? -1 : 1;
        }
        
        // Both upcoming: Sort by starting soonest
        if (statusA.isUpcoming) {
            const startsA = a.starts_at ? new Date(a.starts_at).getTime() : Infinity;
            const startsB = b.starts_at ? new Date(b.starts_at).getTime() : Infinity;
            return startsA - startsB;
        }
        
        // Both expired/finished: Sort by recently ended
        const endsAtA = a.ends_at ? new Date(a.ends_at).getTime() : 0;
        const endsAtB = b.ends_at ? new Date(b.ends_at).getTime() : 0;
        return endsAtB - endsAtA;
    });
}

function getInventoryFilters() {
    // Get filter state from UI checkboxes and selected games array
    return {
        show_active: document.getElementById('filter-active')?.checked || false,
        show_not_linked: document.getElementById('filter-not-linked')?.checked || false,
        show_upcoming: document.getElementById('filter-upcoming')?.checked || false,
        show_expired: document.getElementById('filter-expired')?.checked || false,
        show_finished: document.getElementById('filter-finished')?.checked || false,
        game_name_search: [...selectedInventoryGames],  // Array of selected game names
        // Benefit type filters (default to true if checkbox doesn't exist)
        show_benefit_item: document.getElementById('filter-benefit-item')?.checked !== false,
        show_benefit_badge: document.getElementById('filter-benefit-badge')?.checked !== false,
        show_benefit_emote: document.getElementById('filter-benefit-emote')?.checked !== false,
        show_benefit_other: document.getElementById('filter-benefit-other')?.checked !== false,
    };
}

// 1. Determines the precise lifecycle state of a campaign
// Helper to determine campaign status using both time and API flags
function getCampaignStatus(campaign, now = Date.now()) {
    const startsAt = campaign.starts_at ? new Date(campaign.starts_at).getTime() : 0;
    const endsAt = campaign.ends_at ? new Date(campaign.ends_at).getTime() : 0;

    // Check upcoming by local time OR by Twitch API flags
    const isUpcoming = (startsAt > now) || 
                            (campaign.status === 'UPCOMING') || 
                            (campaign.upcoming === true);

    // Check active by local time OR by Twitch API flags (must not be upcoming)
    const isActive = (((startsAt <= now && endsAt > now) || 
                      (campaign.status === 'ACTIVE') || 
                      (campaign.active === true)) && !isUpcoming);

    const isExpired = (endsAt > 0 && endsAt <= now) || (campaign.status === 'EXPIRED');
    // NOVÝ KÓD:
	const dropsList = campaign.drops || campaign.time_based_drops || [];
	const realClaimed = dropsList.length > 0 
		? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
		: (campaign.claimed_drops || 0);
	const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

	const isFinished = realTotal > 0 && realClaimed >= realTotal;

    return {
        isActive,
        isUpcoming,
        isExpired,
        isFinished
    };
}

// 2. Checks if a campaign matches status checkboxes
function matchesStatusFilters(campaign, filters, status) {
    const hasAnyFilter = filters.show_active || filters.show_not_linked ||
                         filters.show_upcoming || filters.show_expired || 
                         filters.show_finished;
    
    if (!hasAnyFilter) return true;

    // 1. Time status check (Active, Upcoming, Expired, Finished)
    const hasTimeFilter = filters.show_active || filters.show_upcoming || 
                          filters.show_expired || filters.show_finished;
    
    let matchesTime = !hasTimeFilter; // Default to true if no time filter is selected
    if (hasTimeFilter) {
        if (filters.show_finished && status.isFinished) matchesTime = true;
        if (filters.show_expired && status.isExpired && !status.isFinished) matchesTime = true;
        
        // TADY: Pokud je zaškrtnuté Upcoming a kampaň je podle času vyhodnocena jako nadcházející
        if (filters.show_upcoming && status.isUpcoming && !status.isFinished) matchesTime = true;
        
        if (filters.show_active && status.isActive && !status.isFinished && !status.isUpcoming) matchesTime = true;
    }

    // 2. Connection status check (Not Linked)
    let matchesLink = true;
    if (!campaign.linked) {
        matchesLink = filters.show_not_linked;
    } else {
        if (filters.show_not_linked && !hasTimeFilter) {
            matchesLink = false;
        }
    }

    return matchesTime && matchesLink;
}

// 3. Checks if a campaign matches the search query
function matchesGameFilter(campaign, filters) {
    if (!filters.game_name_search || filters.game_name_search.length === 0) return true;
    return filters.game_name_search.includes(campaign.game_name);
}

// 4. Checks if a campaign has drops matching selected reward types
function matchesBenefitFilter(campaign, filters) {
    const allBenefitsEnabled = filters.show_benefit_item && filters.show_benefit_badge &&
                               filters.show_benefit_emote && filters.show_benefit_other;
    
    if (allBenefitsEnabled || !campaign.drops) return true;

    const hasBenefitFilter = filters.show_benefit_item || filters.show_benefit_badge || 
                             filters.show_benefit_emote || filters.show_benefit_other;
    if (!hasBenefitFilter) return true;

    for (const drop of campaign.drops) {
        if (!drop.benefits) continue;
        for (const benefit of drop.benefits) {
            const benefitType = (benefit.type || '').toUpperCase();
            if (filters.show_benefit_item && benefitType === 'DIRECT_ENTITLEMENT') return true;
            if (filters.show_benefit_badge && benefitType === 'BADGE') return true;
            if (filters.show_benefit_emote && benefitType === 'EMOTE') return true;
            if (filters.show_benefit_other && benefitType === 'UNKNOWN') return true;
        }
    }
    return false;
}

// Main filter matcher
function campaignMatchesFilters(campaign, filters) {
    const status = getCampaignStatus(campaign);

    if (!matchesStatusFilters(campaign, filters, status)) return false;
    if (!matchesGameFilter(campaign, filters)) return false;
    if (!matchesBenefitFilter(campaign, filters)) return false;

    return true;
}

function onInventoryFilterChange() {
    // Save filter state to settings and re-render inventory
    saveSettings();
    renderInventory();
}

function clearInventoryFilters() {
    // Uncheck all filter checkboxes
    document.getElementById('filter-active').checked = false;
    document.getElementById('filter-not-linked').checked = false;
    document.getElementById('filter-upcoming').checked = false;
    document.getElementById('filter-expired').checked = false;
    document.getElementById('filter-finished').checked = false;
    document.getElementById('inventory-game-search').value = '';

    // Reset benefit type filters to checked (show all)
    if (document.getElementById('filter-benefit-item')) document.getElementById('filter-benefit-item').checked = true;
    if (document.getElementById('filter-benefit-badge')) document.getElementById('filter-benefit-badge').checked = true;
    if (document.getElementById('filter-benefit-emote')) document.getElementById('filter-benefit-emote').checked = true;
    if (document.getElementById('filter-benefit-other')) document.getElementById('filter-benefit-other').checked = true;

    // Clear selected games
    selectedInventoryGames = [];
    updateGameTagsDisplay();

    // Save and re-render
    saveSettings();
    renderInventory();
}

// Renders a single benefit item (icon + name + type)
function createBenefitItem(benefit) {
    return makeElement('div', { class: 'benefit-item' }, '', el => {
        el.appendChild(makeImageElement(benefit.image_url, benefit.name, 'benefit-icon'));
        el.appendChild(makeElement('div', { class: 'benefit-info' }, '', el2 => {
            el2.appendChild(makeElement('span', { class: 'benefit-name' }, benefit.name));
            const isDirectType = benefit.type && benefit.type.toUpperCase() === 'DIRECT_ENTITLEMENT';
            if (!isDirectType && benefit.type) {
                el2.appendChild(makeElement('span', { class: 'benefit-type' }, `(${benefit.type})`));
            }
        }));
    });
}

// Renders a single drop with its progress and benefits
function createDropItem(drop, t) {
    // 1. Zjistíme stavovou třídu (stejnou pro oba boxy)
    let statusClass = '';
    if (drop.is_claimed) {
        statusClass = 'drop-claimed';
    } else if (drop.can_claim) {
        statusClass = 'drop-ready';
    } else if (drop.is_expired) {
        statusClass = 'drop-expired';
    } else if ((drop.progress || 0) > 0) {
        statusClass = 'drop-active';
    }

    // 2. Vytvoříme vnější i vnitřní box se stejnou třídou
    const dropItem = makeElement('div', { class: `drop-item ${statusClass}` });
    const contentWrapper = makeElement('div', { class: `drop-content-box ${statusClass}` });

    // Header
    contentWrapper.appendChild(
        makeElement('div', { class: 'drop-item-header' }, '', el =>
            el.appendChild(makeElement('div', { class: 'drop-item-info' }, '', el2 =>
                el2.appendChild(makeElement('div', {}, '', el3 => {
                    el3.appendChild(makeElement('strong', {}, drop.name));

                    const badgeContainer = document.createElement('span');
                    badgeContainer.style.marginLeft = '8px';
                    badgeContainer.style.display = 'inline-flex';
                    badgeContainer.style.gap = '6px';
                    badgeContainer.style.alignItems = 'center';
                    el3.appendChild(badgeContainer);
                }))
            ))
        )
    );
    
	// Benefity
    const benefitsList = makeElement('div', { class: 'benefits-list' });
    if (drop.benefits && drop.benefits.length > 0) {
        drop.benefits.forEach(benefit => {
            const benefitEl = createBenefitItem(benefit);
            
            // Přidání ikony do každého benefitu
			const iconHTML = getStatusIconSVG(statusClass);
			if (iconHTML) {
				const iconDiv = document.createElement('div');
				iconDiv.className = 'benefit-status-icon'; // TUTO TŘÍDU CSS ZNÁ
				iconDiv.style.marginLeft = 'auto';
				iconDiv.style.display = 'flex';
				iconDiv.style.alignItems = 'center';
				iconDiv.innerHTML = iconHTML;
				benefitEl.appendChild(iconDiv);
			}
            
            benefitsList.appendChild(benefitEl);
        });
    }
    contentWrapper.appendChild(benefitsList);

    // Progress
    if (!drop.is_claimed) {
        const isDirect = drop.delivery_method === 'DIRECT_ENTITLEMENT' || 
                         drop.deliveryMethod === 'DIRECT_ENTITLEMENT' || 
                         !drop.required_minutes;

        if (!isDirect) {
            if (!drop.can_claim) {
                const progressPercent = Math.round((drop.progress || 0) * 100);
                contentWrapper.appendChild(makeElement('div', {}, `${drop.current_minutes || 0} / ${drop.required_minutes} minutes (${progressPercent}%)`));
            } else if (drop.can_claim) {
                contentWrapper.appendChild(makeElement('div', { style: 'color: var(--warning-color); font-weight: bold; margin-top: 5px;' }, 'Ready to claim!'));
            }
        } else {
            contentWrapper.appendChild(makeElement('div', { class: 'drop-direct-badge' }, '✦ Instant / Direct Reward'));
        }
    }

    dropItem.appendChild(contentWrapper);
    return dropItem;
}

function createDropsContainer(drops, t) {
    const container = document.createElement('div');
    container.className = 'campaign-drops';

    if (drops && drops.length > 0) {
        drops.forEach(drop => {
            container.appendChild(createDropBlock(drop, t));
        });
    }

    return container;
}

function createDropBlock(drop, t) {
    let statusClass = '';
    if (drop.is_claimed) statusClass = 'drop-claimed';
    else if (drop.can_claim) statusClass = 'drop-ready';
    else if (drop.progress > 0) statusClass = 'drop-active';
    else statusClass = 'drop-expired';

    const dropBlock = document.createElement('div');
    dropBlock.className = `drop-block ${statusClass}`;

    dropBlock.appendChild(createDropItem(drop, t));

    return dropBlock;
}

// Renders the top header of a campaign card (Game art, linking state, external links)
function createCampaignHeader(campaign) {
    const dropsList = campaign.drops || campaign.time_based_drops || [];
    const realClaimed = dropsList.length > 0 
        ? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
        : (campaign.claimed_drops || 0);
    const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

    const isCompleted = realTotal > 0 && realClaimed >= realTotal;
    const isActive = (campaign.is_active !== undefined ? campaign.is_active : campaign.active) && !isCompleted;

    let statusClass = 'expired';
    let statusText = t.gui?.inventory?.expired || 'Expired';

    if (isCompleted) {
        statusClass = 'completed';
        statusText = t.gui?.inventory?.completed || 'Completed ✔';
    } else if (isActive) {
        statusClass = 'active';
        statusText = t.gui?.inventory?.active || 'Active ✔';
    }

    const claimedCountText = t.gui?.inventory?.claimed_drops || 'claimed';

    const headerEl = makeElement('div', { class: `campaign-header ${statusClass}` });

    headerEl.appendChild(makeElement('div', { class: 'campaign-title-row' }, '', el => {
        el.appendChild(makeElement('h3', {}, campaign.name || campaign.game_name || 'Campaign'));
    }));

    headerEl.appendChild(makeElement('div', { class: 'campaign-status', style: 'display: flex; justify-content: space-between;' }, '', el => {
        el.appendChild(makeElement('span', { class: `status-tag ${statusClass}` }, statusText));
        el.appendChild(makeElement('span', { class: 'claimed-counter' }, `${realClaimed} / ${realTotal} ${claimedCountText}`));
    }));

    return headerEl;
}

function createCampaignCard(campaign, t) {
    let statusClass = '';
    let statusText = '';

    if (campaign.claimed_drops !== undefined && campaign.total_drops !== undefined && campaign.claimed_drops >= campaign.total_drops) {
        statusClass = 'completed';
        statusText = 'Completed'; 
    } else if (campaign.active) {
        statusClass = 'active';
        statusText = t.gui?.inventory?.status?.active || 'Active';
    } else if (campaign.upcoming) {
        statusClass = 'upcoming';
        statusText = t.gui?.inventory?.status?.upcoming || 'Upcoming';
    } else if (campaign.expired) {
        statusClass = 'expired';
        statusText = t.gui?.inventory?.status?.expired || 'Expired';
    }

    const card = makeElement('div', { class: `campaign-card ${statusClass}` });
    const campaignInfo = makeElement('div', { class: 'campaign-info' });

    // --- HLAVIČKA (Header) ---
    const campaignHeader = makeElement('div', { class: 'campaign-header' });

    if (campaign.game_box_art_url) {
        const iconUrl = campaign.game_box_art_url.replace('{width}', '52').replace('{height}', '70');
        campaignHeader.appendChild(makeImageElement(iconUrl, campaign.game_name, 'game-icon'));
    }

    campaignHeader.appendChild(makeElement('div', { style: 'display: flex; flex-direction: column; margin-left: 10px;' }, '', textCol => {
        textCol.appendChild(makeElement('span', { class: 'campaign-game-name' }, campaign.game_name));
        textCol.appendChild(makeElement('a', { 
            href: campaign.campaign_url, 
            target: '_blank', 
            rel: 'noopener noreferrer', 
            class: 'campaign-name-link',
            style: 'font-size: 11px; margin-top: 2px;'
        }, 'View on Twitch 🔗'));
    }));

    campaignHeader.appendChild(makeElement('div', { 
        style: 'margin-left: auto; display: flex; align-items: center; gap: 8px;' 
    }, '', rightGroup => {
        const iconHtml = getStatusIconSVG(statusClass);
        if (iconHtml) {
            rightGroup.appendChild(makeElement('div', { 
                class: 'campaign-header-icon', 
                style: 'display: flex; align-items: center;' 
            }, '', el => {
                el.innerHTML = iconHtml;
            }));
        }

        rightGroup.appendChild(makeElement('span', { 
            class: `campaign-badge ${campaign.linked ? 'linked' : 'not-linked'}` 
        }, campaign.linked ? 'LINKED' : 'NOT LINKED'));
    }));

    campaignInfo.appendChild(campaignHeader);

	// --- Status řádek ---
    const claimedCountText = t.gui?.inventory?.claimed_drops || 'claimed';

    const dropsList = campaign.drops || campaign.time_based_drops || [];
    const realClaimed = dropsList.length > 0 
        ? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
        : (campaign.claimed_drops || 0);
    const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

    campaignInfo.appendChild(makeElement('div', { class: 'campaign-status', style: 'display: flex; justify-content: space-between;' }, '', el => {
        el.appendChild(makeElement('span', {}, statusText));
        el.appendChild(makeElement('span', {}, `${realClaimed} / ${realTotal} ${claimedCountText}`));
    }));
    
    // --- Tlačítko Link ---
    if (!campaign.linked && campaign.link_url) {
        campaignInfo.appendChild(makeElement('button', { 
            class: 'link-account-btn', 
            style: 'width: 100%; margin: 10px 0; padding: 8px; cursor: pointer;' 
        }, 'Link Account', btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open(campaign.link_url, '_blank');
            });
        }));
    }

    // --- Timing (Starts/Ends) ---
    if (campaign.starts_at) {
        const startsLabel = t.gui?.inventory?.starts || 'Starts: {time}';
        campaignInfo.appendChild(makeElement('div', { class: 'campaign-timing' }, 
            startsLabel.replace('{time}', new Date(campaign.starts_at).toLocaleString())
        ));
    }

    if (campaign.ends_at) {
        const endsLabel = t.gui?.inventory?.ends || 'Ends: {time}';
        campaignInfo.appendChild(makeElement('div', { class: 'campaign-timing' }, 
            endsLabel.replace('{time}', new Date(campaign.ends_at).toLocaleString())
        ));
    }

	// --- DROPS BLOK ---
    const dropsBox = makeElement('div', { class: 'campaign-drops' });

    if (campaign.drops && campaign.drops.length > 0) {
        dropsBox.appendChild(makeElement('div', { class: 'campaign-drop-title' }, campaign.name));
        
        campaign.drops.forEach(drop => {
            dropsBox.appendChild(createDropBlock(drop, t));
        });
    }

    card.replaceChildren(campaignInfo, dropsBox);
    return card;
}

function renderInventory() {
    const container = document.getElementById('inventory-grid');
    container.innerHTML = '';

    updateOverallProgress();

    const t = state.translations;
    const allCampaigns = Object.values(state.campaigns);

    const filters = getInventoryFilters();
    const hasStatusFilter = filters.show_active || filters.show_not_linked ||
                            filters.show_upcoming || filters.show_expired || 
                            filters.show_finished;

    if (!hasStatusFilter) return;

    // 1. Filter
    const filteredCampaigns = allCampaigns.filter(campaign => campaignMatchesFilters(campaign, filters));
    
    // 2. Sort
    const sortedCampaigns = sortCampaigns(filteredCampaigns);

    // 3. Handle Empty States
    if (allCampaigns.length === 0) {
        const emptyMsg = t.gui?.inventory?.no_campaigns || 'No campaigns loaded yet...';
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
        return;
    }

    if (sortedCampaigns.length === 0) {
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, 'No campaigns match the current filters.'));
        return;
    }

    // 4. Render and Append Cards
    sortedCampaigns.forEach(campaign => {
        container.appendChild(createCampaignCard(campaign, t));
    });
}
