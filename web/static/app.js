// Twitch Drops Miner Web Client
// Socket.IO and API communication


let selectedInventoryGames = [];
let availableGames = new Set(); // All games from campaigns
let draggedElement = null;

// Global state
const state = {
    connected: false,
    channels: {},
    campaigns: {},
    settings: {},
    currentDrop: null,
    countdownTimer: null,  // Track the active countdown timer
    translations: {}  // Store current translations
};

const imageCache = new Map();

function getCachedImage(url, alt, className, styles = {}) {
    if (!url) return null;
    
    if (imageCache.has(url)) {
        const cachedImg = imageCache.get(url).cloneNode(true);
        Object.assign(cachedImg.style, styles);
        return cachedImg;
    }

    const imgEl = document.createElement('img');
    imgEl.src = url;
    if (alt) imgEl.alt = alt;
    if (className) imgEl.className = className;
    Object.assign(imgEl.style, styles);

    imageCache.set(url, imgEl);
    return imgEl.cloneNode(true);
}

// ==================== Version Checking ====================

async function fetchAndDisplayVersion() {
    try {
        const response = await fetch('/api/version');
        if (!response.ok) throw new Error('Failed to fetch version');

        const data = await response.json();
        const versionElement = document.getElementById('current-version');
        if (versionElement) {
            let versionText = data.current_version;
            // Add (latest) indicator if we know the latest version and it matches
            if (data.latest_version && data.current_version === data.latest_version) {
                versionText += ' (latest)';
            }
            versionElement.textContent = versionText;

            // Translate footer version text
            const footerVersionText = document.getElementById('footer-version-text');
            if (footerVersionText && state.translations.gui?.footer) {
                const versionLabel = state.translations.gui.footer.version || 'Version:';
                // Preserve the span inside
                const span = footerVersionText.querySelector('span');
                footerVersionText.textContent = versionLabel + ' ';
                footerVersionText.appendChild(span);
            }
        }

        // Display update notification if available
        if (data.update_available && data.latest_version) {
            const updateIndicator = document.getElementById('footer-update-indicator');
            const latestVersionSpan = document.getElementById('latest-version');
            const updateLink = document.getElementById('footer-update-link');

            if (updateIndicator && latestVersionSpan && updateLink) {
                latestVersionSpan.textContent = data.latest_version;
                updateLink.href = data.download_url;
                updateIndicator.style.display = 'inline-block';

                // Translate update message
                if (state.translations.gui?.footer) {
                    const updateLabel = state.translations.gui.footer.update_available || 'Update Available:';
                    const linkText = document.createTextNode(` ⚠ ${updateLabel} `);
                    // Clear existing text nodes but keep the span
                    const span = updateLink.querySelector('span'); // latest-version span
                    updateLink.textContent = '';
                    updateLink.appendChild(linkText);
                    updateLink.appendChild(span);
                }

                // Log to console
                console.log(`Update available: ${data.latest_version} (current: ${data.current_version})`);
            }
        }
    } catch (error) {
        console.warn('Could not fetch version information:', error);
        // Set placeholder text if fetch fails
        const versionElement = document.getElementById('current-version');
        const loadingText = state.translations.gui?.footer?.loading || 'Loading...';
        if (versionElement && versionElement.textContent === loadingText) {
            versionElement.textContent = 'Unknown';
        }
    }
}

// Initialize Socket.IO connection
const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

// ==================== Socket.IO Event Handlers ====================

socket.on('connect', () => {
    console.log('Connected to server');
    state.connected = true;
    const connText = state.translations.gui?.websocket?.connected || 'Connected';
    document.getElementById('connection-indicator').textContent = '● ' + connText;
    document.getElementById('connection-indicator').className = 'connected';
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    state.connected = false;
    const disconnText = state.translations.gui?.websocket?.disconnected || 'Disconnected';
    document.getElementById('connection-indicator').textContent = '● ' + disconnText;
    document.getElementById('connection-indicator').className = 'disconnected';
});

