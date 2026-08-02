////////////////////////////////////////////////////////////////
// ==================== Inventory Filtering ====================
////////////////////////////////////////////////////////////////

// GLOBAL STATES AND VARIABLES

let selectedInventoryGames = [];
let inventorySaveTimeout = null;
let gameDropdownFocusedIndex = -1;
let gameDropdownVisible = false;

// ==================== Game Dropdown & Tags ====================

function getAvailableGamesForDropdown() {
    // Combine games from campaigns and availableGames Set
    const gamesFromCampaigns = Object.values(state.campaigns || {}).map(c => c.game_name);
    const gamesFromSettings = Array.from(availableGames || []);

    // Merge and deduplicate
    const allGames = [...new Set([...gamesFromCampaigns, ...gamesFromSettings])];

    // Sort alphabetically
    return allGames.sort((a, b) => a.localeCompare(b));
}

function renderGameDropdown(searchTerm = '') {
    const dropdown = document.getElementById('game-dropdown-list');
    if (!dropdown) return;

    const allGames = getAvailableGamesForDropdown();

    // Filter games by search term (case-insensitive)
    const searchLower = searchTerm.toLowerCase().trim();
    const filteredGames = searchLower
        ? allGames.filter(game => game.toLowerCase().includes(searchLower))
        : allGames;

    dropdown.innerHTML = '';

    if (filteredGames.length === 0) {
        dropdown.replaceChildren(makeElement('div', { class: 'dropdown-item no-results' }, 'No games found'));
        gameDropdownFocusedIndex = -1;
        return;
    }

    filteredGames.forEach((gameName, index) => {
        const isSelected = selectedInventoryGames.includes(gameName);
        const isFocused = index === gameDropdownFocusedIndex;

        const item = document.createElement('div');
        item.className = 'dropdown-item' + (isFocused ? ' focused' : '');
        item.dataset.gameName = gameName;
        item.dataset.index = index;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isSelected;
        checkbox.id = `game-dropdown-${index}`;

        const label = document.createElement('label');
        label.setAttribute('for', `game-dropdown-${index}`);
        label.textContent = gameName;

        item.appendChild(checkbox);
        item.appendChild(label);

        // Click handler for the entire item
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleGameSelection(gameName);
        });

        dropdown.appendChild(item);
    });
}

function showGameDropdown() {
    const dropdown = document.getElementById('game-dropdown-list');
    if (!dropdown) return;
    dropdown.style.display = 'block';
    gameDropdownVisible = true;
    gameDropdownFocusedIndex = -1;
    const searchInput = document.getElementById('inventory-game-search');
    renderGameDropdown(searchInput ? searchInput.value : '');
}

function closeGameDropdown() {
    const dropdown = document.getElementById('game-dropdown-list');
    if (!dropdown) return;
    dropdown.style.display = 'none';
    gameDropdownVisible = false;
    gameDropdownFocusedIndex = -1;
}

function handleGameSearchKeydown(event) {
    if (!gameDropdownVisible) return;

    const dropdown = document.getElementById('game-dropdown-list');
    if (!dropdown) return;

    const items = dropdown.querySelectorAll('.dropdown-item:not(.no-results)');
    const maxIndex = items.length - 1;
    const searchInput = document.getElementById('inventory-game-search');
    const searchValue = searchInput ? searchInput.value : '';

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        gameDropdownFocusedIndex = Math.min(gameDropdownFocusedIndex + 1, maxIndex);
        renderGameDropdown(searchValue);

        const focusedItem = dropdown.querySelector('.dropdown-item.focused');
        if (focusedItem) focusedItem.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        gameDropdownFocusedIndex = Math.max(gameDropdownFocusedIndex - 1, 0);
        renderGameDropdown(searchValue);

        const focusedItem = dropdown.querySelector('.dropdown-item.focused');
        if (focusedItem) focusedItem.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (gameDropdownFocusedIndex >= 0 && gameDropdownFocusedIndex <= maxIndex) {
            const focusedItem = items[gameDropdownFocusedIndex];
            const gameName = focusedItem ? focusedItem.dataset.gameName : null;
            if (gameName) toggleGameSelection(gameName);
        }
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeGameDropdown();
        if (searchInput) searchInput.blur();
    }
}

