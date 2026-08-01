////////////////////////////////////////
// MAIN PAGE////////////////////////////
////////////////////////////////////////

function addConsoleLine(message) {
    addConsoleLineRaw(message);
}

function addConsoleLineRaw(line) {
    const console = document.getElementById('console-output');
    if (!console) return;

    const div = document.createElement('div');
    div.textContent = line;
    console.appendChild(div);
    console.scrollTop = console.scrollHeight;

    while (console.children.length > 1000) {
        console.removeChild(console.firstChild);
    }
}


// INITIALIZATION HELPERS

/**
 * Handles channels received from the server.
 */
function handleInitialChannels(channelsData) {
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
        state.currentDrop = dropData;
        
        if (typeof updateDropProgress === 'function') {
            updateDropProgress(dropData);
        }
    } else {
        state.currentDrop = null;

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
function checkSyncConsistency(eventName, payload) {
    if (typeof state === 'undefined') return;

    // 1. Get currently watched channel and its associated game
    const watchedChannelId = state.watching_channel;
    const watchedChannelObj = (watchedChannelId && state.channels) ? state.channels[watchedChannelId] : null;
    const watchedGame = watchedChannelObj ? (watchedChannelObj.game_name || watchedChannelObj.game || 'Unknown Game') : 'None';
    const watchedStreamer = watchedChannelObj ? (watchedChannelObj.displayName || watchedChannelObj.name || watchedChannelId) : 'None';

    // 2. Get active drop and its associated game
    const currentDrop = state.currentDrop || state.current_drop;
    const dropGame = currentDrop ? (currentDrop.game_name || currentDrop.game || currentDrop.game_title || 'Unknown Drop Game') : 'None';

    // 3. Print current state context
    console.group(`🔍 [STATE INSPECTOR] Event: '${eventName}'`);
    console.log(`📺 Watched Channel: ${watchedStreamer} (Game: '${watchedGame}')`);
    console.log(`⚡ Active Drop Game: '${dropGame}'`);

    // 4. Trigger alert if watched game does not match active drop game
    if (watchedGame !== 'None' && dropGame !== 'None' && watchedGame !== dropGame) {
        console.error(`🚨 [SYNC ERROR] MISMATCH DETECTED! Channel is watching '${watchedGame}', but drop progress is running for '${dropGame}'!`);
        console.log('📦 Current Drop Object:', currentDrop);
        console.log('📺 Watched Channel Object:', watchedChannelObj);
    }

    console.groupEnd();
}

// Auto-attach inspector to socket events (without high-frequency status_update spam)
if (typeof socket !== 'undefined') {
    ['drop_progress', 'channel_watching', 'initial_state', 'channels_batch_update'].forEach(evt => {
        socket.on(evt, (data) => {
            setTimeout(() => checkSyncConsistency(evt, data), 20);
        });
    });
}