socket.on('initial_state', (data) => {
    console.log('Received initial state', data);
    if (data.status) updateStatus(data.status);

    // Batch update channels to prevent UI freezing
    if (data.channels) {
        data.channels.forEach(ch => {
            state.channels[ch.id] = ch;
        });
        renderChannels();
    }

    // Batch update campaigns to prevent UI freezing
    if (data.campaigns) {
        data.campaigns.forEach(camp => {
            state.campaigns[camp.id] = camp;
        });
        renderInventory();
    }

    // Batch update console logs
    if (data.console) {
        const consoleEl = document.getElementById('console-output');
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

    if (data.settings) updateSettingsUI(data.settings);
    if (data.login) updateLoginStatus(data.login);
    if (data.manual_mode) updateManualModeUI(data.manual_mode);
    // Restore current drop progress if it exists
    if (data.current_drop) {
        updateDropProgress(data.current_drop);
    } else {
        clearDropProgress();
    }

    if (data.wanted_items) {
        renderWantedItems(data.wanted_items);
    }

	// Update the checkbox UI from server settings and apply auto-sort and autoadd if active
	const autosortEl = document.getElementById('auto-sort-by-end');
	if (autosortEl && data.settings) {
		autosortEl.checked = data.settings.auto_sort_by_end || false;
		applyAutoSortIfNeeded();
	}
	
	const autoaddEl = document.getElementById('auto-add-all-games');
	if (autoaddEl && data.settings) {
		autoaddEl.checked = data.settings.auto_add_all_games || false;
		applyAutoAddIfNeeded();
	}
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
    updateDropProgress(data);
});

socket.on('drop_progress_stop', () => {
    clearDropProgress();
});

socket.on('campaign_add', (data) => {
    addCampaign(data);
});

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

function updateDrop(campaignId, updatedDrop) {
    // 1. Najdeme kampaň v paměti frontendu
    // (uprav 'state.campaigns' podle toho, v jaké proměnné držíš seznam kampaní)
    const campaignList = state.campaignsQueue || state.campaigns || [];
    const campaign = campaignList.find(c => c.id === campaignId);
    
    if (!campaign) return;

    // 2. Aktualizujeme data konkrétního dropu
    const dropsList = campaign.drops || campaign.time_based_drops || [];
    const dropIndex = dropsList.findIndex(d => d.id === updatedDrop.id);
    
    if (dropIndex !== -1) {
        dropsList[dropIndex] = { ...dropsList[dropIndex], ...updatedDrop };
    }

    // 3. ⚡ OKAMŽITÝ RE-RENDER
    // Vynutíme přepočet 5/5 claimed, přepnutí na Completed a prekreslení karty kampaně
    if (typeof renderCampaign === 'function') {
        renderCampaign(campaign);
    } else if (typeof renderInventory === 'function') {
        renderInventory();
    }
}

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

// ==================== UI Update Functions ====================
// ================================================================

function updateStatus(status) {
    const statusEl = document.getElementById('status-text');
    if (statusEl) {
        statusEl.textContent = status;
    }
}

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

function updateChannel(channelData) {
    state.channels[channelData.id] = channelData;
    renderChannels();
}

function removeChannel(channelId) {
    delete state.channels[channelId];
    renderChannels();
}

function clearChannels() {
    state.channels = {};
    renderChannels();
}

function setWatchingChannel(channelId) {
    Object.values(state.channels).forEach(ch => ch.watching = false);
    if (state.channels[channelId]) {
        state.channels[channelId].watching = true;
    }
    renderChannels();
}

function clearWatchingChannel() {
    Object.values(state.channels).forEach(ch => ch.watching = false);
    renderChannels();
}

function renderChannels() {
    const container = document.getElementById('channels-list');
    if (!container) return;

    const t = state.translations || {};
    const channels = Object.values(state.channels);
    if (channels.length === 0) {
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

// ==================== Active Drop & Campaign Rotation ====================

// Initialize state variables if not already defined
if (!state.activeCampaignsQueue) state.activeCampaignsQueue = [];
if (state.campaignRotationIndex === undefined) state.campaignRotationIndex = 0;
if (!state.activeDropsQueue) state.activeDropsQueue = [];
if (state.dropRotationIndex === undefined) state.dropRotationIndex = 0;
if (!state.rotationTimer) state.rotationTimer = null;
if (!state.countdownTimer) state.countdownTimer = null;

let dropTotalSeconds = 0;

/**
 * Helper to universally check if a drop or campaign is claimed
 */
function isItemClaimed(item) {
    if (!item) return true;
    return item.is_claimed === true || 
           item.claimed === true || 
           item.isClaimed === true || 
           item.status === 'CLAIMED';
}

/**
 * Helper to retrieve campaign and its drops list accurately
 */
function getCampaignAndDrops(queueItem) {
    if (!queueItem) return { campaign: null, drops: [] };

    if (queueItem.drops) {
        const drops = Array.isArray(queueItem.drops) ? queueItem.drops : Object.values(queueItem.drops);
        return { campaign: queueItem, drops };
    }

    if (state.campaigns && queueItem.campaign_id) {
        const campaignsArray = Array.isArray(state.campaigns) ? state.campaigns : Object.values(state.campaigns);
        const found = campaignsArray.find(c => c && (c.id === queueItem.campaign_id || c.campaign_id === queueItem.campaign_id));
        if (found && found.drops) {
            const drops = Array.isArray(found.drops) ? found.drops : Object.values(found.drops);
            return { campaign: found, drops };
        }
    }

    return { campaign: queueItem, drops: [queueItem] };
}

/**
 * Formats seconds into readable time (e.g. 1d 2h 3m, 2h 05m, or 5:00)
 */
function formatTime(secs) {
    if (isNaN(secs) || secs < 0) return '0:00';

    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const remSecs = secs % 60;

    if (days > 0) {
        return `${days}d ${hours}h ${mins}m`;
    } else if (hours > 0) {
        return `${hours}h ${mins.toString().padStart(2, '0')}m`;
    } else {
        return `${mins}:${remSecs.toString().padStart(2, '0')}`;
    }
}

/**
 * Clear or reset drop progress UI components
 */
function clearDropProgress() {
    state.currentDrop = null;
    dropTotalSeconds = 0;
    
    if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'block';
    if (dropInfo) dropInfo.style.display = 'none';

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = '0%';
        fill.textContent = '0%';
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) {
        progressText.textContent = '0 / 0 min';
    }

    const timeEl = document.getElementById('progress-time');
    if (timeEl) {
        timeEl.textContent = 'Time remaining: 0:00';
    }
}

/**
 * Live 1-Second Countdown Timer for active drop
 */
function updateRemainingTime(initialSeconds, forceReset = false) {
    // Keep running timer uninterrupted if showing the same drop
    if (state.countdownTimer && !forceReset) {
        return;
    }

    if (state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
    }

    let remaining = Math.max(0, Math.floor(initialSeconds));

    function tick() {
        const timeEl = document.getElementById('progress-time');
        
        if (timeEl) {
            const reqSecs = (state.currentDrop?.required_minutes || 0) * 60;
            timeEl.textContent = `Time remaining: ${formatTime(remaining)} / ${formatTime(reqSecs)}`;
        }

        if (remaining <= 0) {
            if (state.countdownTimer) {
                clearInterval(state.countdownTimer);
                state.countdownTimer = null;
            }
            return;
        }

        remaining--;
        if (state.currentDrop) {
            state.currentDrop.remaining_seconds = remaining;
        }
    }

    tick();
    state.countdownTimer = setInterval(tick, 1000);
}

/**
 * Combined rotation timer for active campaigns and drops
 */
function startCombinedRotation(forceRestart = true) {
    if (state.rotationTimer && !forceRestart) {
        return; 
    }

    if (state.rotationTimer) {
        clearInterval(state.rotationTimer);
        state.rotationTimer = null;
    }

    const executeRotationStep = () => {
        const rawQueue = state.activeCampaignsQueue || [];

        const validCampaigns = rawQueue.filter(c => {
            if (isItemClaimed(c)) return false;
            const { drops } = getCampaignAndDrops(c);
            if (drops.length === 0) return true;
            return drops.some(d => !isItemClaimed(d));
        });

        if (validCampaigns.length === 0) {
            return;
        }

        if (state.campaignRotationIndex >= validCampaigns.length || state.campaignRotationIndex < 0) {
            state.campaignRotationIndex = 0;
            state.dropRotationIndex = 0;
        }

        let currentCampaign = validCampaigns[state.campaignRotationIndex];
        const { drops: cDrops } = getCampaignAndDrops(currentCampaign);
        let activeDrops = cDrops.length > 0 ? cDrops.filter(d => !isItemClaimed(d)) : [currentCampaign];

        if (state.dropRotationIndex >= activeDrops.length || state.dropRotationIndex < 0) {
            state.dropRotationIndex = 0;
        }

        if (currentCampaign && typeof switchCampaignDisplay === 'function') {
            switchCampaignDisplay(currentCampaign, false); 
        }

        // Only increment index if there are multiple campaigns or drops to cycle through
        if (validCampaigns.length > 1 || activeDrops.length > 1) {
            state.dropRotationIndex++;

            if (state.dropRotationIndex >= activeDrops.length) {
                state.dropRotationIndex = 0;
                state.campaignRotationIndex++;
                
                if (state.campaignRotationIndex >= validCampaigns.length) {
                    state.campaignRotationIndex = 0;
                }
            }
        }
    };

    executeRotationStep();
    state.rotationTimer = setInterval(executeRotationStep, 4000);
}

/**
 * Render single drop progress bar
 */
function renderAllProgressBars(currentMins, dropData, elapsedSecsOverride = null) {
    const reqMins = dropData.required_minutes || 1;
    let dropPercentage = 0;

    const elapsedSecs = elapsedSecsOverride !== null
        ? elapsedSecsOverride
        : (dropTotalSeconds - (dropData.remaining_seconds || 0));

    if (dropTotalSeconds > 0) {
        dropPercentage = Math.min(100, Math.max(0, (elapsedSecs / dropTotalSeconds) * 100));
    } else {
        dropPercentage = (currentMins / reqMins) * 100;
    }

    const fill = document.getElementById('progress-fill');
    if (fill) {
        fill.style.width = `${dropPercentage.toFixed(1)}%`;
        fill.textContent = `${Math.round(dropPercentage)}%`;
    }

    const progressText = document.getElementById('progress-text');
    if (progressText) {
        progressText.textContent = `${currentMins} / ${reqMins} min`;
    }

    updateCampaignProgressData(dropData, currentMins);
    updateOverallProgress();
}

/**
 * Render single drop UI component with memory caching for zero-stutter rotation
 */
function updateSingleDropDisplay(data) {
    if (!data) return;
    
    // Helper for claim checking
    const isClaimedSafe = (item) => {
        if (!item) return true;
        if (item.claimed || item.is_claimed || item.isClaimed) return true;
        try {
            if (typeof isItemClaimed === 'function') {
                return isItemClaimed(item);
            }
        } catch (e) {}
        return false;
    };

    const reqMins = Number(data.required_minutes || 1);
    const curMins = Number(data.current_minutes || 0);

    // Automatically remove/skip completed or claimed drops immediately without requiring a page refresh
    if (isClaimedSafe(data) || curMins >= reqMins) {
        if (state.activeDropsQueue && Array.isArray(state.activeDropsQueue)) {
            const dropIdToClean = data.drop_id || data.id;
            state.activeDropsQueue = state.activeDropsQueue.filter(d => (d.drop_id || d.id) !== dropIdToClean);
        }
        if (typeof startCombinedRotation === 'function') {
            startCombinedRotation(true);
        }
        return;
    }

    state.currentDrop = data;

    const currentSecs = curMins * 60;
    // Strictly calculate remaining seconds based on current and required minutes to prevent desyncs (e.g. 3h 11m bug)
    const remSecs = Math.max(0, (reqMins - curMins) * 60);
    dropTotalSeconds = currentSecs + remSecs;

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'none';
    if (dropInfo) dropInfo.style.display = 'block';

    const rewardImgUrl = data.image_url ||
        data.reward_image_url ||
        data.icon_url ||
        data.benefit_icon_url ||
        data.reward?.image_url ||
        data.reward?.icon_url ||
        data.benefit?.image_url ||
        data.benefits?.[0]?.image_url ||
        data.benefit_edges?.[0]?.node?.asset_url ||
        data.benefit_edges?.[0]?.node?.image_url;

    const dropNameEl = document.getElementById('drop-name');
    if (dropNameEl) {
        const rawQueue = state.activeCampaignsQueue || [];
        const validCampaigns = rawQueue.filter(c => {
            if (isClaimedSafe(c)) return false;
            const { drops } = getCampaignAndDrops(c);
            return drops.length === 0 || drops.some(d => !isClaimedSafe(d));
        });
        
        const queueLength = validCampaigns.length > 0 ? validCampaigns.length : 1;
        const currentIndex = (state.campaignRotationIndex !== undefined ? state.campaignRotationIndex : 0) + 1;
        
        dropNameEl.textContent = `${data.game_name || ''} (${currentIndex}/${queueLength})`;
    }

    const dropGameEl = document.getElementById('drop-game');
    if (dropGameEl) {
        let boxArtUrl = data.game_box_art_url;
        if (!boxArtUrl && state.campaigns && data.campaign_id) {
            const foundCampaign = state.campaigns[data.campaign_id] ||
                Object.values(state.campaigns).find(c => c && (c.id === data.campaign_id || c.campaign_id === data.campaign_id));
            if (foundCampaign) {
                boxArtUrl = foundCampaign.game_box_art_url || foundCampaign.box_art_url || foundCampaign.art_url;
            }
        }

        dropGameEl.style.display = 'flex';
        dropGameEl.style.alignItems = 'center';
        dropGameEl.style.gap = '12px';
        dropGameEl.style.margin = '8px 0';

        const children = [];

        if (boxArtUrl) {
            const iconUrl = boxArtUrl.replace('{width}', '52').replace('{height}', '70');
            const imgEl = getCachedImage(iconUrl, data.game_name || '', 'game-icon', {
                width: '42px',
                height: '56px',
                borderRadius: '6px',
                objectFit: 'cover',
                flexShrink: '0'
            });
            if (imgEl) children.push(imgEl);
        }

        if (typeof makeElement === 'function') {
            const infoTextDiv = makeElement('div', { class: 'drop-game-text-info' });
            infoTextDiv.style.display = 'flex';
            infoTextDiv.style.flexDirection = 'column';
            infoTextDiv.style.justifyContent = 'center';

            if (data.campaign_id) {
                const campaignUrl = `https://www.twitch.tv/drops/campaigns?dropID=${data.campaign_id}`;
                const linkEl = makeElement('a', { href: campaignUrl, target: '_blank', rel: 'noopener noreferrer', class: 'drop-campaign-link' }, data.campaign_name || '');
                const subText = makeElement('span', { class: 'drop-sub-name' }, data.drop_name || '');
                subText.style.fontSize = '0.9em';
                subText.style.opacity = '0.85';

                infoTextDiv.appendChild(linkEl);
                infoTextDiv.appendChild(subText);
            } else {
                const titleEl = makeElement('span', { class: 'drop-campaign-title' }, data.campaign_name || '');
                const subText = makeElement('span', { class: 'drop-sub-name' }, data.drop_name || '');
                subText.style.fontSize = '0.9em';
                subText.style.opacity = '0.85';

                infoTextDiv.appendChild(titleEl);
                infoTextDiv.appendChild(subText);
            }

            children.push(infoTextDiv);
        }

        dropGameEl.replaceChildren(...children);
    }

    const currentDropLabel = document.getElementById('current-drop-label');
    if (currentDropLabel) {
        const dropQueueLen = state.activeDropsQueue && state.activeDropsQueue.length > 0 ? state.activeDropsQueue.length : 1;
        const dropIdx = (state.dropRotationIndex !== undefined ? state.dropRotationIndex : 0) + 1;

        currentDropLabel.textContent = `⚡ Drop (${dropIdx}/${dropQueueLen}): ${data.drop_name || ''}`;

        let cardOuter = currentDropLabel.closest('.drop-card-container');
        
        if (!cardOuter) {
            const progressTime = document.getElementById('progress-time');
            const progressFill = document.getElementById('progress-fill');
            let parentSearch = currentDropLabel.parentElement;

            while (parentSearch && parentSearch !== document.body) {
                if ((progressTime && parentSearch.contains(progressTime)) || (progressFill && parentSearch.contains(progressFill))) {
                    cardOuter = parentSearch;
                    cardOuter.classList.add('drop-card-container');
                    break;
                }
                parentSearch = parentSearch.parentElement;
            }
        }

        if (cardOuter) {
            let rightCol = cardOuter.querySelector('#drop-card-right-col');
            let leftImg = cardOuter.querySelector('#drop-card-left-img');

            if (!rightCol) {
                rightCol = document.createElement('div');
                rightCol.id = 'drop-card-right-col';
                rightCol.style.flex = '1';
                rightCol.style.display = 'flex';
                rightCol.style.flexDirection = 'column';
                rightCol.style.justifyContent = 'space-between';
                rightCol.style.gap = '6px';
                rightCol.style.minWidth = '0';

                while (cardOuter.firstChild) {
                    rightCol.appendChild(cardOuter.firstChild);
                }

                cardOuter.style.display = 'flex';
                cardOuter.style.flexDirection = 'row';
                cardOuter.style.alignItems = 'stretch';
                cardOuter.style.gap = '12px';

                cardOuter.appendChild(rightCol);
            }

            if (rewardImgUrl) {
                if (!leftImg || !cardOuter.contains(leftImg)) {
                    leftImg = document.createElement('img');
                    leftImg.id = 'drop-card-left-img';
                    cardOuter.insertBefore(leftImg, rightCol);
                }
                leftImg.src = rewardImgUrl;
                leftImg.alt = data.drop_name || '';
                leftImg.style.width = '72px';
                leftImg.style.height = 'auto';
                leftImg.style.maxHeight = '100%';
                leftImg.style.alignSelf = 'center';
                leftImg.style.objectFit = 'contain';
                leftImg.style.borderRadius = '6px';
                leftImg.style.flexShrink = '0';
                leftImg.style.display = 'block';
            } else if (leftImg) {
                leftImg.remove();
            }
        }
    }

    renderAllProgressBars(curMins, data);
    updateRemainingTime(remSecs);
}

/**
 * Switch campaign display and prepare drops queue with automatic cleanup of claimed items
 */
function switchCampaignDisplay(data, isManualSwitch = true) {
    if (!data) return;

    // Automatically clean up claimed campaigns from the active queue so they disappear without a full refresh
    if (state.activeCampaignsQueue && Array.isArray(state.activeCampaignsQueue)) {
        state.activeCampaignsQueue = state.activeCampaignsQueue.filter(c => {
            if (typeof isItemClaimed === 'function' && isItemClaimed(c)) return false;
            if (c.claimed || c.is_claimed || c.isClaimed) return false;
            
            let cDrops = [];
            try {
                if (typeof getCampaignAndDrops === 'function') {
                    const res = getCampaignAndDrops(c);
                    if (res) {
                        if (Array.isArray(res.drops)) cDrops = res.drops;
                        else if (res.drops && typeof res.drops === 'object') cDrops = Object.values(res.drops);
                        else if (Array.isArray(res)) cDrops = res;
                    }
                }
            } catch (e) {}
            
            if (cDrops.length === 0 && c.drops) {
                cDrops = Array.isArray(c.drops) ? c.drops : Object.values(c.drops);
            }
            
            if (cDrops.length === 0) return true;
            return cDrops.some(d => {
                if (!d) return false;
                if (d.claimed || d.is_claimed || d.isClaimed) return false;
                if (typeof isItemClaimed === 'function' && isItemClaimed(d)) return false;
                return true;
            });
        });
    }

    const previousDropId = state.currentDrop ? (state.currentDrop.drop_id || state.currentDrop.id) : null;

    const { drops } = getCampaignAndDrops(data);

    if (drops.length > 0) {
        if (data.drop_id) {
            const targetDrop = drops.find(d => (d.id || d.drop_id) === data.drop_id);
            if (targetDrop) {
                if (data.current_minutes !== undefined) targetDrop.current_minutes = data.current_minutes;
                if (data.required_minutes !== undefined) targetDrop.required_minutes = data.required_minutes;
                if (data.remaining_seconds !== undefined) targetDrop.remaining_seconds = data.remaining_seconds;
                if (data.is_claimed !== undefined) targetDrop.is_claimed = data.is_claimed;
            }
        }

        const unclaimedDrops = drops.filter(d => !isItemClaimed(d));
        const targetDrops = unclaimedDrops.length > 0 ? unclaimedDrops : drops;

        state.activeDropsQueue = targetDrops.map(d => {
            const dropImg = d.image_url ||
                d.reward_image_url ||
                d.icon_url ||
                d.benefit_icon_url ||
                d.reward?.image_url ||
                d.benefit?.image_url ||
                d.benefits?.[0]?.image_url ||
                d.benefit_edges?.[0]?.node?.asset_url ||
                data.image_url;

            const curMins = d.current_minutes !== undefined ? d.current_minutes : (data.current_minutes || 0);
            const reqMins = d.required_minutes || data.required_minutes || 1;

            return {
                ...data,
                drop_id: d.id || d.drop_id,
                drop_name: d.name || d.drop_name,
                image_url: dropImg,
                current_minutes: curMins,
                required_minutes: reqMins,
                remaining_seconds: d.remaining_seconds !== undefined 
                    ? d.remaining_seconds 
                    : Math.max(0, (reqMins - curMins) * 60)
            };
        });

        if (isManualSwitch) {
            const idx = state.activeDropsQueue.findIndex(d => (d.drop_id || d.id) === data.drop_id);
            if (idx !== -1) {
                state.dropRotationIndex = idx;
            }
            if (typeof startCombinedRotation === 'function') {
                startCombinedRotation(true);
            }
        }
    } else {
        state.activeDropsQueue = [data];
    }

    if (Array.isArray(state.activeDropsQueue)) {
        state.activeDropsQueue.forEach(dropItem => {
            if (dropItem && dropItem.image_url) {
                const img = new Image();
                img.src = dropItem.image_url;
            }
        });
    }

    const initialActiveDrop = state.activeDropsQueue[state.dropRotationIndex] || state.activeDropsQueue[0] || data;
    const newDropId = initialActiveDrop ? (initialActiveDrop.drop_id || initialActiveDrop.id) : null;
    const dropChanged = !previousDropId || !newDropId || previousDropId !== newDropId;

    if (typeof updateSingleDropDisplay === 'function') {
        updateSingleDropDisplay(initialActiveDrop, dropChanged);
    }
}

/**
 * Handle incoming progress update
 */
function updateDropProgress(data) {
    if (!state.activeCampaignsQueue) {
        state.activeCampaignsQueue = [];
    }

    if (data.progress !== undefined && data.required_minutes) {
        if (data.progress <= 1.0 && data.current_minutes === undefined) {
            data.current_minutes = Math.floor(data.progress * data.required_minutes);
        }
    }

    const existingIndex = state.activeCampaignsQueue.findIndex(c => c.campaign_id === data.campaign_id);
    if (existingIndex !== -1) {
        state.activeCampaignsQueue[existingIndex] = { ...state.activeCampaignsQueue[existingIndex], ...data };
    } else {
        state.activeCampaignsQueue.push(data);
    }

    const isCurrentActive = !state.currentDrop || state.currentDrop.campaign_id === data.campaign_id;
    if (isCurrentActive || state.activeCampaignsQueue.length === 1) {
        switchCampaignDisplay(data, false);
    }

    startCombinedRotation(false);
}

/**
 * Update campaign level progress bar
 */
function updateCampaignProgressData(data, liveCurrentMins) {
    const campaignFill = document.getElementById('campaign-progress-fill');
    const campaignText = document.getElementById('campaign-progress-text');
    const campaignTitle = document.getElementById('campaign-progress-title');

    if (!campaignFill || !campaignText) return;

    if (!data || !data.campaign_id || !state.campaigns) {
        campaignFill.style.width = '0%';
        campaignFill.textContent = '0%';
        campaignText.textContent = '0 / 0 min';
        return;
    }

    const { campaign, drops } = getCampaignAndDrops(data);

    if (!campaign || drops.length === 0) {
        campaignFill.style.width = '0%';
        campaignFill.textContent = '0%';
        campaignText.textContent = `${liveCurrentMins} / ${data.required_minutes || 0} min`;
        return;
    }

    let maxReq = 0;
    let maxCur = 0;
    let currentIndex = 1;

    drops.forEach((d, index) => {
        let cur = Number(d.current_minutes) || 0;
        const req = Number(d.required_minutes) || 0;

        if (d.id === data.drop_id || d.drop_id === data.drop_id) {
            cur = liveCurrentMins;
            currentIndex = index + 1;
        }

        if (req > maxReq) {
            maxReq = req;
            maxCur = cur;
        }
    });

    if (campaignTitle && campaign.name) {
        campaignTitle.textContent = `${campaign.name} • Drop ${currentIndex}/${drops.length}`;
    }

    if (maxReq > 0) {
        const percentage = Math.min(100, Math.round((maxCur / maxReq) * 100));
        campaignFill.style.width = `${percentage}%`;
        campaignFill.textContent = `${percentage}%`;
        campaignText.textContent = `${maxCur} / ${maxReq} min`;
    } else {
        campaignFill.style.width = '0%';
        campaignFill.textContent = '0%';
        campaignText.textContent = '0 / 0 min';
    }
}

/**
 * Overall queue progress calculator reading directly from the global state
 */
function updateOverallProgress() {
    try {
        const overallFill = document.getElementById('overall-progress-fill');
        const overallText = document.getElementById('overall-progress-text');

        if (!overallFill || !overallText) return;

        // Retrieve queue tree directly from global state with fallback cache
        const queueTree = state.wantedItemsTree || window._lastValidWantedTree || [];

        if (!queueTree || queueTree.length === 0) {
            overallFill.style.width = '0%';
            overallFill.textContent = '';
            overallText.textContent = '0% (0 / 0 min)';
            
            const overallTimeEl = document.getElementById('overall-progress-time');
            if (overallTimeEl) {
                overallTimeEl.textContent = 'Total remaining time: 0m';
            }
            return;
        }

        // Cache valid data globally to prevent any flashing to zero
        window._lastValidWantedTree = queueTree;

        let totalCurrent = 0;
        let totalRequired = 0;
        let totalRemainingSecs = 0;

        // Process game groups from the global tree
        queueTree.forEach(gameGroup => {
            if (!gameGroup || !gameGroup.campaigns || !Array.isArray(gameGroup.campaigns)) return;

            let maxCampaignReq = 0;
            let maxCampaignCur = 0;
            let maxCampaignRemainingSecs = 0;

            // Find the longest campaign per game group
            gameGroup.campaigns.forEach(campaign => {
                if (!campaign || !campaign.drops || !Array.isArray(campaign.drops)) return;

                let campReq = 0;
                let campCur = 0;
                let campRemainingSecs = 0;

                campaign.drops.forEach(drop => {
                    if (!drop) return;

                    const req = Number(drop.required_minutes || drop.requiredMinutes || drop.duration || 0);
                    let cur = Number(drop.current_minutes || drop.currentMinutes || 0);
                    const isClaimed = Boolean(drop.is_claimed || drop.claimed || drop.isClaimed);

                    if (isClaimed) {
                        cur = req;
                    }
                    if (cur > req) cur = req;

                    campReq += req;
                    campCur += cur;

                    const dropRemaining = isClaimed ? 0 : Math.max(0, req - cur);
                    campRemainingSecs += dropRemaining * 60;
                });

                if (campReq > maxCampaignReq) {
                    maxCampaignReq = campReq;
                    maxCampaignCur = campCur;
                    maxCampaignRemainingSecs = campRemainingSecs;
                }
            });

            totalRequired += maxCampaignReq;
            totalCurrent += maxCampaignCur;
            totalRemainingSecs += maxCampaignRemainingSecs;
        });

        // Update UI progress bar
        if (totalRequired > 0) {
            const percentage = Math.min(100, Math.round((totalCurrent / totalRequired) * 100));
            overallFill.style.width = `${percentage}%`;
            overallFill.textContent = percentage > 5 ? `${percentage}%` : ''; 
            overallText.textContent = `${percentage}% (${totalCurrent} / ${totalRequired} min)`;
        } else {
            overallFill.style.width = '0%';
            overallFill.textContent = '';
            overallText.textContent = '0% (0 / 0 min)';
        }

        // Update UI remaining time label
        let overallTimeEl = document.getElementById('overall-progress-time');
        if (!overallTimeEl) {
            const parent = overallText.parentElement;
            if (parent) {
                overallTimeEl = document.createElement('div');
                overallTimeEl.id = 'overall-progress-time';
                overallTimeEl.style.fontSize = '0.85em';
                overallTimeEl.style.opacity = '0.8';
                overallTimeEl.style.marginTop = '4px';
                parent.appendChild(overallTimeEl);
            }
        }
        if (overallTimeEl) {
            const formattedTime = typeof formatTime === 'function' 
                ? formatTime(totalRemainingSecs) 
                : `${Math.ceil(totalRemainingSecs / 60)}m`;
            overallTimeEl.textContent = `Total remaining time: ${formattedTime}`;
        }

    } catch (e) {
        console.error('Error updating overall progress:', e);
    }
}

// ==================== Inventory Filtering ====================

function sortCampaigns(campaigns) {

    const now = Date.now();
    return [...campaigns].sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        
        // Active: Sort by ending soonest
        if (a.active) {
            const dateA = a.ends_at ? new Date(a.ends_at).getTime() : Infinity;
            const dateB = b.ends_at ? new Date(b.ends_at).getTime() : Infinity;
            return dateA - dateB;
        }
        
        const statusA = getCampaignStatus(a, now);
        const statusB = getCampaignStatus(b, now);
        
        // Upcoming: Prioritize over expired/finished
        if (statusA.isUpcoming !== statusB.isUpcoming) {
            return statusA.isUpcoming ? -1 : 1;
        }
        
        // Both upcoming: Sort by starting soonest
        if (statusA.isUpcoming) {
            const startsA = a.starts_at ? new Date(a.starts_at).getTime() : Infinity;
            const startsB = b.starts_at ? new Date(b.starts_at).getTime() : Infinity;
            return startsA - startsB;
        }
        
        // Both expired/finished: Sort by recently ended
        const endsAtA = a.ends_at ? new Date(a.ends_at).getTime() : 0;
        const endsAtB = b.ends_at ? new Date(b.ends_at).getTime() : 0;
        return endsAtB - endsAtA;
    });
}

