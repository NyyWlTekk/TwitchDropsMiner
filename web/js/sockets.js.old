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
    if (isDebugEnabled()) {
        console.log('[Socket DEBUG] Connected with socket ID:', socket.id);
    } else {
        console.log('[Socket] Connected to server');
    }
    state.connected = true;
    const connText = state.translations?.gui?.websocket?.connected || 'Connected';
    const indicatorEl = document.getElementById('connection-indicator');
    if (indicatorEl) {
        indicatorEl.textContent = '● ' + connText;
        indicatorEl.className = 'connected';
    }
    syncAdminState();
}

function handleDisconnect(reason) {
    if (isDebugEnabled()) {
        console.warn('[Socket DEBUG] Disconnected reason:', reason);
    } else {
        console.log('[Socket] Disconnected from server');
    }
    state.connected = false;
    const disconnText = state.translations?.gui?.websocket?.disconnected || 'Disconnected';
    const indicatorEl = document.getElementById('connection-indicator');
    if (indicatorEl) {
        indicatorEl.textContent = '● ' + disconnText;
        indicatorEl.className = 'disconnected';
    }
    syncAdminState();
}

function handleConnectError(error) {
    if (isDebugEnabled()) {
        console.error('[Socket DEBUG] Connection error:', error);
    }
}

function updateQueueAndState(data) {
    if (data.queue_count !== undefined || data.rotation_index !== undefined) {
        if (typeof state !== 'undefined') {
            if (data.queue_count !== undefined) state.queue_count = data.queue_count;
            if (data.rotation_index !== undefined) state.rotation_index = data.rotation_index;
        }
    }
    syncAdminState();
}

/**
 * Synchronizes initial state when socket connects to the server
 */
function handleInitialState(data) {
    console.log('[Socket] Received initial state synchronization', data);

    if (data.settings && typeof state !== 'undefined') {
        state.settings = { ...state.settings, ...data.settings };
    }

    if (typeof state !== 'undefined') {
        // --- PROPOJENÍ MANUÁLNÍHO REŽIMU DO STATE ---
        if (data.manual_mode !== undefined) {
            state.manual_mode = data.manual_mode;
            state.is_manual = !!(data.manual_mode && data.manual_mode.active);
            if (!data.manual_mode || !data.manual_mode.active) {
                delete state.manual_game;
            }
        }

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
    }

    data = filterIgnoredData(data);

    try { if (data.status && typeof updateStatus === 'function') updateStatus(data.status); } catch (e) { console.error("[INIT_ERR] Status:", e); }
    try { if (data.wanted_items && typeof handleInitialWantedItems === 'function') handleInitialWantedItems(data.wanted_items); } catch (e) { console.error("[INIT_ERR] Wanted:", e); }
    try { if (data.channels && typeof handleInitialChannels === 'function') handleInitialChannels(data.channels); } catch (e) { console.error("[INIT_ERR] Channels:", e); }

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
                consoleEl.innerHTML = '';
                const linesToRender = data.console.length > 1000 ? data.console.slice(-1000) : data.console;
                const fragment = document.createDocumentFragment();
                linesToRender.forEach(line => {
                    const div = document.createElement('div');
                    div.textContent = line;
                    fragment.appendChild(div);
                });
                consoleEl.appendChild(fragment);
                consoleEl.scrollTop = consoleEl.scrollHeight;
            }
        }
    } catch (e) { console.error("[INIT_ERR] Console:", e); }

    try { if (data.settings && typeof updateSettingsUI === 'function') updateSettingsUI(data.settings); } catch (e) { console.error("[INIT_ERR] Settings:", e); }
    try { if (data.login && typeof updateLoginStatus === 'function') updateLoginStatus(data.login); } catch (e) { console.error("[INIT_ERR] Login:", e); }
    try { if (data.manual_mode && typeof updateManualModeUI === 'function') updateManualModeUI(data.manual_mode); } catch (e) { console.error("[INIT_ERR] ManualMode:", e); }

    try { 
        if (data.current_drop) {
            if (typeof handleInitialCurrentDrop === 'function') {
                handleInitialCurrentDrop(data.current_drop, data.status);
            }
        } else {
            if (typeof clearDropProgress === 'function') {
                clearDropProgress();
            }
        }
    } catch (e) { 
        console.error("[INIT_ERR] Drop:", e); 
    }

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

    syncAdminState();
}

// ============================================================================
// 4. CHANNELS TAB HANDLERS & HELPERS
// ============================================================================

function handleChannelAdd(data) {
    console.log('[Channel] Channel added:', data?.displayName || data?.name || data?.id);
    if (typeof updateChannel === 'function') {
        updateChannel(data);
    }
}

function handleChannelUpdate(data) {
    if (typeof updateChannel === 'function') {
        updateChannel(data);
    }
}

function handleChannelRemove(data) {
    console.log('[Channel] Channel removed ID:', data?.id);
    if (typeof removeChannel === 'function') {
        removeChannel(data?.id);
    }
}

function handleChannelsClear() {
    console.log('[Channel] Cleared all channels');
    if (typeof clearChannels === 'function') {
        clearChannels();
    }
}

