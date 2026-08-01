// ============================================================================
// 1. SOCKET INITIALIZATION & DEBUG SETUP//////////////////////////////////////
// ============================================================================

const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

// Helper check for debug mode (window.DEBUG, state.debug, or URL query param ?debug)
const isDebugEnabled = () => {
    if (typeof window !== 'undefined') {
        if (window.DEBUG || (typeof state !== 'undefined' && state.debug)) return true;
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('debug')) return true;
    }
    return false;
};

// Global debug listener for incoming socket events
if (typeof socket.onAny === 'function') {
    socket.onAny((eventName, ...args) => {
        if (isDebugEnabled()) {
            console.log(`[Socket DEBUG] Incoming Event: '${eventName}'`, args);
        }
    });
}


// ============================================================================
// 2. SOCKET EVENT HANDLERS
// ============================================================================

// ----------------------------------------------------------------------------
// 🟢 Connection & Status Events
// ----------------------------------------------------------------------------

socket.on('connect', () => handleConnect());
socket.on('disconnect', (reason) => handleDisconnect(reason));
socket.on('connect_error', (error) => handleConnectError(error));
socket.on('status_update', (data) => handleStatusUpdate(data));


// ----------------------------------------------------------------------------
// 📦 Core Data & Campaign Sync Events
// ----------------------------------------------------------------------------

socket.on('initial_state', (data) => handleInitialState(data));
socket.on('wanted_items_update', (data) => handleWantedItemsUpdate(data));
socket.on('drop_progress', (data) => handleDropProgress(data));
socket.on('drop_progress_stop', () => clearDropProgress());
socket.on('campaign_add', (data) => handleCampaignAdd(data));
socket.on('inventory_clear', () => clearInventory());
socket.on('inventory_batch_update', (data) => handleInventoryBatchUpdate(data));
socket.on('games_available', (data) => handleGamesAvailable(data));


// ----------------------------------------------------------------------------
// 📺 Channels & Console Events
// ----------------------------------------------------------------------------

socket.on('console_output', (data) => addConsoleLine(data.message));
socket.on('channel_add', (data) => updateChannel(data));
socket.on('channel_update', (data) => updateChannel(data));
socket.on('channel_remove', (data) => removeChannel(data.id));
socket.on('channels_clear', () => clearChannels());
socket.on('channels_batch_update', (data) => handleChannelsBatchUpdate(data));
socket.on('channel_watching', (data) => setWatchingChannel(data.id));
socket.on('channel_watching_clear', () => clearWatchingChannel());


// ----------------------------------------------------------------------------
// ⚙️ Settings, Auth & Language Events
// ----------------------------------------------------------------------------

socket.on('login_required', () => showLoginForm());
socket.on('oauth_code_required', (data) => showOAuthCode(data.url, data.code));
socket.on('login_status', (data) => updateLoginStatus(data));
socket.on('login_clear', (data) => handleLoginClear(data));
socket.on('settings_updated', (data) => handleSettingsUpdated(data));
socket.on('manual_mode_update', (data) => updateManualModeUI(data));
socket.on('language_changed', (data) => handleLanguageChanged(data));


// ----------------------------------------------------------------------------
// 🎨 Theme & Notification Events
// ----------------------------------------------------------------------------

socket.on('theme_change', (data) => handleThemeChange(data));
socket.on('notification', (data) => handleNotification(data));
socket.on('attention_required', (data) => handleAttentionRequired(data));


// ============================================================================
// 3. HELPER & UTILITY FUNCTIONS
// ============================================================================

// ----------------------------------------------------------------------------
// 🟢 Connection & Status Handlers
// ----------------------------------------------------------------------------

/**
 * Handles successful socket connection.
 */
function handleConnect() {
    if (isDebugEnabled()) {
        console.log('[Socket DEBUG] Connected with socket ID:', socket.id);
    } else {
        console.log('Connected to server');
    }
    state.connected = true;
    const connText = state.translations.gui?.websocket?.connected || 'Connected';
    document.getElementById('connection-indicator').textContent = '● ' + connText;
    document.getElementById('connection-indicator').className = 'connected';
}

/**
 * Handles socket disconnection.
 */
function handleDisconnect(reason) {
    if (isDebugEnabled()) {
        console.warn('[Socket DEBUG] Disconnected reason:', reason);
    } else {
        console.log('Disconnected from server');
    }
    state.connected = false;
    const disconnText = state.translations.gui?.websocket?.disconnected || 'Disconnected';
    document.getElementById('connection-indicator').textContent = '● ' + disconnText;
    document.getElementById('connection-indicator').className = 'disconnected';
}

/**
 * Handles socket connection errors.
 */