function getInventoryFilters() {
    // Get filter state from UI checkboxes and selected games array
    return {
        show_active: document.getElementById('filter-active')?.checked || false,
        show_not_linked: document.getElementById('filter-not-linked')?.checked || false,
        show_upcoming: document.getElementById('filter-upcoming')?.checked || false,
        show_expired: document.getElementById('filter-expired')?.checked || false,
        show_finished: document.getElementById('filter-finished')?.checked || false,
        game_name_search: [...selectedInventoryGames],  // Array of selected game names
        // Benefit type filters (default to true if checkbox doesn't exist)
        show_benefit_item: document.getElementById('filter-benefit-item')?.checked !== false,
        show_benefit_badge: document.getElementById('filter-benefit-badge')?.checked !== false,
        show_benefit_emote: document.getElementById('filter-benefit-emote')?.checked !== false,
        show_benefit_other: document.getElementById('filter-benefit-other')?.checked !== false,
    };
}

// 1. Determines the precise lifecycle state of a campaign
// Helper to determine campaign status using both time and API flags
function getCampaignStatus(campaign, now = Date.now()) {
    const startsAt = campaign.starts_at ? new Date(campaign.starts_at).getTime() : 0;
    const endsAt = campaign.ends_at ? new Date(campaign.ends_at).getTime() : 0;

    // Check upcoming by local time OR by Twitch API flags
    const isUpcoming = (startsAt > now) || 
                            (campaign.status === 'UPCOMING') || 
                            (campaign.upcoming === true);

    // Check active by local time OR by Twitch API flags (must not be upcoming)
    const isActive = (((startsAt <= now && endsAt > now) || 
                      (campaign.status === 'ACTIVE') || 
                      (campaign.active === true)) && !isUpcoming);

    const isExpired = (endsAt > 0 && endsAt <= now) || (campaign.status === 'EXPIRED');
    // NOVÝ KÓD:
	const dropsList = campaign.drops || campaign.time_based_drops || [];
	const realClaimed = dropsList.length > 0 
		? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
		: (campaign.claimed_drops || 0);
	const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

	const isFinished = realTotal > 0 && realClaimed >= realTotal;

    return {
        isActive,
        isUpcoming,
        isExpired,
        isFinished
    };
}

// 2. Checks if a campaign matches status checkboxes
function matchesStatusFilters(campaign, filters, status) {
    const hasAnyFilter = filters.show_active || filters.show_not_linked ||
                         filters.show_upcoming || filters.show_expired || 
                         filters.show_finished;
    
    if (!hasAnyFilter) return true;

    // 1. Time status check (Active, Upcoming, Expired, Finished)
    const hasTimeFilter = filters.show_active || filters.show_upcoming || 
                          filters.show_expired || filters.show_finished;
    
    let matchesTime = !hasTimeFilter; // Default to true if no time filter is selected
    if (hasTimeFilter) {
        if (filters.show_finished && status.isFinished) matchesTime = true;
        if (filters.show_expired && status.isExpired && !status.isFinished) matchesTime = true;
        
        // TADY: Pokud je zaškrtnuté Upcoming a kampaň je podle času vyhodnocena jako nadcházející
        if (filters.show_upcoming && status.isUpcoming && !status.isFinished) matchesTime = true;
        
        if (filters.show_active && status.isActive && !status.isFinished && !status.isUpcoming) matchesTime = true;
    }

    // 2. Connection status check (Not Linked)
    let matchesLink = true;
    if (!campaign.linked) {
        matchesLink = filters.show_not_linked;
    } else {
        if (filters.show_not_linked && !hasTimeFilter) {
            matchesLink = false;
        }
    }

    return matchesTime && matchesLink;
}

// 3. Checks if a campaign matches the search query
function matchesGameFilter(campaign, filters) {
    if (!filters.game_name_search || filters.game_name_search.length === 0) return true;
    return filters.game_name_search.includes(campaign.game_name);
}

// 4. Checks if a campaign has drops matching selected reward types
function matchesBenefitFilter(campaign, filters) {
    const allBenefitsEnabled = filters.show_benefit_item && filters.show_benefit_badge &&
                               filters.show_benefit_emote && filters.show_benefit_other;
    
    if (allBenefitsEnabled || !campaign.drops) return true;

    const hasBenefitFilter = filters.show_benefit_item || filters.show_benefit_badge || 
                             filters.show_benefit_emote || filters.show_benefit_other;
    if (!hasBenefitFilter) return true;

    for (const drop of campaign.drops) {
        if (!drop.benefits) continue;
        for (const benefit of drop.benefits) {
            const benefitType = (benefit.type || '').toUpperCase();
            if (filters.show_benefit_item && benefitType === 'DIRECT_ENTITLEMENT') return true;
            if (filters.show_benefit_badge && benefitType === 'BADGE') return true;
            if (filters.show_benefit_emote && benefitType === 'EMOTE') return true;
            if (filters.show_benefit_other && benefitType === 'UNKNOWN') return true;
        }
    }
    return false;
}

// Main filter matcher
function campaignMatchesFilters(campaign, filters) {
    const status = getCampaignStatus(campaign);

    if (!matchesStatusFilters(campaign, filters, status)) return false;
    if (!matchesGameFilter(campaign, filters)) return false;
    if (!matchesBenefitFilter(campaign, filters)) return false;

    return true;
}

function onInventoryFilterChange() {
    // Save filter state to settings and re-render inventory
    saveSettings();
    renderInventory();
}

function clearInventoryFilters() {
    // Uncheck all filter checkboxes
    document.getElementById('filter-active').checked = false;
    document.getElementById('filter-not-linked').checked = false;
    document.getElementById('filter-upcoming').checked = false;
    document.getElementById('filter-expired').checked = false;
    document.getElementById('filter-finished').checked = false;
    document.getElementById('inventory-game-search').value = '';

    // Reset benefit type filters to checked (show all)
    if (document.getElementById('filter-benefit-item')) document.getElementById('filter-benefit-item').checked = true;
    if (document.getElementById('filter-benefit-badge')) document.getElementById('filter-benefit-badge').checked = true;
    if (document.getElementById('filter-benefit-emote')) document.getElementById('filter-benefit-emote').checked = true;
    if (document.getElementById('filter-benefit-other')) document.getElementById('filter-benefit-other').checked = true;

    // Clear selected games
    selectedInventoryGames = [];
    updateGameTagsDisplay();

    // Save and re-render
    saveSettings();
    renderInventory();
}