function handleChannelsBatchUpdate(data) {
    console.log('[Channels] Processing batch channels update');
    state.channels = {};
    if (Array.isArray(data.channels)) {
        data.channels.forEach(ch => {
            state.channels[ch.id] = ch;
        });
    }

    const watchedChannelObj = getWatchedChannelObject();
    const currentWatchedGame = watchedChannelObj ? (watchedChannelObj.game_name || watchedChannelObj.game) : null;
    const activeDrop = state.currentDrop || state.current_drop;

    if (activeDrop && currentWatchedGame) {
        const activeDropGame = typeof getDropGameName === 'function' ? getDropGameName(activeDrop) : null;
        if (activeDropGame && currentWatchedGame !== activeDropGame) {
            console.warn(`[SYNC CLEANUP] Mismatch after channels update: watched '${currentWatchedGame}' vs drop '${activeDropGame}'. Clearing.`);
            if (typeof safeClearDrop === 'function') safeClearDrop();
        }
    }

    if (typeof scheduleRenderChannels === 'function') {
        scheduleRenderChannels();
    } else if (typeof renderChannels === 'function') {
        renderChannels();
    }
    
    syncAdminState();
}

function handleChannelWatching(data) {
    const channelId = (typeof data === 'object' && data !== null) ? data.id : data;
    console.log('[Channel] Switched watching target:', channelId);

    if (typeof state !== 'undefined') {
        state.watching_channel = channelId;

        const watchedChannelObj = getWatchedChannelObject();
        const watchedGame = watchedChannelObj ? (watchedChannelObj.game_name || watchedChannelObj.game) : null;

        if (state.currentDrop || state.current_drop) {
            const activeDrop = state.currentDrop || state.current_drop;
            const currentDropGame = typeof getDropGameName === 'function' ? getDropGameName(activeDrop) : null;
            if (watchedGame && currentDropGame && watchedGame !== currentDropGame) {
                console.log(`[CHANNEL SWITCH] Clearing stale drop '${currentDropGame}' (Channel plays '${watchedGame}')`);
                if (typeof safeClearDrop === 'function') safeClearDrop();
            }
        }
    }

    if (typeof setWatchingChannel === 'function') {
        setWatchingChannel(channelId);
    }
    syncAdminState();
}

function handleChannelWatchingClear() {
    console.log('[Channel] Resetting active watching channel state');
    if (typeof state !== 'undefined') {
        state.watching_channel = null;
    }
    if (typeof clearWatchingChannel === 'function') {
        clearWatchingChannel();
    }
    if (typeof clearDropProgress === 'function') {
        clearDropProgress();
    }
    syncAdminState();
}

function getWatchedChannelObject() {
    if (typeof state === 'undefined' || !state.watching_channel || !state.channels) return null;
    const target = state.watching_channel;

    if (Array.isArray(state.channels)) {
        return state.channels.find(c => 
            String(c.id) === String(target) || 
            c.name === target || 
            c.displayName === target ||
            c.username === target
        ) || null;
    } else if (typeof state.channels === 'object') {
        if (state.channels[target]) return state.channels[target];
        if (state.channels[String(target)]) return state.channels[String(target)];
        return Object.values(state.channels).find(c => 
            String(c?.id) === String(target) || 
            c?.name === target || 
            c?.displayName === target ||
            c?.username === target
        ) || null;
    }
    return null;
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

function handleInventoryClear() {
    console.log('[Inventory] Received clear command');
    clearInventory();
}

function clearInventory() {
    console.log('[Inventory] Resetting state inventory object');
    if (typeof state !== 'undefined') {
        state.campaigns = {};
    }
    if (typeof renderInventory === 'function') renderInventory();
    syncAdminState();
}

function handleInventoryBatchUpdate(data) {
    console.log('[Inventory] Processing batch inventory update');
    state.campaigns = {};
    const filtered = (data.campaigns || []).filter(c => !isGameIgnored(c.game_name || c.game));
    filtered.forEach(camp => {
        state.campaigns[camp.id] = camp;
    });
    if (typeof renderInventory === 'function') renderInventory();
    if (typeof applyAutoSortIfNeeded === 'function') applyAutoSortIfNeeded();
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
    if (data.login) document.getElementById('username').value = '';
    if (data.password) document.getElementById('password').value = '';
    if (data.token) document.getElementById('2fa-token').value = '';
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

    // VYČIŠTĚNÍ PAMĚTI: Při výstupu z manuálního režimu promazat dokončené kampaně
    if (isExitingManual && typeof cleanupInactiveCampaigns === 'function') {
        cleanupInactiveCampaigns();
    }

    // Následný rebuild UI už vykreslí kompletně čistý stav
    if (typeof renderWantedQueue === 'function') {
        renderWantedQueue();
    }
    if (typeof renderWantedItems === 'function') {
        renderWantedItems();
    }
    if (typeof refreshUI === 'function') {
        refreshUI();
    }

    syncAdminState();
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
    if (data.dark_mode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
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
// 8. ADMIN & DIAGNOSTICS HELPERS
// ============================================================================

/**
 * Throttled state synchronization with administration.js to prevent UI thrashing.
 */
function syncAdminState() {
    if (!window.Administration || isAdminSyncScheduled) return;

    isAdminSyncScheduled = true;
    requestAnimationFrame(() => {
        isAdminSyncScheduled = false;
        if (!window.Administration) return;

        let qCount = 0;
        if (typeof state !== 'undefined') {
            if (Array.isArray(state.wanted_items)) {
                qCount = state.wanted_items.length;
            } else if (state.campaigns) {
                for (const _ in state.campaigns) qCount++;
            }
        }

        window.Administration.updateDiagnostics({
            connected: Boolean(state?.connected),
            queueCount: qCount,
            rotationIndex: state?.rotation_index || state?.rotationIndex || 0
        });

        window.Administration.setState(state);
    });
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
