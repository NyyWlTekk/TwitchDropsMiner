/////////////////////////////////////////////////////
////////////CHANNELS WATCHED/////////////////////////
/////////////////////////////////////////////////////

let renderChannelsTimeout = null;

/**
 * Debounces channels rendering to prevent DOM render spamming during rapid websocket updates.
 */
function scheduleRenderChannels() {
    if (renderChannelsTimeout) {
        clearTimeout(renderChannelsTimeout);
    }
    
    // Batch multiple fast updates and wait for them to settle before re-rendering
    renderChannelsTimeout = setTimeout(() => {
        renderChannels();
        renderChannelsTimeout = null;
    }, 250);
}

function hasImportantChange(oldData, newData) {
    if (!oldData) return true;

    // Critical structural changes affecting order or badges
    if (oldData.game !== newData.game ||
        oldData.online !== newData.online ||
        oldData.drops_enabled !== newData.drops_enabled ||
        oldData.acl_based !== newData.acl_based) {
        return true;
    }

    // Dynamic viewer change check (percentage + minimum threshold guard)
    const oldViewers = oldData.viewers || 0;
    const newViewers = newData.viewers || 0;
    const viewerDiff = Math.abs(oldViewers - newViewers);

    // Trigger full re-render only if change is at least 15% AND at least 5 viewers difference
    const percentChange = oldViewers > 0 ? (viewerDiff / oldViewers) : 1;
    return viewerDiff >= 5 && percentChange >= 0.15;
}