// ==================== Game Dropdown & Tags ====================

// Track selected games for inventory filter

let gameDropdownFocusedIndex = -1;
let gameDropdownVisible = false;

function getAvailableGamesForDropdown() {
    // Combine games from campaigns and availableGames Set
    const gamesFromCampaigns = Object.values(state.campaigns).map(c => c.game_name);
    const gamesFromSettings = Array.from(availableGames || []);

    // Merge and deduplicate
    const allGames = [...new Set([...gamesFromCampaigns, ...gamesFromSettings])];

    // Sort alphabetically
    return allGames.sort((a, b) => a.localeCompare(b));
}

function renderGameDropdown(searchTerm = '') {
    const dropdown = document.getElementById('game-dropdown-list');
    const allGames = getAvailableGamesForDropdown();

    // Filter games by search term (case-insensitive)
    const searchLower = searchTerm.toLowerCase().trim();
    const filteredGames = searchLower
        ? allGames.filter(game => game.toLowerCase().includes(searchLower))
        : allGames;

    dropdown.innerHTML = '';

    if (filteredGames.length === 0) {
        dropdown.replaceChildren(makeElement('div', { class: 'dropdown-item no-results' }, 'No games found'));
        gameDropdownFocusedIndex = -1;
        return;
    }

    filteredGames.forEach((gameName, index) => {
        const isSelected = selectedInventoryGames.includes(gameName);
        const isFocused = index === gameDropdownFocusedIndex;

        const item = document.createElement('div');
        item.className = 'dropdown-item' + (isFocused ? ' focused' : '');
        item.dataset.gameName = gameName;
        item.dataset.index = index;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isSelected;
        checkbox.id = `game-dropdown-${index}`;

        const label = document.createElement('label');
        label.setAttribute('for', `game-dropdown-${index}`);
        label.textContent = gameName;

        item.appendChild(checkbox);
        item.appendChild(label);

        // Click handler for the entire item
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleGameSelection(gameName);
        });

        dropdown.appendChild(item);
    });
}

function toggleGameSelection(gameName) {
    const index = selectedInventoryGames.indexOf(gameName);
    if (index >= 0) {
        // Remove game
        selectedInventoryGames.splice(index, 1);
    } else {
        // Add game
        selectedInventoryGames.push(gameName);
    }

    updateGameTagsDisplay();
    renderGameDropdown(document.getElementById('inventory-game-search').value);
    saveSettings();
    renderInventory();
}

function removeGameTag(gameName) {
    const index = selectedInventoryGames.indexOf(gameName);
    if (index >= 0) {
        selectedInventoryGames.splice(index, 1);
        updateGameTagsDisplay();
        renderGameDropdown(document.getElementById('inventory-game-search').value);
        saveSettings();
        renderInventory();
    }
}

function updateGameTagsDisplay() {
    const container = document.getElementById('selected-game-tags');
    container.innerHTML = '';

    selectedInventoryGames.forEach(gameName => {
        const tag = document.createElement('div');
        tag.className = 'game-tag';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'game-tag-name';
        nameSpan.textContent = gameName;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'game-tag-remove';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', `Remove ${gameName}`);
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeGameTag(gameName);
        });

        tag.appendChild(nameSpan);
        tag.appendChild(removeBtn);
        container.appendChild(tag);
    });
}

function showGameDropdown() {
    const dropdown = document.getElementById('game-dropdown-list');
    dropdown.style.display = 'block';
    gameDropdownVisible = true;
    gameDropdownFocusedIndex = -1;
    renderGameDropdown(document.getElementById('inventory-game-search').value);
}

function closeGameDropdown() {
    const dropdown = document.getElementById('game-dropdown-list');
    dropdown.style.display = 'none';
    gameDropdownVisible = false;
    gameDropdownFocusedIndex = -1;
}

function handleGameSearchKeydown(event) {
    if (!gameDropdownVisible) {
        return;
    }

    const dropdown = document.getElementById('game-dropdown-list');
    const items = dropdown.querySelectorAll('.dropdown-item:not(.no-results)');
    const maxIndex = items.length - 1;

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        gameDropdownFocusedIndex = Math.min(gameDropdownFocusedIndex + 1, maxIndex);
        renderGameDropdown(document.getElementById('inventory-game-search').value);

        // Scroll focused item into view
        const focusedItem = dropdown.querySelector('.dropdown-item.focused');
        if (focusedItem) {
            focusedItem.scrollIntoView({ block: 'nearest' });
        }
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        gameDropdownFocusedIndex = Math.max(gameDropdownFocusedIndex - 1, 0);
        renderGameDropdown(document.getElementById('inventory-game-search').value);

        // Scroll focused item into view
        const focusedItem = dropdown.querySelector('.dropdown-item.focused');
        if (focusedItem) {
            focusedItem.scrollIntoView({ block: 'nearest' });
        }
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (gameDropdownFocusedIndex >= 0 && gameDropdownFocusedIndex <= maxIndex) {
            const focusedItem = items[gameDropdownFocusedIndex];
            const gameName = focusedItem.dataset.gameName;
            if (gameName) {
                toggleGameSelection(gameName);
            }
        }
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeGameDropdown();
        document.getElementById('inventory-game-search').blur();
    }
}

// Renders a single benefit item (icon + name + type)
function createBenefitItem(benefit) {
    return makeElement('div', { class: 'benefit-item' }, '', el => {
        el.appendChild(makeImageElement(benefit.image_url, benefit.name, 'benefit-icon'));
        el.appendChild(makeElement('div', { class: 'benefit-info' }, '', el2 => {
            el2.appendChild(makeElement('span', { class: 'benefit-name' }, benefit.name));
            const isDirectType = benefit.type && benefit.type.toUpperCase() === 'DIRECT_ENTITLEMENT';
            if (!isDirectType && benefit.type) {
                el2.appendChild(makeElement('span', { class: 'benefit-type' }, `(${benefit.type})`));
            }
        }));
    });
}

// Renders a single drop with its progress and benefits
function createDropItem(drop, t) {
    // 1. Zjistíme stavovou třídu (stejnou pro oba boxy)
    let statusClass = '';
    if (drop.is_claimed) {
        statusClass = 'drop-claimed';
    } else if (drop.can_claim) {
        statusClass = 'drop-ready';
    } else if (drop.is_expired) {
        statusClass = 'drop-expired';
    } else if ((drop.progress || 0) > 0) {
        statusClass = 'drop-active';
    }

    // 2. Vytvoříme vnější i vnitřní box se stejnou třídou
    const dropItem = makeElement('div', { class: `drop-item ${statusClass}` });
    const contentWrapper = makeElement('div', { class: `drop-content-box ${statusClass}` });

    // Header
    contentWrapper.appendChild(
        makeElement('div', { class: 'drop-item-header' }, '', el =>
            el.appendChild(makeElement('div', { class: 'drop-item-info' }, '', el2 =>
                el2.appendChild(makeElement('div', {}, '', el3 => {
                    el3.appendChild(makeElement('strong', {}, drop.name));

                    const badgeContainer = document.createElement('span');
                    badgeContainer.style.marginLeft = '8px';
                    badgeContainer.style.display = 'inline-flex';
                    badgeContainer.style.gap = '6px';
                    badgeContainer.style.alignItems = 'center';
                    el3.appendChild(badgeContainer);
                }))
            ))
        )
    );
    
	// Benefity
    const benefitsList = makeElement('div', { class: 'benefits-list' });
    if (drop.benefits && drop.benefits.length > 0) {
        drop.benefits.forEach(benefit => {
            const benefitEl = createBenefitItem(benefit);
            
            // Přidání ikony do každého benefitu
			const iconHTML = getStatusIconSVG(statusClass);
			if (iconHTML) {
				const iconDiv = document.createElement('div');
				iconDiv.className = 'benefit-status-icon'; // TUTO TŘÍDU CSS ZNÁ
				iconDiv.style.marginLeft = 'auto';
				iconDiv.style.display = 'flex';
				iconDiv.style.alignItems = 'center';
				iconDiv.innerHTML = iconHTML;
				benefitEl.appendChild(iconDiv);
			}
            
            benefitsList.appendChild(benefitEl);
        });
    }
    contentWrapper.appendChild(benefitsList);

    // Progress
    if (!drop.is_claimed) {
        const isDirect = drop.delivery_method === 'DIRECT_ENTITLEMENT' || 
                         drop.deliveryMethod === 'DIRECT_ENTITLEMENT' || 
                         !drop.required_minutes;

        if (!isDirect) {
            if (!drop.can_claim) {
                const progressPercent = Math.round((drop.progress || 0) * 100);
                contentWrapper.appendChild(makeElement('div', {}, `${drop.current_minutes || 0} / ${drop.required_minutes} minutes (${progressPercent}%)`));
            } else if (drop.can_claim) {
                contentWrapper.appendChild(makeElement('div', { style: 'color: var(--warning-color); font-weight: bold; margin-top: 5px;' }, 'Ready to claim!'));
            }
        } else {
            contentWrapper.appendChild(makeElement('div', { class: 'drop-direct-badge' }, '✦ Instant / Direct Reward'));
        }
    }

    dropItem.appendChild(contentWrapper);
    return dropItem;
}

function createDropsContainer(drops, t) {
    const container = document.createElement('div');
    container.className = 'campaign-drops';

    // Prostě projdeme všechny dropy, které k této kampani patří
    if (drops && drops.length > 0) {
        drops.forEach(drop => {
            // Vykreslíme blok pro drop
            container.appendChild(createDropBlock(drop, t));
        });
    }

    return container;
}

function createDropBlock(drop, t) {
    // Určení stavu pro obalovací blok
    let statusClass = '';
    if (drop.is_claimed) statusClass = 'drop-claimed';
    else if (drop.can_claim) statusClass = 'drop-ready';
    else if (drop.progress > 0) statusClass = 'drop-active';
    else statusClass = 'drop-expired';

    const dropBlock = document.createElement('div');
    dropBlock.className = `drop-block ${statusClass}`;

    // Samotný item (zde si pohlídej, aby ani createDropItem nevykresloval název)
    dropBlock.appendChild(createDropItem(drop, t));

    return dropBlock;
}

// Renders the top header of a campaign card (Game art, linking state, external links)
function createCampaignHeader(campaign) {
    // 1. Sjednocená detekce stavu a reálného počtu dropů
    const dropsList = campaign.drops || campaign.time_based_drops || [];
    const realClaimed = dropsList.length > 0 
        ? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
        : (campaign.claimed_drops || 0);
    const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

    const isCompleted = realTotal > 0 && realClaimed >= realTotal;
    const isActive = (campaign.is_active !== undefined ? campaign.is_active : campaign.active) && !isCompleted;

    // 2. Třída a text podle reálného stavu
    let statusClass = 'expired';
    let statusText = t.gui?.inventory?.expired || 'Expired';

    if (isCompleted) {
        statusClass = 'completed';
        statusText = t.gui?.inventory?.completed || 'Completed ✔';
    } else if (isActive) {
        statusClass = 'active';
        statusText = t.gui?.inventory?.active || 'Active ✔';
    }

    const claimedCountText = t.gui?.inventory?.claimed_drops || 'claimed';

    // 3. Vytvoření samotného HTML prvku hlavičky
    const headerEl = makeElement('div', { class: `campaign-header ${statusClass}` });

    headerEl.appendChild(makeElement('div', { class: 'campaign-title-row' }, '', el => {
        el.appendChild(makeElement('h3', {}, campaign.name || campaign.game_name || 'Campaign'));
    }));

    headerEl.appendChild(makeElement('div', { class: 'campaign-status', style: 'display: flex; justify-content: space-between;' }, '', el => {
        el.appendChild(makeElement('span', { class: `status-tag ${statusClass}` }, statusText));
        el.appendChild(makeElement('span', { class: 'claimed-counter' }, `${realClaimed} / ${realTotal} ${claimedCountText}`));
    }));

    return headerEl;
}

