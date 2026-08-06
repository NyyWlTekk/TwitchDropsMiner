////////////////////////////////////////////////////////////////
// ==================== Inventory Filtering ====================
////////////////////////////////////////////////////////////////

// GLOBAL STATES AND VARIABLES

let selectedInventoryGames = [];
let inventorySaveTimeout = null;
let gameDropdownFocusedIndex = -1;
let gameDropdownVisible = false;

//////////////////////////////////////////
///////// HANDLERS /////////////////
/////////////////////////////////

function handleInventoryClear() {
    console.log('[Inventory] Received clear command');
    if (typeof state !== 'undefined') {
        state.campaigns = {};
    }
    if (typeof renderInventory === 'function') renderInventory();
    syncAdminState();
}

function handleInventoryBatchUpdate(data) {
    console.log('[Inventory] Processing batch inventory update');
    if (typeof state !== 'undefined') {
        state.campaigns = {};
        const filtered = (data.campaigns || []).filter(c => !isGameIgnored(c.game_name || c.game));
        filtered.forEach(camp => {
            state.campaigns[camp.id] = camp;
        });
    }
    if (typeof renderInventory === 'function') renderInventory();
    if (typeof applyAutoSortIfNeeded === 'function') applyAutoSortIfNeeded();
    syncAdminState();
}

// ==================== Game Dropdown & Tags ====================

function getAvailableGamesForDropdown() {
    // Extract game names from campaigns safely and remove empty/falsy values
    const gamesFromCampaigns = Object.values(state?.campaigns || {})
        .map(campaign => campaign?.game_name)
        .filter(Boolean);

    // Convert settings to array and filter falsy values
    const gamesFromSettings = Array.from(availableGames || []).filter(Boolean);

    // Merge, deduplicate, and sort alphabetically
    const uniqueGames = Array.from(new Set([...gamesFromCampaigns, ...gamesFromSettings]));

    return uniqueGames.sort((a, b) => a.localeCompare(b));
}

let lastGameDropdownHash = null;

function renderGameDropdown(searchTerm = '', force = false) {
    const dropdown = document.getElementById('game-dropdown-list');
    if (!dropdown) return;

    const allGames = typeof getAvailableGamesForDropdown === 'function' ? getAvailableGamesForDropdown() : [];

    // Filter games by search term (case-insensitive)
    const searchLower = searchTerm.toLowerCase().trim();
    const filteredGames = searchLower
        ? allGames.filter(game => game.toLowerCase().includes(searchLower))
        : allGames;

    const selectedGames = Array.isArray(selectedInventoryGames) ? selectedInventoryGames : [];
    const focusedIdx = typeof gameDropdownFocusedIndex !== 'undefined' ? gameDropdownFocusedIndex : -1;

    // Structural Fingerprint Check: Serialize filtered and selected games to capture actual state changes
    const filteredHash = filteredGames.join('|');
    const selectedHash = selectedGames.join('|');
    const currentHash = `${searchLower}_${filteredHash}_${focusedIdx}_${selectedHash}`;

    if (!force && lastGameDropdownHash === currentHash) {
        return;
    }
    lastGameDropdownHash = currentHash;

    // Handle Empty States
    if (filteredGames.length === 0) {
        dropdown.replaceChildren(makeElement('div', { class: 'dropdown-item no-results' }, 'No games found'));
        if (typeof gameDropdownFocusedIndex !== 'undefined') {
            gameDropdownFocusedIndex = -1;
        }
        return;
    }

    // Batch DOM Injection via DocumentFragment
    const fragment = document.createDocumentFragment();

    filteredGames.forEach((gameName, index) => {
        const isSelected = selectedGames.includes(gameName);
        const isFocused = index === focusedIdx;

        const item = document.createElement('div');
        // Added 'selected' class so CSS can style the background of checked items
        item.className = 'dropdown-item' 
            + (isFocused ? ' focused' : '') 
            + (isSelected ? ' selected' : '');
            
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

            // Prevent double triggers from native label/checkbox clicks
            if (e.target === checkbox || e.target === label) {
                e.preventDefault();
            }

            if (typeof toggleGameSelection === 'function') {
                toggleGameSelection(gameName);
            }
        });

        fragment.appendChild(item);
    });

    // Atomic insertion of the entire tree into the DOM at once
    dropdown.replaceChildren(fragment);
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

    console.log('[Game Filter] Toggled inventory game selection:', gameName, 'Active selection:', selectedInventoryGames);

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
        console.log('[Game Filter] Flushing inventory selection to server...');
        saveSettings();
    }, 1000); // Wait 1 second before saving
}

