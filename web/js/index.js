// Twitch Drops Miner Web Client
// Socket.IO and API communication


let selectedInventoryGames = [];
let availableGames = new Set(); // All games from campaigns
let draggedElement = null;

// Global state
const state = {
//    debug: true,
    connected: false,
    channels: {},
    campaigns: {},
    settings: {},
    currentDrop: null,
    countdownTimer: null,  // Track the active countdown timer
    translations: {}  // Store current translations
};

const imageCache = new Map();

// ==================== Version Checking ====================

async function fetchAndDisplayVersion() {
    try {
        const response = await fetch('/api/version');
        if (!response.ok) throw new Error('Failed to fetch version');

        const data = await response.json();
        const versionElement = document.getElementById('current-version');
        if (versionElement) {
            let versionText = data.current_version;
            // Add (latest) indicator if we know the latest version and it matches
            if (data.latest_version && data.current_version === data.latest_version) {
                versionText += ' (latest)';
            }
            versionElement.textContent = versionText;

            // Translate footer version text
            const footerVersionText = document.getElementById('footer-version-text');
            if (footerVersionText && state.translations.gui?.footer) {
                const versionLabel = state.translations.gui.footer.version || 'Version:';
                // Preserve the span inside
                const span = footerVersionText.querySelector('span');
                footerVersionText.textContent = versionLabel + ' ';
                footerVersionText.appendChild(span);
            }
        }

        // Display update notification if available
        if (data.update_available && data.latest_version) {
            const updateIndicator = document.getElementById('footer-update-indicator');
            const latestVersionSpan = document.getElementById('latest-version');
            const updateLink = document.getElementById('footer-update-link');

            if (updateIndicator && latestVersionSpan && updateLink) {
                latestVersionSpan.textContent = data.latest_version;
                updateLink.href = data.download_url;
                updateIndicator.style.display = 'inline-block';

                // Translate update message
                if (state.translations.gui?.footer) {
                    const updateLabel = state.translations.gui.footer.update_available || 'Update Available:';
                    const linkText = document.createTextNode(` ⚠ ${updateLabel} `);
                    // Clear existing text nodes but keep the span
                    const span = updateLink.querySelector('span'); // latest-version span
                    updateLink.textContent = '';
                    updateLink.appendChild(linkText);
                    updateLink.appendChild(span);
                }

                // Log to console
//                console.log(`Update available: ${data.latest_version} (current: ${data.current_version})`);
            }
        }
    } catch (error) {
        console.warn('Could not fetch version information:', error);
        // Set placeholder text if fetch fails
        const versionElement = document.getElementById('current-version');
        const loadingText = state.translations.gui?.footer?.loading || 'Loading...';
        if (versionElement && versionElement.textContent === loadingText) {
            versionElement.textContent = 'Unknown';
        }
    }
}

// ==================== Game Dropdown & Tags ====================

// Track selected games for inventory filter

let gameDropdownFocusedIndex = -1;
let gameDropdownVisible = false;

function getAvailableGamesForDropdown() {
    // Combine games from campaigns and availableGames Set
    const gamesFromCampaigns = Object.values(state.campaigns).map(c => c.game_name);
    const gamesFromSettings = Array.from(availableGames || []);

    // Merge and deduplicate
    const allGames = [...new Set([...gamesFromCampaigns, ...gamesFromSettings])];

    // Sort alphabetically
    return allGames.sort((a, b) => a.localeCompare(b));
}