function createCampaignCard(campaign, t) {
    // 1. Inicializace stavů
    let statusClass = '';
    let statusText = '';

    // Priorita: Completed -> Active -> Upcoming -> Expired
    if (campaign.claimed_drops !== undefined && campaign.total_drops !== undefined && campaign.claimed_drops >= campaign.total_drops) {
        statusClass = 'completed';
        statusText = 'Completed'; 
    } else if (campaign.active) {
        statusClass = 'active';
        statusText = t.gui?.inventory?.status?.active || 'Active';
    } else if (campaign.upcoming) {
        statusClass = 'upcoming';
        statusText = t.gui?.inventory?.status?.upcoming || 'Upcoming';
    } else if (campaign.expired) {
        statusClass = 'expired';
        statusText = t.gui?.inventory?.status?.expired || 'Expired';
    }

    const card = makeElement('div', { class: `campaign-card ${statusClass}` });
    const campaignInfo = makeElement('div', { class: 'campaign-info' });

    // --- HLAVIČKA (Header) ---
    const campaignHeader = makeElement('div', { class: 'campaign-header' });

    // A. Herní ikona (vlevo)
    if (campaign.game_box_art_url) {
        const iconUrl = campaign.game_box_art_url.replace('{width}', '52').replace('{height}', '70');
        campaignHeader.appendChild(makeImageElement(iconUrl, campaign.game_name, 'game-icon'));
    }

    // B. Kontejner pro text (název a link pod ním)
    campaignHeader.appendChild(makeElement('div', { style: 'display: flex; flex-direction: column; margin-left: 10px;' }, '', textCol => {
        textCol.appendChild(makeElement('span', { class: 'campaign-game-name' }, campaign.game_name));
        textCol.appendChild(makeElement('a', { 
            href: campaign.campaign_url, 
            target: '_blank', 
            rel: 'noopener noreferrer', 
            class: 'campaign-name-link',
            style: 'font-size: 11px; margin-top: 2px;'
        }, 'View on Twitch 🔗'));
    }));

    // C. PRAVÁ STRANA: Ikona stavu + Badge
    campaignHeader.appendChild(makeElement('div', { 
        style: 'margin-left: auto; display: flex; align-items: center; gap: 8px;' 
    }, '', rightGroup => {
        
        // 1. Ikona stavu
        const iconHtml = getStatusIconSVG(statusClass);
        if (iconHtml) {
            rightGroup.appendChild(makeElement('div', { 
                class: 'campaign-header-icon', 
                style: 'display: flex; align-items: center;' 
            }, '', el => {
                el.innerHTML = iconHtml;
            }));
        }

        // 2. Badge (Linked/Not Linked)
        rightGroup.appendChild(makeElement('span', { 
            class: `campaign-badge ${campaign.linked ? 'linked' : 'not-linked'}` 
        }, campaign.linked ? 'LINKED' : 'NOT LINKED'));
        
        // Poznámka: Tlačítko Link Account bylo odstraněno z hlavičky, je teď dole u statusu.
    }));

    campaignInfo.appendChild(campaignHeader);

	// --- Status řádek (pouze texty) ---
    const claimedCountText = t.gui?.inventory?.claimed_drops || 'claimed';

    // Dynamické spočítání reálného stavu z pole dropů
    const dropsList = campaign.drops || campaign.time_based_drops || [];
    const realClaimed = dropsList.length > 0 
        ? dropsList.filter(d => d.is_claimed || d.claimed || d.isClaimed || d.status === 'CLAIMED').length 
        : (campaign.claimed_drops || 0);
    const realTotal = dropsList.length > 0 ? dropsList.length : (campaign.total_drops || 0);

    campaignInfo.appendChild(makeElement('div', { class: 'campaign-status', style: 'display: flex; justify-content: space-between;' }, '', el => {
        el.appendChild(makeElement('span', {}, statusText));
        el.appendChild(makeElement('span', {}, `${realClaimed} / ${realTotal} ${claimedCountText}`));
    }));
    
    // --- Tlačítko Link (přesunuto sem - mezi status a timing) ---
    if (!campaign.linked && campaign.link_url) {
        campaignInfo.appendChild(makeElement('button', { 
            class: 'link-account-btn', 
            style: 'width: 100%; margin: 10px 0; padding: 8px; cursor: pointer;' 
        }, 'Link Account', btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open(campaign.link_url, '_blank');
            });
        }));
    }

    // --- Timing (Starts/Ends) ---
    if (campaign.starts_at) {
        const startsLabel = t.gui?.inventory?.starts || 'Starts: {time}';
        campaignInfo.appendChild(makeElement('div', { class: 'campaign-timing' }, 
            startsLabel.replace('{time}', new Date(campaign.starts_at).toLocaleString())
        ));
    }

    if (campaign.ends_at) {
        const endsLabel = t.gui?.inventory?.ends || 'Ends: {time}';
        campaignInfo.appendChild(makeElement('div', { class: 'campaign-timing' }, 
            endsLabel.replace('{time}', new Date(campaign.ends_at).toLocaleString())
        ));
    }

	// --- B. DROPS BLOK ---
    const dropsBox = makeElement('div', { class: 'campaign-drops' });

    if (campaign.drops && campaign.drops.length > 0) {
        // Tady přidáme název kampaně jako hlavní nadpis pro tuto sekci
        dropsBox.appendChild(makeElement('div', { class: 'campaign-drop-title' }, campaign.name));
        
        // A pod to vypíšeme všechny odměny bez dalšího zbytečného dělení
        campaign.drops.forEach(drop => {
            dropsBox.appendChild(createDropBlock(drop, t));
        });
    }

    card.replaceChildren(campaignInfo, dropsBox);
    return card;
}

function renderInventory() {
    const container = document.getElementById('inventory-grid');
    container.innerHTML = '';

    updateOverallProgress();

    const t = state.translations;
    const allCampaigns = Object.values(state.campaigns);

    const filters = getInventoryFilters();
    const hasStatusFilter = filters.show_active || filters.show_not_linked ||
                            filters.show_upcoming || filters.show_expired || 
                            filters.show_finished;

    if (!hasStatusFilter) return;

    // 1. Filter
    const filteredCampaigns = allCampaigns.filter(campaign => campaignMatchesFilters(campaign, filters));
    
    // 2. Sort
    const sortedCampaigns = sortCampaigns(filteredCampaigns);

    // 3. Handle Empty States
    if (allCampaigns.length === 0) {
        const emptyMsg = t.gui?.inventory?.no_campaigns || 'No campaigns loaded yet...';
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
        return;
    }

    if (sortedCampaigns.length === 0) {
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, 'No campaigns match the current filters.'));
        return;
    }

    // 4. Render and Append Cards
    sortedCampaigns.forEach(campaign => {
        container.appendChild(createCampaignCard(campaign, t));
    });
}

function showLoginForm() {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('oauth-code-display').style.display = 'none';
}

function showOAuthCode(url, code) {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('oauth-code-display').style.display = 'block';
    document.getElementById('oauth-url').href = url;
    document.getElementById('oauth-code').textContent = code;
}

function updateLoginStatus(data) {
    const statusEl = document.getElementById('login-status');
    const t = state.translations;
    if (data.user_id) {
        const userIdLabel = t.gui?.login?.user_id_label || 'User ID:';
        statusEl.textContent = `${data.status} (${userIdLabel} ${data.user_id})`;
        statusEl.removeAttribute('translation-key');
        statusEl.style.color = 'var(--success-color)';
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('oauth-code-display').style.display = 'none';
    } else {
        const loggedOut = t.gui?.login?.logged_out || 'Not logged in';
        statusEl.textContent = data.status || loggedOut;
        statusEl.setAttribute('translation-key', 'logged_out');
        statusEl.style.color = 'var(--text-secondary)';
        // Check if OAuth is pending (for late-connecting clients)
        if (data.oauth_pending) {
            showOAuthCode(data.oauth_pending.url, data.oauth_pending.code);
        }
    }
}

function updateSettingsUI(settings) {
    state.settings = settings;
    document.getElementById('dark-mode').checked = settings.dark_mode || false;
    document.getElementById('auto-sort-by-end').checked = settings.auto_sort_by_end || false;
    document.getElementById('mine-badges-first').checked = settings.mine_badges_first || false;
    document.getElementById('auto-add-all-games').checked = settings.auto_add_all_games || false;
    document.getElementById('connection-quality').value = settings.connection_quality || 1;
    document.getElementById('minimum-refresh-interval').value = settings.minimum_refresh_interval_minutes || 30;

    // Update proxy settings and indicator
    const proxyUrl = settings.proxy || '';
    const proxyInput = document.getElementById('proxy-url');
    if (proxyInput) proxyInput.value = proxyUrl;

    const proxyIndicator = document.getElementById('proxy-indicator');
    if (proxyIndicator) {
        proxyIndicator.style.display = proxyUrl ? 'inline-flex' : 'none';
        proxyIndicator.title = proxyUrl ? `Proxy active: ${proxyUrl}` : 'Proxy disabled';
    }

    // Update language dropdown if we have the current language
    if (settings.language) {
        const languageSelect = document.getElementById('language');
        if (languageSelect) {
            languageSelect.value = settings.language;
        }
    }

    if (settings.dark_mode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }

	// Update available games if provided in settings
    if (settings.games_available) {
        availableGames = new Set(settings.games_available);
        
        // Ensure watched games are always part of the available pool
        if (settings.games_to_watch) {
            settings.games_to_watch.forEach(game => availableGames.add(game));
        }
    }

    // Restore inventory filters from settings
    if (settings.inventory_filters) {
        document.getElementById('filter-active').checked = settings.inventory_filters.show_active || false;
        document.getElementById('filter-not-linked').checked = settings.inventory_filters.show_not_linked || false;
        document.getElementById('filter-upcoming').checked = settings.inventory_filters.show_upcoming || false;
        document.getElementById('filter-expired').checked = settings.inventory_filters.show_expired || false;
        document.getElementById('filter-finished').checked = settings.inventory_filters.show_finished || false;

        // Restore selected games array
        selectedInventoryGames = Array.isArray(settings.inventory_filters.game_name_search)
            ? [...settings.inventory_filters.game_name_search]
            : [];  // Handle old string format gracefully
        updateGameTagsDisplay();

        // Restore benefit type filters (default to true if not set)
        if (document.getElementById('filter-benefit-item')) document.getElementById('filter-benefit-item').checked = settings.inventory_filters.show_benefit_item !== false;
        if (document.getElementById('filter-benefit-badge')) document.getElementById('filter-benefit-badge').checked = settings.inventory_filters.show_benefit_badge !== false;
        if (document.getElementById('filter-benefit-emote')) document.getElementById('filter-benefit-emote').checked = settings.inventory_filters.show_benefit_emote !== false;
        if (document.getElementById('filter-benefit-other')) document.getElementById('filter-benefit-other').checked = settings.inventory_filters.show_benefit_other !== false;
    }

    // Restore mining benefit filters
    if (settings.mining_benefits) {
        if (document.getElementById('mining-benefit-item')) document.getElementById('mining-benefit-item').checked = settings.mining_benefits.DIRECT_ENTITLEMENT;
        if (document.getElementById('mining-benefit-badge')) document.getElementById('mining-benefit-badge').checked = settings.mining_benefits.BADGE;
        if (document.getElementById('mining-benefit-emote')) document.getElementById('mining-benefit-emote').checked = settings.mining_benefits.EMOTE;
        if (document.getElementById('mining-benefit-unknown')) document.getElementById('mining-benefit-unknown').checked = settings.mining_benefits.UNKNOWN;
    }


    // Update games to watch lists
    renderGamesToWatch();

    // Re-render channels list to apply filter based on updated games to watch
    renderChannels();

    // Re-render inventory to apply filters
    renderInventory();
    
    // Check if we need to auto-add games after settings are applied
    applyAutoAddIfNeeded();
}

function updateManualModeUI(manualModeInfo) {
    const manualBadge = document.getElementById('manual-mode-badge');
    const autoBadge = document.getElementById('auto-mode-badge');
    const manualGameName = document.getElementById('manual-game-name');
    const manualControls = document.getElementById('manual-mode-controls');
    const manualModeGame = document.getElementById('manual-mode-game');

    if (manualModeInfo.active) {
        // Show manual mode badge, hide auto badge
        manualBadge.classList.remove('hidden');
        autoBadge.classList.add('hidden');
        manualGameName.textContent = manualModeInfo.game_name || '';

        // Show manual mode controls in drop progress section
        if (manualControls) {
            manualControls.classList.remove('hidden');
            if (manualModeGame) {
                manualModeGame.textContent = manualModeInfo.game_name || '';
            }
        }
    } else {
        // Hide manual mode badge, show auto badge
        manualBadge.classList.add('hidden');
        autoBadge.classList.remove('hidden');

        // Hide manual mode controls
        if (manualControls) {
            manualControls.classList.add('hidden');
        }
    }
}

// ==================== Games to Watch Management ====================

socket.on('games_available', (data) => {
    availableGames = new Set(data.games || []);
    renderGamesToWatch();
    applyAutoAddIfNeeded();
});

function renderGamesToWatch() {
    // Only get data, do not mutate state here
    let selectedGames = state.settings.games_to_watch || [];
    const filterText = document.getElementById('games-filter')?.value.toLowerCase() || '';

    // Safeguard: Force all watched games into the pool to prevent them from disappearing
    selectedGames.forEach(game => availableGames.add(game));

    // Render left side
    renderSelectedGames(selectedGames);

    // Render right side
    const unselectedGames = Array.from(availableGames)
        .filter(game => !selectedGames.includes(game))
        .filter(game => game.toLowerCase().includes(filterText))
        .sort((a, b) => a.localeCompare(b));

    renderAvailableGames(unselectedGames, filterText);
    updateUIState();
}

function renderSelectedGames(games) {
    const container = document.getElementById('selected-games-list');
    if (!container) return;

    const t = state.translations;
    container.innerHTML = '';

    if (games.length === 0) {
        const emptyMsg = t.gui?.settings?.no_games_selected || 'No games selected. Check games below to add them.';
        container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
        return;
    }

    games.forEach((game, index) => {
        const div = document.createElement('div');
        div.className = 'sortable-item';
        div.draggable = true;
        div.dataset.game = game;
        div.replaceChildren(
            makeElement('span', { class: 'drag-handle' }, '☰'),
            makeElement('span', { class: 'priority-number' }, String(index + 1)),
            makeElement('span', { class: 'game-name' }, game),
            makeElement('button', { class: 'remove-btn' }, '✕'),
        );

        // Event listener for the delete button
        const removeBtn = div.querySelector('.remove-btn');
        removeBtn.addEventListener('click', () => removeGameFromWatch(game));

        // Drag event handlers
        div.addEventListener('dragstart', handleDragStart);
        div.addEventListener('dragover', handleDragOver);
        div.addEventListener('drop', handleDrop);
        div.addEventListener('dragend', handleDragEnd);

        container.appendChild(div);
    });
}

