////////////////////////////////////////////////////////////////
// ==================== Inventory Filtering ====================
////////////////////////////////////////////////////////////////

// Listener na event ze state manageru
window.addEventListener('stateUpdated', (e) => {
	handleInventoryBatchUpdate(e.detail?.inventory, e.detail?.settings);
});

// GLOBAL STATES AND VARIABLES

let selectedInventoryGames = [];
let inventorySaveTimeout = null;
let gameDropdownFocusedIndex = -1;
let gameDropdownVisible = false;

//////////////////////////////////////////
///////// HANDLERS /////////////////
/////////////////////////////////

function handleInventoryClear() {
//    console.log('[Inventory] Received clear command (ignored to keep existing state until new data arrives)');
}

/**
 * Pomocná funkce pro bezpečné vytažení názvu hry (řeší game_name i game.name)[cite: 1]
 */
function getCampaignGameName(campaign) {
    if (!campaign) return '';
    return campaign.game_name || campaign.game?.name || campaign.gameName || '';
}

/**
 * Pomocná funkce pro bezpečné vytažení dropů z kampaně (sjednocuje timed_drops, timedDrops, drops)[cite: 1]
 */
function getCampaignDrops(campaign) {
    if (!campaign) return [];
    return campaign.timed_drops || campaign.timedDrops || campaign.drops || campaign.time_based_drops || [];
}

/**
 * Zpracování hromadné aktualizace inventáře ze serveru[cite: 1]
 */
function handleInventoryBatchUpdate(rawData) {
    if (!rawData) return;

    const extracted = typeof extractWantedItemsData === 'function' ? extractWantedItemsData(rawData) : null;
    const sourceData = extracted?.inventory || rawData.campaigns || rawData.inventory || rawData;

    let inventoryList = [];
    let campaignsMap = {};

    if (Array.isArray(sourceData)) {
        inventoryList = sourceData;
        sourceData.forEach(camp => {
            if (camp && (camp.id || camp.id === 0)) {
                camp.game_name = getCampaignGameName(camp);
                
                // Bezpečná normalizace timed_drops, pokud by dorazily jako objekt
                const drops = getCampaignDrops(camp);
                if (camp.timed_drops && !Array.isArray(camp.timed_drops)) {
                    camp.timed_drops = Object.values(camp.timed_drops);
                } else if (!camp.timed_drops && Array.isArray(drops)) {
                    camp.timed_drops = drops;
                }

                campaignsMap[camp.id] = camp;
            }
        });
    } else if (typeof sourceData === 'object' && sourceData !== null) {
        Object.keys(sourceData).forEach(key => {
            const camp = sourceData[key];
            if (camp && typeof camp === 'object') {
                camp.game_name = getCampaignGameName(camp);
                
                const drops = getCampaignDrops(camp);
                if (camp.timed_drops && !Array.isArray(camp.timed_drops)) {
                    camp.timed_drops = Object.values(camp.timed_drops);
                } else if (!camp.timed_drops && Array.isArray(drops)) {
                    camp.timed_drops = drops;
                }

                campaignsMap[key] = camp;
            }
        });
        inventoryList = Object.values(campaignsMap);
    }

    window.state = window.state || {};
    window.state.inventory = inventoryList;
    window.state.campaigns = campaignsMap;

    if (typeof state !== 'undefined' && state !== window.state) {
        state.inventory = inventoryList;
        state.campaigns = campaignsMap;
    }

    if (typeof updateGameTagsDisplay === 'function') updateGameTagsDisplay();
    if (typeof renderGameDropdown === 'function') renderGameDropdown('', true);
    if (typeof renderInventory === 'function') renderInventory(true);
    if (typeof applyAutoSortIfNeeded === 'function') applyAutoSortIfNeeded();
    if (typeof syncAdminState === 'function') syncAdminState();
}

// ==================== Game Dropdown & Tags ====================

function getAvailableGamesForDropdown() {
    const currentCampaigns = window.state?.campaigns || (typeof state !== 'undefined' ? state?.campaigns : {}) || {};

    const gamesFromCampaigns = Object.values(currentCampaigns)
        .map(campaign => getCampaignGameName(campaign))
        .filter(Boolean);

    const gamesFromSettings = Array.from(typeof availableGames !== 'undefined' ? availableGames : []).filter(Boolean);
    const uniqueGames = Array.from(new Set([...gamesFromCampaigns, ...gamesFromSettings]));

    return uniqueGames.sort((a, b) => a.localeCompare(b));
}

let lastGameDropdownHash = null;

