// Initialize Socket.IO connection
const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

// ==================== Socket.IO Debug & Event Handlers ====================

// Check if debug mode is enabled (via window.DEBUG, state.debug, localStorage or URL query param)
const isDebugEnabled = () => {
    if (typeof window !== 'undefined') {
        if (window.DEBUG || (typeof state !== 'undefined' && state.debug)) return true;
        if (localStorage.getItem('debug') === 'true') return true;
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('debug')) return true;
    }
    return false;
};

// Catch-all debug listener for all incoming socket events
if (typeof socket.onAny === 'function') {
    socket.onAny((eventName, ...args) => {
        if (isDebugEnabled()) {
            console.log(`[Socket DEBUG] Incoming Event: '${eventName}'`, args);
        }
    });
}

socket.on('connect', () => {
    if (isDebugEnabled()) {
        console.log('[Socket DEBUG] Connected with socket ID:', socket.id);
    } else {
        console.log('Connected to server');
    }
    state.connected = true;
    const connText = state.translations.gui?.websocket?.connected || 'Connected';
    document.getElementById('connection-indicator').textContent = '● ' + connText;
    document.getElementById('connection-indicator').className = 'connected';
});

socket.on('disconnect', (reason) => {
    if (isDebugEnabled()) {
        console.warn('[Socket DEBUG] Disconnected reason:', reason);
    } else {
        console.log('Disconnected from server');
    }
    state.connected = false;
    const disconnText = state.translations.gui?.websocket?.disconnected || 'Disconnected';
    document.getElementById('connection-indicator').textContent = '● ' + disconnText;
    document.getElementById('connection-indicator').className = 'disconnected';
});

socket.on('connect_error', (error) => {
    if (isDebugEnabled()) {
        console.error('[Socket DEBUG] Connection error:', error);
    }
});

/**
 * [CACHE_HELPER] Safely set item in localStorage
 */
function safeSetStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.error(`[CACHE_ERROR] Failed to save ${key}:`, e);
    }
}

/**
 * [CACHE_HELPER] Safely get item from localStorage
 */
function safeGetStorage(key) {
    try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        console.error(`[CACHE_ERROR] Failed to read ${key}:`, e);
        return null;
    }
}

/**
 * [CHANNELS_CACHE] Handles initial channel loading with cache fallback
 */
function handleInitialChannels(channelsData) {
    state.channels = {};

    let channelsList = [];
    if (Array.isArray(channelsData)) {
        channelsList = channelsData;
    } else if (channelsData && typeof channelsData === 'object') {
        channelsList = Object.values(channelsData);
    }

    if (channelsList.length === 0) {
        const cached = safeGetStorage('app_saved_channels');
        if (cached && typeof cached === 'object') {
            state.channels = cached;
            console.log("[CHANNELS_CACHE] Restored channels from localStorage.");
        }
    } else {
        channelsList.forEach(ch => {
            if (ch && ch.id) {
                state.channels[ch.id] = ch;
            }
        });
        safeSetStorage('app_saved_channels', state.channels);
    }

    if (typeof renderChannels === 'function') {
        renderChannels();
    }
}

/**
 * [WANTED_CACHE] Handles wanted items tree loading with cache fallback
 */
function handleInitialWantedItems(wantedData) {
    let treeToRender = wantedData;

    if (treeToRender && !Array.isArray(treeToRender) && typeof treeToRender === 'object') {
        treeToRender = Object.values(treeToRender);
    }

    if (!Array.isArray(treeToRender) || treeToRender.length === 0) {
        const cached = safeGetStorage('app_saved_wanted_tree');
        if (Array.isArray(cached) && cached.length > 0) {
            treeToRender = cached;
            console.log("[WANTED_CACHE] Restored wanted tree from localStorage.");
        }
    }

    if (Array.isArray(treeToRender) && treeToRender.length > 0) {
        state.wantedItemsTree = treeToRender;
        safeSetStorage('app_saved_wanted_tree', treeToRender);
        if (typeof renderWantedItems === 'function') {
            renderWantedItems(treeToRender);
        }
    }
}

/**
 * [DROP_CACHE] Drží progress bar z keše, dokud nepřijdou nová platná data
 */
function handleInitialCurrentDrop(dropData) {
    const hasValidDrop = dropData && typeof dropData === 'object' && Object.keys(dropData).length > 0;

    if (hasValidDrop) {
        // Přišla nová platná data z backendu -> uložíme a vykreslíme
        safeSetStorage('app_saved_current_drop', dropData);
        if (typeof updateDropProgress === 'function') {
            updateDropProgress(dropData);
        }
    } else {
        // Backend neposlal drop (např. při gathering channels) -> VŽDY držíme keš!
        const cached = safeGetStorage('app_saved_current_drop');
        if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
            console.log("[DROP_CACHE] Backend nezaslal drop (gathering). Držím progress bar z keše.");
            if (typeof updateDropProgress === 'function') {
                updateDropProgress(cached);
            }
        } else if (typeof clearDropProgress === 'function') {
            // Provedeme clear JEN v případě, že nemáme vůbec nic v keši
            clearDropProgress();
        }
    }
}

