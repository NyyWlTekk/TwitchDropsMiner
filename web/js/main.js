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
// DIAGNOSTIC DESYNCHRONIZATION TRACER
// ============================================================================

/**
 * Checks consistency between active cards and watched channel in DOM.
 */
function checkSyncConsistency(eventName, payload) {
    // 1. Get watched channel and its game in UI
    const watchingEl = document.querySelector('.channel-card.watching, .channel-item.watching');
    const watchingText = watchingEl ? watchingEl.textContent.trim().replace(/\s+/g, ' ') : 'None';

    // 2. Find green-bordered elements (currently processing drop / campaign)
    // We target inner drop progress containers or watching indicators
    const greenBorderCards = Array.from(document.querySelectorAll('.drop-progress-container, .campaign-card-active, .watching-drop'))
        .map(el => el.textContent.trim().replace(/\s+/g, ' ').substring(0, 60));

    // 3. Log current state during events
    console.group(`🔍 [SYNC INSPECTOR] Event: '${eventName}'`);
    console.log('📺 Watched Channel in UI:', watchingText);
    console.log('🟢 Green highlighted items in UI:', greenBorderCards);
    console.log('📦 Socket payload:', payload);

    // 4. Check if current drop game matches watched channel game
    if (state.currentDrop && state.channels && state.watching_channel) {
        const currentChannel = state.channels[state.watching_channel];
        const watchedGame = currentChannel ? (currentChannel.game_name || currentChannel.game) : null;
        const dropGame = state.currentDrop.game_name || state.currentDrop.game || state.currentDrop.game_title;

        if (watchedGame && dropGame && watchedGame !== dropGame) {
            console.error(`❌ [GAME MISMATCH] Watching channel for '${watchedGame}', but currentDrop is for '${dropGame}'!`);
        }
    }
    
    console.groupEnd();
}
