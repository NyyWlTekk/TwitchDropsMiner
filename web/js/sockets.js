///////////////////////////////////////////////////////////////////////////////
// SOCKETS MODULE - INITIALIZATION, BINDINGS & EVENT HANDLERS
///////////////////////////////////////////////////////////////////////////////

// ============================================================================
// 1. STATE & DEBUG SETUP
// ============================================================================

const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

/**
socket.on('status_update', (...args) => handleStatusUpdate?.(...args));


// Progress & Drops

socket.on('drop_progress', (...args) => handleDropProgress?.(...args));
// socket.on('drop_progress_stop', (...args) => handleDropProgressStop?.(...args));

// Inventory & Campaigns

socket.on('inventory_clear', (...args) => handleInventoryClear?.(...args));
socket.on('inventory_batch_update', (...args) => handleInventoryBatchUpdate?.(...args));
socket.on('games_available', (...args) => handleGamesAvailable?.(...args));

// Channels & Streamers
socket.on('channel_add', (...args) => handleChannelAdd?.(...args));
socket.on('channel_update', (...args) => handleChannelUpdate?.(...args));
socket.on('channel_remove', (...args) => handleChannelRemove?.(...args));
socket.on('channels_clear', (...args) => handleChannelsClear?.(...args));
socket.on('channels_batch_update', (...args) => handleChannelsBatchUpdate?.(...args));
socket.on('channel_watching', (...args) => handleChannelWatching?.(...args));
socket.on('channel_watching_clear', (...args) => handleChannelWatchingClear?.(...args));

// Console Output
socket.on('console_output', (...args) => handleConsoleOutput?.(...args));

// Auth & Settings
socket.on('login_required', (...args) => handleLoginRequired?.(...args));
socket.on('oauth_code_required', (...args) => handleOAuthCodeRequired?.(...args));
socket.on('login_status', (...args) => handleLoginStatus?.(...args));
socket.on('login_clear', (...args) => handleLoginClear?.(...args));
socket.on('settings_updated', (...args) => handleSettingsUpdated?.(...args));
socket.on('manual_mode_update', (...args) => handleManualModeUpdate?.(...args));
socket.on('language_changed', (...args) => handleLanguageChanged?.(...args));

// UI Theme & Notifications
socket.on('theme_change', (...args) => handleThemeChange?.(...args));
socket.on('notification', (...args) => handleNotification?.(...args));
socket.on('attention_required', (...args) => handleAttentionRequired?.(...args));
**/

/////////////////////////////////////////////////////////////
////////////////  STATE HANDLER SOCKET ///////////////////////
/////////////////////////////////////////////////////////////

// ----------------------------------------------------------------------------
// STATE HANDLER & LOOP
// ----------------------------------------------------------------------------



// 2. Okamžitá žádost o stav při navázání spojení
socket.on('connect', () => {
    console.log('🟢 [Socket] Připojeno k serveru. Žádám o prvotní state...');
    socket.emit('state');
});



/////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////

// connection error handle :-)
socket.on('connect_error', (...args) => handleConnectError?.(...args));

function handleConnectError(error) {
    if (isDebugEnabled()) {
        console.error('[Socket DEBUG] Connection error:', error);
    }
}

// ============================================================================
// //////////////////////////////////////////////////////////////////////////
// ============================================================================

function handleLoginRequired() {
    console.log('[Auth] Login required by server');
    showLoginForm?.();
}

function handleOAuthCodeRequired(data) {
    console.log('[Auth] OAuth code entry required');
    showOAuthCode?.(data?.url, data?.code);
}

function handleLoginStatus(data) {
    console.log('[Auth] Login status update received');
    updateLoginStatus?.(data);
}

function handleLoginClear(data) {
    console.log('[Auth] Clearing login fields');
    resetLoginForm?.(data);
}

function handleSettingsUpdated(data) {
    console.log('[Settings] Updated settings from server applied');
    if (state) {
        state.settings = { ...state.settings, ...data };
    }
    updateSettingsUI?.(data);
    if (data.auto_sort_by_end) {
        sortGamesByEnding?.();
    }
    syncAdminState?.();
}

function handleManualModeUpdate(data) {
    console.log('[ManualMode] State updated:', data);
    const isExitingManual = !data || !data.active;
    
    if (state) {
        state.manual_mode = data;
        state.is_manual = !isExitingManual;

        if (isExitingManual) {
            delete state.manual_game;
        }
    }

    updateManualModeUI?.(data);
    syncAdminState?.();
}

function handleLanguageChanged(data) {
    console.log('[Language] Changed to:', data.language);
    fetchAndApplyTranslations?.();
}

// ============================================================================
// 7. UI, CONSOLE, THEME & NOTIFICATION HANDLERS
// ============================================================================

function handleConsoleOutput(data) {
    if (data?.message) {
        addConsoleLine?.(data.message);
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
    flashTitle?.();
}

// ============================================================================
// 9. GAME FILTERING & UTILITIES
// ============================================================================

function isGameIgnored(gameName) {
    if (!gameName || !state?.settings || !Array.isArray(state.settings.ignored_games)) {
        return false;
    }
    return state.settings.ignored_games.includes(gameName);
}

/**
 * FIXED: Returns a shallow filtered clone instead of mutating original input payload
 */
function filterIgnoredData(data) {
    if (!data || !state?.settings || !Array.isArray(state.settings.ignored_games)) {
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