function renderGameDropdown(searchTerm = '', force = false) {
    const dropdown = document.getElementById('game-dropdown-list');
    if (!dropdown) return;

    const allGames = typeof getAvailableGamesForDropdown === 'function' ? getAvailableGamesForDropdown() : [];
    const searchLower = searchTerm.toLowerCase().trim();
    const filteredGames = searchLower
        ? allGames.filter(game => game.toLowerCase().includes(searchLower))
        : allGames;

    const selectedGames = Array.isArray(selectedInventoryGames) ? selectedInventoryGames : [];
    const focusedIdx = typeof gameDropdownFocusedIndex !== 'undefined' ? gameDropdownFocusedIndex : -1;

    const filteredHash = filteredGames.join('|');
    const selectedHash = selectedGames.join('|');
    const currentHash = `${searchLower}_${filteredHash}_${focusedIdx}_${selectedHash}`;

    if (!force && lastGameDropdownHash === currentHash) {
        return;
    }
    lastGameDropdownHash = currentHash;

    if (filteredGames.length === 0) {
        dropdown.replaceChildren(makeElement('div', { class: 'dropdown-item no-results' }, 'No games found'));
        if (typeof gameDropdownFocusedIndex !== 'undefined') {
            gameDropdownFocusedIndex = -1;
        }
        return;
    }

    const fragment = document.createDocumentFragment();

    filteredGames.forEach((gameName, index) => {
        const isSelected = selectedGames.includes(gameName);
        const isFocused = index === focusedIdx;

        const item = document.createElement('div');
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

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target === checkbox || e.target === label) {
                e.preventDefault();
            }
            if (typeof toggleGameSelection === 'function') {
                toggleGameSelection(gameName);
            }
        });

        fragment.appendChild(item);
    });

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

    updateGameTagsDisplay();
    const searchInput = document.getElementById('inventory-game-search');
    renderGameDropdown(searchInput ? searchInput.value : '');
    if (typeof renderInventory === 'function') renderInventory();

    if (inventorySaveTimeout) {
        clearTimeout(inventorySaveTimeout);
    }

    inventorySaveTimeout = setTimeout(() => {
        saveSettings();
    }, 1000);
}

function removeGameTag(gameName) {
    const index = selectedInventoryGames.indexOf(gameName);
    if (index >= 0) {
        selectedInventoryGames.splice(index, 1);
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
    return [...campaigns].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        
        if (a.active) {
            const dateA = a.ends_at ? new Date(a.ends_at).getTime() : Infinity;
            const dateB = b.ends_at ? new Date(b.ends_at).getTime() : Infinity;
            return dateA - dateB;
        }
        
        const statusA = getCampaignStatus(a, now);
        const statusB = getCampaignStatus(b, now);
        
        if (statusA.isUpcoming !== statusB.isUpcoming) {
            return statusA.isUpcoming ? -1 : 1;
        }
        
        if (statusA.isUpcoming) {
            const startsA = a.starts_at ? new Date(a.starts_at).getTime() : Infinity;
            const startsB = b.starts_at ? new Date(b.starts_at).getTime() : Infinity;
            return startsA - startsB;
        }
        
        const endsAtA = a.ends_at ? new Date(a.ends_at).getTime() : 0;
        const endsAtB = b.ends_at ? new Date(b.ends_at).getTime() : 0;
        return endsAtB - endsAtA;
    });
}

function getInventoryFilters() {
    return {
        show_active: document.getElementById('filter-active')?.checked || false,
        show_not_linked: document.getElementById('filter-not-linked')?.checked || false,
        show_upcoming: document.getElementById('filter-upcoming')?.checked || false,
        show_expired: document.getElementById('filter-expired')?.checked || false,
        show_finished: document.getElementById('filter-finished')?.checked || false,
        game_name_search: [...selectedInventoryGames],
        show_benefit_item: document.getElementById('filter-benefit-item')?.checked !== false,
        show_benefit_badge: document.getElementById('filter-benefit-badge')?.checked !== false,
        show_benefit_emote: document.getElementById('filter-benefit-emote')?.checked !== false,
        show_benefit_other: document.getElementById('filter-benefit-other')?.checked !== false,
    };
}