function renderGameDropdown(searchTerm = '') {
    const dropdown = document.getElementById('game-dropdown-list');
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

function toggleGameSelection(gameName) {
    const index = selectedInventoryGames.indexOf(gameName);
    if (index >= 0) {
        // Remove game
        selectedInventoryGames.splice(index, 1);
    } else {
        // Add game
        selectedInventoryGames.push(gameName);
    }

    updateGameTagsDisplay();
    renderGameDropdown(document.getElementById('inventory-game-search').value);
    saveSettings();
    renderInventory();
}

function removeGameTag(gameName) {
    const index = selectedInventoryGames.indexOf(gameName);
    if (index >= 0) {
        selectedInventoryGames.splice(index, 1);
        updateGameTagsDisplay();
        renderGameDropdown(document.getElementById('inventory-game-search').value);
        saveSettings();
        renderInventory();
    }
}

function updateGameTagsDisplay() {
    const container = document.getElementById('selected-game-tags');
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

function showGameDropdown() {
    const dropdown = document.getElementById('game-dropdown-list');
    dropdown.style.display = 'block';
    gameDropdownVisible = true;
    gameDropdownFocusedIndex = -1;
    renderGameDropdown(document.getElementById('inventory-game-search').value);
}

function closeGameDropdown() {
    const dropdown = document.getElementById('game-dropdown-list');
    dropdown.style.display = 'none';
    gameDropdownVisible = false;
    gameDropdownFocusedIndex = -1;
}

function handleGameSearchKeydown(event) {
    if (!gameDropdownVisible) {
        return;
    }

    const dropdown = document.getElementById('game-dropdown-list');
    const items = dropdown.querySelectorAll('.dropdown-item:not(.no-results)');
    const maxIndex = items.length - 1;

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        gameDropdownFocusedIndex = Math.min(gameDropdownFocusedIndex + 1, maxIndex);
        renderGameDropdown(document.getElementById('inventory-game-search').value);

        // Scroll focused item into view
        const focusedItem = dropdown.querySelector('.dropdown-item.focused');
        if (focusedItem) {
            focusedItem.scrollIntoView({ block: 'nearest' });
        }
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        gameDropdownFocusedIndex = Math.max(gameDropdownFocusedIndex - 1, 0);
        renderGameDropdown(document.getElementById('inventory-game-search').value);

        // Scroll focused item into view
        const focusedItem = dropdown.querySelector('.dropdown-item.focused');
        if (focusedItem) {
            focusedItem.scrollIntoView({ block: 'nearest' });
        }
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (gameDropdownFocusedIndex >= 0 && gameDropdownFocusedIndex <= maxIndex) {
            const focusedItem = items[gameDropdownFocusedIndex];
            const gameName = focusedItem.dataset.gameName;
            if (gameName) {
                toggleGameSelection(gameName);
            }
        }
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeGameDropdown();
        document.getElementById('inventory-game-search').blur();
    }
}

function showLoginForm() {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('oauth-code-display').style.display = 'none';
}

function showOAuthCode(url, code) {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('oauth-code-display').style.display = 'block';
    document.getElementById('oauth-url').href = url;
    document.getElementById('oauth-code').textContent = code;
}

function updateLoginStatus(data) {
    const statusEl = document.getElementById('login-status');
    const t = state.translations;
    if (data.user_id) {
        const userIdLabel = t.gui?.login?.user_id_label || 'User ID:';
        statusEl.textContent = `${data.status} (${userIdLabel} ${data.user_id})`;
        statusEl.removeAttribute('translation-key');
        statusEl.style.color = 'var(--success-color)';
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('oauth-code-display').style.display = 'none';
    } else {
        const loggedOut = t.gui?.login?.logged_out || 'Not logged in';
        statusEl.textContent = data.status || loggedOut;
        statusEl.setAttribute('translation-key', 'logged_out');
        statusEl.style.color = 'var(--text-secondary)';
        // Check if OAuth is pending (for late-connecting clients)
        if (data.oauth_pending) {
            showOAuthCode(data.oauth_pending.url, data.oauth_pending.code);
        }
    }
}

function updateSettingsUI(settings) {
    state.settings = settings;
    document.getElementById('dark-mode').checked = settings.dark_mode || false;
    document.getElementById('auto-sort-by-end').checked = settings.auto_sort_by_end || false;
    document.getElementById('mine-badges-first').checked = settings.mine_badges_first || false;
    document.getElementById('auto-add-all-games').checked = settings.auto_add_all_games || false;
    document.getElementById('connection-quality').value = settings.connection_quality || 1;
    document.getElementById('minimum-refresh-interval').value = settings.minimum_refresh_interval_minutes || 30;

    // Update proxy settings and indicator
    const proxyUrl = settings.proxy || '';
    const proxyInput = document.getElementById('proxy-url');
    if (proxyInput) proxyInput.value = proxyUrl;

    const proxyIndicator = document.getElementById('proxy-indicator');
    if (proxyIndicator) {
        proxyIndicator.style.display = proxyUrl ? 'inline-flex' : 'none';
        proxyIndicator.title = proxyUrl ? `Proxy active: ${proxyUrl}` : 'Proxy disabled';
    }

    // Update language dropdown if we have the current language
    if (settings.language) {
        const languageSelect = document.getElementById('language');
        if (languageSelect) {
            languageSelect.value = settings.language;
        }
    }

    if (settings.dark_mode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }

	// Update available games if provided in settings
    if (settings.games_available) {
        availableGames = new Set(settings.games_available);
        
        // Ensure watched games are always part of the available pool
        if (settings.games_to_watch) {
            settings.games_to_watch.forEach(game => availableGames.add(game));
        }
    }

    // Restore inventory filters from settings
    if (settings.inventory_filters) {
        document.getElementById('filter-active').checked = settings.inventory_filters.show_active || false;
        document.getElementById('filter-not-linked').checked = settings.inventory_filters.show_not_linked || false;
        document.getElementById('filter-upcoming').checked = settings.inventory_filters.show_upcoming || false;
        document.getElementById('filter-expired').checked = settings.inventory_filters.show_expired || false;
        document.getElementById('filter-finished').checked = settings.inventory_filters.show_finished || false;

        // Restore selected games array
        selectedInventoryGames = Array.isArray(settings.inventory_filters.game_name_search)
            ? [...settings.inventory_filters.game_name_search]
            : [];  // Handle old string format gracefully
        updateGameTagsDisplay();

        // Restore benefit type filters (default to true if not set)
        if (document.getElementById('filter-benefit-item')) document.getElementById('filter-benefit-item').checked = settings.inventory_filters.show_benefit_item !== false;
        if (document.getElementById('filter-benefit-badge')) document.getElementById('filter-benefit-badge').checked = settings.inventory_filters.show_benefit_badge !== false;
        if (document.getElementById('filter-benefit-emote')) document.getElementById('filter-benefit-emote').checked = settings.inventory_filters.show_benefit_emote !== false;
        if (document.getElementById('filter-benefit-other')) document.getElementById('filter-benefit-other').checked = settings.inventory_filters.show_benefit_other !== false;
    }

    // Restore mining benefit filters
    if (settings.mining_benefits) {
        if (document.getElementById('mining-benefit-item')) document.getElementById('mining-benefit-item').checked = settings.mining_benefits.DIRECT_ENTITLEMENT;
        if (document.getElementById('mining-benefit-badge')) document.getElementById('mining-benefit-badge').checked = settings.mining_benefits.BADGE;
        if (document.getElementById('mining-benefit-emote')) document.getElementById('mining-benefit-emote').checked = settings.mining_benefits.EMOTE;
        if (document.getElementById('mining-benefit-unknown')) document.getElementById('mining-benefit-unknown').checked = settings.mining_benefits.UNKNOWN;
    }


    // Update games to watch lists
    renderGamesToWatch();

    // Re-render channels list to apply filter based on updated games to watch
    renderChannels();

    // Re-render inventory to apply filters
    renderInventory();
    
    // Check if we need to auto-add games after settings are applied
    applyAutoAddIfNeeded();
}

function updateManualModeUI(manualModeInfo) {
    const manualBadge = document.getElementById('manual-mode-badge');
    const autoBadge = document.getElementById('auto-mode-badge');
    const manualGameName = document.getElementById('manual-game-name');
    const manualControls = document.getElementById('manual-mode-controls');
    const manualModeGame = document.getElementById('manual-mode-game');

    if (manualModeInfo.active) {
        // Show manual mode badge, hide auto badge
        manualBadge.classList.remove('hidden');
        autoBadge.classList.add('hidden');
        manualGameName.textContent = manualModeInfo.game_name || '';

        // Show manual mode controls in drop progress section
        if (manualControls) {
            manualControls.classList.remove('hidden');
            if (manualModeGame) {
                manualModeGame.textContent = manualModeInfo.game_name || '';
            }
        }
    } else {
        // Hide manual mode badge, show auto badge
        manualBadge.classList.add('hidden');
        autoBadge.classList.remove('hidden');

        // Hide manual mode controls
        if (manualControls) {
            manualControls.classList.add('hidden');
        }
    }
}

// ==================== Games to Watch / Ignore Management ====================

function renderGamesToWatch() {
    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);
    
    const leftHeading = document.querySelector('.available-games h3');
    const rightHeading = document.querySelector('.selected-games h3');

    // Update headings and colors based on active mode
    if (isIgnoreMode) {
        if (leftHeading) {
            leftHeading.textContent = 'Active / Auto-Mined Games';
            leftHeading.style.color = '#2ecc71';
        }
        if (rightHeading) {
            rightHeading.textContent = 'Ignore List (Blacklisted)';
            rightHeading.style.color = '#ff4d4d';
        }
    } else {
        if (leftHeading) {
            leftHeading.textContent = 'Available Games';
            leftHeading.style.color = '';
        }
        if (rightHeading) {
            rightHeading.textContent = 'Selected Games (Priority Order)';
            rightHeading.style.color = '#2ecc71';
        }
    }

    const filterText = document.getElementById('games-filter')?.value.toLowerCase() || '';

    if (isIgnoreMode) {
        const ignoredGames = state?.settings?.ignored_games || [];
        ignoredGames.forEach(game => availableGames.add(game));

        // Active games (all available MINUS ignored ones)
        const activeGames = Array.from(availableGames)
            .filter(game => !ignoredGames.some(ig => ig.toLowerCase() === game.toLowerCase()))
            .filter(game => game.toLowerCase().includes(filterText))
            .sort((a, b) => a.localeCompare(b));

        const blacklistedGames = ignoredGames
            .filter(game => game.toLowerCase().includes(filterText))
            .sort((a, b) => a.localeCompare(b));

        renderAvailableGames(activeGames, filterText);
        renderSelectedGames(blacklistedGames);
    } else {
        const watchedGames = state?.settings?.games_to_watch || [];
        watchedGames.forEach(game => availableGames.add(game));

        const availableList = Array.from(availableGames)
            .filter(game => !watchedGames.includes(game))
            .filter(game => game.toLowerCase().includes(filterText))
            .sort((a, b) => a.localeCompare(b));

        renderAvailableGames(availableList, filterText);
        renderSelectedGames(watchedGames);
    }

    updateUIState();
}

