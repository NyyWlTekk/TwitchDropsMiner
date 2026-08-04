///////////////////////////////////////////////////////////////////////////////
// MAIN PAGE / INITIALIZERS, PROGRESS & STATE MANAGEMENT
///////////////////////////////////////////////////////////////////////////////

// Shared module state variables
let pendingStatusText = null;
let isRafScheduled = false;
let lastLoggedCampaignProgress = -1;
let lastLoggedMismatch = null;

// ============================================================================
// 1. DROP PROGRESS & MEMORY MANAGEMENT
// ============================================================================

/**
 * Handles live socket progress and stores fresh metrics into live cache
 */
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

    const dropId = String(data.drop_id || data.id || '');

    if (typeof state !== 'undefined') {
        state.currentDrop = data;
        state.current_drop = data;

        // Save latest socket data into live cache indexed by drop ID
        if (!state.liveDropsCache) state.liveDropsCache = {};
        if (dropId) {
            state.liveDropsCache[dropId] = {
                ...(state.liveDropsCache[dropId] || {}),
                ...data
            };
        }
    }

    if (dropId && typeof syncAnyDropProgress === 'function') {
        syncAnyDropProgress(dropId, data);
    }

    // 1. Update main UI progress bar
    if (typeof updateDropProgress === 'function') {
        updateDropProgress(data);
    }

    // 2. Immediate synchronization and DOM update for Wanted section
    if (typeof syncWantedItemsProgress === 'function') {
        syncWantedItemsProgress(data);
    }

    syncAdminState();
}

function handleDropProgressStop() {
    console.log('[Drop] Stopped drop progress execution');
    if (typeof clearDropProgress === 'function') {
        clearDropProgress();
    }
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

/**
 * Handles current drop received from the server during initial synchronization.
 */
function handleInitialCurrentDrop(dropData) {
    const hasValidDrop = dropData && typeof dropData === 'object' && Object.keys(dropData).length > 0;

    if (hasValidDrop) {
        if (typeof state !== 'undefined') {
            state.currentDrop = dropData;
            state.current_drop = dropData;
        }
        
        if (typeof updateDropProgress === 'function') {
            updateDropProgress(dropData);
        }
    } else {
        if (typeof state !== 'undefined') {
            state.currentDrop = null;
            state.current_drop = null;
        }

        if (typeof clearDropProgress === 'function') {
            clearDropProgress(true); // Forced cleanup
        }
    }
}

// ============================================================================
// 2. STATUS UPDATES & UI RENDERING
// ============================================================================

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

// ============================================================================
// 3. CHANNELS INITIALIZATION
// ============================================================================

/**
 * Handles channels received from the server.
 */
function handleInitialChannels(channelsData) {
    if (typeof state === 'undefined') return;

    state.channels = {};
    let channelsList = [];
    
    if (Array.isArray(channelsData)) {
        channelsList = channelsData;
    } else if (channelsData && typeof channelsData === 'object') {
        channelsList = Object.values(channelsData);
    }

    channelsList.forEach(ch => {
        if (ch && ch.id) {
            state.channels[ch.id] = ch;
        }
    });

    if (typeof renderChannels === 'function') {
        renderChannels();
    }
}

// ============================================================================
// 4. WANTED ITEMS HANDLERS
// ============================================================================

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

/**
 * Handles wanted items received from the server.
 */
function handleInitialWantedItems(wantedData) {
    if (typeof state === 'undefined') return;

    let treeToRender = wantedData;

    if (treeToRender && !Array.isArray(treeToRender) && typeof treeToRender === 'object') {
        treeToRender = Object.values(treeToRender);
    }

    if (Array.isArray(treeToRender) && treeToRender.length > 0) {
        state.wantedItemsTree = treeToRender;
        if (typeof renderWantedItems === 'function') {
            renderWantedItems(treeToRender);
        }
    }
}

// ============================================================================
// 5. DIAGNOSTIC STATE INSPECTOR
// ============================================================================

/**
 * Inspects state object directly for channel and drop mismatches.
 */
function checkSyncConsistency(evt = null, data = null) {
    if (typeof state === 'undefined') return;

    const currentDrop = state.currentDrop || state.current_drop;
    if (!currentDrop) {
        lastLoggedMismatch = null;
        return;
    }

    const watchedChannelObj = typeof getWatchedChannelObject === 'function' ? getWatchedChannelObject() : null;
    const watchedGame = watchedChannelObj ? (watchedChannelObj.game_name || watchedChannelObj.game || watchedChannelObj.game_title) : null;
    const activeDropGame = typeof getDropGameName === 'function' ? getDropGameName(currentDrop) : null;

    if (watchedGame && activeDropGame) {
        const cleanWatched = watchedGame.trim().toLowerCase();
        const cleanDrop = activeDropGame.trim().toLowerCase();

        if (cleanWatched !== cleanDrop) {
            const mismatchKey = `${cleanWatched}_vs_${cleanDrop}`;

            // Log warning only once per unique mismatch
            if (lastLoggedMismatch !== mismatchKey) {
                console.warn(`[SYNC AUTOCLEAN] Ghost drop detected '${activeDropGame}' while watching '${watchedGame}'. Clearing from memory.`);
                lastLoggedMismatch = mismatchKey;
            }

            // Immediate memory & UI cleanup
            if (typeof safeClearDrop === 'function') {
                safeClearDrop();
            }
        } else {
            lastLoggedMismatch = null;
        }
    }
}

// Auto-attach inspector to socket events (without high-frequency status_update spam)
if (typeof socket !== 'undefined') {
    ['drop_progress', 'channel_watching', 'initial_state', 'channels_batch_update'].forEach(evt => {
        socket.on(evt, (data) => {
            setTimeout(() => checkSyncConsistency(evt, data), 20);
        });
    });
}