function handleConnectError(error) {
    if (isDebugEnabled()) {
        console.error('[Socket DEBUG] Connection error:', error);
    }
}

/**
 * Handles status update payload from server.
 */
function handleStatusUpdate(data) {
    if (data && data.status) {
        updateStatus(data.status);
    }
}


// ----------------------------------------------------------------------------
// 📦 Core Data & Campaign Sync Handlers
// ----------------------------------------------------------------------------

/**
 * Handles initial state payload received from server.
 */
function handleInitialState(data) {
    console.log('[SOCKET] Received initial state', data);

    if (data.settings && typeof state !== 'undefined') {
        state.settings = { ...state.settings, ...data.settings };
    }

    data = filterIgnoredData(data);

    try { if (data.status && typeof updateStatus === 'function') updateStatus(data.status); } catch (e) { console.error("[INIT_ERR] Status:", e); }
    try { handleInitialWantedItems(data.wanted_items); } catch (e) { console.error("[INIT_ERR] Wanted:", e); }
    try { handleInitialChannels(data.channels); } catch (e) { console.error("[INIT_ERR] Channels:", e); }

    try {
        if (data.campaigns) {
            state.campaigns = {};
            const campList = Array.isArray(data.campaigns) ? data.campaigns : Object.values(data.campaigns);
            campList.forEach(camp => {
                if (camp && camp.id) state.campaigns[camp.id] = camp;
            });
            if (typeof renderInventory === 'function') renderInventory();
        }
    } catch (e) { console.error("[INIT_ERR] Campaigns:", e); }

    try {
        if (data.console && typeof document !== 'undefined') {
            const consoleEl = document.getElementById('console-output');
            if (consoleEl && Array.isArray(data.console)) {
                const fragment = document.createDocumentFragment();
                data.console.forEach(line => {
                    const div = document.createElement('div');
                    div.textContent = line;
                    fragment.appendChild(div);
                });
                consoleEl.appendChild(fragment);
                consoleEl.scrollTop = consoleEl.scrollHeight;
                while (consoleEl.children.length > 1000) {
                    consoleEl.removeChild(consoleEl.firstChild);
                }
            }
        }
    } catch (e) { console.error("[INIT_ERR] Console:", e); }

    try { if (data.settings && typeof updateSettingsUI === 'function') updateSettingsUI(data.settings); } catch (e) { console.error("[INIT_ERR] Settings:", e); }
    try { if (data.login && typeof updateLoginStatus === 'function') updateLoginStatus(data.login); } catch (e) { console.error("[INIT_ERR] Login:", e); }
    try { if (data.manual_mode && typeof updateManualModeUI === 'function') updateManualModeUI(data.manual_mode); } catch (e) { console.error("[INIT_ERR] ManualMode:", e); }

    try { handleInitialCurrentDrop(data.current_drop, data.status); } catch (e) { console.error("[INIT_ERR] Drop:", e); }

    try {
        const autosortEl = document.getElementById('auto-sort-by-end');
        if (autosortEl && data.settings) {
            autosortEl.checked = !!data.settings.auto_sort_by_end;
            if (typeof applyAutoSortIfNeeded === 'function') applyAutoSortIfNeeded();
        }

        if (data.settings && typeof syncAutoAddUI === 'function') {
            syncAutoAddUI(data.settings);
        }

        if (typeof startCombinedRotation === 'function') {
            startCombinedRotation(true);
        }
    } catch (e) { console.error("[INIT_ERR] Rotation:", e); }
}

/**
 * Handles wanted items update filtering out ignored games.
 */
function handleWantedItemsUpdate(data) {
    let filteredData = data;
    if (Array.isArray(data)) {
        filteredData = data.filter(item => !isGameIgnored(item.game_name || item.game));
    }
    renderWantedItems(filteredData);
}

/**
 * Handles live drop progress updates.
 */
function handleDropProgress(data) {
    const gameName = data.game_name || data.game || data.game_title;
    if (isGameIgnored(gameName)) {
        if (typeof clearDropProgress === 'function') clearDropProgress();
        return;
    }

    const dropId = data.drop_id || data.id;
    if (dropId) {
        syncAnyDropProgress(String(dropId), data);
    }

    if (typeof updateDropProgress === 'function') {
        updateDropProgress(data);
    }
}

/**
 * Handles adding a single campaign.
 */
function handleCampaignAdd(data) {
    const gameName = data.game_name || data.game;
    if (!isGameIgnored(gameName)) {
        addCampaign(data);
    }
}

/**
 * Handles batch inventory updates.
 */