// Instant cache restore on DOM load (before WebSocket connection completes)
document.addEventListener('DOMContentLoaded', () => {
    console.log("[CACHE] Instant recovery sequence started...");

    // 1. Restore current drop progress immediately
    const cachedDrop = safeGetStorage('app_saved_current_drop');
    if (cachedDrop && Object.keys(cachedDrop).length > 0) {
        if (typeof updateDropProgress === 'function') {
            updateDropProgress(cachedDrop);
        }
    }

    // 2. Restore channels
    const cachedChannels = safeGetStorage('app_saved_channels');
    if (cachedChannels && Object.keys(cachedChannels).length > 0) {
        state.channels = cachedChannels;
        if (typeof renderChannels === 'function') renderChannels();
    }

    // 3. Restore wanted tree
    const cachedWanted = safeGetStorage('app_saved_wanted_tree');
    if (Array.isArray(cachedWanted) && cachedWanted.length > 0) {
        state.wantedItemsTree = cachedWanted;
        if (typeof renderWantedItems === 'function') renderWantedItems(cachedWanted);
    }
});

function updateStatus(status) {
    const statusEl = document.getElementById('status-text');
    if (statusEl) {
        statusEl.textContent = status;
    }
}

// Main socket event listener with fail-safe blocks
socket.on('initial_state', (data) => {
    console.log('[SOCKET] Received initial state', data);

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

        const autoaddEl = document.getElementById('auto-add-all-games');
        if (autoaddEl && data.settings) {
            autoaddEl.checked = !!data.settings.auto_add_all_games;
            if (typeof applyAutoAddIfNeeded === 'function') applyAutoAddIfNeeded();
        }

        if (typeof startCombinedRotation === 'function') {
            startCombinedRotation(true);
        }
    } catch (e) { console.error("[INIT_ERR] Rotation:", e); }
});

socket.on('status_update', (data) => {
    updateStatus(data.status);
});

socket.on('console_output', (data) => {
    addConsoleLine(data.message);
});

socket.on('channel_add', (data) => {
    updateChannel(data);
});

socket.on('channel_update', (data) => {
    updateChannel(data);
});

socket.on('channel_remove', (data) => {
    removeChannel(data.id);
});

socket.on('channels_clear', () => {
    clearChannels();
});

socket.on('channels_batch_update', (data) => {
    // Replace all channels atomically to prevent flickering
    state.channels = {};
    data.channels.forEach(ch => {
        state.channels[ch.id] = ch;
    });
    renderChannels();
});

socket.on('channel_watching', (data) => {
    setWatchingChannel(data.id);
});

socket.on('channel_watching_clear', () => {
    clearWatchingChannel();
});

socket.on('drop_progress', (data) => {
    // Získáme ID dropu (server může posílat drop_id nebo id)
    const dropId = data.drop_id || data.id;
    if (dropId) {
        // Okamžitě synchronizujeme obě místa na hlavní stránce
        syncAnyDropProgress(String(dropId), data);
    }
    
    // Původní funkce pro jistotu zůstane zachovaná
    if (typeof updateDropProgress === 'function') {
        updateDropProgress(data);
    }
});

socket.on('drop_progress_stop', () => {
    clearDropProgress();
});

socket.on('campaign_add', (data) => {
    addCampaign(data);
});


function clearInventory() {
    state.campaigns = {};
    if (typeof renderInventory === 'function') renderInventory();
}

socket.on('inventory_clear', () => {
    clearInventory();
});

socket.on('inventory_batch_update', (data) => {
    // Replace all campaigns atomically to prevent flickering
    state.campaigns = {};
    data.campaigns.forEach(camp => {
        state.campaigns[camp.id] = camp;
    });
    renderInventory();
    
    // Apply auto-sort after new campaigns are loaded
    applyAutoSortIfNeeded(); 
});

socket.on('login_required', () => {
    showLoginForm();
});

socket.on('oauth_code_required', (data) => {
    showOAuthCode(data.url, data.code);
});

socket.on('login_status', (data) => {
    updateLoginStatus(data);
});

socket.on('login_clear', (data) => {
    if (data.login) document.getElementById('username').value = '';
    if (data.password) document.getElementById('password').value = '';
    if (data.token) document.getElementById('2fa-token').value = '';
});

socket.on('settings_updated', (data) => {
    updateSettingsUI(data);
    
    // If the server confirmed auto-sort is enabled, trigger sorting immediately
    if (data.auto_sort_by_end) {        
        sortGamesByEnding(); 
    }
});

socket.on('theme_change', (data) => {
    if (data.dark_mode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
});

socket.on('notification', (data) => {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(data.title, {
            body: data.message,
            icon: '/static/icon.png'
        });
    }
});

socket.on('attention_required', (data) => {
    if (data.sound) {
        // Play notification sound
        const audio = new Audio('/static/notification.mp3');
        audio.play().catch(() => { });
    }
    // Flash title
    flashTitle();
});

socket.on('manual_mode_update', (data) => {
    updateManualModeUI(data);
});

socket.on('language_changed', (data) => {
    console.log('Language changed to:', data.language);
    fetchAndApplyTranslations();
});

socket.on('wanted_items_update', (data) => {
    renderWantedItems(data);
});
