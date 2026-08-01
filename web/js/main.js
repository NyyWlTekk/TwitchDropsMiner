////////////////////////////////////////
// MAIN PAGE / INITIALIZERS & LOGGING
////////////////////////////////////////

// INITIALIZATION HELPERS

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

/**
 * Handles current drop received from the server.
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
// DIAGNOSTIC STATE INSPECTOR
// ============================================================================

/**
 * Inspects state object directly for channel and drop mismatches.
 */
let lastLoggedMismatch = null;

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