function updateChannel(channelData) {
    if (!channelData || !channelData.id) return;
    const existing = state.channels[channelData.id];

    // 1. Completely ignore update if data is identical
    if (existing && JSON.stringify(existing) === JSON.stringify(channelData)) {
        return;
    }

    // Preserve watching status if not explicitly passed
    if (existing && channelData.watching === undefined) {
        channelData.watching = existing.watching;
    }

    // 2. Targeted DOM update if no structural/important changes occurred
    if (existing && !hasImportantChange(existing, channelData)) {
        const watchingChanged = existing.watching !== channelData.watching;
        state.channels[channelData.id] = channelData;

        const channelEl = document.getElementById(`channel-${channelData.id}`);
        if (channelEl) {
            if (watchingChanged) {
                channelEl.classList.toggle('watching', !!channelData.watching);
            }

            const viewerEl = channelEl.querySelector('.channel-info');
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
    
    // Direct DOM removal if element exists to avoid full re-render
    const el = document.getElementById(`channel-${channelId}`);
    if (el) {
        el.remove();
    } else {
        scheduleRenderChannels();
    }
}

function clearChannels() {
    console.log('[Channels] Clearing all channels from state');
    state.channels = {};
    scheduleRenderChannels();
}

function setWatchingChannel(channelId) {
    console.log(`[Channels] Setting active watching channel ID: '${channelId}'`);
    
    // Update watching state and perform targeted DOM class toggles
    Object.values(state.channels).forEach(ch => {
        const isTarget = String(ch.id) === String(channelId);
        if (ch.watching !== isTarget) {
            ch.watching = isTarget;
            
            const el = document.getElementById(`channel-${ch.id}`);
            if (el) {
                el.classList.toggle('watching', isTarget);
                const viewerEl = el.querySelector('.channel-info');
                if (viewerEl) {
                    const viewersText = ch.viewers !== null ? `${ch.viewers.toLocaleString()} viewers` : 'Offline';
                    if (isTarget) {
                        viewerEl.replaceChildren(
                            document.createTextNode(viewersText + ' • '),
                            makeElement('strong', {}, 'WATCHING')
                        );
                    } else {
                        viewerEl.textContent = viewersText;
                    }
                }
            }
        }
    });
}

function clearWatchingChannel() {
    console.log('[Channels] Clearing watching state for all channels');
    Object.values(state.channels).forEach(ch => {
        if (ch.watching) {
            ch.watching = false;
            const el = document.getElementById(`channel-${ch.id}`);
            if (el) {
                el.classList.remove('watching');
                const viewerEl = el.querySelector('.channel-info');
                if (viewerEl) {
                    viewerEl.textContent = ch.viewers !== null ? `${ch.viewers.toLocaleString()} viewers` : 'Offline';
                }
            }
        }
    });
}

/**
 * Resolves game boxart icon URL accurately from channel object or state.campaigns fallback
 */
function resolveGameIconUrl(channel) {
    if (!channel) return null;

    // Helper to extract image URL from any known structure
    const extractBoxArt = (obj) => {
        if (!obj) return null;
        const g = (typeof obj.game === 'object' && obj.game !== null) ? obj.game : {};
        return obj.game_box_art_url || obj.gameBoxArtURL || obj.gameBoxArtUrl ||
               obj.game_icon || obj.gameIcon || obj.box_art_url || obj.boxArtURL || obj.boxArtUrl ||
               obj.icon_url || obj.iconURL || obj.iconUrl || obj.image_url || obj.imageUrl ||
               g.box_art_url || g.boxArtURL || g.boxArtUrl || g.icon_url || g.iconURL || g.image_url;
    };

    // 1. Try resolving directly from channel object
    let iconUrl = extractBoxArt(channel);

    // 2. Fallback lookup in state.campaigns if icon is missing on channel
    if (!iconUrl && typeof state !== 'undefined' && state.campaigns) {
        const gameId = channel.game_id ? String(channel.game_id) : null;
        const gameName = channel.game ? String(channel.game).trim().toLowerCase() : null;

        const campaigns = state.campaigns;
        const campaignList = Array.isArray(campaigns) ? campaigns : Object.values(campaigns);

        for (let i = 0; i < campaignList.length; i++) {
            const camp = campaignList[i];
            if (!camp) continue;

            const campGameId = camp.game_id || (typeof camp.game === 'object' ? camp.game?.id : null);
            const campGameName = camp.game_name || (typeof camp.game === 'string' ? camp.game : camp.game?.name);

            const matchesId = gameId && campGameId && String(campGameId) === gameId;
            const matchesName = gameName && campGameName && String(campGameName).trim().toLowerCase() === gameName;

            if (matchesId || matchesName) {
                iconUrl = extractBoxArt(camp);
                if (iconUrl) break;
            }
        }
    }

    if (!iconUrl) return null;

    // 3. Format template placeholders if present
    if (typeof iconUrl === 'string' && (iconUrl.includes('{width}') || iconUrl.includes('{height}'))) {
        return iconUrl.replace('{width}', '40').replace('{height}', '53');
    }

    return iconUrl;
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
        
        // Dynamic icon resolution via channel data or campaign fallback
        const gameIcon = resolveGameIconUrl(channel);

        if (!gameGroups[gameId]) {
            gameGroups[gameId] = {
                name: gameName,
                icon: gameIcon,
                channels: []
            };
        } else if (!gameGroups[gameId].icon && gameIcon) {
            // Update group icon if previously missing channel had no icon, but current channel has one
            gameGroups[gameId].icon = gameIcon;
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
            // Retrieve image from global cache if available, fallback to basic image element builder
            const imgEl = (typeof getCachedImage === 'function')
                ? getCachedImage(group.icon, group.name, 'game-icon')
                : makeImageElement(group.icon, group.name, 'game-icon');

            gameHeader.appendChild(imgEl);
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
            div.id = `channel-${channel.id}`;
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

async function selectChannel(channelId) {
    try {
        console.debug('[Channel] Selecting channel:', channelId);
        const response = await fetch('/api/channels/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_id: channelId })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Failed to select channel:', errorData.detail || 'Unknown error');
            if (typeof addConsoleLine === 'function') addConsoleLine(`Error selecting channel: ${errorData.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Failed to select channel:', error);
        if (typeof addConsoleLine === 'function') addConsoleLine(`Error selecting channel: ${error.message}`);
    }
}