function handleInventoryBatchUpdate(data) {
    state.campaigns = {};
    const filtered = (data.campaigns || []).filter(c => !isGameIgnored(c.game_name || c.game));
    filtered.forEach(camp => {
        state.campaigns[camp.id] = camp;
    });
    renderInventory();
    applyAutoSortIfNeeded();
}

/**
 * Handles available games payload.
 */
function handleGamesAvailable(data) {
    availableGames = new Set(data.games || []);
    renderGamesToWatch();
    applyAutoAddIfNeeded();
}


// ----------------------------------------------------------------------------
// 📺 Channels & UI Handlers
// ----------------------------------------------------------------------------

/**
 * Handles batch channels updates.
 */
function handleChannelsBatchUpdate(data) {
    state.channels = {};
    if (Array.isArray(data.channels)) {
        data.channels.forEach(ch => {
            state.channels[ch.id] = ch;
        });
    }
    renderChannels();
}


// ----------------------------------------------------------------------------
// ⚙️ Settings, Auth & Theme Handlers
// ----------------------------------------------------------------------------

/**
 * Handles login credentials reset in UI.
 */
function handleLoginClear(data) {
    if (data.login) document.getElementById('username').value = '';
    if (data.password) document.getElementById('password').value = '';
    if (data.token) document.getElementById('2fa-token').value = '';
}

/**
 * Handles settings update confirmation from server.
 */
function handleSettingsUpdated(data) {
    if (typeof state !== 'undefined') {
        state.settings = { ...state.settings, ...data };
    }
    updateSettingsUI(data);

    if (data.auto_sort_by_end) {
        sortGamesByEnding();
    }
}

/**
 * Handles UI language change.
 */
function handleLanguageChanged(data) {
    console.log('Language changed to:', data.language);
    fetchAndApplyTranslations();
}

/**
 * Handles theme toggle.
 */
function handleThemeChange(data) {
    if (data.dark_mode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
}

/**
 * Handles browser desktop notification.
 */
function handleNotification(data) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(data.title, {
            body: data.message,
            icon: '/static/icon.png'
        });
    }
}

/**
 * Handles visual/audio attention requests.
 */
function handleAttentionRequired(data) {
    if (data.sound) {
        const audio = new Audio('/static/notification.mp3');
        audio.play().catch(() => { });
    }
    flashTitle();
}


// ----------------------------------------------------------------------------
// 🛠️ Ignore List & State Utilities
// ----------------------------------------------------------------------------

/**
 * Checks whether a game is present in the ignore list.
 */
function isGameIgnored(gameName) {
    if (!gameName || typeof state === 'undefined' || !state.settings || !Array.isArray(state.settings.ignored_games)) {
        return false;
    }
    return state.settings.ignored_games.includes(gameName);
}

/**
 * Filters out ignored games from incoming socket data payloads.
 */
function filterIgnoredData(data) {
    if (!data || typeof state === 'undefined' || !state.settings || !Array.isArray(state.settings.ignored_games)) {
        return data;
    }
    const ignored = state.settings.ignored_games;
    if (ignored.length === 0) return data;

    if (data.current_drop) {
        const dropGame = data.current_drop.game_name || data.current_drop.game || data.current_drop.game_title;
        if (ignored.includes(dropGame)) {
            data.current_drop = null;
        }
    }

    if (Array.isArray(data.campaigns)) {
        data.campaigns = data.campaigns.filter(c => {
            const cGame = c.game_name || c.game || c.game_title;
            return !ignored.includes(cGame);
        });
    }

    if (Array.isArray(data.wanted_items)) {
        data.wanted_items = data.wanted_items.filter(item => {
            const gName = item.game_name || item.game;
            return !ignored.includes(gName);
        });
    }

    return data;
}

/**
 * Updates status display and triggers UI refreshes.
 */
function updateStatus(status) {
    const statusEl = document.getElementById('status-text');
    if (statusEl) {
        statusEl.textContent = status;
    }

    if (typeof renderWantedQueue === 'function') {
        renderWantedQueue();
    }
    if (typeof refreshUI === 'function') {
        refreshUI();
    }
}

/**
 * Synchronizes auto-add UI state and settings checkboxes.
 */
function syncAutoAddUI(settings) {
    if (!settings) return;

    const autoaddEl = document.getElementById('auto-add-all-games');
    if (autoaddEl) {
        autoaddEl.checked = Boolean(settings.auto_add_all_games);
    }

    if (typeof renderGamesToWatch === 'function') {
        renderGamesToWatch();
    }
}

/**
 * Clears campaigns from global state and re-renders inventory.
 */
function clearInventory() {
    state.campaigns = {};
    if (typeof renderInventory === 'function') renderInventory();
}
