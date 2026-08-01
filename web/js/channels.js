/////////////////////////////////////////////////////
////////////CHANNELS WATCHED/////////////////////////
/////////////////////////////////////////////////////

let isChannelsRenderScheduled = false;

/**
 * Schedules channels rendering on the next animation frame to prevent DOM render spamming.
 */
function scheduleRenderChannels() {
    if (isChannelsRenderScheduled) return;
    isChannelsRenderScheduled = true;
    
    // Batch multiple render calls into a single animation frame
    requestAnimationFrame(() => {
        renderChannels();
        isChannelsRenderScheduled = false;
    });
}

function hasImportantChange(oldData, newData) {
    if (!oldData) return true;

    // Critical structural changes affecting order or badges
    if (oldData.game !== newData.game ||
        oldData.online !== newData.online ||
        oldData.watching !== newData.watching ||
        oldData.drops_enabled !== newData.drops_enabled ||
        oldData.acl_based !== newData.acl_based) {
        return true;
    }

    // Trigger full re-render for viewers only on significant jumps
    const viewerDiff = Math.abs((oldData.viewers || 0) - (newData.viewers || 0));
    return viewerDiff > 50; 
}

function updateChannel(channelData) {
    if (!channelData || !channelData.id) return;
    const existing = state.channels[channelData.id];

    // 1. Completely ignore update if data is identical
    if (existing && JSON.stringify(existing) === JSON.stringify(channelData)) {
        return;
    }

    // 2. Targeted DOM update if no structural/important changes occurred
    if (existing && !hasImportantChange(existing, channelData)) {
        state.channels[channelData.id] = channelData;

        const viewerEl = document.querySelector(`#channel-${channelData.id} .channel-info`);
        if (viewerEl) {
            const viewersText = channelData.viewers !== null ? `${channelData.viewers.toLocaleString()} viewers` : 'Offline';
            
            if (channelData.watching) {
                viewerEl.replaceChildren(
                    document.createTextNode(viewersText + ' • '),
                    makeElement('strong', {}, 'WATCHING')
                );
            } else {
                viewerEl.textContent = viewersText;
            }
        }
        return; // Skip full re-render
    }

    // 3. Fallback to full re-render on major status/game changes
    console.log(`[Channel] Structural change detected for channel: ${channelData.displayName || channelData.name || channelData.id}`);
    state.channels[channelData.id] = channelData;
    scheduleRenderChannels();
}

function removeChannel(channelId) {
    console.log(`[Channels] Removing channel ID: '${channelId}'`);
    delete state.channels[channelId];
    scheduleRenderChannels();
}

function clearChannels() {
    console.log('[Channels] Clearing all channels from state');
    state.channels = {};
    scheduleRenderChannels();
}

function setWatchingChannel(channelId) {
    console.log(`[Channels] Setting active watching channel ID: '${channelId}'`);
    Object.values(state.channels).forEach(ch => ch.watching = false);
    if (state.channels[channelId]) {
        state.channels[channelId].watching = true;
    }
    scheduleRenderChannels();
}

function clearWatchingChannel() {
    console.log('[Channels] Clearing watching state for all channels');
    Object.values(state.channels).forEach(ch => ch.watching = false);
    scheduleRenderChannels();
}