function renderAvailableGames(games, filterText) {
    const container = document.getElementById('available-games-list');
    if (!container) return;

    const t = state.translations;
    container.innerHTML = '';

    if (games.length === 0) {
        if (filterText) {
            const emptyMsg = t.gui?.settings?.no_games_match || 'No games match your search.';
            const addHint = t.gui?.settings?.add_game_hint || ' Click "Add Game" to add it manually.';
            container.replaceChildren(makeElement('p', { class: 'empty-message' }, `${emptyMsg}${addHint}`));
        } else {
            const emptyMsg = t.gui?.settings?.all_games_selected || 'All games are selected or no games available.';
            container.replaceChildren(makeElement('p', { class: 'empty-message' }, emptyMsg));
        }
        return;
    }

    games.forEach(game => {
        const label = document.createElement('label');
        label.className = 'game-checkbox';
        label.replaceChildren(
            makeElement('input', { type: 'checkbox', value: game }),
            makeElement('span', {}, game),
        );

        const checkbox = label.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => toggleGameWatch(game, e.target.checked));

        container.appendChild(label);
    });
}

// Drag and drop handlers
function handleDragStart(e) {
    draggedElement = e.target;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.target.innerHTML);
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';

    const target = e.target.closest('.sortable-item');
    if (target && target !== draggedElement) {
        const container = target.parentNode;
        const allItems = [...container.querySelectorAll('.sortable-item')];
        const draggedIndex = allItems.indexOf(draggedElement);
        const targetIndex = allItems.indexOf(target);

        if (draggedIndex < targetIndex) {
            target.parentNode.insertBefore(draggedElement, target.nextSibling);
        } else {
            target.parentNode.insertBefore(draggedElement, target);
        }
    }
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    return false;
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');

    // Update the order in state
    const container = document.getElementById('selected-games-list');
    const items = container.querySelectorAll('.sortable-item');
    const newOrder = Array.from(items).map(item => item.dataset.game);

    state.settings.games_to_watch = newOrder;

    // Re-render to update priority numbers
    renderSelectedGames(newOrder);

    // Re-render channels list to apply updated filter
    renderChannels();

    // Save settings
    saveSettings();
}

function toggleGameWatch(gameName, checked) {
    const games = state.settings.games_to_watch || [];

    if (checked && !games.includes(gameName)) {
        games.push(gameName);
    } else if (!checked) {
        const index = games.indexOf(gameName);
        if (index > -1) {
            games.splice(index, 1);
        }
    }

    state.settings.games_to_watch = games;
    renderGamesToWatch();
    renderChannels();
    saveSettings();
}

function removeGameFromWatch(gameName) {
    const games = state.settings.games_to_watch || [];
    const index = games.indexOf(gameName);
    if (index > -1) {
        games.splice(index, 1);
        state.settings.games_to_watch = games;
        renderGamesToWatch();
        renderChannels();
        saveSettings();
    }
}

function selectAllGames() {
    state.settings.games_to_watch = Array.from(availableGames).sort();
    renderGamesToWatch();
    renderChannels();
    saveSettings();
}

function deselectAllGames() {
    state.settings.games_to_watch = [];
    renderGamesToWatch();
    renderChannels();
    saveSettings();
}

function addGameFromSearch() {
    const searchInput = document.getElementById('games-filter');
    const gameName = searchInput.value.trim();

    if (!gameName) {
        return;
    }

    const games = state.settings.games_to_watch || [];
    
    // Check if already selected
    if (games.includes(gameName)) {
        searchInput.value = ''; // Clear input if already added
        renderGamesToWatch(); // Just re-render to clear any filtering state if needed
        return;
    }

    // Add to selected games
    games.push(gameName);
    state.settings.games_to_watch = games;

    // Add to available games set so it shows up in lists
    availableGames.add(gameName);

    // Clear search and update UI
    searchInput.value = '';
    renderGamesToWatch();
    renderChannels();
    saveSettings();
}

function flashTitle() {
    const originalTitle = document.title;
    let count = 0;
    const interval = setInterval(() => {
        document.title = count % 2 === 0 ? '🔔 Attention!' : originalTitle;
        count++;
        if (count >= 10) {
            document.title = originalTitle;
            clearInterval(interval);
        }
    }, 1000);
}

// ==================== Automated process ====================

function sortGamesByEnding() {
    if (!state.settings || !Array.isArray(state.settings.games_to_watch)) return;

    const originalOrder = JSON.stringify(state.settings.games_to_watch);
    
    // Apply smart sorting function
    state.settings.games_to_watch = getSortedGamesArray(state.settings.games_to_watch);
    const newOrder = JSON.stringify(state.settings.games_to_watch);

    // If order changed, force render and save
    if (originalOrder !== newOrder) {
        renderGamesToWatch();
        renderChannels(); // Channels rely on watch priority, they must update too
        saveSettings();
        console.log("Game list sorted by ending date and changes saved.");
    }
}

// Pure function - only calculates, does not mutate DOM or Trigger APIs
function getSortedGamesArray(games) {
    // FALLBACK: If campaign data is missing, return original array
    if (!state.campaigns || Object.keys(state.campaigns).length === 0) {
        console.warn("Sorting skipped: Campaign data not available yet.");
        return games; 
    }

    const campaignsArray = Object.values(state.campaigns)
        .filter(campaign => campaign.expired === false);

    const gameEndDates = {};
    campaignsArray.forEach(campaign => {
        if (campaign.ends_at) {
            const endDate = new Date(campaign.ends_at).getTime();
            if (!gameEndDates[campaign.game_name] || endDate < gameEndDates[campaign.game_name]) {
                gameEndDates[campaign.game_name] = endDate;
            }
        }
    });

    // Sort array
    return [...games].sort((a, b) => {
        const dateA = gameEndDates[a] || Infinity;
        const dateB = gameEndDates[b] || Infinity;
        
        if (dateA === Infinity && dateB === Infinity) return 0;
        return dateA - dateB;
    });
}

function applyAutoSortIfNeeded() {
	console.log('Spouštím auto-sort ...');
    const autoSortCb = document.getElementById('auto-sort-by-end');
    // Check if the checkbox exists and is checked
    if (autoSortCb && autoSortCb.checked) {
        console.log('Auto-sort enabled: Triggering sort automatically.');
        sortGamesByEnding();
    }
}

// Standalone function to handle auto-adding games based on user settings
function applyAutoAddIfNeeded() {
    const autoaddEl = document.getElementById('auto-add-all-games');
    if (autoaddEl && autoaddEl.checked) {
        let hasChanges = false;
        const availableArray = Array.from(availableGames);
        
        availableArray.forEach(game => {
            // Add game if it is not already in the watch list
            if (!state.settings.games_to_watch.includes(game)) {
                state.settings.games_to_watch.push(game);
                hasChanges = true;
            }
        });
        
        // Only trigger UI updates and API calls if a new game was actually added
        if (hasChanges) {
            availableGames.clear(); 
            renderGamesToWatch();
            if (typeof renderAvailableGames === 'function') {
                renderAvailableGames(Array.from(availableGames), document.getElementById('games-filter')?.value.toLowerCase() || '');
            }
            saveSettings();
            console.log("Games automatically moved to watched list:", state.settings.games_to_watch);
            updateUIState();
        }
    }
}

// ==================== API Functions ====================

async function selectChannel(channelId) {
    try {
        const response = await fetch('/api/channels/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_id: channelId })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Failed to select channel:', errorData.detail || 'Unknown error');
            addConsoleLine(`Error selecting channel: ${errorData.detail || 'Unknown error'}`);
        }
    } catch (error) {
        console.error('Failed to select channel:', error);
        addConsoleLine(`Error selecting channel: ${error.message}`);
    }
}

async function exitManualMode() {
    try {
        const response = await fetch('/api/mode/exit-manual', {
            method: 'POST'
        });

        const result = await response.json();
        if (!result.success) {
            console.log('Exit manual mode:', result.message || 'Already in automatic mode');
        }
    } catch (error) {
        console.error('Failed to exit manual mode:', error);
        addConsoleLine(`Error exiting manual mode: ${error.message}`);
    }
}

async function submitLogin() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const token = document.getElementById('2fa-token').value;

    try {
        await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, token })
        });
    } catch (error) {
        console.error('Failed to submit login:', error);
    }
}

async function confirmOAuth() {
    // Signal that OAuth code has been entered
    try {
        await fetch('/api/oauth/confirm', {
            method: 'POST'
        });
        // Hide the OAuth form and show waiting message
        document.getElementById('oauth-code-display').style.display = 'none';
        const t = state.translations;
        const waitingAuth = t.gui?.login?.waiting_auth || 'Waiting for authentication...';
        const loginStatus = document.getElementById('login-status');
        loginStatus.textContent = waitingAuth;
        loginStatus.setAttribute('translation-key', 'waiting_auth');
    } catch (error) {
        console.error('Failed to confirm OAuth:', error);
    }
}

async function verifyProxy() {
    const proxyInput = document.getElementById('proxy-url');
    const proxyUrl = proxyInput ? proxyInput.value.trim() : '';
    const resultDiv = document.getElementById('proxy-verify-result');

    if (!resultDiv) return;

    // Reset display
    resultDiv.style.display = 'block';
    resultDiv.className = 'verify-result loading';
    resultDiv.textContent = 'Verifying connection...';

    if (!proxyUrl) {
        resultDiv.className = 'verify-result error';
        resultDiv.textContent = 'Please enter a proxy URL first.';
        return;
    }

    try {
        const response = await fetch('/api/settings/verify-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxy: proxyUrl })
        });

        const data = await response.json();

        if (data.success) {
            resultDiv.className = 'verify-result success';
            resultDiv.textContent = `✓ ${data.message}`;
        } else {
            resultDiv.className = 'verify-result error';
            resultDiv.textContent = `✗ ${data.message}`;
        }
    } catch (error) {
        resultDiv.className = 'verify-result error';
        resultDiv.textContent = `Error: ${error.message}`;
    }
}

async function saveSettings() {
    const settings = {
        dark_mode: document.getElementById('dark-mode').checked,
        language: document.getElementById('language').value,
        connection_quality: parseInt(document.getElementById('connection-quality').value),
        minimum_refresh_interval_minutes: parseInt(document.getElementById('minimum-refresh-interval').value),
        proxy: state.settings.proxy || '',
        games_to_watch: state.settings.games_to_watch || [],
        inventory_filters: getInventoryFilters(),
        auto_sort_by_end: document.getElementById('auto-sort-by-end')?.checked || false,
        mine_badges_first: document.getElementById('mine-badges-first')?.checked || false,
        auto_add_all_games: document.getElementById('auto-add-all-games')?.checked || false,
        mining_benefits: {
            "DIRECT_ENTITLEMENT": document.getElementById('mining-benefit-item')?.checked,
            "BADGE": document.getElementById('mining-benefit-badge')?.checked,
            "EMOTE": document.getElementById('mining-benefit-emote')?.checked,
            "UNKNOWN": document.getElementById('mining-benefit-unknown')?.checked
        }
    };

    try {
        await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        console.log('Settings saved automatically');
    } catch (error) {
        console.error('Failed to save settings:', error);
    }
}

async function fetchAndPopulateLanguages() {
    try {
        const response = await fetch('/api/languages');
        const data = await response.json();

        const languageSelect = document.getElementById('language');
        if (!languageSelect) {
            console.warn('Language select element not found');
            return;
        }

        // Clear existing options
        languageSelect.innerHTML = '';

        // Populate with available languages
        data.available.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            languageSelect.appendChild(option);
        });

        // Set current language
        if (data.current) {
            languageSelect.value = data.current;
        }
    } catch (error) {
        console.error('Failed to fetch languages:', error);
        const languageSelect = document.getElementById('language');
        if (languageSelect) {
            languageSelect.replaceChildren(makeElement('option', { value: '' }, 'Failed to load languages'));
        }
        addConsoleLine('Error: Unable to fetch available languages. Please check your connection or try again later.');
    }
}

async function fetchAndApplyTranslations() {
    try {
        const response = await fetch('/api/translations');
        const data = await response.json();

        state.translations = data;
        applyTranslations(data);
        console.log('Translations applied for language:', data.language_name);
    } catch (error) {
        console.error('Failed to fetch translations:', error);
    }
}

