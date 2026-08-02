// ==================== Games to Watch / Ignore Management ====================

let renderGamesDebounceTimer = null;

function renderGamesToWatch() {
    if (renderGamesDebounceTimer) {
        clearTimeout(renderGamesDebounceTimer);
    }
    
    renderGamesDebounceTimer = setTimeout(() => {
        renderGamesDebounceTimer = null;
        _performRenderGamesToWatch();
    }, 150);
}

function _performRenderGamesToWatch() {
    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);
    
    const leftHeading = document.querySelector('.available-games h3');
    const rightHeading = document.querySelector('.selected-games h3');

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

    const searchInput = document.getElementById('games-filter');
    const filterText = searchInput ? searchInput.value.toLowerCase() : '';

    if (isIgnoreMode) {
        const ignoredGames = state?.settings?.ignored_games || [];
        ignoredGames.forEach(game => availableGames.add(game));

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
    console.debug('[Game List] Games rendered (debounced). Ignore mode:', isIgnoreMode);
}

function renderSelectedGames(games) {
    const container = document.getElementById('selected-games-list');
    if (!container) return;

    const t = state.translations;
    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);
    
    container.innerHTML = '';

    if (!games || games.length === 0) {
        const emptyMsg = isIgnoreMode
            ? (t.gui?.settings?.no_games_ignored || 'No games on ignore list.')
            : (t.gui?.settings?.no_games_selected || 'No games selected. Check games below to add them.');
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
        return;
    }

    const fragment = document.createDocumentFragment();

    games.forEach((game, index) => {
        const div = document.createElement('div');
        div.className = 'sortable-item';
        div.dataset.game = game;

        if (isIgnoreMode) {
            div.draggable = false;
            div.replaceChildren(
                makeElement('span', { class: 'game-name', style: 'flex-grow: 1;' }, game),
                makeElement('button', { class: 'remove-btn', title: 'Remove from Ignore List' }, '✕')
            );
        } else {
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
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                removeGameFromWatch(game);
            });
        }

        fragment.appendChild(div);
    });

    container.appendChild(fragment);
}

function renderAvailableGames(games, filterText) {
    const container = document.getElementById('available-games-list');
    if (!container) return;

    const t = state.translations;
    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);

    container.innerHTML = '';

    if (!games || games.length === 0) {
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

    const fragment = document.createDocumentFragment();

    games.forEach(game => {
        const label = document.createElement('label');
        label.className = 'game-checkbox';

        if (isIgnoreMode) {
            const ignoreBtn = makeElement('button', { class: 'remove-btn', style: 'margin-right: 8px;', title: 'Add to Ignore List' }, '🚫');
            ignoreBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (typeof toggleGameIgnore === 'function') {
                    toggleGameIgnore(game, true);
                } else {
                    if (!state.settings) state.settings = {};
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
            const isChecked = (state?.settings?.games_to_watch || []).includes(game);
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

        fragment.appendChild(label);
    });

    container.appendChild(fragment);
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

    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);
    if (isIgnoreMode) return;

    const container = document.getElementById('selected-games-list');
    if (!container) return;

    const items = container.querySelectorAll('.sortable-item');
    const newOrder = Array.from(items).map(item => item.dataset.game);

    if (state.settings) {
        state.settings.games_to_watch = newOrder;
    }

    renderSelectedGames(newOrder);
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
    console.debug('[Game List] Priority order updated via drag-and-drop.');
}

let watchSaveTimeout = null;

function toggleGameWatch(gameName, checked) {
    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);
    if (isIgnoreMode) return;

    if (!state.settings) state.settings = {};
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
    console.debug('[Game List] Toggled watch status:', gameName, 'Checked:', checked);

    // 1. Okamžitá lokální aktualizace rozhraní (Optimistic UI)
    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();

    // 2. Buffer / Debounce pro uložení na server (počká 1 sekundu na případné další kliknutí)
    if (watchSaveTimeout) {
        clearTimeout(watchSaveTimeout);
    }

    watchSaveTimeout = setTimeout(() => {
        console.debug('[Game List] Flushing watch settings to server...');
        saveSettings();
    }, 1000);
}

function removeGameFromWatch(gameName) {
    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);

    if (isIgnoreMode) {
        if (typeof toggleGameIgnore === 'function') {
            toggleGameIgnore(gameName, false);
            return;
        }
    } else {
        if (!state.settings) state.settings = {};
        const games = state.settings.games_to_watch || [];
        const index = games.indexOf(gameName);
        if (index > -1) {
            games.splice(index, 1);
            state.settings.games_to_watch = games;
        }
    }

    console.debug('[Game List] Removed game from watch/ignore list:', gameName);
    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

function selectAllGames() {
    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);
    if (!state.settings) state.settings = {};

    if (isIgnoreMode) {
        state.settings.ignored_games = [];
    } else {
        state.settings.games_to_watch = Array.from(availableGames).sort();
    }

    console.debug('[Game List] Selected all games.');
    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

function deselectAllGames() {
    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);
    if (!state.settings) state.settings = {};

    if (isIgnoreMode) {
        state.settings.ignored_games = Array.from(availableGames).sort();
    } else {
        state.settings.games_to_watch = [];
    }

    console.debug('[Game List] Deselected all games.');
    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

function addGameFromSearch() {
    const searchInput = document.getElementById('games-filter');
    if (!searchInput) return;

    const gameName = searchInput.value.trim();
    if (!gameName) return;

    const isIgnoreMode = Boolean(state?.settings?.auto_add_all_games);
    if (!state.settings) state.settings = {};

    if (isIgnoreMode) {
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
    console.debug('[Game List] Added game manually:', gameName);
    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    saveSettings();
}

let settingsSaveTimeout = null;

async function toggleGameIgnore(game, isIgnored) {
    if (!state.settings) state.settings = {};
    if (!state.settings.ignored_games) {
        state.settings.ignored_games = [];
    }

    if (isIgnored) {
        if (!state.settings.ignored_games.includes(game)) {
            state.settings.ignored_games.push(game);
        }

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

        if (Array.isArray(state.wantedItemsTree)) {
            state.wantedItemsTree = state.wantedItemsTree.filter(group => group.game_name !== game);
        }

        if (typeof clearWantedActiveState === 'function') {
            clearWantedActiveState();
        }

    } else {
        state.settings.ignored_games = state.settings.ignored_games.filter(g => g !== game);
    }

    // 1. Okamžitá lokální aktualizace rozhraní (Optimistic UI)
    if (typeof renderGamesToWatch === 'function') {
        renderGamesToWatch();
    }
    if (typeof renderWantedItems === 'function' && Array.isArray(state.wantedItemsTree)) {
        renderWantedItems(state.wantedItemsTree);
    }
    if (typeof renderWantedQueue === 'function') {
        renderWantedQueue();
    }
    if (typeof refreshUI === 'function') {
        refreshUI();
    }

    console.debug('[Game List] Updated game ignore status locally:', game, 'IsIgnored:', isIgnored);

    // 2. Buffer / Debounce pro uložení na server (zkráceno na 1000ms pro svižnější odezvu)
    if (settingsSaveTimeout) {
        clearTimeout(settingsSaveTimeout);
    }

    settingsSaveTimeout = setTimeout(async () => {
        console.debug('[Game List] Flushing batched ignore settings to server...');
        await saveSettings();

        if (typeof startCombinedRotation === 'function') {
            startCombinedRotation(true);
        }
    }, 1000); 
}