function toggleGameSelection(gameName) {
    const index = selectedInventoryGames.indexOf(gameName);
    if (index >= 0) {
        selectedInventoryGames.splice(index, 1);
    } else {
        selectedInventoryGames.push(gameName);
    }

    console.debug('[Game Filter] Toggled inventory game selection:', gameName, 'Active selection:', selectedInventoryGames);

    // 1. Immediate local UI update (Optimistic UI)
    updateGameTagsDisplay();
    const searchInput = document.getElementById('inventory-game-search');
    renderGameDropdown(searchInput ? searchInput.value : '');
    if (typeof renderInventory === 'function') renderInventory();

    // 2. Buffer / Debounce for server save
    if (inventorySaveTimeout) {
        clearTimeout(inventorySaveTimeout);
    }

    inventorySaveTimeout = setTimeout(() => {
        console.debug('[Game Filter] Flushing inventory selection to server...');
        saveSettings();
    }, 1000); // Wait 1 second before saving
}

function removeGameTag(gameName) {
    const index = selectedInventoryGames.indexOf(gameName);
    if (index >= 0) {
        selectedInventoryGames.splice(index, 1);
        console.debug('[Game Filter] Removed game tag:', gameName);
        updateGameTagsDisplay();
        const searchInput = document.getElementById('inventory-game-search');
        renderGameDropdown(searchInput ? searchInput.value : '');
        saveSettings();
        if (typeof renderInventory === 'function') renderInventory();
    }
}

function updateGameTagsDisplay() {
    const container = document.getElementById('selected-game-tags');
    if (!container) return;
    container.innerHTML = '';

    selectedInventoryGames.forEach(gameName => {
        const tag = document.createElement('div');
        tag.className = 'game-tag';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'game-tag-name';
        nameSpan.textContent = gameName;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'game-tag-remove';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', `Remove ${gameName}`);
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeGameTag(gameName);
        });

        tag.appendChild(nameSpan);
        tag.appendChild(removeBtn);
        container.appendChild(tag);
    });
}

function sortCampaigns(campaigns) {
    const now = Date.now();
    console.debug('[Inventory Sort] Sorting campaigns array of count:', campaigns.length);
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
    const filters = {
        show_active: document.getElementById('filter-active')?.checked || false,
        show_not_linked: document.getElementById('filter-not-linked')?.checked || false,
        show_upcoming: document.getElementById('filter-upcoming')?.checked || false,
        show_expired: document.getElementById('filter-expired')?.checked || false,
        show_finished: document.getElementById('filter-finished')?.checked || false,
        game_name_search: [...selectedInventoryGames],
        // Benefit type filters (default to true if checkbox doesn't exist)
        show_benefit_item: document.getElementById('filter-benefit-item')?.checked !== false,
        show_benefit_badge: document.getElementById('filter-benefit-badge')?.checked !== false,
        show_benefit_emote: document.getElementById('filter-benefit-emote')?.checked !== false,
        show_benefit_other: document.getElementById('filter-benefit-other')?.checked !== false,
    };
    return filters;
}

// Determines the precise lifecycle state of a campaign
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
    
    // Calculate claim status across time-based drops or summary flags
    const dropsList = campaign.drops || campaign.time_based_drops || [];
    const realClaimed = dropsList.length > 0 
        ? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
        : (campaign.claimed_drops || 0);
    const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

    const isFinished = realTotal > 0 && realClaimed >= realTotal;

    const statusResult = {
        isActive,
        isUpcoming,
        isExpired,
        isFinished
    };

    console.debug(`[Inventory Status] "${campaign.name || campaign.game_name}":`, statusResult);
    return statusResult;
}

// Checks if a campaign matches status checkboxes
function matchesStatusFilters(campaign, filters, status) {
    const hasAnyFilter = filters.show_active || filters.show_not_linked ||
                         filters.show_upcoming || filters.show_expired || 
                         filters.show_finished;
    
    if (!hasAnyFilter) return true;

    // Time status check (Active, Upcoming, Expired, Finished)
    const hasTimeFilter = filters.show_active || filters.show_upcoming || 
                          filters.show_expired || filters.show_finished;
    
    let matchesTime = !hasTimeFilter;
    if (hasTimeFilter) {
        if (filters.show_finished && status.isFinished) matchesTime = true;
        if (filters.show_expired && status.isExpired && !status.isFinished) matchesTime = true;
        if (filters.show_upcoming && status.isUpcoming && !status.isFinished) matchesTime = true;
        if (filters.show_active && status.isActive && !status.isFinished && !status.isUpcoming) matchesTime = true;
    }

    // Connection status check (Not Linked)
    let matchesLink = true;
    if (!campaign.linked) {
        matchesLink = filters.show_not_linked;
    } else if (filters.show_not_linked && !hasTimeFilter) {
        matchesLink = false;
    }

    return matchesTime && matchesLink;
}