function applyTranslations(t) {
    // Update tab buttons
    const tabButtons = {
        'main': document.querySelector('[data-tab="main"]'),
        'inventory': document.querySelector('[data-tab="inventory"]'),
        'settings': document.querySelector('[data-tab="settings"]'),
        'help': document.querySelector('[data-tab="help"]')
    };

    if (tabButtons.main && t.gui?.tabs) tabButtons.main.textContent = t.gui.tabs.main;
    if (tabButtons.inventory && t.gui?.tabs) tabButtons.inventory.textContent = t.gui.tabs.inventory;
    if (tabButtons.settings && t.gui?.tabs) tabButtons.settings.textContent = t.gui.tabs.settings;
    if (tabButtons.help && t.gui?.tabs) tabButtons.help.textContent = t.gui.tabs.help;

    // Update Main tab - Login section
    const mainTab = document.getElementById('main-tab');
    if (mainTab && t.gui?.login) {
        const loginHeader = mainTab.querySelector('.login-panel h2');
        if (loginHeader) loginHeader.textContent = t.gui.login.name;

        const loginStatus = document.getElementById('login-status');
        if (loginStatus?.hasAttribute('translation-key')) loginStatus.textContent = t.login?.status?.[loginStatus.getAttribute('translation-key')];

        // Update login form placeholders
        const usernameInput = document.getElementById('username');
        if (usernameInput) usernameInput.placeholder = t.gui.login.username;

        const passwordInput = document.getElementById('password');
        if (passwordInput) passwordInput.placeholder = t.gui.login.password;

        const twofaInput = document.getElementById('2fa-token');
        if (twofaInput) twofaInput.placeholder = t.gui.login.twofa_code;

        const loginButton = document.getElementById('login-button');
        if (loginButton) loginButton.textContent = t.gui.login.button;

        // Update OAuth display text
        const oauthDisplay = document.getElementById('oauth-code-display');
        if (oauthDisplay) {
            const oauthP = oauthDisplay.querySelector('p');
            if (oauthP) {
                const link = oauthP.querySelector('a');
                if (link) {
                    oauthP.textContent = t.gui.login.oauth_prompt + ' ';
                    link.textContent = t.gui.login.oauth_activate;
                    oauthP.appendChild(link);
                }
            }

            const oauthConfirmBtn = document.getElementById('oauth-confirm');
            if (oauthConfirmBtn) oauthConfirmBtn.textContent = t.gui.login.oauth_confirm;
        }
    }

    // Update Progress section
    if (mainTab && t.gui?.progress) {
        // ID: progress-header
        const progressHeader = document.getElementById('progress-header');
        if (progressHeader) progressHeader.textContent = t.gui.progress.name;

        const noDropMsg = document.getElementById('no-drop-message');
        if (noDropMsg) noDropMsg.textContent = t.gui.progress.no_drop;

        const exitManualBtn = document.getElementById('exit-manual-btn');
        if (exitManualBtn) exitManualBtn.textContent = t.gui.progress.return_to_auto;
    }

    // Update Console section
    if (mainTab && t.gui) {
        // ID: console-header
        const consoleHeader = document.getElementById('console-header');
        if (consoleHeader) consoleHeader.textContent = t.gui.output;
    }

    // Update Channels section
    if (mainTab && t.gui?.channels) {
        // ID: channels-header
        const channelsHeader = document.getElementById('channels-header');
        if (channelsHeader) channelsHeader.textContent = t.gui.channels.name;
        // Channel list will re-render with translated empty messages
        renderChannels();
    }

    // Update Inventory tab
    const inventoryTab = document.getElementById('inventory-tab');
    if (inventoryTab && t.gui?.inventory) {
        // Inventory will re-render with translated status and empty messages
        renderInventory();
    }

    // Update Settings tab
    const settingsTab = document.getElementById('settings-tab');
    if (settingsTab && t.gui?.settings) {
        // Use IDs for robust selection
        const generalHeader = document.getElementById('settings-general-header');
        if (generalHeader) generalHeader.textContent = t.gui.settings.general.name;

        const benefitsHeader = document.getElementById('settings-benefits-header');
        if (benefitsHeader && t.gui.settings.mining_benefits) benefitsHeader.textContent = t.gui.settings.mining_benefits;

        const gamesHeader = document.getElementById('settings-games-header');
        if (gamesHeader) gamesHeader.textContent = t.gui.settings.games_to_watch;

        const actionsHeader = document.getElementById('settings-actions-header');
        if (actionsHeader) actionsHeader.textContent = t.gui.settings.actions;

        const darkModeLabel = settingsTab.querySelector('label:has(#dark-mode)');
        if (darkModeLabel) {
            const checkbox = darkModeLabel.querySelector('input');
            darkModeLabel.textContent = '';
            darkModeLabel.appendChild(checkbox);
            darkModeLabel.appendChild(document.createTextNode(' ' + t.gui.settings.general.dark_mode));
        }

        const connQualityLabel = settingsTab.querySelector('label:has(#connection-quality)');
        if (connQualityLabel) {
            const input = connQualityLabel.querySelector('input');
            connQualityLabel.textContent = t.gui.settings.connection_quality + ' ';
            connQualityLabel.appendChild(input);
        }

        const refreshLabel = settingsTab.querySelector('label:has(#minimum-refresh-interval)');
        if (refreshLabel) {
            const input = refreshLabel.querySelector('input');
            refreshLabel.textContent = t.gui.settings.minimum_refresh + ' ';
            refreshLabel.appendChild(input);
        }

        const benefitsHelp = document.getElementById('settings-benefits-help');
        if (benefitsHelp && t.gui.settings.mining_benefits_help) benefitsHelp.textContent = t.gui.settings.mining_benefits_help;

        const gamesHelp = document.getElementById('settings-games-help');
        if (gamesHelp) gamesHelp.textContent = t.gui.settings.games_help;

        const searchInput = document.getElementById('games-filter');
        if (searchInput) searchInput.placeholder = t.gui.settings.search_games;

        const selectAllBtn = document.getElementById('select-all-btn');
        if (selectAllBtn) selectAllBtn.textContent = t.gui.settings.select_all;

        const deselectAllBtn = document.getElementById('deselect-all-btn');
        if (deselectAllBtn) deselectAllBtn.textContent = t.gui.settings.deselect_all;

        const addGameBtn = document.getElementById('add-game-btn');
        if (addGameBtn && t.gui.settings.add_game) addGameBtn.textContent = t.gui.settings.add_game;

        const selectedGamesHeader = settingsTab.querySelector('.selected-games h3');
        if (selectedGamesHeader) selectedGamesHeader.textContent = t.gui.settings.selected_games;

        const availableGamesHeader = settingsTab.querySelector('.available-games h3');
        if (availableGamesHeader) availableGamesHeader.textContent = t.gui.settings.available_games;

		const reloadBtn = document.getElementById('reload-btn');

		if (reloadBtn) {
			reloadBtn.textContent = t.gui.settings.reload_campaigns;
			reloadBtn.addEventListener('click', () => {
				saveSettings();			
				reloadBtn.disabled = true;
				const originalText = reloadBtn.textContent;
				reloadBtn.textContent = "Reloading..."; 				
				socket.emit('reload_campaigns');				
				setTimeout(() => { 
					reloadBtn.disabled = false; 
					reloadBtn.textContent = originalText;
				}, 30000);
			});
		}
        // Re-render games to watch with translated empty messages
        renderGamesToWatch();
    }

    // Update Help tab
    const helpTab = document.getElementById('help-tab');
    if (helpTab && t.gui?.help) {
        // Robust ID selection for Help tab headers
        const aboutHeader = document.getElementById('help-about-header');
        if (aboutHeader) aboutHeader.textContent = t.gui.help.about || 'About Twitch Drops Miner';

        const howtoHeader = document.getElementById('help-howto-header');
        if (howtoHeader) howtoHeader.textContent = t.gui.help.how_to_use || 'How to Use';

        const featuresHeader = document.getElementById('help-features-header');
        if (featuresHeader) featuresHeader.textContent = t.gui.help.features || 'Features';

        const notesHeader = document.getElementById('help-notes-header');
        if (notesHeader) notesHeader.textContent = t.gui.help.important_notes || 'Important Notes';

        // Update list items and links (keeping innerHTML approach for lists as they are dynamic content blocks)
        const helpContent = helpTab.querySelector('.help-content');
        if (helpContent) {
            const howToItems = t.gui.help.how_to_use_items || [
                'Login using your Twitch account (OAuth device code flow)',
                'Link your accounts at <a href="https://www.twitch.tv/drops/campaigns" target="_blank">twitch.tv/drops/campaigns</a>',
                'The miner will automatically discover campaigns and start mining',
                'Configure priority games in Settings to focus on what you want',
                'Monitor progress in the Main and Inventory tabs'
            ];
            const featuresItems = t.gui.help.features_items || [
                'Stream-less drop mining - saves bandwidth',
                'Game priority and exclusion lists',
                'Tracks up to 199 channels simultaneously',
                'Automatic channel switching',
                'Real-time progress tracking'
            ];
            const notesItems = t.gui.help.important_notes_items || [
                'Do not watch streams on the same account while mining',
                'Keep your cookies.jar file secure',
                'Requires linked game accounts for drops'
            ];

            helpContent.replaceChildren(
                makeElement('h2', { id: 'help-about-header' }, t.gui.help.about || 'About Twitch Drops Miner'),
                makeElement('p', {}, t.gui.help.about_text || 'This application automatically mines timed Twitch drops without downloading stream data.'),
                makeElement('h3', { id: 'help-howto-header' }, t.gui.help.how_to_use || 'How to Use'),
                makeHelpList('ol', howToItems),
                makeElement('h3', { id: 'help-features-header' }, t.gui.help.features || 'Features'),
                makeHelpList('ul', featuresItems),
                makeElement('h3', { id: 'help-notes-header' }, t.gui.help.important_notes || 'Important Notes'),
                makeHelpList('ul', notesItems),
                makeElement('div', { class: 'help-links' }, '', el =>
                    el.appendChild(makeElement('a', { href: 'https://github.com/rangermix/TwitchDropsMiner', target: '_blank', rel: 'noopener noreferrer' }, t.gui.help.github_repo || 'GitHub Repository'))
                ),
            );
        }
    }

    // Update Footer
    if (t.gui?.footer) {
        const loadingText = t.gui.footer.loading || 'Loading...';
        const currentVersionEl = document.getElementById('current-version');
        // Only update if it's the specific "Loading..." text to avoid overwriting the fetched version
        if (currentVersionEl && currentVersionEl.textContent === 'Loading...') {
            currentVersionEl.textContent = loadingText;
        }

        const footerVersionText = document.getElementById('footer-version-text');
        if (footerVersionText) {
            const versionLabel = t.gui.footer.version || 'Version:';
            const span = document.getElementById('current-version'); // Need to re-fetch or preserve
            footerVersionText.textContent = versionLabel + ' ';
            // Re-finding the span because textContent wiped it from parent
            if (span) footerVersionText.appendChild(span);
        }
    }

    // Update Badges tooltips
    if (t.gui?.badges) {
        const manualBadge = document.getElementById('manual-mode-badge');
        if (manualBadge && t.gui.badges.manual) manualBadge.title = t.gui.badges.manual.title;

        const autoBadge = document.getElementById('auto-mode-badge');
        if (autoBadge && t.gui.badges.auto) autoBadge.title = t.gui.badges.auto.title;

        const proxyBadge = document.getElementById('proxy-indicator');
        if (proxyBadge && t.gui.badges.proxy) proxyBadge.title = t.gui.badges.proxy.title; // Note: append logic in updateSettingsUI overrides this
    }

    // Update Wanted Drops Panel
    if (mainTab && t.gui?.wanted) {
        // ID: wanted-header
        const wantedHeader = document.getElementById('wanted-header');
        if (wantedHeader) wantedHeader.textContent = t.gui.wanted.name;
        // Re-render wanted items to update empty message
        // Since we don't store wanted items in state globally (only receives them), we rely on updateWantedItems triggering render
    }

    // Update Inventory Filters (re-using existing inventoryTab variable if available, or just querying)
    // Note: inventoryTab was declared above in "Update Inventory Status" section
    // But since that might be in a different block or not, let's be safe and just query element directly without const redeclaration if it conflicts.
    // However, looking at the code, the previous declaration was likely in the same function scope.
    // Simplest fix: use the existing element or re-query without 'const' if needed, but best to just use the one we have.
    // Actually, looking at the view_file, there was 'const inventoryTab' around line 1639.
    // So I should just reuse that variable or use a different name.

    if (inventoryTab && t.gui?.inventory?.filters) {
        const f = t.gui.inventory.filters;
        const updateLabel = (id, text) => {
            const el = document.getElementById(id)?.parentElement.querySelector('span');
            if (el) el.textContent = text;
        };
        updateLabel('filter-active', f.active);
        updateLabel('filter-not-linked', f.not_linked);
        updateLabel('filter-upcoming', f.upcoming);
        updateLabel('filter-expired', f.expired);
        updateLabel('filter-finished', f.finished);
        updateLabel('filter-benefit-item', f.item);
        updateLabel('filter-benefit-badge', f.badge);
        updateLabel('filter-benefit-emote', f.emote);
        updateLabel('filter-benefit-other', f.other);
        updateLabel('hide-complete-events', f.hide_completed_events);

        const clearBtn = document.getElementById('clear-filters-btn');
        if (clearBtn) clearBtn.textContent = f.clear;

        const searchInput = document.getElementById('games-filter');
        if (searchInput) searchInput.placeholder = f.search_placeholder;

        // Update Mining Benefit Labels in Settings (re-using inventory filter keys)
        // IDs: mining-benefit-item, mining-benefit-badge, mining-benefit-emote, mining-benefit-unknown
        updateLabel('mining-benefit-item', f.item);
        updateLabel('mining-benefit-badge', f.badge);
        updateLabel('mining-benefit-emote', f.emote);
        updateLabel('mining-benefit-unknown', f.other);
    }

    // Update header elements
    if (t.gui?.header) {
        const languageLabel = document.querySelector('.language-selector span');
        if (languageLabel) languageLabel.textContent = t.gui.header.language;

        const statusText = document.getElementById('status-text');
        if (statusText && statusText.textContent === 'Initializing...') {
            statusText.textContent = t.gui.header.initializing;
        }

        // Update connection indicator
        const connIndicator = document.getElementById('connection-indicator');
        if (connIndicator) {
            if (state.connected) {
                connIndicator.textContent = '● ' + (t.gui.websocket.connected || 'Connected');
            } else {
                connIndicator.textContent = '● ' + (t.gui.websocket.disconnected || 'Disconnected');
            }
        }
    }
}

async function reloadCampaigns() {
    try {
        await fetch('/api/reload', { method: 'POST' });
        // Status will update via Socket.IO when backend starts operation
    } catch (error) {
        console.error('Failed to reload:', error);
    }
}


// ==================== Tab and Button Management ====================

function switchTab(tabName) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });

    // Show selected tab
    document.getElementById(`${tabName}-tab`).classList.add('active');
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
}