function renderSelectedGames(games) {
    const container = document.getElementById('selected-games-list');
    if (!container) return;

    const t = state.translations;
    const isIgnoreMode = Boolean(state.settings?.auto_add_all_games);
    
    container.innerHTML = '';

    if (games.length === 0) {
        const emptyMsg = isIgnoreMode
            ? (t.gui?.settings?.no_games_ignored || 'No games on ignore list.')
            : (t.gui?.settings?.no_games_selected || 'No games selected. Check games below to add them.');
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
        return;
    }

    games.forEach((game, index) => {
        const div = document.createElement('div');
        div.className = 'sortable-item';
        div.dataset.game = game;

        if (isIgnoreMode) {
            // In Ignore Mode, priority and dragging are disabled
            div.draggable = false;
            div.replaceChildren(
                makeElement('span', { class: 'game-name', style: 'flex-grow: 1;' }, game),
                makeElement('button', { class: 'remove-btn', title: 'Remove from Ignore List' }, '✕')
            );
        } else {
            // Whitelist mode supports drag-and-drop reordering
            div.draggable = true;
            div.replaceChildren(
                makeElement('span', { class: 'drag-handle' }, '☰'),
                makeElement('span', { class: 'priority-number' }, String(index + 1)),
                makeElement('span', { class: 'game-name' }, game),
                makeElement('button', { class: 'remove-btn', title: 'Remove from Watch List' }, '✕')
            );

            div.addEventListener('dragstart', handleDragStart);
            div.addEventListener('dragover', handleDragOver);
            div.addEventListener('drop', handleDrop);
            div.addEventListener('dragend', handleDragEnd);
        }

        const removeBtn = div.querySelector('.remove-btn');
        removeBtn.addEventListener('click', () => {
            removeGameFromWatch(game);
        });

        container.appendChild(div);
    });
}

function renderAvailableGames(games, filterText) {
    const container = document.getElementById('available-games-list');
    if (!container) return;

    const t = state.translations;
    const isIgnoreMode = Boolean(state.settings?.auto_add_all_games);

    container.innerHTML = '';

    if (games.length === 0) {
        if (filterText) {
            const emptyMsg = t.gui?.settings?.no_games_match || 'No games match your search.';
            const addHint = t.gui?.settings?.add_game_hint || ' Click "Add Game" to add it manually.';
            container.replaceChildren(makeElement('p', { class: 'empty-message' }, `${emptyMsg}${addHint}`));
        } else {
            const emptyMsg = isIgnoreMode 
                ? (t.gui?.settings?.no_active_games || 'No active games available.')
                : (t.gui?.settings?.all_games_selected || 'All games are selected or no games available.');
            container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
        }
        return;
    }

    games.forEach(game => {
        const label = document.createElement('label');
        label.className = 'game-checkbox';

        if (isIgnoreMode) {
            // Active games get a block button to add them to the ignore list
            const ignoreBtn = makeElement('button', { class: 'remove-btn', style: 'margin-right: 8px;', title: 'Add to Ignore List' }, '🚫');
            ignoreBtn.addEventListener('click', (e) => {
                e.preventDefault();
                // Call dedicated handler to ensure instant UI render and Socket.IO emission
                if (typeof toggleGameIgnore === 'function') {
                    toggleGameIgnore(game, true);
                } else {
                    // Fallback in case handler is unavailable
                    if (!state.settings.ignored_games) state.settings.ignored_games = [];
                    if (!state.settings.ignored_games.some(g => g.toLowerCase() === game.toLowerCase())) {
                        state.settings.ignored_games.push(game);
                    }
                    renderGamesToWatch();
                    saveSettings();
                }
            });

            label.replaceChildren(
                ignoreBtn,
                makeElement('span', {}, game)
            );
        } else {
            const isChecked = (state.settings?.games_to_watch || []).includes(game);
            const input = makeElement('input', { type: 'checkbox', value: game });
            input.checked = isChecked;

            input.addEventListener('change', (e) => {
                toggleGameWatch(game, e.target.checked);
            });

            label.replaceChildren(
                input,
                makeElement('span', {}, game)
            );
        }

        container.appendChild(label);
    });
}

// Drag and drop handlers
function handleDragStart(e) {
    draggedElement = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.target.innerHTML);
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';

    const target = e.target.closest('.sortable-item');
    if (target && target !== draggedElement) {
        const container = target.parentNode;
        const allItems = [...container.querySelectorAll('.sortable-item')];
        const draggedIndex = allItems.indexOf(draggedElement);
        const targetIndex = allItems.indexOf(target);

        if (draggedIndex < targetIndex) {
            target.parentNode.insertBefore(draggedElement, target.nextSibling);
        } else {
            target.parentNode.insertBefore(draggedElement, target);
        }
    }
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    return false;
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');

    const isIgnoreMode = Boolean(state.settings?.auto_add_all_games);
    if (isIgnoreMode) return; // Order does not matter for Ignore List

    const container = document.getElementById('selected-games-list');
    const items = container.querySelectorAll('.sortable-item');
    const newOrder = Array.from(items).map(item => item.dataset.game);

    state.settings.games_to_watch = newOrder;

    renderSelectedGames(newOrder);
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