// Checks if a campaign matches the selected game filters
function matchesGameFilter(campaign, filters) {
    if (!filters.game_name_search || filters.game_name_search.length === 0) return true;
    return filters.game_name_search.includes(campaign.game_name);
}

// Checks if a campaign has drops matching selected reward types
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
    console.debug('[Inventory Filter] Filter state changed by user interaction.');
    saveSettings();
    renderInventory();
}

function clearInventoryFilters() {
    document.getElementById('filter-active').checked = false;
    document.getElementById('filter-not-linked').checked = false;
    document.getElementById('filter-upcoming').checked = false;
    document.getElementById('filter-expired').checked = false;
    document.getElementById('filter-finished').checked = false;
    document.getElementById('inventory-game-search').value = '';

    if (document.getElementById('filter-benefit-item')) document.getElementById('filter-benefit-item').checked = true;
    if (document.getElementById('filter-benefit-badge')) document.getElementById('filter-benefit-badge').checked = true;
    if (document.getElementById('filter-benefit-emote')) document.getElementById('filter-benefit-emote').checked = true;
    if (document.getElementById('filter-benefit-other')) document.getElementById('filter-benefit-other').checked = true;

    selectedInventoryGames = [];
    updateGameTagsDisplay();

    console.debug('[Inventory Filter] Cleared all inventory filters to default state.');
    saveSettings();
    renderInventory();
}