function removeGameTag(gameName) {
    const index = selectedInventoryGames.indexOf(gameName);
    if (index >= 0) {
        selectedInventoryGames.splice(index, 1);
        console.log('[Game Filter] Removed game tag:', gameName);
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
    console.log('[Inventory Sort] Sorting campaigns array of count:', campaigns.length);
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
    if (!campaign) {
        return { isActive: false, isUpcoming: false, isExpired: false, isFinished: false, isReady: false };
    }

    // Bezpečný převod data na timestamp s ochranou proti NaN
    const parseTimestamp = (dateVal) => {
        if (!dateVal) return 0;
        const time = new Date(dateVal).getTime();
        return Number.isNaN(time) ? 0 : time;
    };

    const startsAt = parseTimestamp(campaign.starts_at);
    const endsAt = parseTimestamp(campaign.ends_at);

    // 1. Check Upcoming (Plánovaná / Nadcházející)
    const isUpcoming = (startsAt > now) || 
                       (campaign.status === 'UPCOMING') || 
                       (campaign.upcoming === true);

    // 2. Check Expired (Vypršená - nesmí být Upcoming)
    const isExpired = !isUpcoming && (
        (endsAt > 0 && endsAt <= now) || 
        (campaign.status === 'EXPIRED')
    );

    // 3. Check Active (Aktivní - nesmí být Upcoming ani Expired)
    const isActive = !isUpcoming && !isExpired && (
        (startsAt > 0 && startsAt <= now && (endsAt === 0 || endsAt > now)) || 
        (campaign.status === 'ACTIVE') || 
        (campaign.active === true)
    );

    // 4. Calculate Drops / Progress
    const dropsList = campaign.drops || campaign.time_based_drops || [];
    const realClaimed = dropsList.length > 0 
        ? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
        : (campaign.claimed_drops || 0);
    const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

    const isFinished = realTotal > 0 && realClaimed >= realTotal;

    // 5. Check Ready To Claim (Natěženo 100 %, nevyzvednuto, kampaň nevypršela)
    const hasClaimableDrop = dropsList.some(d => {
        const isClaimed = d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED';
        if (isClaimed) return false;

        const isClaimableFlag = d.is_claimable || d.claimable || d.isClaimable || d.status === 'READY_TO_CLAIM' || d.status === 'CLAIMABLE';
        const isProgressFull = (d.current_minutes && d.required_minutes && d.current_minutes >= d.required_minutes);

        return isClaimableFlag || isProgressFull;
    });

    const isReady = !isExpired && !isFinished && (
        hasClaimableDrop || 
        campaign.has_claimable_drops === true || 
        campaign.is_ready === true || 
        campaign.status === 'READY' ||
        campaign.status === 'READY_TO_CLAIM'
    );

    return {
        isActive,
        isUpcoming,
        isExpired,
        isFinished,
        isReady
    };
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

    const matchStatus = matchesStatusFilters(campaign, filters, status);
    const matchGame = matchesGameFilter(campaign, filters);
    const matchBenefit = matchesBenefitFilter(campaign, filters);

    const result = matchStatus && matchGame && matchBenefit;

    if (!result) {
        console.log(`[Filter Debug] Rejected campaign '${campaign.game_name || campaign.name}':`, {
            status,
            matchStatus,
            matchGame,
            matchBenefit
        });
    }

    return result;
}

function onInventoryFilterChange() {
    console.log('[Inventory Filter] Filter state changed by user interaction.');
    saveSettings();
    renderInventory();
}

/**
 * Safely sets the checked state of a checkbox if it exists in the DOM.
 */
function setCheckboxChecked(elementId, state) {
    const el = document.getElementById(elementId);
    if (el) {
        el.checked = state;
    }
}

/**
 * Clears all inventory filters to default state safely.
 */
function clearInventoryFilters() {
    const idsToUncheck = [
        'filter-active',
        'filter-not-linked',
        'filter-upcoming',
        'filter-expired',
        'filter-finished'
    ];

    const idsToCheck = [
        'filter-benefit-item',
        'filter-benefit-badge',
        'filter-benefit-emote',
        'filter-benefit-other'
    ];

    // 1. Safely uncheck state filters
    idsToUncheck.forEach(id => setCheckboxChecked(id, false));

    // 2. Safely check benefit filters
    idsToCheck.forEach(id => setCheckboxChecked(id, true));

    // 3. Safely clear search input
    const searchInput = document.getElementById('inventory-game-search');
    if (searchInput) {
        searchInput.value = '';
    }

    // 4. Safely clear array without breaking reference
    if (typeof selectedInventoryGames !== 'undefined' && Array.isArray(selectedInventoryGames)) {
        selectedInventoryGames.length = 0;
    }

    // 5. Update UI tags display & dropdown checkboxes
    if (typeof updateGameTagsDisplay === 'function') {
        updateGameTagsDisplay();
    }
    if (typeof renderGameDropdown === 'function') {
        renderGameDropdown('', true); // Force re-render dropdownu bez vybraných her
    }

    console.log('[Inventory Filter] Cleared all inventory filters to default state.');

    // 6. Save settings and re-render grid
    if (typeof saveSettings === 'function') {
        saveSettings();
    }

    if (typeof renderInventory === 'function') {
        renderInventory(true); // Force re-render inventory mřížky
    }
}

// Renders a single benefit item
function renderBenefitItem(benefit, statusClass = '') {
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
function renderDropItem(drop, t) {
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
            const benefitEl = renderBenefitItem(benefit, statusClass);
            
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

function renderDropBlock(drop, t) {
    let statusClass = 'drop-upcoming';
    if (drop.is_claimed) {
        statusClass = 'drop-claimed';
    } else if (drop.can_claim) {
        statusClass = 'drop-ready';
    } else if (drop.is_expired) {
        statusClass = 'drop-expired';
    } else if ((drop.progress || 0) > 0 || drop.current_minutes > 0) {
        statusClass = 'drop-active';
    }

    const dropBlock = document.createElement('div');
    dropBlock.className = `drop-block ${statusClass}`;
    dropBlock.appendChild(renderDropItem(drop, t));

    return dropBlock;
}

// Renders header section for a campaign card
function renderCardHeaderSection(campaign, statusClass, t) {
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
function renderCardInfoSection(campaign, statusText, t) {
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
function renderCardDropsSection(campaign, t) {
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

            const dropBlock = renderDropBlock(drop, t);
            
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
// Builds the final HTML element for a single campaign card
function renderCampaignCard(campaign, t) {
    const status = getCampaignStatus(campaign);
    const isLinked = campaign.linked !== undefined ? campaign.linked : (campaign.is_account_connected !== undefined ? campaign.is_account_connected : true);

    let statusClass = 'upcoming';
    let statusText = t.gui?.inventory?.status?.upcoming || 'Upcoming';

    // Status evaluation hierarchy
    if (!isLinked) {
        statusClass = 'not-linked';
        statusText = t.gui?.inventory?.status?.not_linked || 'Not Linked';
    } else if (status.isExpired) {
        statusClass = 'expired';
        statusText = t.gui?.inventory?.status?.expired || 'Expired';
    } else if (status.isFinished) {
        statusClass = 'completed';
        statusText = t.gui?.inventory?.status?.completed || 'Completed';
    } else if (status.isReady) {
        // Orange status for ready to claim drops
        statusClass = 'ready';
        statusText = t.gui?.inventory?.status?.ready || 'Ready to Claim';
    } else if (campaign.is_mining_in_progress) {
        statusClass = 'in-progress';
        statusText = t.gui?.inventory?.status?.in_progress || 'In Progress';
    } else if (status.isActive) {
        statusClass = 'active';
        statusText = t.gui?.inventory?.status?.active || 'Active';
    } else if (status.isUpcoming) {
        statusClass = 'upcoming';
        statusText = t.gui?.inventory?.status?.upcoming || 'Upcoming';
    }

    const card = makeElement('div', { class: `campaign-card ${statusClass}` });
    
    const campaignInfo = renderCardInfoSection(campaign, statusText, t);
    campaignInfo.prepend(renderCardHeaderSection(campaign, statusClass, t));

    const dropsBox = renderCardDropsSection(campaign, t);

    card.replaceChildren(campaignInfo, dropsBox);
    return card;
}

let lastInventoryRenderHash = null;

// Main grid rendering procedure
function renderInventory(force = false) {
    console.log('[Inventory Debug] === Executing renderInventory ===');
    try {
        const container = document.getElementById('inventory-grid');
        if (!container) {
            console.error('[Inventory Debug] ERROR: Element #inventory-grid NOT FOUND in DOM!');
            return;
        }

        if (typeof updateOverallProgress === 'function') {
            updateOverallProgress();
        } else {
            console.log('[Inventory Debug] WARNING: Function updateOverallProgress does not exist.');
        }

        const t = state?.translations || {};
        const allCampaigns = state?.campaigns ? Object.values(state.campaigns) : [];

        console.log(`[Inventory Debug] Total campaigns in state object: ${allCampaigns.length}`, state?.campaigns);

        const filters = getInventoryFilters();
        console.log('[Inventory Debug] Loaded filters from UI:', filters);

        // Filter & Sort
        const filteredCampaigns = allCampaigns.filter(campaign => campaignMatchesFilters(campaign, filters));
        console.log(`[Inventory Debug] Campaigns passing filter: ${filteredCampaigns.length} of ${allCampaigns.length}`);

        const sortedCampaigns = sortCampaigns(filteredCampaigns);

        // Enhanced Fingerprint Guard: Includes campaign state, live progress, claimed counts, account link status, and isReady state
        const campaignStateFingerprint = sortedCampaigns.map(c => {
            const id = c.id || c.game_name || '';
            const progress = c.current_minutes || c.progress || 0;
            const claimed = c.claimed_drops_count || c.claimed || 0;
            const status = c.status || '';
            const isLinked = c.is_account_connected !== undefined ? c.is_account_connected : (c.linked !== undefined ? c.linked : true);
            
            // Check if campaign is in READY TO CLAIM state
            const isReadyState = typeof getCampaignStatus === 'function' ? getCampaignStatus(c).isReady : false;

            return `${id}:${status}:${progress}:${claimed}:${isLinked}:${isReadyState}`;
        }).join('|');

        const currentHash = `${sortedCampaigns.length}_${campaignStateFingerprint}_${JSON.stringify(filters)}`;

        if (!force && lastInventoryRenderHash === currentHash) {
            console.log('[Inventory Debug] Render skipped (identical data, live status, and filters - fingerprint match).');
            return;
        }
        lastInventoryRenderHash = currentHash;

        if (allCampaigns.length === 0) {
            console.log('[Inventory Debug] WARNING: No data in state.campaigns!');
            const emptyMsg = t.gui?.inventory?.no_campaigns || 'No campaigns loaded yet...';
            container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
            return;
        }

        if (sortedCampaigns.length === 0) {
            console.log('[Inventory Debug] WARNING: Filters rejected ALL campaigns!');
            const noMatchMsg = t.gui?.inventory?.no_matching_campaigns || 'No campaigns match the current filters.';
            container.replaceChildren(makeElement('p', { class: 'empty-message' }, noMatchMsg));
            return;
        }

        const fragment = document.createDocumentFragment();
        sortedCampaigns.forEach((campaign, idx) => {
            try {
                fragment.appendChild(renderCampaignCard(campaign, t));
            } catch (err) {
                console.error(`[Inventory Debug] ERROR creating card for campaign #${idx} (${campaign.game_name}):`, err);
            }
        });

        container.replaceChildren(fragment);
        console.log('[Inventory Debug] SUCCESS: Grid successfully rendered into DOM!');

    } catch (globalErr) {
        console.error('[Inventory Debug] CRITICAL ERROR inside renderInventory:', globalErr);
    }
}