function updateUIState() {
    const isAutoAddEnabled = document.getElementById('auto-add-all-games')?.checked;

    // 1. Vypnutí tlačítek pro hromadný výběr
    const buttons = [
        document.getElementById('select-all-btn'), 
        document.getElementById('deselect-all-btn')
    ];
    
    buttons.forEach(btn => {
        if (btn) btn.disabled = isAutoAddEnabled;
    });

    // 2. Vypnutí jednotlivých checkboxů her
    // Předpokládám, že tvoje checkboxy mají třídu 'game-checkbox'
    // Pokud mají jinou, uprav ten selektor
    document.querySelectorAll('.game-checkbox').forEach(cb => {
        cb.disabled = isAutoAddEnabled;
    });
}

// ==================== Event Listeners ====================

document.addEventListener('DOMContentLoaded', () => {
    // Fetch and display version information
    fetchAndDisplayVersion();

    // Tab switching
    document.querySelectorAll('.tab-button').forEach(button => {
        button.addEventListener('click', () => {
            switchTab(button.dataset.tab);
        });
    });

    // Login form
    document.getElementById('login-button').addEventListener('click', submitLogin);
    document.getElementById('oauth-confirm').addEventListener('click', confirmOAuth);

    // Settings - auto-save on change
    document.getElementById('dark-mode').addEventListener('change', (e) => {
        // Apply dark mode immediately for instant feedback
        if (e.target.checked) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
        // Then save settings
        saveSettings();
    });
    
	// Auto-sort checkbox management
	const autoSortEl = document.getElementById('auto-sort-by-end');
	if (autoSortEl) {
		autoSortEl.addEventListener('change', (e) => {
			// Save the updated auto-sort state to the API
			saveSettings();
			
			// If the user enabled auto-sort, trigger the sorting function immediately
			if (e.target.checked) {
				sortGamesByEnding();
			}
		});
	}
    
	document.getElementById('auto-add-all-games')?.addEventListener('change', async (e) => {
		// Ensure the state is updated locally first
		if (state && state.settings) {
			state.settings.auto_add_all_games = e.target.checked;
		}
		
		// Always save the new checkbox state to the backend immediately
		await saveSettings();
		
		if (e.target.checked) {
			// Apply the logic to add games if needed
			applyAutoAddIfNeeded();
		} else {
			// Unlock UI or apply other logic when turned off
			updateUIState();
		}
	});
	
	document.getElementById('mine-badges-first').addEventListener('change', saveSettings);
    document.getElementById('language').addEventListener('change', saveSettings);
    document.getElementById('connection-quality').addEventListener('change', saveSettings);
    document.getElementById('minimum-refresh-interval').addEventListener('change', saveSettings);
    // Proxy uses a manual "Set Proxy" button instead of auto-save
    document.getElementById('set-proxy-btn').addEventListener('click', () => {
        const proxyInput = document.getElementById('proxy-url');
        const newValue = proxyInput ? proxyInput.value : '';

        // Only save if changed
        if (newValue !== (state.settings.proxy || '')) {
            state.settings.proxy = newValue;
            saveSettings();
            updateUIState();
        }
    });
    document.getElementById('verify-proxy-btn').addEventListener('click', verifyProxy);
    document.getElementById('reload-btn').addEventListener('click', reloadCampaigns);


    // Games to watch management
    document.getElementById('select-all-btn').addEventListener('click', selectAllGames);
    document.getElementById('deselect-all-btn').addEventListener('click', deselectAllGames);
    document.getElementById('add-game-btn').addEventListener('click', addGameFromSearch);
    document.getElementById('sort-by-end-btn').addEventListener('click', sortGamesByEnding);
    document.getElementById('games-filter').addEventListener('input', renderGamesToWatch);

    // Inventory filters
    document.getElementById('filter-active').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-not-linked').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-upcoming').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-expired').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-finished').addEventListener('change', onInventoryFilterChange);
    // Benefit type filters
    document.getElementById('filter-benefit-item').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-benefit-badge').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-benefit-emote').addEventListener('change', onInventoryFilterChange);
    document.getElementById('filter-benefit-other').addEventListener('change', onInventoryFilterChange);
    document.getElementById('clear-filters-btn').addEventListener('click', clearInventoryFilters);

    // Mining benefit settings
    document.getElementById('mining-benefit-item').addEventListener('change', saveSettings);
    document.getElementById('mining-benefit-badge').addEventListener('change', saveSettings);
    document.getElementById('mining-benefit-emote').addEventListener('change', saveSettings);
    document.getElementById('mining-benefit-unknown').addEventListener('change', saveSettings);


    // Inventory game search dropdown
    const gameSearchInput = document.getElementById('inventory-game-search');
    gameSearchInput.addEventListener('focus', () => {
        showGameDropdown();
    });
    gameSearchInput.addEventListener('input', (e) => {
        renderGameDropdown(e.target.value);
    });
    gameSearchInput.addEventListener('keydown', handleGameSearchKeydown);

    // Click outside to close dropdown
    document.addEventListener('click', (e) => {
        const container = document.querySelector('.game-dropdown-container');
        if (container && !container.contains(e.target) && gameDropdownVisible) {
            closeGameDropdown();
        }
    });

    // Manual mode controls
    const exitManualBtn = document.getElementById('exit-manual-btn');
    if (exitManualBtn) {
        exitManualBtn.addEventListener('click', exitManualMode);
    }

    // Fetch and populate available languages
    fetchAndPopulateLanguages();

    // Fetch and apply translations for the current language
    fetchAndApplyTranslations();

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
});


// ==================== Wanted Items Rendering ====================

function formatCampaignDates(startIso, endIso) {
    if (!startIso || !endIso) return '';
    try {
        const start = new Date(startIso);
        const end = new Date(endIso);
        const formatOpts = { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' };
        return `${start.toLocaleDateString(undefined, formatOpts)} – ${end.toLocaleDateString(undefined, formatOpts)}`;
    } catch (e) {
        return '';
    }
}

function renderWantedItems(tree) {
    const container = document.getElementById('wanted-items-list');
    if (!container) return;

    container.innerHTML = '';

    // Uložíme aktuální strom do globálního stavu
    state.wantedItemsTree = tree || [];

    if (!tree || tree.length === 0) {
        const emptyMsg = state.translations.gui?.wanted?.none || 'No wanted drops queued...';
        container.replaceChildren(makeElement('p', { class: 'empty-message-small' }, emptyMsg));
        updateOverallProgress(); // Volání bez argumentu
        return;
    }

    tree.forEach((gameGroup, index) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'wanted-game-group';

        // Game Icon
        let iconUrl = gameGroup.game_icon;
        if (iconUrl) {
            iconUrl = iconUrl.replace('{width}', '40').replace('{height}', '53');
        }

        const headerChildren = [makeElement('span', { class: 'wanted-game-index' }, `#${index + 1}`)];
        if (iconUrl) {
            headerChildren.push(makeImageElement(iconUrl, gameGroup.game_name, 'wanted-game-icon'));
        }
        headerChildren.push(makeElement('span', { class: 'wanted-game-title' }, gameGroup.game_name));

        if (gameGroup.total_remaining_minutes) {
            const hours = Math.floor(gameGroup.total_remaining_minutes / 60);
            const mins = gameGroup.total_remaining_minutes % 60;
            const timeText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
            
            const badgeEl = makeElement('span', { class: 'wanted-game-time-badge' });
            badgeEl.innerHTML = `${getStatusIconSVG('active')} ${timeText}`;
            headerChildren.push(badgeEl);
        }

        const headerEl = makeElement('div', { class: 'wanted-game-header' }, '', el => {
            headerChildren.forEach(child => el.appendChild(child));
        });
        groupEl.appendChild(headerEl);

        const campaignListEl = document.createElement('div');
        campaignListEl.className = 'wanted-campaign-list';

        gameGroup.campaigns.forEach(campaign => {
            const cardEl = makeElement('div', { class: 'wanted-card' }, '', el => {
                // Hlavička kampaně
                el.appendChild(makeElement('div', { class: 'wanted-card-header' }, '', h => {
                    const titleRow = makeElement('div', { class: 'wanted-card-header-main' }, '', row => {
                        row.appendChild(makeElement('a', { 
                            href: campaign.url, 
                            target: '_blank', 
                            rel: 'noopener noreferrer', 
                            class: 'wanted-card-campaign-link', 
                            title: campaign.name 
                        }, campaign.name));

                        const claimedCount = campaign.claimed_drops_count ?? campaign.drops.filter(d => d.is_claimed).length;
                        const totalCount = campaign.total_drops_count ?? campaign.drops.length;
                        row.appendChild(makeElement('span', { class: 'wanted-campaign-badge' }, `(${claimedCount}/${totalCount})`));
                    });
                    h.appendChild(titleRow);

                    // Datumy kampaně
                    const dateText = formatCampaignDates(campaign.starts_at, campaign.ends_at);
                    if (dateText) {
                        const datesEl = makeElement('div', { class: 'wanted-campaign-dates' });
                        datesEl.innerHTML = `${getStatusIconSVG('upcoming')} ${dateText}`;
                        h.appendChild(datesEl);
                    }
                }));

                const dropContainer = makeElement('div', { class: 'wanted-drops-container' });

                campaign.drops.forEach(drop => {
                    const dropEl = makeElement('div', { 
                        class: `wanted-drop-item ${drop.is_claimed ? 'is-claimed' : ''}` 
                    }, '', el => {
                        
                        // 1. Název dropu + Benefits
                        const infoEl = makeElement('div', { class: 'wanted-drop-info' }, '', info => {
                            info.appendChild(makeElement('span', { class: 'wanted-drop-name' }, drop.name));
                            (drop.benefits || []).forEach(benefit => {
                                info.appendChild(makeElement('span', { class: 'wanted-benefit-pill' }, benefit));
                            });
                        });
                        el.appendChild(infoEl);

                        // 2. Použití SVG ikon pro stavové štítky
                        const statusEl = makeElement('div', { class: 'wanted-drop-status' });
                        if (drop.is_claimed) {
                            statusEl.innerHTML = `<span class="status-tag tag-claimed">${getStatusIconSVG('drop-claimed')} Claimed</span>`;
                        } else if (drop.can_claim) {
                            statusEl.innerHTML = `<span class="status-tag tag-ready">${getStatusIconSVG('drop-ready')} Ready to claim!</span>`;
                        } else if (drop.required_minutes) {
                            const current = drop.current_minutes || 0;
                            statusEl.innerHTML = `<span class="status-tag tag-progress">${getStatusIconSVG('drop-active')} ${current} / ${drop.required_minutes} min</span>`;
                        }
                        el.appendChild(statusEl);

                        // 3. Progress bar
                        if (!drop.is_claimed && drop.progress !== undefined) {
                            const progressPct = Math.min(100, Math.max(0, drop.progress));
                            el.appendChild(makeElement('div', { class: 'wanted-drop-progressbar' }, '', pb => {
                                pb.appendChild(makeElement('div', { 
                                    class: 'wanted-drop-progressfill', 
                                    style: `width: ${progressPct}%` 
                                }));
                            }));
                        }
                    });

                    dropContainer.appendChild(dropEl);
                });

                el.appendChild(makeElement('div', { class: 'wanted-card-body' }, '', b =>
                    b.appendChild(dropContainer)
                ));
            });

            campaignListEl.appendChild(cardEl);
        });

        groupEl.appendChild(campaignListEl);
        container.appendChild(groupEl);
    });

    // Spuštění výpočtu celkového progressu ze synchronizovaného globálního stavu
    updateOverallProgress();
}

// ==================== DOM Utilities ====================

const TRUSTED_HELP_LINKS = new Set(['https://www.twitch.tv/drops/campaigns']);

/**
 * @param {string} tag
 * @param {Record<string, string|number|boolean>} attrs
 * @param {string|number|null} text
 * @param {(el: HTMLElement) => void|null} callback
 */
function makeElement(tag, attrs = {}, text = null, callback = null) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
    if (text !== null && text !== undefined) {
        el.textContent = String(text);
    }
    if (callback) {
        callback(el);
    }
    return el;
}

function makeImageElement(src, alt, className) {
    const image = makeElement('img', { src, alt, class: className });
    image.onerror = () => {
        image.style.display = 'none';
    };
    return image;
}

function makeHelpList(tag, items) {
    return makeElement(tag, {}, null, list => {
        items.forEach(item => {
            list.appendChild(makeElement('li', {}, null, li => appendTrustedHelpContent(li, item)));
        });
    });
}

function appendTrustedHelpContent(parent, text) {
    const source = String(text);
    const linkPattern = /<a\b[^>]*\bhref=(["'])(https:\/\/www\.twitch\.tv\/drops\/campaigns)\1[^>]*>(.*?)<\/a>/gi;
    let lastIndex = 0;
    let match;
    let matched = false;

    while ((match = linkPattern.exec(source)) !== null) {
        matched = true;
        if (match.index > lastIndex) {
            parent.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
        }
        const href = match[2];
        if (TRUSTED_HELP_LINKS.has(href)) {
            parent.appendChild(makeElement('a', { href, target: '_blank', rel: 'noopener noreferrer' }, match[3]));
        } else {
            parent.appendChild(document.createTextNode(match[0]));
        }
        lastIndex = linkPattern.lastIndex;
    }

    if (!matched) {
        parent.textContent = source;
        return;
    }

    if (lastIndex < source.length) {
        parent.appendChild(document.createTextNode(source.slice(lastIndex)));
    }
}


function getStatusIconSVG(statusClass) {
    const icons = {
        // Drops
        'completed': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
        'ready': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`,
        'drop-claimed': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
        // Změněno na ikonu dárku pro "Ready"
        'drop-ready': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`,
        // Změněno na křížek v kroužku
        'drop-expired': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`,
        'drop-active': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        
        // Kampaně
        'active': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        'upcoming': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
        'expired': `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>`
    };
    return icons[statusClass] || '';
}