// Renders a single benefit item
function createBenefitItem(benefit, statusClass = '') {
    const className = statusClass ? `benefit-item ${statusClass}` : 'benefit-item';
    
    return makeElement('div', { class: className }, '', el => {
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

// Renders a single drop item with progress and benefits
function createDropItem(drop, t) {
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

    const dropItem = makeElement('div', { class: `drop-item ${statusClass}` });
    const contentWrapper = makeElement('div', { class: `drop-content-box ${statusClass}` });

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
    
    const benefitsList = makeElement('div', { class: 'benefits-list' });
    if (drop.benefits && drop.benefits.length > 0) {
        drop.benefits.forEach(benefit => {
            const benefitEl = createBenefitItem(benefit, statusClass);
            
            const iconHTML = getStatusIconSVG(statusClass);
            if (iconHTML) {
                const iconDiv = document.createElement('div');
                iconDiv.className = 'benefit-status-icon';
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

    if (!drop.is_claimed) {
        const isDirect = drop.delivery_method === 'DIRECT_ENTITLEMENT' || 
                         drop.deliveryMethod === 'DIRECT_ENTITLEMENT' || 
                         !drop.required_minutes;

        if (!isDirect) {
            if (!drop.can_claim) {
                const progressPercent = Math.round((drop.progress || 0) * 100);
                contentWrapper.appendChild(makeElement('div', {}, `${drop.current_minutes || 0} / ${drop.required_minutes} minutes (${progressPercent}%)`));
            } else {
                contentWrapper.appendChild(makeElement('div', { style: 'color: var(--warning-color); font-weight: bold; margin-top: 5px;' }, 'Ready to claim!'));
            }
        } else {
            contentWrapper.appendChild(makeElement('div', { class: 'drop-direct-badge' }, '✦ Instant / Direct Reward'));
        }
    }

    dropItem.appendChild(contentWrapper);
    return dropItem;
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

// Renders header section for a campaign card
function createCardHeaderSection(campaign, statusClass, t) {
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

    return campaignHeader;
}

// Renders info section (status, counters, timing)
function createCardInfoSection(campaign, statusText, t) {
    const infoSection = makeElement('div', { class: 'campaign-info' });

    const dropsList = campaign.drops || campaign.time_based_drops || [];
    const realClaimed = dropsList.length > 0 
        ? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
        : (campaign.claimed_drops || 0);
    const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);
    const claimedCountText = t.gui?.inventory?.claimed_drops || 'claimed';

    infoSection.appendChild(makeElement('div', { class: 'campaign-status', style: 'display: flex; justify-content: space-between;' }, '', el => {
        el.appendChild(makeElement('span', {}, statusText));
        el.appendChild(makeElement('span', {}, `${realClaimed} / ${realTotal} ${claimedCountText}`));
    }));
    
    if (!campaign.linked && campaign.link_url) {
        infoSection.appendChild(makeElement('button', { 
            class: 'link-account-btn', 
            style: 'width: 100%; margin: 10px 0; padding: 8px; cursor: pointer;' 
        }, 'Link Account', btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open(campaign.link_url, '_blank');
            });
        }));
    }

    if (campaign.starts_at) {
        const startsLabel = t.gui?.inventory?.starts || 'Starts: {time}';
        infoSection.appendChild(makeElement('div', { class: 'campaign-timing' }, 
            startsLabel.replace('{time}', new Date(campaign.starts_at).toLocaleString())
        ));
    }

    if (campaign.ends_at) {
        const endsLabel = t.gui?.inventory?.ends || 'Ends: {time}';
        infoSection.appendChild(makeElement('div', { class: 'campaign-timing' }, 
            endsLabel.replace('{time}', new Date(campaign.ends_at).toLocaleString())
        ));
    }

    return infoSection;
}

// Renders campaign drops section
function createCardDropsSection(campaign, t) {
    const dropsBox = makeElement('div', { class: 'campaign-drops' });
    const currentDrop = (typeof state !== 'undefined' && state.currentDrop) || null;

    if (campaign.drops && campaign.drops.length > 0) {
        dropsBox.appendChild(makeElement('div', { class: 'campaign-drop-title' }, campaign.name));
        
        campaign.drops.forEach(drop => {
            const dropId = drop.id || drop.drop_id || '';
            let isActivelyMining = false;
            
            if (currentDrop && dropId) {
                const currentId = currentDrop.id || currentDrop.drop_id || '';
                isActivelyMining = currentId && String(dropId) === String(currentId);
            }

            const current = Math.round(drop.current_minutes || 0);
            const required = drop.required_minutes || 0;
            const isClaimed = drop.is_claimed === true || drop.is_claimed === 1 || drop.is_claimed === 'true' || drop.is_claimed === '1';
            const canClaim = drop.can_claim === true || drop.can_claim === 1;
            const isFinished = isClaimed || canClaim || (required > 0 && current >= required);

            const hasProgress = !isActivelyMining && !isFinished && current > 0;

            const dropBlock = createDropBlock(drop, t);
            
            if (dropId && dropBlock && typeof dropBlock.setAttribute === 'function') {
                dropBlock.setAttribute('data-drop-id', String(dropId));
            }

            if (isActivelyMining) {
                dropBlock.classList.add('active-mining');
            } else if (hasProgress) {
                dropBlock.classList.add('in-progress');
            }

            dropsBox.appendChild(dropBlock);
        });
    }

    return dropsBox;
}

// Builds the final HTML element for a single campaign card
function createCampaignCard(campaign, t) {
    const status = getCampaignStatus(campaign);

    let statusClass = 'expired';
    let statusText = t.gui?.inventory?.status?.expired || 'Expired';

    if (status.isFinished) {
        statusClass = 'completed';
        statusText = t.gui?.inventory?.status?.completed || 'Completed';
    } else if (status.isActive) {
        statusClass = 'active';
        statusText = t.gui?.inventory?.status?.active || 'Active';
    } else if (status.isUpcoming) {
        statusClass = 'upcoming';
        statusText = t.gui?.inventory?.status?.upcoming || 'Upcoming';
    }

    const card = makeElement('div', { class: `campaign-card ${statusClass}` });
    
    const campaignInfo = createCardInfoSection(campaign, statusText, t);
    campaignInfo.prepend(createCardHeaderSection(campaign, statusClass, t));

    const dropsBox = createCardDropsSection(campaign, t);

    card.replaceChildren(campaignInfo, dropsBox);
    return card;
}

// Main grid rendering procedure
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

    if (!hasStatusFilter) {
        console.debug('[Inventory Render] Skipping render: No status filters active.');
        return;
    }

    // Filter & Sort
    const filteredCampaigns = allCampaigns.filter(campaign => campaignMatchesFilters(campaign, filters));
    const sortedCampaigns = sortCampaigns(filteredCampaigns);

    console.debug('[Inventory Render] Filter results:', { 
        total: allCampaigns.length, 
        filteredCount: sortedCampaigns.length,
        filters 
    });

    // Handle Empty States
    if (allCampaigns.length === 0) {
        const emptyMsg = t.gui?.inventory?.no_campaigns || 'No campaigns loaded yet...';
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
        return;
    }

    if (sortedCampaigns.length === 0) {
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, 'No campaigns match the current filters.'));
        return;
    }

    // Render Cards
    sortedCampaigns.forEach(campaign => {
        container.appendChild(createCampaignCard(campaign, t));
    });
}
