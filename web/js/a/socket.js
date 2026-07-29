import { state } from './state.js';

// Vytvoříme socket hned, aby byl window.socket dostupný okamžitě
export const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
});

window.socket = socket;

/**
 * Initialize all Socket.io event listeners and connection
 */
export function initSocketConnection() {
    console.log('Initializing socket event listeners...');

    socket.on('connect', () => {
        console.log('Connected to server');
        state.connected = true;
        const connText = state.translations.gui?.websocket?.connected || 'Connected';
        const indicator = document.getElementById('connection-indicator');
        if (indicator) {
            indicator.textContent = '● ' + connText;
            indicator.className = 'connected';
        }
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        state.connected = false;
        const disconnText = state.translations.gui?.websocket?.disconnected || 'Disconnected';
        const indicator = document.getElementById('connection-indicator');
        if (indicator) {
            indicator.textContent = '● ' + disconnText;
            indicator.className = 'disconnected';
        }
    });

    socket.on('initial_state', (data) => {
        console.log('Received initial state', data);
        if (data.status && typeof window.updateStatus === 'function') window.updateStatus(data.status);

        if (data.channels) {
            data.channels.forEach(ch => {
                state.channels[ch.id] = ch;
            });
            if (typeof window.renderChannels === 'function') window.renderChannels();
        }

        if (data.campaigns) {
            data.campaigns.forEach(camp => {
                state.campaigns[camp.id] = camp;
            });
            if (typeof window.renderInventory === 'function') window.renderInventory();
        }

        if (data.console) {
            const consoleEl = document.getElementById('console-output');
            if (consoleEl) {
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

        if (data.settings && typeof window.updateSettingsUI === 'function') window.updateSettingsUI(data.settings);
        if (data.login && typeof window.updateLoginStatus === 'function') window.updateLoginStatus(data.login);
        if (data.manual_mode && typeof window.updateManualModeUI === 'function') window.updateManualModeUI(data.manual_mode);
        
        if (data.current_drop && typeof window.updateDropProgress === 'function') {
            window.updateDropProgress(data.current_drop);
        } else if (typeof window.clearDropProgress === 'function') {
            window.clearDropProgress();
        }

        if (data.wanted_items && typeof window.renderWantedItems === 'function') {
            window.renderWantedItems(data.wanted_items);
        }

        const autosortEl = document.getElementById('auto-sort-by-end');
        if (autosortEl && data.settings) {
            autosortEl.checked = data.settings.auto_sort_by_end || false;
            if (typeof window.applyAutoSortIfNeeded === 'function') window.applyAutoSortIfNeeded();
        }
        
        const autoaddEl = document.getElementById('auto-add-all-games');
        if (autoaddEl && data.settings) {
            autoaddEl.checked = data.settings.auto_add_all_games || false;
            if (typeof window.applyAutoAddIfNeeded === 'function') window.applyAutoAddIfNeeded();
        }
    });

    socket.on('status_update', (data) => {
        if (typeof window.updateStatus === 'function') window.updateStatus(data.status);
    });

    socket.on('console_output', (data) => {
        if (typeof window.addConsoleLine === 'function') window.addConsoleLine(data.message);
    });

    socket.on('channel_add', (data) => {
        if (typeof window.updateChannel === 'function') window.updateChannel(data);
    });

    socket.on('channel_update', (data) => {
        if (typeof window.updateChannel === 'function') window.updateChannel(data);
    });

    socket.on('channel_remove', (data) => {
        if (typeof window.removeChannel === 'function') window.removeChannel(data.id);
    });

    socket.on('channels_clear', () => {
        if (typeof window.clearChannels === 'function') window.clearChannels();
    });

    socket.on('channels_batch_update', (data) => {
        state.channels = {};
        data.channels.forEach(ch => {
            state.channels[ch.id] = ch;
        });
        if (typeof window.renderChannels === 'function') window.renderChannels();
    });

    socket.on('channel_watching', (data) => {
        if (typeof window.setWatchingChannel === 'function') window.setWatchingChannel(data.id);
    });

    socket.on('channel_watching_clear', () => {
        if (typeof window.clearWatchingChannel === 'function') window.clearWatchingChannel();
    });

    socket.on('drop_progress', (data) => {
        if (typeof window.updateDropProgress === 'function') window.updateDropProgress(data);
    });

    socket.on('drop_progress_stop', () => {
        if (typeof window.clearDropProgress === 'function') window.clearDropProgress();
    });

    socket.on('campaign_add', (data) => {
        if (typeof window.addCampaign === 'function') window.addCampaign(data);
    });

    socket.on('inventory_clear', () => {
        if (typeof window.clearInventory === 'function') window.clearInventory();
    });

    socket.on('inventory_batch_update', (data) => {
        state.campaigns = {};
        data.campaigns.forEach(camp => {
            state.campaigns[camp.id] = camp;
        });
        if (typeof window.renderInventory === 'function') window.renderInventory();
        if (typeof window.applyAutoSortIfNeeded === 'function') window.applyAutoSortIfNeeded();
    });

    socket.on('login_required', () => {
        if (typeof window.showLoginForm === 'function') window.showLoginForm();
    });

    socket.on('oauth_code_required', (data) => {
        if (typeof window.showOAuthCode === 'function') window.showOAuthCode(data.url, data.code);
    });

    socket.on('login_status', (data) => {
        if (typeof window.updateLoginStatus === 'function') window.updateLoginStatus(data);
    });

    socket.on('login_clear', (data) => {
        if (data.login) document.getElementById('username').value = '';
        if (data.password) document.getElementById('password').value = '';
        if (data.token) document.getElementById('2fa-token').value = '';
    });

    socket.on('settings_updated', (data) => {
        if (typeof window.updateSettingsUI === 'function') window.updateSettingsUI(data);
        if (data.auto_sort_by_end && typeof window.sortGamesByEnding === 'function') {
            window.sortGamesByEnding();
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
            const audio = new Audio('/static/notification.mp3');
            audio.play().catch(() => {});
        }
        if (typeof window.flashTitle === 'function') window.flashTitle();
    });

    socket.on('manual_mode_update', (data) => {
        if (typeof window.updateManualModeUI === 'function') window.updateManualModeUI(data);
    });

    socket.on('language_changed', (data) => {
        console.log('Language changed to:', data.language);
        if (typeof window.fetchAndApplyTranslations === 'function') window.fetchAndApplyTranslations();
    });

    socket.on('wanted_items_update', (data) => {
        if (typeof window.renderWantedItems === 'function') window.renderWantedItems(data);
    });

    return socket;
}
