// ============================================================================
// 1. SOCKET INITIALIZATION & DEBUG SETUP
// ============================================================================

const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

// Cache debug check to avoid constructing URLSearchParams on every single event
let isDebugCached = null;
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
// 2. SOCKET EVENT HANDLERS (CLEAN BINDINGS)
// ============================================================================

// Connection & Status Events
socket.on('connect', handleConnect);
socket.on('disconnect', handleDisconnect);
socket.on('connect_error', handleConnectError);
socket.on('status_update', handleStatusUpdate);

// Core Data & Campaign Sync Events
socket.on('initial_state', handleInitialState);
socket.on('wanted_items_update', handleWantedItemsUpdate);
socket.on('drop_progress', handleDropProgress);
socket.on('drop_progress_stop', handleDropProgressStop);
socket.on('campaign_add', handleCampaignAdd);
socket.on('inventory_clear', handleInventoryClear);
socket.on('inventory_batch_update', handleInventoryBatchUpdate);
socket.on('games_available', handleGamesAvailable);

// Channels & Console Events
socket.on('console_output', handleConsoleOutput);
socket.on('channel_add', handleChannelAdd);
socket.on('channel_update', handleChannelUpdate);
socket.on('channel_remove', handleChannelRemove);
socket.on('channels_clear', handleChannelsClear);
socket.on('channels_batch_update', handleChannelsBatchUpdate);
socket.on('channel_watching', handleChannelWatching);
socket.on('channel_watching_clear', handleChannelWatchingClear);

// Settings, Auth & Language Events
socket.on('login_required', handleLoginRequired);
socket.on('oauth_code_required', handleOAuthCodeRequired);
socket.on('login_status', handleLoginStatus);
socket.on('login_clear', handleLoginClear);
socket.on('settings_updated', handleSettingsUpdated);
socket.on('manual_mode_update', handleManualModeUpdate);
socket.on('language_changed', handleLanguageChanged);

// Theme & Notification Events
socket.on('theme_change', handleThemeChange);
socket.on('notification', handleNotification);
socket.on('attention_required', handleAttentionRequired);


// ============================================================================
// 3. HELPER & UTILITY FUNCTIONS
// ============================================================================

let isAdminSyncScheduled = false;

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

let pendingStatusText = null;
let isRafScheduled = false;
let lastLoggedCampaignProgress = -1;

function handleStatusUpdate(data) {
    if (!data || !data.status) {
        if (data) {
            updateQueueAndState(data);
        }
        return;
    }

    const statusText = data.status;
    let shouldLog = true;

    if (statusText.startsWith('Adding campaigns to inventory...')) {
        const match = statusText.match(/\((\d+)\/(\d+)\)/);
        if (match) {
            const current = parseInt(match[1], 10);
            const total = parseInt(match[2], 10);
            const percent = Math.floor((current / total) * 100);

            const isQuarterStep = percent % 25 === 0 && percent !== lastLoggedCampaignProgress;
            shouldLog = current === 1 || current === total || isQuarterStep;

            if (shouldLog) {
                lastLoggedCampaignProgress = percent;
            }
        }
    } else {
        lastLoggedCampaignProgress = -1;
    }

    if (shouldLog) {
        console.log('[Status] Received update:', statusText);
    }

    scheduleStatusUpdate(statusText);

    const statusLower = statusText.toLowerCase();
    if (statusLower.includes('idle') || statusLower.includes('no active campaigns') || statusLower.includes('offline')) {
        if (typeof clearDropProgress === 'function') {
            clearDropProgress();
        }
    }

    updateQueueAndState(data);
}