function renderChannels() {
    const container = document.getElementById('channels-list');
    if (!container) {
        console.warn('[Channels] Element #channels-list not found in DOM');
        return;
    }

    const t = state.translations || {};
    const channels = Object.values(state.channels);
    if (channels.length === 0) {
        console.log('[Channels] No channels available to render');
        const emptyMsg = t.gui?.channels?.no_channels || 'No channels tracked yet...';
        container.replaceChildren(
            makeElement('p', { class: 'empty-message' }, emptyMsg)
        );
        return;
    }

    const gamesToWatch = state.settings?.games_to_watch || [];
    const gamesToWatchSet = new Set(gamesToWatch);

    const filteredChannels = channels.filter(channel => {
        const gameName = channel.game;
        return gamesToWatch.length === 0 || (gameName && gamesToWatchSet.has(gameName));
    });

    if (filteredChannels.length === 0) {
        console.log('[Channels] No channels found matching selected games filter');
        const emptyMsg = t.gui?.channels?.no_channels_for_games || 'No channels found for selected games...';
        container.replaceChildren(
            makeElement('p', { class: 'empty-message' }, emptyMsg)
        );
        return;
    }

    const gameGroups = {};
    filteredChannels.forEach(channel => {
        const gameName = channel.game || 'No Game';
        const gameId = channel.game_id || 'no-game';
        const gameIcon = channel.game_icon;

        if (!gameGroups[gameId]) {
            gameGroups[gameId] = {
                name: gameName,
                icon: gameIcon,
                channels: []
            };
        }
        gameGroups[gameId].channels.push(channel);
    });

    const sortedGames = Object.entries(gameGroups).sort(([idA, groupA], [idB, groupB]) => {
        const hasWatchingA = groupA.channels.some(ch => ch.watching);
        const hasWatchingB = groupB.channels.some(ch => ch.watching);

        if (hasWatchingA !== hasWatchingB) return hasWatchingB ? 1 : -1;

        const totalViewersA = groupA.channels.reduce((sum, ch) => sum + (ch.viewers || 0), 0);
        const totalViewersB = groupB.channels.reduce((sum, ch) => sum + (ch.viewers || 0), 0);

        return totalViewersB - totalViewersA;
    });

    console.log(`[Channels] Rendering ${filteredChannels.length} channel(s) across ${sortedGames.length} game group(s)`);

    container.innerHTML = '';
    sortedGames.forEach(([gameId, group]) => {
        const gameHeader = document.createElement('div');
        gameHeader.className = 'game-group-header';

        const channelCount = group.channels.length;
        const totalViewers = group.channels.reduce((sum, ch) => sum + (ch.viewers || 0), 0);

        const channelText = channelCount === 1
            ? (t.gui?.channels?.channel_count || 'channel')
            : (t.gui?.channels?.channel_count_plural || 'channels');
        const viewersText = t.gui?.channels?.viewers || 'viewers';

        if (group.icon) {
            gameHeader.appendChild(makeImageElement(group.icon.replace('{width}', '40').replace('{height}', '53'), group.name, 'game-icon'));
        }
        gameHeader.appendChild(makeElement('div', { class: 'game-group-info' }, null, el => {
            el.appendChild(makeElement('div', { class: 'game-group-name' }, group.name));
            el.appendChild(makeElement('div', { class: 'game-group-stats' }, `${channelCount} ${channelText} • ${totalViewers.toLocaleString()} ${viewersText}`));
        }));

        container.appendChild(gameHeader);

        group.channels.sort((a, b) => {
            if (a.watching !== b.watching) return b.watching ? 1 : -1;
            if (a.online !== b.online) return b.online ? 1 : -1;
            return (b.viewers || 0) - (a.viewers || 0);
        });

        group.channels.forEach(channel => {
            const div = document.createElement('div');
            div.id = `channel-${channel.id}`; // Assigned ID for targeted updates
            div.className = 'channel-item';
            if (channel.watching) div.classList.add('watching');
            if (channel.online) div.classList.add('online');
            else div.classList.add('offline');

            const nameDiv = makeElement('div', { class: 'channel-name' }, channel.name, el => {
                if (channel.drops_enabled) {
                    el.appendChild(document.createTextNode(' '));
                    el.appendChild(makeElement('span', { class: 'channel-badge drops' }, 'DROPS'));
                }
                if (channel.acl_based) {
                    el.appendChild(document.createTextNode(' '));
                    el.appendChild(makeElement('span', { class: 'channel-badge acl' }, 'ACL'));
                }
            });
            const infoDiv = makeElement('div', { class: 'channel-info' }, channel.viewers !== null ? channel.viewers.toLocaleString() + ' viewers' : 'Offline', el => {
                if (channel.watching) {
                    el.appendChild(document.createTextNode(' • '));
                    el.appendChild(makeElement('strong', {}, 'WATCHING'));
                }
            });
            div.replaceChildren(nameDiv, infoDiv);

            div.onclick = () => selectChannel(channel.id);
            container.appendChild(div);
        });
    });
}
