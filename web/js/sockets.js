///////////////////////////////////////////////////////////////////////////////
// SOCKETS MODULE - INITIALIZATION, BINDINGS & EVENT HANDLERS
///////////////////////////////////////////////////////////////////////////////

// ============================================================================
// 1. STATE & DEBUG SETUP
// ============================================================================

let isAdminSyncScheduled = false;
let isDebugCached = null;

const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

/**
 * Checks whether debug logging is enabled via URL param or global state
 */
const isDebugEnabled = () => {
    if (isDebugCached !== null) return isDebugCached;
    if (typeof window !== 'undefined') {
        if (window.DEBUG || (typeof state !== 'undefined' && state.debug)) {
            isDebugCached = true;
            return true;
        }
        isDebugCached = new URLSearchParams(window.location.search).has('debug');
        return isDebugCached;
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
// 2. SOCKET EVENT HANDLERS BINDING (LAZY EVALUATION)
// ============================================================================

// Core Connection & Status
socket.on('connect', (...args) => typeof handleConnect === 'function' && handleConnect(...args));
socket.on('disconnect', (...args) => typeof handleDisconnect === 'function' && handleDisconnect(...args));
socket.on('connect_error', (...args) => typeof handleConnectError === 'function' && handleConnectError(...args));
socket.on('status_update', (...args) => typeof handleStatusUpdate === 'function' && handleStatusUpdate(...args));
socket.on('initial_state', (...args) => typeof handleInitialState === 'function' && handleInitialState(...args));

// Progress & Drops
socket.on('wanted_items_update', (...args) => typeof handleWantedItemsUpdate === 'function' && handleWantedItemsUpdate(...args));
socket.on('drop_progress', (...args) => typeof handleDropProgress === 'function' && handleDropProgress(...args));
socket.on('drop_progress_stop', (...args) => typeof handleDropProgressStop === 'function' && handleDropProgressStop(...args));

// Inventory & Campaigns
socket.on('campaign_add', (...args) => typeof handleCampaignAdd === 'function' && handleCampaignAdd(...args));
socket.on('inventory_clear', (...args) => typeof handleInventoryClear === 'function' && handleInventoryClear(...args));
socket.on('inventory_batch_update', (...args) => typeof handleInventoryBatchUpdate === 'function' && handleInventoryBatchUpdate(...args));
socket.on('games_available', (...args) => typeof handleGamesAvailable === 'function' && handleGamesAvailable(...args));

// Channels & Streamers
socket.on('channel_add', (...args) => typeof handleChannelAdd === 'function' && handleChannelAdd(...args));
socket.on('channel_update', (...args) => typeof handleChannelUpdate === 'function' && handleChannelUpdate(...args));
socket.on('channel_remove', (...args) => typeof handleChannelRemove === 'function' && handleChannelRemove(...args));
socket.on('channels_clear', (...args) => typeof handleChannelsClear === 'function' && handleChannelsClear(...args));
socket.on('channels_batch_update', (...args) => typeof handleChannelsBatchUpdate === 'function' && handleChannelsBatchUpdate(...args));
socket.on('channel_watching', (...args) => typeof handleChannelWatching === 'function' && handleChannelWatching(...args));
socket.on('channel_watching_clear', (...args) => typeof handleChannelWatchingClear === 'function' && handleChannelWatchingClear(...args));

// Console Output
socket.on('console_output', (...args) => typeof handleConsoleOutput === 'function' && handleConsoleOutput(...args));

// Auth & Settings
socket.on('login_required', (...args) => typeof handleLoginRequired === 'function' && handleLoginRequired(...args));
socket.on('oauth_code_required', (...args) => typeof handleOAuthCodeRequired === 'function' && handleOAuthCodeRequired(...args));
socket.on('login_status', (...args) => typeof handleLoginStatus === 'function' && handleLoginStatus(...args));
socket.on('login_clear', (...args) => typeof handleLoginClear === 'function' && handleLoginClear(...args));
socket.on('settings_updated', (...args) => typeof handleSettingsUpdated === 'function' && handleSettingsUpdated(...args));
socket.on('manual_mode_update', (...args) => typeof handleManualModeUpdate === 'function' && handleManualModeUpdate(...args));
socket.on('language_changed', (...args) => typeof handleLanguageChanged === 'function' && handleLanguageChanged(...args));

// UI Theme & Notifications
socket.on('theme_change', (...args) => typeof handleThemeChange === 'function' && handleThemeChange(...args));
socket.on('notification', (...args) => typeof handleNotification === 'function' && handleNotification(...args));
socket.on('attention_required', (...args) => typeof handleAttentionRequired === 'function' && handleAttentionRequired(...args));

// ============================================================================
// 3. CORE CONNECTION & SYSTEM HANDLERS
// ============================================================================

function handleConnect() {
    console.log('[Socket] Connected to server');
    
    if (typeof state !== 'undefined') {
        state.connected = true;
    }

    // 💡 Voláme přímo naši novou master funkci!
    if (typeof updateConnectionStatus === 'function') {
        updateConnectionStatus(true);
    }

    window.dispatchEvent(new CustomEvent('app:socket-connected'));
}

function handleDisconnect(reason) {
    console.warn('[Socket] Disconnected from server:', reason);
    
    if (typeof state !== 'undefined') {
        state.connected = false;
    }

    // 💡 Voláme přímo naši novou master funkci!
    if (typeof updateConnectionStatus === 'function') {
        updateConnectionStatus(false);
    }

    window.dispatchEvent(new CustomEvent('app:socket-disconnected'));
}

function handleConnectError(error) {
    if (isDebugEnabled()) {
        console.error('[Socket DEBUG] Connection error:', error);
    }
}

/**
 * Synchronizes initial state when socket connects to the server
 */
function handleInitialState(data) {
    console.log('[Socket] Received initial state synchronization', data);

    if (!data || typeof data !== 'object') return;

    if (typeof state !== 'undefined') {
        if (data.settings) {
            state.settings = { ...state.settings, ...data.settings };
        }

        if (data.manual_mode !== undefined) {
            state.manual_mode = data.manual_mode;
            state.is_manual = !!(data.manual_mode && data.manual_mode.active);
            if (!data.manual_mode || !data.manual_mode.active) {
                delete state.manual_game;
            }
        }

        if (data.active_game) state.active_game = data.active_game;
        if (data.active_channel) state.active_channel = data.active_channel;

        if (data.watching_channel) {
            state.watching_channel = data.watching_channel;
        } else if (data.status && typeof data.status === 'string' && data.status.startsWith('Watching: ')) {
            const streamerName = data.status.replace('Watching: ', '').trim();
            const channels = data.channels || {};
            const chList = Array.isArray(channels) ? channels : Object.values(channels);
            const found = chList.find(c => (c.displayName || c.name || c.username) === streamerName);
            if (found) {
                state.watching_channel = found.id;
            }
        }

        if (data.campaigns) {
            state.campaigns = {};
            const campList = Array.isArray(data.campaigns) ? data.campaigns : Object.values(data.campaigns);
            campList.forEach(camp => {
                if (camp && camp.id) state.campaigns[camp.id] = camp;
            });
        }
    }

    const filteredData = filterIgnoredData(data);

    if (filteredData.status && typeof updateStatus === 'function') {
        updateStatus(filteredData.status);
    }

    const wantedPayload = filteredData.wanted_items || filteredData.inventory || filteredData.campaigns;
    if (wantedPayload && typeof handleWantedItemsUpdate === 'function') {
        handleWantedItemsUpdate(wantedPayload);
    }

    if (filteredData.channels && typeof handleChannelsBatchUpdate === 'function') {
        handleChannelsBatchUpdate({ channels: filteredData.channels });
    }

    if (filteredData.settings && typeof updateSettingsUI === 'function') {
        updateSettingsUI(filteredData.settings);
    }

    if (filteredData.login && typeof updateLoginStatus === 'function') {
        updateLoginStatus(filteredData.login);
    }

    if (filteredData.manual_mode && typeof updateManualModeUI === 'function') {
        updateManualModeUI(filteredData.manual_mode);
    }

    if (filteredData.current_drop || filteredData.currentDrop) {
        if (typeof handleDropProgress === 'function') {
            handleDropProgress(filteredData.current_drop || filteredData.currentDrop);
        }
    } else if (typeof clearDropProgress === 'function') {
        if (typeof safeClearDrop === 'function') {
            safeClearDrop();
        } else {
            clearDropProgress();
        }
    }

    if (filteredData.console && typeof renderInitialConsole === 'function') {
        renderInitialConsole(filteredData.console);
    }

    if (typeof onInitialStateLoaded === 'function') {
        onInitialStateLoaded(filteredData);
    }

    syncAdminState();
}

// ============================================================================
// 5. INVENTORY & GAMES TAB HANDLERS
// ============================================================================

function handleCampaignAdd(data) {
    const gameName = data.game_name || data.game;
    console.log('[Campaign] Processing new campaign:', gameName || data.id);
    if (!isGameIgnored(gameName) && typeof addCampaign === 'function') {
        addCampaign(data);
    }
    syncAdminState();
}

function handleGamesAvailable(data) {
    console.log('[Games] Received available games list update');
    if (typeof availableGames !== 'undefined') {
        availableGames = new Set(data.games || []);
    }
    if (typeof renderGamesToWatch === 'function') renderGamesToWatch();
    if (typeof applyAutoAddIfNeeded === 'function') applyAutoAddIfNeeded();
    syncAdminState();
}

// ============================================================================
// 6. AUTH, SETTINGS & MANUAL MODE HANDLERS
// ============================================================================

function handleLoginRequired() {
    console.log('[Auth] Login required by server');
    if (typeof showLoginForm === 'function') {
        showLoginForm();
    }
}

function handleOAuthCodeRequired(data) {
    console.log('[Auth] OAuth code entry required');
    if (typeof showOAuthCode === 'function') {
        showOAuthCode(data?.url, data?.code);
    }
}

function handleLoginStatus(data) {
    console.log('[Auth] Login status update received');
    if (typeof updateLoginStatus === 'function') {
        updateLoginStatus(data);
    }
}

function handleLoginClear(data) {
    console.log('[Auth] Clearing login fields');
    if (typeof resetLoginForm === 'function') {
        resetLoginForm(data);
    }
}

function handleSettingsUpdated(data) {
    console.log('[Settings] Updated settings from server applied');
    if (typeof state !== 'undefined') {
        state.settings = { ...state.settings, ...data };
    }
    if (typeof updateSettingsUI === 'function') {
        updateSettingsUI(data);
    }
    if (data.auto_sort_by_end && typeof sortGamesByEnding === 'function') {
        sortGamesByEnding();
    }
    syncAdminState();
}

function handleManualModeUpdate(data) {
    console.log('[ManualMode] State updated:', data);
    const isExitingManual = !data || !data.active;
    
    if (typeof state !== 'undefined') {
        state.manual_mode = data;
        state.is_manual = !isExitingManual;

        if (isExitingManual) {
            delete state.manual_game;
        }
    }

    if (typeof updateManualModeUI === 'function') {
        updateManualModeUI(data);
    }

    if (typeof renderWantedItems === 'function') {
        renderWantedItems();
    }

    if (typeof syncAdminState === 'function') {
        syncAdminState();
    }
}

function handleLanguageChanged(data) {
    console.log('[Language] Changed to:', data.language);
    if (typeof fetchAndApplyTranslations === 'function') {
        fetchAndApplyTranslations();
    }
}

// ============================================================================
// 7. UI, CONSOLE, THEME & NOTIFICATION HANDLERS
// ============================================================================

function handleConsoleOutput(data) {
    if (data && data.message && typeof addConsoleLine === 'function') {
        addConsoleLine(data.message);
    }
}

function handleThemeChange(data) {
    const themeName = data.dark_mode ? 'Dark' : 'Light';
    console.log(`[Theme] Switched UI theme to ${themeName}`);
    if (typeof applyTheme === 'function') {
        applyTheme(data.dark_mode);
    } else {
        document.body.classList.toggle('dark-mode', !!data.dark_mode);
    }
}

function handleNotification(data) {
    console.log('[Notification] Displaying notification:', data.title);
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(data.title, {
            body: data.message,
            icon: '/static/icon.png'
        });
    }
}

function handleAttentionRequired(data) {
    console.log('[Attention] Requesting user attention');
    if (data.sound) {
        const audio = new Audio('/static/notification.mp3');
        audio.play().catch(() => { });
    }
    if (typeof flashTitle === 'function') {
        flashTitle();
    }
}

// ============================================================================
// 9. GAME FILTERING & UTILITIES
// ============================================================================

function isGameIgnored(gameName) {
    if (!gameName || typeof state === 'undefined' || !state.settings || !Array.isArray(state.settings.ignored_games)) {
        return false;
    }
    return state.settings.ignored_games.includes(gameName);
}

/**
 * FIXED: Returns a shallow filtered clone instead of mutating original input payload
 */
function filterIgnoredData(data) {
    if (!data || typeof state === 'undefined' || !state.settings || !Array.isArray(state.settings.ignored_games)) {
        return data;
    }
    const ignored = state.settings.ignored_games;
    if (ignored.length === 0) return data;

    const cloned = { ...data };

    if (cloned.current_drop) {
        const dropGame = cloned.current_drop.game_name || cloned.current_drop.game || cloned.current_drop.game_title;
        if (ignored.includes(dropGame)) {
            cloned.current_drop = null;
        }
    }

    if (Array.isArray(cloned.campaigns)) {
        cloned.campaigns = cloned.campaigns.filter(c => {
            const cGame = c.game_name || c.game || c.game_title;
            return !ignored.includes(cGame);
        });
    }

    if (Array.isArray(cloned.wanted_items)) {
        cloned.wanted_items = cloned.wanted_items.filter(item => {
            const gName = item.game_name || item.game;
            return !ignored.includes(gName);
        });
    }

    return cloned;
}