function scheduleStatusUpdate(statusText) {
    pendingStatusText = statusText;

    if (!isRafScheduled) {
        isRafScheduled = true;
        requestAnimationFrame(() => {
            if (pendingStatusText !== null) {
                updateStatus(pendingStatusText);
                pendingStatusText = null;
            }
            isRafScheduled = false;
        });
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

function handleInitialState(data) {
    console.log('[Socket] Received initial state synchronization', data);

    if (data.settings && typeof state !== 'undefined') {
        state.settings = { ...state.settings, ...data.settings };
    }

    if (typeof state !== 'undefined') {
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

function handleWantedItemsUpdate(data) {
    console.log('[WantedItems] Received list update');
    let filteredData = data;
    if (Array.isArray(data)) {
        filteredData = data.filter(item => !isGameIgnored(item.game_name || item.game));
    }
    if (typeof renderWantedItems === 'function') {
        renderWantedItems(filteredData);
    }
    syncAdminState();
}

function handleDropProgress(data) {
    if (!data) return;

    const incomingGame = getDropGameName(data);
    const watchedChannelObj = getWatchedChannelObject();
    let currentlyWatchedGame = watchedChannelObj ? (watchedChannelObj.game_name || watchedChannelObj.game || watchedChannelObj.game_title) : null;

    if (!currentlyWatchedGame && typeof state !== 'undefined' && state.active_game) {
        currentlyWatchedGame = state.active_game;
    }

    if (incomingGame && isGameIgnored(incomingGame)) {
        console.log(`[Drop] Blocked drop progress for ignored game: '${incomingGame}'`);
        return;
    }

    if (currentlyWatchedGame && incomingGame) {
        const cleanIncoming = incomingGame.trim().toLowerCase();
        const cleanWatched = currentlyWatchedGame.trim().toLowerCase();

        if (cleanIncoming !== cleanWatched) {
            if (typeof logOnce === 'function') {
                logOnce('ghost_blocked', `Ignored drop for '${incomingGame}' (Channel is watching '${currentlyWatchedGame}')`, true);
            }
            safeClearDrop();
            return;
        }
    }

    console.log(`[Drop] Updating progress for '${incomingGame || 'Unknown Game'}'`);

    if (typeof state !== 'undefined') {
        state.currentDrop = data;
        state.current_drop = data;
    }

    const dropId = data.drop_id || data.id;
    if (dropId && typeof syncAnyDropProgress === 'function') {
        syncAnyDropProgress(String(dropId), data);
    }

    if (typeof updateDropProgress === 'function') {
        updateDropProgress(data);
    }
    syncAdminState();
}

function handleDropProgressStop() {
    console.log('[Drop] Stopped drop progress execution');
    if (typeof clearDropProgress === 'function') {
        clearDropProgress();
    }
}

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

function handleConsoleOutput(data) {
    if (data && data.message && typeof addConsoleLine === 'function') {
        addConsoleLine(data.message);
    }
}

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
        const activeDropGame = getDropGameName(activeDrop);
        if (activeDropGame && currentWatchedGame !== activeDropGame) {
            console.warn(`[SYNC CLEANUP] Mismatch after channels update: watched '${currentWatchedGame}' vs drop '${activeDropGame}'. Clearing.`);
            safeClearDrop();
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
            const currentDropGame = getDropGameName(activeDrop);
            if (watchedGame && currentDropGame && watchedGame !== currentDropGame) {
                console.log(`[CHANNEL SWITCH] Clearing stale drop '${currentDropGame}' (Channel plays '${watchedGame}')`);
                safeClearDrop();
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

function handleManualModeUpdate(data) {
    console.log('[ManualMode] State updated:', data);
    if (typeof updateManualModeUI === 'function') {
        updateManualModeUI(data);
    }
}

function handleLanguageChanged(data) {
    console.log('[Language] Changed to:', data.language);
    if (typeof fetchAndApplyTranslations === 'function') {
        fetchAndApplyTranslations();
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

function clearInventory() {
    console.log('[Inventory] Resetting state inventory object');
    state.campaigns = {};
    if (typeof renderInventory === 'function') renderInventory();
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

function getDropGameName(data) {
    if (!data) return null;
    let game = data.game_name || data.game || data.game_title || data.campaign?.game_name || data.drop?.game_name;
    if (game) return game;

    const dropId = data.drop_id || data.id;
    if (dropId && typeof state !== 'undefined' && state.campaigns) {
        if (Array.isArray(state.campaigns)) {
            for (const camp of state.campaigns) {
                if (camp.time_based_drops?.some(d => String(d.id) === String(dropId))) {
                    return camp.game_name || camp.game;
                }
            }
        } else {
            for (const key in state.campaigns) {
                const camp = state.campaigns[key];
                if (camp.time_based_drops?.some(d => String(d.id) === String(dropId))) {
                    return camp.game_name || camp.game;
                }
            }
        }
    }
    return null;
}

function safeClearDrop() {
    console.log('[Drop] Clearing active drop from state');
    if (typeof state !== 'undefined') {
        state.currentDrop = null;
        state.current_drop = null;
    }
    if (typeof clearDropProgress === 'function') {
        clearDropProgress(true);
    }
    syncAdminState();
}