function getCampaignStatus(campaign, now = Date.now()) {
    if (!campaign) {
        return { isActive: false, isUpcoming: false, isExpired: false, isFinished: false, isReady: false };
    }

    const parseTimestamp = (dateVal) => {
        if (!dateVal) return 0;
        const time = new Date(dateVal).getTime();
        return Number.isNaN(time) ? 0 : time;
    };

    const startsAt = parseTimestamp(campaign.starts_at);
    const endsAt = parseTimestamp(campaign.ends_at);

    const isUpcoming = (startsAt > now) || 
                       (campaign.status === 'UPCOMING') || 
                       (campaign.upcoming === true);

    const isExpired = !isUpcoming && (
        (endsAt > 0 && endsAt <= now) || 
        (campaign.status === 'EXPIRED')
    );

    const isActive = !isUpcoming && !isExpired && (
        (startsAt > 0 && startsAt <= now && (endsAt === 0 || endsAt > now)) || 
        (campaign.status === 'ACTIVE') || 
        (campaign.active === true)
    );

    // Použití univerzální funkce getCampaignDrops pro správné načtení dropů z nového modelu[cite: 1]
    const dropsList = getCampaignDrops(campaign);
    const realClaimed = dropsList.length > 0 
        ? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
        : (campaign.claimed_drops || 0);
    const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

    const isFinished = realTotal > 0 && realClaimed >= realTotal;

    const hasClaimableDrop = dropsList.some(d => {
        const isClaimed = d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED';
        if (isClaimed) return false;

        const isClaimableFlag = d.is_claimable || d.claimable || d.isClaimable || d.status === 'READY_TO_CLAIM' || d.status === 'CLAIMABLE';
        const currentMins = d.current_minutes !== undefined ? d.current_minutes : (d.real_current_minutes || 0);
        const isProgressFull = (currentMins && d.required_minutes && currentMins >= d.required_minutes);

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

function matchesStatusFilters(campaign, filters, status) {
    const hasAnyFilter = filters.show_active || filters.show_not_linked ||
                         filters.show_upcoming || filters.show_expired || 
                         filters.show_finished;
    
    if (!hasAnyFilter) return true;

    const hasTimeFilter = filters.show_active || filters.show_upcoming || 
                          filters.show_expired || filters.show_finished;
    
    let matchesTime = !hasTimeFilter;
    if (hasTimeFilter) {
        if (filters.show_finished && status.isFinished) matchesTime = true;
        if (filters.show_expired && status.isExpired && !status.isFinished) matchesTime = true;
        if (filters.show_upcoming && status.isUpcoming && !status.isFinished) matchesTime = true;
        if (filters.show_active && status.isActive && !status.isFinished && !status.isUpcoming) matchesTime = true;
    }

    let matchesLink = true;
    if (!campaign.linked) {
        matchesLink = filters.show_not_linked;
    } else if (filters.show_not_linked && !hasTimeFilter) {
        matchesLink = false;
    }

    return matchesTime && matchesLink;
}

function matchesGameFilter(campaign, filters) {
    if (!filters.game_name_search || filters.game_name_search.length === 0) return true;
    const gameName = getCampaignGameName(campaign);
    return filters.game_name_search.includes(gameName);
}

function matchesBenefitFilter(campaign, filters) {
    const allBenefitsEnabled = filters.show_benefit_item && filters.show_benefit_badge &&
                               filters.show_benefit_emote && filters.show_benefit_other;
    
    const drops = getCampaignDrops(campaign);
    if (allBenefitsEnabled || drops.length === 0) return true;

    const hasBenefitFilter = filters.show_benefit_item || filters.show_benefit_badge || 
                             filters.show_benefit_emote || filters.show_benefit_other;
    if (!hasBenefitFilter) return true;

    for (const drop of drops) {
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

function campaignMatchesFilters(campaign, filters) {
    const status = getCampaignStatus(campaign);
    const matchStatus = matchesStatusFilters(campaign, filters, status);
    const matchGame = matchesGameFilter(campaign, filters);
    const matchBenefit = matchesBenefitFilter(campaign, filters);

    return matchStatus && matchGame && matchBenefit;
}

function onInventoryFilterChange() {
    saveSettings();
    renderInventory();
}

function setCheckboxChecked(elementId, state) {
    const el = document.getElementById(elementId);
    if (el) {
        el.checked = state;
    }
}

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

    idsToUncheck.forEach(id => setCheckboxChecked(id, false));
    idsToCheck.forEach(id => setCheckboxChecked(id, true));

    const searchInput = document.getElementById('inventory-game-search');
    if (searchInput) {
        searchInput.value = '';
    }

    if (typeof selectedInventoryGames !== 'undefined' && Array.isArray(selectedInventoryGames)) {
        selectedInventoryGames.length = 0;
    }

    if (typeof updateGameTagsDisplay === 'function') {
        updateGameTagsDisplay();
    }
    if (typeof renderGameDropdown === 'function') {
        renderGameDropdown('', true);
    }

    if (typeof saveSettings === 'function') {
        saveSettings();
    }

    if (typeof renderInventory === 'function') {
        renderInventory(true);
    }
}

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
                const currentMins = drop.current_minutes !== undefined ? drop.current_minutes : (drop.real_current_minutes || 0);
                const progressPercent = Math.round((drop.progress || (drop.required_minutes ? currentMins / drop.required_minutes : 0)) * 100);
                contentWrapper.appendChild(makeElement('div', {}, `${currentMins} / ${drop.required_minutes} minutes (${progressPercent}%)`));
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
    } else if ((drop.progress || 0) > 0 || (drop.current_minutes || drop.real_current_minutes) > 0) {
        statusClass = 'drop-active';
    }

    const dropBlock = document.createElement('div');
    dropBlock.className = `drop-block ${statusClass}`;
    dropBlock.appendChild(renderDropItem(drop, t));

    return dropBlock;
}

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

function renderCardInfoSection(campaign, statusText, t) {
    const infoSection = makeElement('div', { class: 'campaign-info' });

    const dropsList = getCampaignDrops(campaign);
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

function renderCardDropsSection(campaign, t) {
    const dropsBox = makeElement('div', { class: 'campaign-drops' });
    const currentDrop = (typeof state !== 'undefined' && state.currentDrop) || null;

    const dropsList = getCampaignDrops(campaign);
    if (dropsList.length > 0) {
        dropsBox.appendChild(makeElement('div', { class: 'campaign-drop-title' }, campaign.name));
        
        dropsList.forEach(drop => {
            const dropId = drop.id || drop.drop_id || '';
            let isActivelyMining = false;
            
            if (currentDrop && dropId) {
                const currentId = currentDrop.id || currentDrop.drop_id || '';
                isActivelyMining = currentId && String(dropId) === String(currentId);
            }

            const current = Math.round(drop.current_minutes !== undefined ? drop.current_minutes : (drop.real_current_minutes || 0));
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

function renderCampaignCard(campaign, t) {
    const status = getCampaignStatus(campaign);
    const isLinked = campaign.linked !== undefined ? campaign.linked : (campaign.is_account_connected !== undefined ? campaign.is_account_connected : true);

    let statusClass = 'upcoming';
    let statusText = t.gui?.inventory?.status?.upcoming || 'Upcoming';

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

function renderInventory(force = false) {
    try {
        const container = document.getElementById('inventory-grid');
        if (!container) {
            return;
        }

        if (typeof updateOverallProgress === 'function') {
            updateOverallProgress();
        }

        const t = state?.translations || {};
        const allCampaigns = state?.campaigns ? Object.values(state.campaigns) : [];
        const filters = getInventoryFilters();

        const filteredCampaigns = allCampaigns.filter(campaign => campaignMatchesFilters(campaign, filters));
        const sortedCampaigns = sortCampaigns(filteredCampaigns);

        const campaignStateFingerprint = sortedCampaigns.map(c => {
            const id = c.id || c.game_name || '';
            const progress = c.current_minutes || c.progress || 0;
            const claimed = c.claimed_drops_count || c.claimed || 0;
            const status = c.status || '';
            const isLinked = c.is_account_connected !== undefined ? c.is_account_connected : (c.linked !== undefined ? c.linked : true);
            const isReadyState = typeof getCampaignStatus === 'function' ? getCampaignStatus(c).isReady : false;

            return `${id}:${status}:${progress}:${claimed}:${isLinked}:${isReadyState}`;
        }).join('|');

        const currentHash = `${sortedCampaigns.length}_${campaignStateFingerprint}_${JSON.stringify(filters)}`;

        if (!force && lastInventoryRenderHash === currentHash) {
            return;
        }
        lastInventoryRenderHash = currentHash;

        if (allCampaigns.length === 0) {
            const emptyMsg = t.gui?.inventory?.no_campaigns || 'No campaigns loaded yet...';
            container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
            return;
        }

        if (sortedCampaigns.length === 0) {
            const noMatchMsg = t.gui?.inventory?.no_matching_campaigns || 'No campaigns match the current filters.';
            container.replaceChildren(makeElement('p', { class: 'empty-message' }, noMatchMsg));
            return;
        }

        const fragment = document.createDocumentFragment();
        sortedCampaigns.forEach((campaign, idx) => {
            try {
                fragment.appendChild(renderCampaignCard(campaign, t));
            } catch (err) {
                // console.error(err);
            }
        });

        container.replaceChildren(fragment);

    } catch (globalErr) {
        // console.error(globalErr);
    }
}