// Helper state modification functions
function toggleGameWatch(gameName, checked) {
    const isIgnoreMode = Boolean(state.settings?.auto_add_all_games);
    if (isIgnoreMode) return;

    const games = state.settings.games_to_watch || [];

    if (checked && !games.includes(gameName)) {
        games.push(gameName);
    } else if (!checked) {
        const index = games.indexOf(gameName);
        if (index > -1) {
            games.splice(index, 1);
        }
    }

    state.settings.games_to_watch = games;
    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

function removeGameFromWatch(gameName) {
    const isIgnoreMode = Boolean(state.settings?.auto_add_all_games);

    if (isIgnoreMode) {
        if (typeof toggleGameIgnore === 'function') {
            toggleGameIgnore(gameName, false);
            return;
        }
    } else {
        const games = state.settings.games_to_watch || [];
        const index = games.indexOf(gameName);
        if (index > -1) {
            games.splice(index, 1);
            state.settings.games_to_watch = games;
        }
    }

    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

function selectAllGames() {
    const isIgnoreMode = Boolean(state.settings?.auto_add_all_games);

    if (isIgnoreMode) {
        // Clear ignore list to mine all available games
        state.settings.ignored_games = [];
    } else {
        state.settings.games_to_watch = Array.from(availableGames).sort();
    }

    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

function deselectAllGames() {
    const isIgnoreMode = Boolean(state.settings?.auto_add_all_games);

    if (isIgnoreMode) {
        // Ignore all available games
        state.settings.ignored_games = Array.from(availableGames).sort();
    } else {
        state.settings.games_to_watch = [];
    }

    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

function addGameFromSearch() {
    const searchInput = document.getElementById('games-filter');
    const gameName = searchInput.value.trim();

    if (!gameName) return;

    const isIgnoreMode = Boolean(state.settings?.auto_add_all_games);

    if (isIgnoreMode) {
        // Adding a game manually in ignore mode removes it from ignored_games
        if (state.settings.ignored_games) {
            state.settings.ignored_games = state.settings.ignored_games.filter(
                g => g.toLowerCase() !== gameName.toLowerCase()
            );
        }
    } else {
        const games = state.settings.games_to_watch || [];
        if (!games.includes(gameName)) {
            games.push(gameName);
            state.settings.games_to_watch = games;
        }
    }

    availableGames.add(gameName);
    searchInput.value = '';
    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

function flashTitle() {
    const originalTitle = document.title;
    let count = 0;
    const interval = setInterval(() => {
        document.title = count % 2 === 0 ? '🔔 Attention!' : originalTitle;
        count++;
        if (count >= 10) {
            document.title = originalTitle;
            clearInterval(interval);
        }
    }, 1000);
}

// ==================== Automated process ====================

function sortGamesByEnding() {
    if (!state.settings || !Array.isArray(state.settings.games_to_watch)) return;

    const originalOrder = JSON.stringify(state.settings.games_to_watch);
    
    // Apply smart sorting function
    state.settings.games_to_watch = getSortedGamesArray(state.settings.games_to_watch);
    const newOrder = JSON.stringify(state.settings.games_to_watch);

    // If order changed, force render and save
    if (originalOrder !== newOrder) {
        renderGamesToWatch();
        renderChannels(); // Channels rely on watch priority, they must update too
        saveSettings();
//        console.log("Game list sorted by ending date and changes saved.");
    }
}

// Pure function - only calculates, does not mutate DOM or Trigger APIs
function getSortedGamesArray(games) {
    // FALLBACK: If campaign data is missing, return original array
    if (!state.campaigns || Object.keys(state.campaigns).length === 0) {
        console.warn("Sorting skipped: Campaign data not available yet.");
        return games; 
    }

    const campaignsArray = Object.values(state.campaigns)
        .filter(campaign => campaign.expired === false);

    const gameEndDates = {};
    campaignsArray.forEach(campaign => {
        if (campaign.ends_at) {
            const endDate = new Date(campaign.ends_at).getTime();
            if (!gameEndDates[campaign.game_name] || endDate < gameEndDates[campaign.game_name]) {
                gameEndDates[campaign.game_name] = endDate;
            }
        }
    });

    // Sort array
    return [...games].sort((a, b) => {
        const dateA = gameEndDates[a] || Infinity;
        const dateB = gameEndDates[b] || Infinity;
        
        if (dateA === Infinity && dateB === Infinity) return 0;
        return dateA - dateB;
    });
}

function applyAutoSortIfNeeded() {
//	console.log('Spouštím auto-sort ...');
    const autoSortCb = document.getElementById('auto-sort-by-end');
    // Check if the checkbox exists and is checked
    if (autoSortCb && autoSortCb.checked) {
//        console.log('Auto-sort enabled: Triggering sort automatically.');
        sortGamesByEnding();
    }
}

async function toggleGameIgnore(game, isIgnored) {
    if (!state.settings.ignored_games) {
        state.settings.ignored_games = [];
    }

    if (isIgnored) {
        if (!state.settings.ignored_games.includes(game)) {
            state.settings.ignored_games.push(game);
        }

        // Reset current drop ONLY if the currently active drop belongs to the ignored game
        if (state.currentDrop) {
            const dropGame = state.currentDrop.game_name || state.currentDrop.game || state.currentDrop.game_title;
            if (dropGame === game) {
                state.watching_channel = null;

                if (typeof clearDropProgress === 'function') {
                    clearDropProgress();
                } else {
                    state.currentDrop = null;
                }
            }
        }

        // Remove game from active RAM queues
        if (Array.isArray(state.activeCampaignsQueue)) {
            state.activeCampaignsQueue = state.activeCampaignsQueue.filter(c => (c.game_name || c.game) !== game);
        }
        if (Array.isArray(state.activeDropsQueue)) {
            state.activeDropsQueue = state.activeDropsQueue.filter(ad => (ad.game_name || ad.game) !== game);
        }
        if (Array.isArray(state.liveMiningQueue)) {
            state.liveMiningQueue = state.liveMiningQueue.filter(cid => {
                const camp = state.campaigns ? state.campaigns[cid] : null;
                return camp ? (camp.game_name || camp.game) !== game : true;
            });
        }

        // Filter out ignored game from wanted items tree
        if (Array.isArray(state.wantedItemsTree)) {
            state.wantedItemsTree = state.wantedItemsTree.filter(group => group.game_name !== game);
        }

        // Clear active UI highlight states
        if (typeof clearWantedActiveState === 'function') {
            clearWantedActiveState();
        }

    } else {
        // Remove game from ignored list
        state.settings.ignored_games = state.settings.ignored_games.filter(g => g !== game);
    }

    // Re-render UI components from current RAM state
    if (typeof renderWantedItems === 'function' && Array.isArray(state.wantedItemsTree)) {
        renderWantedItems(state.wantedItemsTree);
    }
    if (typeof renderWantedQueue === 'function') {
        renderWantedQueue();
    }
    if (typeof refreshUI === 'function') {
        refreshUI();
    }

    // Persist settings and request server synchronization
    await saveSettings();

    console.log('[WANTED] Ignore list updated. Requesting queue refresh.');
    socket.emit('get_wanted_items');
    socket.emit('get_campaigns');

    if (typeof startCombinedRotation === 'function') {
        startCombinedRotation(true);
    }
}

// Standalone function to handle auto-adding games based on user settings
function applyAutoAddIfNeeded() {
    // Guard: Do not auto-add games to games_to_watch if Ignore List mode is active
    if (state?.settings?.auto_add_all_games) {
        return;
    }

    const autoaddEl = document.getElementById('auto-add-all-games');
    if (autoaddEl && autoaddEl.checked) {
        let hasChanges = false;
        const availableArray = Array.from(availableGames);
        
        availableArray.forEach(game => {
            // Add game if it is not already in the watch list
            if (!state.settings.games_to_watch.includes(game)) {
                state.settings.games_to_watch.push(game);
                hasChanges = true;
            }
        });
        
        // Only trigger UI updates and API calls if a new game was actually added
        if (hasChanges) {
            availableGames.clear(); 
            renderGamesToWatch();
            if (typeof renderAvailableGames === 'function') {
                renderAvailableGames(Array.from(availableGames), document.getElementById('games-filter')?.value.toLowerCase() || '');
            }
            saveSettings();
            console.log("Games automatically moved to watched list:", state.settings.games_to_watch);
            updateUIState();
        }
    }
}

// ==================== API Functions ====================

async function selectChannel(channelId) {
    try {
        const response = await fetch('/api/channels/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_id: channelId })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Failed to select channel:', errorData.detail || 'Unknown error');
            addConsoleLine(`Error selecting channel: ${errorData.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Failed to select channel:', error);
        addConsoleLine(`Error selecting channel: ${error.message}`);
    }
}

async function exitManualMode() {
    try {
        const response = await fetch('/api/mode/exit-manual', {
            method: 'POST'
        });

        const result = await response.json();
        if (!result.success) {
            console.log('Exit manual mode:', result.message || 'Already in automatic mode');
        }
    } catch (error) {
        console.error('Failed to exit manual mode:', error);
        addConsoleLine(`Error exiting manual mode: ${error.message}`);
    }
}

async function submitLogin() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const token = document.getElementById('2fa-token').value;

    try {
        await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, token })
        });
    } catch (error) {
        console.error('Failed to submit login:', error);
    }
}

async function confirmOAuth() {
    // Signal that OAuth code has been entered
    try {
        await fetch('/api/oauth/confirm', {
            method: 'POST'
        });
        // Hide the OAuth form and show waiting message
        document.getElementById('oauth-code-display').style.display = 'none';
        const t = state.translations;
        const waitingAuth = t.gui?.login?.waiting_auth || 'Waiting for authentication...';
        const loginStatus = document.getElementById('login-status');
        loginStatus.textContent = waitingAuth;
        loginStatus.setAttribute('translation-key', 'waiting_auth');
    } catch (error) {
        console.error('Failed to confirm OAuth:', error);
    }
}

async function verifyProxy() {
    const proxyInput = document.getElementById('proxy-url');
    const proxyUrl = proxyInput ? proxyInput.value.trim() : '';
    const resultDiv = document.getElementById('proxy-verify-result');

    if (!resultDiv) return;

    // Reset display
    resultDiv.style.display = 'block';
    resultDiv.className = 'verify-result loading';
    resultDiv.textContent = 'Verifying connection...';

    if (!proxyUrl) {
        resultDiv.className = 'verify-result error';
        resultDiv.textContent = 'Please enter a proxy URL first.';
        return;
    }

    try {
        const response = await fetch('/api/settings/verify-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxy: proxyUrl })
        });

        const data = await response.json();

        if (data.success) {
            resultDiv.className = 'verify-result success';
            resultDiv.textContent = `✓ ${data.message}`;
        } else {
            resultDiv.className = 'verify-result error';
            resultDiv.textContent = `✗ ${data.message}`;
        }
    } catch (error) {
        resultDiv.className = 'verify-result error';
        resultDiv.textContent = `Error: ${error.message}`;
    }
}

async function saveSettings() {
    const settings = {
        dark_mode: document.getElementById('dark-mode').checked,
        language: document.getElementById('language').value,
        connection_quality: parseInt(document.getElementById('connection-quality').value),
        minimum_refresh_interval_minutes: parseInt(document.getElementById('minimum-refresh-interval').value),
        proxy: state.settings.proxy || '',
        games_to_watch: state.settings.games_to_watch || [],
        inventory_filters: getInventoryFilters(),
        auto_sort_by_end: document.getElementById('auto-sort-by-end')?.checked || false,
        mine_badges_first: document.getElementById('mine-badges-first')?.checked || false,
        auto_add_all_games: document.getElementById('auto-add-all-games')?.checked || false,
        ignored_games: state.settings.ignored_games || [],
        mining_benefits: {
            "DIRECT_ENTITLEMENT": document.getElementById('mining-benefit-item')?.checked,
            "BADGE": document.getElementById('mining-benefit-badge')?.checked,
            "EMOTE": document.getElementById('mining-benefit-emote')?.checked,
            "UNKNOWN": document.getElementById('mining-benefit-unknown')?.checked
        }
    };

    try {
        await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        console.log('Settings saved automatically');
    } catch (error) {
        console.error('Failed to save settings:', error);
    }
}

async function fetchAndPopulateLanguages() {
    try {
        const response = await fetch('/api/languages');
        const data = await response.json();

        const languageSelect = document.getElementById('language');
        if (!languageSelect) {
            console.warn('Language select element not found');
            return;
        }

        // Clear existing options
        languageSelect.innerHTML = '';

        // Populate with available languages
        data.available.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            languageSelect.appendChild(option);
        });

        // Set current language
        if (data.current) {
            languageSelect.value = data.current;
        }
    } catch (error) {
        console.error('Failed to fetch languages:', error);
        const languageSelect = document.getElementById('language');
        if (languageSelect) {
            languageSelect.replaceChildren(makeElement('option', { value: '' }, 'Failed to load languages'));
        }
        addConsoleLine('Error: Unable to fetch available languages. Please check your connection or try again later.');
    }
}

async function fetchAndApplyTranslations() {
    try {
        const response = await fetch('/api/translations');
        const data = await response.json();

        state.translations = data;
        applyTranslations(data);
//        console.log('Translations applied for language:', data.language_name);
    } catch (error) {
        console.error('Failed to fetch translations:', error);
    }
}

function applyTranslations(t) {
    // Update tab buttons
    const tabButtons = {
        'main': document.querySelector('[data-tab="main"]'),
        'inventory': document.querySelector('[data-tab="inventory"]'),
        'settings': document.querySelector('[data-tab="settings"]'),
        'help': document.querySelector('[data-tab="help"]')
    };

    if (tabButtons.main && t.gui?.tabs) tabButtons.main.textContent = t.gui.tabs.main;
    if (tabButtons.inventory && t.gui?.tabs) tabButtons.inventory.textContent = t.gui.tabs.inventory;
    if (tabButtons.settings && t.gui?.tabs) tabButtons.settings.textContent = t.gui.tabs.settings;
    if (tabButtons.help && t.gui?.tabs) tabButtons.help.textContent = t.gui.tabs.help;

    // Update Main tab - Login section
    const mainTab = document.getElementById('main-tab');
    if (mainTab && t.gui?.login) {
        const loginHeader = mainTab.querySelector('.login-panel h2');
        if (loginHeader) loginHeader.textContent = t.gui.login.name;

        const loginStatus = document.getElementById('login-status');
        if (loginStatus?.hasAttribute('translation-key')) loginStatus.textContent = t.login?.status?.[loginStatus.getAttribute('translation-key')];

        // Update login form placeholders
        const usernameInput = document.getElementById('username');
        if (usernameInput) usernameInput.placeholder = t.gui.login.username;

        const passwordInput = document.getElementById('password');
        if (passwordInput) passwordInput.placeholder = t.gui.login.password;

        const twofaInput = document.getElementById('2fa-token');
        if (twofaInput) twofaInput.placeholder = t.gui.login.twofa_code;

        const loginButton = document.getElementById('login-button');
        if (loginButton) loginButton.textContent = t.gui.login.button;

        // Update OAuth display text
        const oauthDisplay = document.getElementById('oauth-code-display');
        if (oauthDisplay) {
            const oauthP = oauthDisplay.querySelector('p');
            if (oauthP) {
                const link = oauthP.querySelector('a');
                if (link) {
                    oauthP.textContent = t.gui.login.oauth_prompt + ' ';
                    link.textContent = t.gui.login.oauth_activate;
                    oauthP.appendChild(link);
                }
            }

            const oauthConfirmBtn = document.getElementById('oauth-confirm');
            if (oauthConfirmBtn) oauthConfirmBtn.textContent = t.gui.login.oauth_confirm;
        }
    }

    // Update Progress section
    if (mainTab && t.gui?.progress) {
        // ID: progress-header
        const progressHeader = document.getElementById('progress-header');
        if (progressHeader) progressHeader.textContent = t.gui.progress.name;

        const noDropMsg = document.getElementById('no-drop-message');
        if (noDropMsg) noDropMsg.textContent = t.gui.progress.no_drop;

        const exitManualBtn = document.getElementById('exit-manual-btn');
        if (exitManualBtn) exitManualBtn.textContent = t.gui.progress.return_to_auto;
    }

    // Update Console section
    if (mainTab && t.gui) {
        // ID: console-header
        const consoleHeader = document.getElementById('console-header');
        if (consoleHeader) consoleHeader.textContent = t.gui.output;
    }

    // Update Channels section
    if (mainTab && t.gui?.channels) {
        // ID: channels-header
        const channelsHeader = document.getElementById('channels-header');
        if (channelsHeader) channelsHeader.textContent = t.gui.channels.name;
        // Channel list will re-render with translated empty messages
        renderChannels();
    }

    // Update Inventory tab
    const inventoryTab = document.getElementById('inventory-tab');
    if (inventoryTab && t.gui?.inventory) {
        // Inventory will re-render with translated status and empty messages
        renderInventory();
    }

    // Update Settings tab
    const settingsTab = document.getElementById('settings-tab');
    if (settingsTab && t.gui?.settings) {
        // Use IDs for robust selection
        const generalHeader = document.getElementById('settings-general-header');
        if (generalHeader) generalHeader.textContent = t.gui.settings.general.name;

        const benefitsHeader = document.getElementById('settings-benefits-header');
        if (benefitsHeader && t.gui.settings.mining_benefits) benefitsHeader.textContent = t.gui.settings.mining_benefits;

        const gamesHeader = document.getElementById('settings-games-header');
        if (gamesHeader) gamesHeader.textContent = t.gui.settings.games_to_watch;

        const actionsHeader = document.getElementById('settings-actions-header');
        if (actionsHeader) actionsHeader.textContent = t.gui.settings.actions;

        const darkModeLabel = settingsTab.querySelector('label:has(#dark-mode)');
        if (darkModeLabel) {
            const checkbox = darkModeLabel.querySelector('input');
            darkModeLabel.textContent = '';
            darkModeLabel.appendChild(checkbox);
            darkModeLabel.appendChild(document.createTextNode(' ' + t.gui.settings.general.dark_mode));
        }

        const connQualityLabel = settingsTab.querySelector('label:has(#connection-quality)');
        if (connQualityLabel) {
            const input = connQualityLabel.querySelector('input');
            connQualityLabel.textContent = t.gui.settings.connection_quality + ' ';
            connQualityLabel.appendChild(input);
        }

        const refreshLabel = settingsTab.querySelector('label:has(#minimum-refresh-interval)');
        if (refreshLabel) {
            const input = refreshLabel.querySelector('input');
            refreshLabel.textContent = t.gui.settings.minimum_refresh + ' ';
            refreshLabel.appendChild(input);
        }

        const benefitsHelp = document.getElementById('settings-benefits-help');
        if (benefitsHelp && t.gui.settings.mining_benefits_help) benefitsHelp.textContent = t.gui.settings.mining_benefits_help;

        const gamesHelp = document.getElementById('settings-games-help');
        if (gamesHelp) gamesHelp.textContent = t.gui.settings.games_help;

        const searchInput = document.getElementById('games-filter');
        if (searchInput) searchInput.placeholder = t.gui.settings.search_games;

        const selectAllBtn = document.getElementById('select-all-btn');
        if (selectAllBtn) selectAllBtn.textContent = t.gui.settings.select_all;

        const deselectAllBtn = document.getElementById('deselect-all-btn');
        if (deselectAllBtn) deselectAllBtn.textContent = t.gui.settings.deselect_all;

        const addGameBtn = document.getElementById('add-game-btn');
        if (addGameBtn && t.gui.settings.add_game) addGameBtn.textContent = t.gui.settings.add_game;

        const selectedGamesHeader = settingsTab.querySelector('.selected-games h3');
        if (selectedGamesHeader) selectedGamesHeader.textContent = t.gui.settings.selected_games;

        const availableGamesHeader = settingsTab.querySelector('.available-games h3');
        if (availableGamesHeader) availableGamesHeader.textContent = t.gui.settings.available_games;

		const reloadBtn = document.getElementById('reload-btn');

		if (reloadBtn) {
			reloadBtn.textContent = t.gui.settings.reload_campaigns;
			reloadBtn.addEventListener('click', () => {
				saveSettings();			
				reloadBtn.disabled = true;
				const originalText = reloadBtn.textContent;
				reloadBtn.textContent = "Reloading..."; 				
				socket.emit('reload_campaigns');				
				setTimeout(() => { 
					reloadBtn.disabled = false; 
					reloadBtn.textContent = originalText;
				}, 30000);
			});
		}
        // Re-render games to watch with translated empty messages
        renderGamesToWatch();
    }

    // Update Help tab
    const helpTab = document.getElementById('help-tab');
    if (helpTab && t.gui?.help) {
        // Robust ID selection for Help tab headers
        const aboutHeader = document.getElementById('help-about-header');
        if (aboutHeader) aboutHeader.textContent = t.gui.help.about || 'About Twitch Drops Miner';

        const howtoHeader = document.getElementById('help-howto-header');
        if (howtoHeader) howtoHeader.textContent = t.gui.help.how_to_use || 'How to Use';

        const featuresHeader = document.getElementById('help-features-header');
        if (featuresHeader) featuresHeader.textContent = t.gui.help.features || 'Features';

        const notesHeader = document.getElementById('help-notes-header');
        if (notesHeader) notesHeader.textContent = t.gui.help.important_notes || 'Important Notes';

        // Update list items and links (keeping innerHTML approach for lists as they are dynamic content blocks)
        const helpContent = helpTab.querySelector('.help-content');
        if (helpContent) {
            const howToItems = t.gui.help.how_to_use_items || [
                'Login using your Twitch account (OAuth device code flow)',
                'Link your accounts at <a href="https://www.twitch.tv/drops/campaigns" target="_blank">twitch.tv/drops/campaigns</a>',
                'The miner will automatically discover campaigns and start mining',
                'Configure priority games in Settings to focus on what you want',
                'Monitor progress in the Main and Inventory tabs'
            ];
            const featuresItems = t.gui.help.features_items || [
                'Stream-less drop mining - saves bandwidth',
                'Game priority and exclusion lists',
                'Tracks up to 199 channels simultaneously',
                'Automatic channel switching',
                'Real-time progress tracking'
            ];
            const notesItems = t.gui.help.important_notes_items || [
                'Do not watch streams on the same account while mining',
                'Keep your cookies.jar file secure',
                'Requires linked game accounts for drops'
            ];

            helpContent.replaceChildren(
                makeElement('h2', { id: 'help-about-header' }, t.gui.help.about || 'About Twitch Drops Miner'),
                makeElement('p', {}, t.gui.help.about_text || 'This application automatically mines timed Twitch drops without downloading stream data.'),
                makeElement('h3', { id: 'help-howto-header' }, t.gui.help.how_to_use || 'How to Use'),
                makeHelpList('ol', howToItems),
                makeElement('h3', { id: 'help-features-header' }, t.gui.help.features || 'Features'),
                makeHelpList('ul', featuresItems),
                makeElement('h3', { id: 'help-notes-header' }, t.gui.help.important_notes || 'Important Notes'),
                makeHelpList('ul', notesItems),
                makeElement('div', { class: 'help-links' }, '', el =>
                    el.appendChild(makeElement('a', { href: 'https://github.com/rangermix/TwitchDropsMiner', target: '_blank', rel: 'noopener noreferrer' }, t.gui.help.github_repo || 'GitHub Repository'))
                ),
            );
        }
    }

    // Update Footer
    if (t.gui?.footer) {
        const loadingText = t.gui.footer.loading || 'Loading...';
        const currentVersionEl = document.getElementById('current-version');
        // Only update if it's the specific "Loading..." text to avoid overwriting the fetched version
        if (currentVersionEl && currentVersionEl.textContent === 'Loading...') {
            currentVersionEl.textContent = loadingText;
        }

        const footerVersionText = document.getElementById('footer-version-text');
        if (footerVersionText) {
            const versionLabel = t.gui.footer.version || 'Version:';
            const span = document.getElementById('current-version'); // Need to re-fetch or preserve
            footerVersionText.textContent = versionLabel + ' ';
            // Re-finding the span because textContent wiped it from parent
            if (span) footerVersionText.appendChild(span);
        }
    }

    // Update Badges tooltips
    if (t.gui?.badges) {
        const manualBadge = document.getElementById('manual-mode-badge');
        if (manualBadge && t.gui.badges.manual) manualBadge.title = t.gui.badges.manual.title;

        const autoBadge = document.getElementById('auto-mode-badge');
        if (autoBadge && t.gui.badges.auto) autoBadge.title = t.gui.badges.auto.title;

        const proxyBadge = document.getElementById('proxy-indicator');
        if (proxyBadge && t.gui.badges.proxy) proxyBadge.title = t.gui.badges.proxy.title; // Note: append logic in updateSettingsUI overrides this
    }

    // Update Wanted Drops Panel
    if (mainTab && t.gui?.wanted) {
        // ID: wanted-header
        const wantedHeader = document.getElementById('wanted-header');
        if (wantedHeader) wantedHeader.textContent = t.gui.wanted.name;
        // Re-render wanted items to update empty message
        // Since we don't store wanted items in state globally (only receives them), we rely on updateWantedItems triggering render
    }

    // Update Inventory Filters (re-using existing inventoryTab variable if available, or just querying)
    // Note: inventoryTab was declared above in "Update Inventory Status" section
    // But since that might be in a different block or not, let's be safe and just query element directly without const redeclaration if it conflicts.
    // However, looking at the code, the previous declaration was likely in the same function scope.
    // Simplest fix: use the existing element or re-query without 'const' if needed, but best to just use the one we have.
    // Actually, looking at the view_file, there was 'const inventoryTab' around line 1639.
    // So I should just reuse that variable or use a different name.

    if (inventoryTab && t.gui?.inventory?.filters) {
        const f = t.gui.inventory.filters;
        const updateLabel = (id, text) => {
            const el = document.getElementById(id)?.parentElement.querySelector('span');
            if (el) el.textContent = text;
        };
        updateLabel('filter-active', f.active);
        updateLabel('filter-not-linked', f.not_linked);
        updateLabel('filter-upcoming', f.upcoming);
        updateLabel('filter-expired', f.expired);
        updateLabel('filter-finished', f.finished);
        updateLabel('filter-benefit-item', f.item);
        updateLabel('filter-benefit-badge', f.badge);
        updateLabel('filter-benefit-emote', f.emote);
        updateLabel('filter-benefit-other', f.other);
        updateLabel('hide-complete-events', f.hide_completed_events);

        const clearBtn = document.getElementById('clear-filters-btn');
        if (clearBtn) clearBtn.textContent = f.clear;

        const searchInput = document.getElementById('games-filter');
        if (searchInput) searchInput.placeholder = f.search_placeholder;

        // Update Mining Benefit Labels in Settings (re-using inventory filter keys)
        // IDs: mining-benefit-item, mining-benefit-badge, mining-benefit-emote, mining-benefit-unknown
        updateLabel('mining-benefit-item', f.item);
        updateLabel('mining-benefit-badge', f.badge);
        updateLabel('mining-benefit-emote', f.emote);
        updateLabel('mining-benefit-unknown', f.other);
    }

    // Update header elements
    if (t.gui?.header) {
        const languageLabel = document.querySelector('.language-selector span');
        if (languageLabel) languageLabel.textContent = t.gui.header.language;

        const statusText = document.getElementById('status-text');
        if (statusText && statusText.textContent === 'Initializing...') {
            statusText.textContent = t.gui.header.initializing;
        }

        // Update connection indicator
        const connIndicator = document.getElementById('connection-indicator');
        if (connIndicator) {
            if (state.connected) {
                connIndicator.textContent = '● ' + (t.gui.websocket.connected || 'Connected');
            } else {
                connIndicator.textContent = '● ' + (t.gui.websocket.disconnected || 'Disconnected');
            }
        }
    }
}

async function reloadCampaigns() {
    try {
        await fetch('/api/reload', { method: 'POST' });
        // Status will update via Socket.IO when backend starts operation
    } catch (error) {
        console.error('Failed to reload:', error);
    }
}


// ==================== Tab and Button Management ====================

function switchTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });

    // Show selected tab
    document.getElementById(`${tabName}-tab`).classList.add('active');
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
}

function updateUIState() {
    const isAutoAddEnabled = document.getElementById('auto-add-all-games')?.checked;

    // 1. Vypnutí tlačítek pro hromadný výběr
    const buttons = [
        document.getElementById('select-all-btn'), 
        document.getElementById('deselect-all-btn')
    ];
    
    buttons.forEach(btn => {
        if (btn) btn.disabled = isAutoAddEnabled;
    });

    // 2. Vypnutí jednotlivých checkboxů her
    // Předpokládám, že tvoje checkboxy mají třídu 'game-checkbox'
    // Pokud mají jinou, uprav ten selektor
    document.querySelectorAll('.game-checkbox').forEach(cb => {
        cb.disabled = isAutoAddEnabled;
    });
}

// ==================== Event Listeners ====================

document.addEventListener('DOMContentLoaded', () => {
    // Fetch and display version information
    fetchAndDisplayVersion();

    // Tab switching
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => {
            switchTab(button.dataset.tab);
        });
    });

    // Login form
    document.getElementById('login-button').addEventListener('click', submitLogin);
    document.getElementById('oauth-confirm').addEventListener('click', confirmOAuth);

    // Settings - auto-save on change
    document.getElementById('dark-mode').addEventListener('change', (e) => {
        // Apply dark mode immediately for instant feedback
        if (e.target.checked) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
        // Then save settings
        saveSettings();
    });
    
    // Auto-sort checkbox management
    const autoSortEl = document.getElementById('auto-sort-by-end');
    if (autoSortEl) {
        autoSortEl.addEventListener('change', (e) => {
            // Save the updated auto-sort state to the API
            saveSettings();
            
            // If the user enabled auto-sort, trigger the sorting function immediately
            if (e.target.checked) {
                sortGamesByEnding();
            }
        });
    }

	// Auto-add / Ignore List toggle management
	document.getElementById('auto-add-all-games')?.addEventListener('change', async (e) => {
		const isChecked = e.target.checked;

		if (state && state.settings) {
			state.settings.auto_add_all_games = isChecked;
		}

		if (typeof renderGamesToWatch === 'function') {
			renderGamesToWatch();
		}

		await saveSettings();
	});
		
    document.getElementById('mine-badges-first').addEventListener('change', saveSettings);
    document.getElementById('language').addEventListener('change', saveSettings);
    document.getElementById('connection-quality').addEventListener('change', saveSettings);
    document.getElementById('minimum-refresh-interval').addEventListener('change', saveSettings);

    // Proxy uses a manual "Set Proxy" button instead of auto-save
    document.getElementById('set-proxy-btn').addEventListener('click', () => {
        const proxyInput = document.getElementById('proxy-url');
        const newValue = proxyInput ? proxyInput.value : '';

        // Only save if changed
        if (newValue !== (state.settings.proxy || '')) {
            state.settings.proxy = newValue;
            saveSettings();
            updateUIState();
        }
    });
    
    document.getElementById('verify-proxy-btn').addEventListener('click', verifyProxy);
    document.getElementById('reload-btn').addEventListener('click', reloadCampaigns);

    // Games to watch management
    document.getElementById('select-all-btn').addEventListener('click', selectAllGames);
    document.getElementById('deselect-all-btn').addEventListener('click', deselectAllGames);
    document.getElementById('add-game-btn').addEventListener('click', addGameFromSearch);
    document.getElementById('sort-by-end-btn').addEventListener('click', sortGamesByEnding);
    document.getElementById('games-filter').addEventListener('input', renderGamesToWatch);

    // Inventory filters
    document.getElementById('filter-active').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-not-linked').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-upcoming').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-expired').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-finished').addEventListener('change', onInventoryFilterChange);

    // Benefit type filters
    document.getElementById('filter-benefit-item').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-benefit-badge').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-benefit-emote').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-benefit-other').addEventListener('change', onInventoryFilterChange);
    document.getElementById('clear-filters-btn').addEventListener('click', clearInventoryFilters);

    // Mining benefit settings
    document.getElementById('mining-benefit-item').addEventListener('change', saveSettings);
    document.getElementById('mining-benefit-badge').addEventListener('change', saveSettings);
    document.getElementById('mining-benefit-emote').addEventListener('change', saveSettings);
    document.getElementById('mining-benefit-unknown').addEventListener('change', saveSettings);

    // Inventory game search dropdown
    const gameSearchInput = document.getElementById('inventory-game-search');
    if (gameSearchInput) {
        gameSearchInput.addEventListener('focus', () => {
            showGameDropdown();
        });
        gameSearchInput.addEventListener('input', (e) => {
            renderGameDropdown(e.target.value);
        });
        gameSearchInput.addEventListener('keydown', handleGameSearchKeydown);
    }

    // Click outside to close dropdown
    document.addEventListener('click', (e) => {
        const container = document.querySelector('.game-dropdown-container');
        if (container && !container.contains(e.target) && gameDropdownVisible) {
            closeGameDropdown();
        }
    });

    // Manual mode controls
    const exitManualBtn = document.getElementById('exit-manual-btn');
    if (exitManualBtn) {
        exitManualBtn.addEventListener('click', exitManualMode);
    }

    // Fetch and populate available languages
    fetchAndPopulateLanguages();

    // Fetch and apply translations for the current language
    fetchAndApplyTranslations();

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
});

// ==================== DOM Utilities ====================

const TRUSTED_HELP_LINKS = new Set(['https://www.twitch.tv/drops/campaigns']);

/**
 * @param {string} tag
 * @param {Record<string, string|number|boolean>} attrs
 * @param {string|number|null} text
 * @param {(el: HTMLElement) => void|null} callback
 */
function makeElement(tag, attrs = {}, text = null, callback = null) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
    if (text !== null && text !== undefined) {
        el.textContent = String(text);
    }
    if (callback) {
        callback(el);
    }
    return el;
}

function makeImageElement(src, alt, className) {
    const image = makeElement('img', { src, alt, class: className });
    image.onerror = () => {
        image.style.display = 'none';
    };
    return image;
}

function makeHelpList(tag, items) {
    return makeElement(tag, {}, null, list => {
        items.forEach(item => {
            list.appendChild(makeElement('li', {}, null, li => appendTrustedHelpContent(li, item)));
        });
    });
}

function appendTrustedHelpContent(parent, text) {
    const source = String(text);
    const linkPattern = /<a\b[^>]*\bhref=(["'])(https:\/\/www\.twitch\.tv\/drops\/campaigns)\1[^>]*>(.*?)<\/a>/gi;
    let lastIndex = 0;
    let match;
    let matched = false;

    while ((match = linkPattern.exec(source)) !== null) {
        matched = true;
        if (match.index > lastIndex) {
            parent.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
        }
        const href = match[2];
        if (TRUSTED_HELP_LINKS.has(href)) {
            parent.appendChild(makeElement('a', { href, target: '_blank', rel: 'noopener noreferrer' }, match[3]));
        } else {
            parent.appendChild(document.createTextNode(match[0]));
        }
        lastIndex = linkPattern.lastIndex;
    }

    if (!matched) {
        parent.textContent = source;
        return;
    }

    if (lastIndex < source.length) {
        parent.appendChild(document.createTextNode(source.slice(lastIndex)));
    }
}


function getStatusIconSVG(statusClass) {
    const icons = {
        // Drops
        'completed': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
        'ready': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`,
        'drop-claimed': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
        // Změněno na ikonu dárku pro "Ready"
        'drop-ready': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`,
        // Změněno na křížek v kroužku
        'drop-expired': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`,
        'drop-active': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        
        // Kampaně
        'active': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        'upcoming': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        'expired': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`
    };
    return icons[statusClass] || '';
}
