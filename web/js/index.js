// Twitch Drops Miner Web Client
// Socket.IO and API communication

// ==================== Global State & Initialization ====================


// DISABLE LOGGING 
console.log = () => {};
console.debug = () => {};

let availableGames = new Set(); // All games from campaigns
let draggedElement = null;

// Global state
const state = {
//  debug: true,
    connected: false,
    channels: {},
    campaigns: {},
    settings: {},
    currentDrop: null,
    countdownTimer: null,  // Track the active countdown timer
    translations: {}  // Store current translations
};

const imageCache = new Map();

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
                if (span) footerVersionText.appendChild(span);
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
                    if (span) updateLink.appendChild(span);
                }
            }
        }
        console.debug('[Version] Fetched and updated app version:', data.current_version);
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

// ==================== Authentication & Login ====================

function showLoginForm() {
    const loginForm = document.getElementById('login-form');
    const oauthDisplay = document.getElementById('oauth-code-display');
    if (loginForm) loginForm.style.display = 'block';
    if (oauthDisplay) oauthDisplay.style.display = 'none';
}

function showOAuthCode(url, code) {
    const loginForm = document.getElementById('login-form');
    const oauthDisplay = document.getElementById('oauth-code-display');
    if (loginForm) loginForm.style.display = 'none';
    if (oauthDisplay) oauthDisplay.style.display = 'block';

    const oauthUrl = document.getElementById('oauth-url');
    const oauthCode = document.getElementById('oauth-code');
    if (oauthUrl) oauthUrl.href = url;
    if (oauthCode) oauthCode.textContent = code;
}

function updateLoginStatus(data) {
    const statusEl = document.getElementById('login-status');
    if (!statusEl) return;

    const t = state.translations;
    if (data.user_id) {
        const userIdLabel = t.gui?.login?.user_id_label || 'User ID:';
        statusEl.textContent = `${data.status} (${userIdLabel} ${data.user_id})`;
        statusEl.removeAttribute('translation-key');
        statusEl.style.color = 'var(--success-color)';
        
        const loginForm = document.getElementById('login-form');
        const oauthDisplay = document.getElementById('oauth-code-display');
        if (loginForm) loginForm.style.display = 'none';
        if (oauthDisplay) oauthDisplay.style.display = 'none';
    } else {
        const loggedOut = t.gui?.login?.logged_out || 'Not logged in';
        statusEl.textContent = data.status || loggedOut;
        statusEl.setAttribute('translation-key', 'logged_out');
        statusEl.style.color = 'var(--text-secondary)';

        if (data.oauth_pending) {
            showOAuthCode(data.oauth_pending.url, data.oauth_pending.code);
        }
    }
    console.debug('[Auth] Login status updated:', data.user_id ? `Authenticated (ID: ${data.user_id})` : 'Logged out / Pending');
}

async function submitLogin() {
    const username = document.getElementById('username')?.value || '';
    const password = document.getElementById('password')?.value || '';
    const token = document.getElementById('2fa-token')?.value || '';

    try {
        console.debug('[Auth] Submitting credentials for user:', username);
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
    try {
        console.debug('[Auth] Confirming OAuth status...');
        await fetch('/api/oauth/confirm', {
            method: 'POST'
        });
        const oauthDisplay = document.getElementById('oauth-code-display');
        if (oauthDisplay) oauthDisplay.style.display = 'none';

        const t = state.translations;
        const waitingAuth = t.gui?.login?.waiting_auth || 'Waiting for authentication...';
        const loginStatus = document.getElementById('login-status');
        if (loginStatus) {
            loginStatus.textContent = waitingAuth;
            loginStatus.setAttribute('translation-key', 'waiting_auth');
        }
    } catch (error) {
        console.error('Failed to confirm OAuth:', error);
    }
}

// ==================== Automated Process & Sorting ====================

function sortGamesByEnding() {
    if (!state.settings || !Array.isArray(state.settings.games_to_watch)) return;

    const originalOrder = JSON.stringify(state.settings.games_to_watch);
    state.settings.games_to_watch = getSortedGamesArray(state.settings.games_to_watch);
    const newOrder = JSON.stringify(state.settings.games_to_watch);

    if (originalOrder !== newOrder) {
        console.debug('[Game List] Sorted watched games by ending campaign dates.');
        renderGamesToWatch();
        if (typeof renderChannels === 'function') renderChannels();
        saveSettings();
    }
}

function getSortedGamesArray(games) {
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

    return [...games].sort((a, b) => {
        const dateA = gameEndDates[a] || Infinity;
        const dateB = gameEndDates[b] || Infinity;
        
        if (dateA === Infinity && dateB === Infinity) return 0;
        return dateA - dateB;
    });
}

function applyAutoSortIfNeeded() {
    const autoSortCb = document.getElementById('auto-sort-by-end');
    if (autoSortCb && autoSortCb.checked) {
        sortGamesByEnding();
    }
}

function applyAutoAddIfNeeded() {
    if (state?.settings?.auto_add_all_games) {
        return;
    }

    const autoaddEl = document.getElementById('auto-add-all-games');
    if (autoaddEl && autoaddEl.checked) {
        let hasChanges = false;
        const availableArray = Array.from(availableGames);
        if (!state.settings) state.settings = {};
        if (!state.settings.games_to_watch) state.settings.games_to_watch = [];
        
        availableArray.forEach(game => {
            if (!state.settings.games_to_watch.includes(game)) {
                state.settings.games_to_watch.push(game);
                hasChanges = true;
            }
        });
        
        if (hasChanges) {
            availableGames.clear(); 
            renderGamesToWatch();
            const filterInput = document.getElementById('games-filter');
            if (typeof renderAvailableGames === 'function') {
                renderAvailableGames(Array.from(availableGames), filterInput ? filterInput.value.toLowerCase() : '');
            }
            saveSettings();
            console.debug('[Game List] Auto-added new games to watch list:', state.settings.games_to_watch);
            updateUIState();
        }
    }
}

// ==================== API Functions ====================

async function exitManualMode() {
    try {
        console.debug('[Manual Mode] Exiting manual mode...');
        const response = await fetch('/api/mode/exit-manual', {
            method: 'POST'
        });

        const result = await response.json();
        if (!result.success) {
            console.debug('[Manual Mode] Exit notice:', result.message || 'Already in automatic mode');
        }
    } catch (error) {
        console.error('Failed to exit manual mode:', error);
        if (typeof addConsoleLine === 'function') addConsoleLine(`Error exiting manual mode: ${error.message}`);
    }
}

async function verifyProxy() {
    const proxyInput = document.getElementById('proxy-url');
    const proxyUrl = proxyInput ? proxyInput.value.trim() : '';
    const resultDiv = document.getElementById('proxy-verify-result');

    if (!resultDiv) return;

    resultDiv.style.display = 'block';
    resultDiv.className = 'verify-result loading';
    resultDiv.textContent = 'Verifying connection...';

    if (!proxyUrl) {
        resultDiv.className = 'verify-result error';
        resultDiv.textContent = 'Please enter a proxy URL first.';
        return;
    }

    try {
        console.debug('[Settings] Verifying proxy connection:', proxyUrl);
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
    const getValue = (id, fallback = 0) => { const el = document.getElementById(id); return el ? parseInt(el.value) : fallback; };
    const getChecked = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };

    // Zajištění, že se aktuální vybrané hry v inventáři propíší do filtrů
    const inventoryFilters = typeof getInventoryFilters === 'function' ? getInventoryFilters() : {};
    inventoryFilters.game_name_search = selectedInventoryGames;

    const settings = {
        dark_mode: getChecked('dark-mode'),
        language: document.getElementById('language')?.value || '',
        connection_quality: getValue('connection-quality', 1),
        minimum_refresh_interval_minutes: getValue('minimum-refresh-interval', 30),
        proxy: state.settings?.proxy || '',
        games_to_watch: state.settings?.games_to_watch || [],
        inventory_filters: inventoryFilters,
        auto_sort_by_end: getChecked('auto-sort-by-end'),
        mine_badges_first: getChecked('mine-badges-first'),
        auto_add_all_games: getChecked('auto-add-all-games'),
        ignored_games: state.settings?.ignored_games || [],
        mining_benefits: {
            "DIRECT_ENTITLEMENT": getChecked('mining-benefit-item'),
            "BADGE": getChecked('mining-benefit-badge'),
            "EMOTE": getChecked('mining-benefit-emote'),
            "UNKNOWN": getChecked('mining-benefit-unknown')
        }
    };

    try {
        await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        console.debug('[Settings] Settings saved successfully.');
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

        languageSelect.innerHTML = '';

        data.available.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang;
            option.textContent = lang;
            languageSelect.appendChild(option);
        });

        if (data.current) {
            languageSelect.value = data.current;
        }
    } catch (error) {
        console.error('Failed to fetch languages:', error);
        const languageSelect = document.getElementById('language');
        if (languageSelect) {
            languageSelect.replaceChildren(makeElement('option', { value: '' }, 'Failed to load languages'));
        }
        if (typeof addConsoleLine === 'function') {
            addConsoleLine('Error: Unable to fetch available languages. Please check your connection or try again later.');
        }
    }
}

async function fetchAndApplyTranslations() {
    try {
        const response = await fetch('/api/translations');
        const data = await response.json();

        state.translations = data;
        applyTranslations(data);
        console.debug('[Translation] Loaded and applied interface translations.');
    } catch (error) {
        console.error('Failed to fetch translations:', error);
    }
}

async function reloadCampaigns() {
    try {
        console.debug('[Campaigns] Requesting campaign data reload...');
        await fetch('/api/reload', { method: 'POST' });
    } catch (error) {
        console.error('Failed to reload:', error);
    }
}

// ==================== Translation & Localization ====================

function applyTranslations(t) {
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

    const mainTab = document.getElementById('main-tab');
    if (mainTab && t.gui?.login) {
        const loginHeader = mainTab.querySelector('.login-panel h2');
        if (loginHeader) loginHeader.textContent = t.gui.login.name;

        const loginStatus = document.getElementById('login-status');
        if (loginStatus?.hasAttribute('translation-key')) loginStatus.textContent = t.login?.status?.[loginStatus.getAttribute('translation-key')];

        const usernameInput = document.getElementById('username');
        if (usernameInput) usernameInput.placeholder = t.gui.login.username;

        const passwordInput = document.getElementById('password');
        if (passwordInput) passwordInput.placeholder = t.gui.login.password;

        const twofaInput = document.getElementById('2fa-token');
        if (twofaInput) twofaInput.placeholder = t.gui.login.twofa_code;

        const loginButton = document.getElementById('login-button');
        if (loginButton) loginButton.textContent = t.gui.login.button;

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

    if (mainTab && t.gui?.progress) {
        const progressHeader = document.getElementById('progress-header');
        if (progressHeader) progressHeader.textContent = t.gui.progress.name;

        const noDropMsg = document.getElementById('no-drop-message');
        if (noDropMsg) noDropMsg.textContent = t.gui.progress.no_drop;

        const exitManualBtn = document.getElementById('exit-manual-btn');
        if (exitManualBtn) exitManualBtn.textContent = t.gui.progress.return_to_auto;
    }

    if (mainTab && t.gui) {
        const consoleHeader = document.getElementById('console-header');
        if (consoleHeader) consoleHeader.textContent = t.gui.output;
    }

    if (mainTab && t.gui?.channels) {
        const channelsHeader = document.getElementById('channels-header');
        if (channelsHeader) channelsHeader.textContent = t.gui.channels.name;
        if (typeof renderChannels === 'function') renderChannels();
    }

    const inventoryTab = document.getElementById('inventory-tab');
    if (inventoryTab && t.gui?.inventory) {
        if (typeof renderInventory === 'function') renderInventory();
    }

    const settingsTab = document.getElementById('settings-tab');
    if (settingsTab && t.gui?.settings) {
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
            if (checkbox) darkModeLabel.appendChild(checkbox);
            darkModeLabel.appendChild(document.createTextNode(' ' + t.gui.settings.general.dark_mode));
        }

        const connQualityLabel = settingsTab.querySelector('label:has(#connection-quality)');
        if (connQualityLabel) {
            const input = connQualityLabel.querySelector('input');
            connQualityLabel.textContent = t.gui.settings.connection_quality + ' ';
            if (input) connQualityLabel.appendChild(input);
        }

        const refreshLabel = settingsTab.querySelector('label:has(#minimum-refresh-interval)');
        if (refreshLabel) {
            const input = refreshLabel.querySelector('input');
            refreshLabel.textContent = t.gui.settings.minimum_refresh + ' ';
            if (input) refreshLabel.appendChild(input);
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
        }

        renderGamesToWatch();
    }

    const helpTab = document.getElementById('help-tab');
    if (helpTab && t.gui?.help) {
        const aboutHeader = document.getElementById('help-about-header');
        if (aboutHeader) aboutHeader.textContent = t.gui.help.about || 'About Twitch Drops Miner';

        const howtoHeader = document.getElementById('help-howto-header');
        if (howtoHeader) howtoHeader.textContent = t.gui.help.how_to_use || 'How to Use';

        const featuresHeader = document.getElementById('help-features-header');
        if (featuresHeader) featuresHeader.textContent = t.gui.help.features || 'Features';

        const notesHeader = document.getElementById('help-notes-header');
        if (notesHeader) notesHeader.textContent = t.gui.help.important_notes || 'Important Notes';

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

    if (t.gui?.footer) {
        const loadingText = t.gui.footer.loading || 'Loading...';
        const currentVersionEl = document.getElementById('current-version');
        if (currentVersionEl && currentVersionEl.textContent === 'Loading...') {
            currentVersionEl.textContent = loadingText;
        }

        const footerVersionText = document.getElementById('footer-version-text');
        if (footerVersionText) {
            const versionLabel = t.gui.footer.version || 'Version:';
            const span = document.getElementById('current-version');
            footerVersionText.textContent = versionLabel + ' ';
            if (span) footerVersionText.appendChild(span);
        }
    }

    if (t.gui?.badges) {
        const manualBadge = document.getElementById('manual-mode-badge');
        if (manualBadge && t.gui.badges.manual) manualBadge.title = t.gui.badges.manual.title;

        const autoBadge = document.getElementById('auto-mode-badge');
        if (autoBadge && t.gui.badges.auto) autoBadge.title = t.gui.badges.auto.title;

        const proxyBadge = document.getElementById('proxy-indicator');
        if (proxyBadge && t.gui.badges.proxy) proxyBadge.title = t.gui.badges.proxy.title;
    }

    if (mainTab && t.gui?.wanted) {
        const wantedHeader = document.getElementById('wanted-header');
        if (wantedHeader) wantedHeader.textContent = t.gui.wanted.name;
    }

    if (inventoryTab && t.gui?.inventory?.filters) {
        const f = t.gui.inventory.filters;
        const updateLabel = (id, text) => {
            const parent = document.getElementById(id)?.parentElement;
            const el = parent ? parent.querySelector('span') : null;
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

        updateLabel('mining-benefit-item', f.item);
        updateLabel('mining-benefit-badge', f.badge);
        updateLabel('mining-benefit-emote', f.emote);
        updateLabel('mining-benefit-unknown', f.other);
    }

    if (t.gui?.header) {
        const languageLabel = document.querySelector('.language-selector span');
        if (languageLabel) languageLabel.textContent = t.gui.header.language;

        const statusText = document.getElementById('status-text');
        if (statusText && statusText.textContent === 'Initializing...') {
            statusText.textContent = t.gui.header.initializing;
        }

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

// ==================== Tab and Navigation Management ====================

function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });

    const targetTab = document.getElementById(`${tabName}-tab`);
    const targetBtn = document.querySelector(`[data-tab="${tabName}"]`);
    if (targetTab) targetTab.classList.add('active');
    if (targetBtn) targetBtn.classList.add('active');

    console.debug('[App] Switched tab to:', tabName);
}

function updateUIState() {
    const isAutoAddEnabled = document.getElementById('auto-add-all-games')?.checked;

    const buttons = [
        document.getElementById('select-all-btn'), 
        document.getElementById('deselect-all-btn')
    ];
    
    buttons.forEach(btn => {
        if (btn) btn.disabled = isAutoAddEnabled;
    });

    document.querySelectorAll('.game-checkbox').forEach(cb => {
        cb.disabled = isAutoAddEnabled;
    });
}

// ==================== DOM & UI Utilities ====================

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

const TRUSTED_HELP_LINKS = new Set(['https://www.twitch.tv/drops/campaigns']);

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

// ==================== Pomocné funkce a Event Handlery ====================

// Debounce pro zamezení častého spouštění příkazů při psaní
function debounce(fn, delay = 200) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

// Handler pro přepínání záložek
function handleTabClick(e) {
    const button = e.target.closest('.tab-button');
    if (button?.dataset?.tab) {
        switchTab(button.dataset.tab);
    }
}

// Handler pro přepnutí Dark Mode
function handleDarkModeChange(e) {
    document.body.classList.toggle('dark-mode', e.target.checked);
    saveSettings();
}

// Handler pro automatické řazení
function handleAutoSortChange(e) {
    saveSettings();
    if (e.target.checked) {
        sortGamesByEnding();
    }
}

// Handler pro automatické přidávání všech her
async function handleAutoAddAllGamesChange(e) {
    if (state?.settings) {
        state.settings.auto_add_all_games = e.target.checked;
    }
    renderGamesToWatch();
    await saveSettings();
}

// Handler pro uložení změn v běžném nastavení (Selecty, Checkboxy)
const SETTINGS_IDS_TO_SAVE = new Set([
    'mine-badges-first', 'language', 'connection-quality', 'minimum-refresh-interval',
    'mining-benefit-item', 'mining-benefit-badge', 'mining-benefit-emote', 'mining-benefit-unknown'
]);

function handleSettingsChange(e) {
    if (SETTINGS_IDS_TO_SAVE.has(e.target.id)) {
        saveSettings();
    }
}

// Handler pro nastavení proxy
function handleSetProxyClick() {
    const proxyInput = document.getElementById('proxy-url');
    const newValue = proxyInput ? proxyInput.value.trim() : '';

    if (!state.settings) state.settings = {};
    if (newValue !== (state.settings.proxy || '')) {
        state.settings.proxy = newValue;
        saveSettings();
        updateUIState();
    }
}

// Handler pro Reload tlačítko
async function handleReloadClick() {
    const reloadBtn = document.getElementById('reload-btn');
    if (!reloadBtn) return;

    saveSettings();

    reloadBtn.disabled = true;
    const originalText = reloadBtn.textContent;
    reloadBtn.textContent = "Reloading...";

    if (typeof updateStatus === 'function') {
        updateStatus('Reloading campaigns...');
    }

    let timeoutId;
    const unlockButton = () => {
        reloadBtn.disabled = false;
        reloadBtn.textContent = originalText;
        if (timeoutId) clearTimeout(timeoutId);
        if (typeof socket !== 'undefined' && socket) {
            socket.off('reload_complete', unlockButton);
        }
    };

    timeoutId = setTimeout(unlockButton, 15000);

    try {
        if (typeof socket !== 'undefined' && socket?.connected) {
            socket.once('reload_complete', unlockButton);
            socket.emit('request_reload');
        } else if (typeof reloadCampaigns === 'function') {
            await reloadCampaigns();
            unlockButton();
        } else {
            unlockButton();
        }
    } catch (err) {
        console.error('Failed to trigger campaign reload:', err);
        if (typeof updateStatus === 'function') {
            updateStatus('Failed to reload campaigns');
        }
        unlockButton();
    }
}

// Handlery pro vyhledávání (s obaleným debounce)
const handleGamesFilterInput = debounce(() => {
    renderGamesToWatch();
}, 150);

const handleGameSearchInput = debounce((e) => {
    renderGameDropdown(e.target.value);
}, 150);

function handleGameSearchFocus() {
    showGameDropdown();
}

// Handler pro inventory filtry (Event Delegation)
function handleInventoryFiltersChange(e) {
    if (e.target.id?.startsWith('filter-') && typeof onInventoryFilterChange === 'function') {
        onInventoryFilterChange(e);
    }
}

// Handler pro zavření dropdownu při kliku mimo
function handleOutsideClick(e) {
    if (!gameDropdownVisible) return;
    const container = document.querySelector('.game-dropdown-container');
    if (container && !container.contains(e.target)) {
        closeGameDropdown();
    }
}


// ==================== Event Listeners Registrace ====================

document.addEventListener('DOMContentLoaded', () => {
    fetchAndDisplayVersion();

    // 1. Přepínání záložek
    (document.querySelector('.tabs-header') || document.body).addEventListener('click', handleTabClick);

    // 2. Akční tlačítka
    document.getElementById('login-button')?.addEventListener('click', submitLogin);
    document.getElementById('oauth-confirm')?.addEventListener('click', confirmOAuth);
    document.getElementById('verify-proxy-btn')?.addEventListener('click', verifyProxy);
    document.getElementById('set-proxy-btn')?.addEventListener('click', handleSetProxyClick);
    document.getElementById('reload-btn')?.addEventListener('click', handleReloadClick);
    document.getElementById('select-all-btn')?.addEventListener('click', selectAllGames);
    document.getElementById('deselect-all-btn')?.addEventListener('click', deselectAllGames);
    document.getElementById('add-game-btn')?.addEventListener('click', addGameFromSearch);
    document.getElementById('sort-by-end-btn')?.addEventListener('click', sortGamesByEnding);
    document.getElementById('exit-manual-btn')?.addEventListener('click', exitManualMode);

    if (typeof clearInventoryFilters === 'function') {
        document.getElementById('clear-filters-btn')?.addEventListener('click', clearInventoryFilters);
    }

    // 3. Přepínače a nastavení
    document.getElementById('dark-mode')?.addEventListener('change', handleDarkModeChange);
    document.getElementById('auto-sort-by-end')?.addEventListener('change', handleAutoSortChange);
    document.getElementById('auto-add-all-games')?.addEventListener('change', handleAutoAddAllGamesChange);

    // 4. Delegation pro sekce (Nastavení a Filtry)
    (document.getElementById('settings-tab') || document.body).addEventListener('change', handleSettingsChange);
    (document.getElementById('inventory-filters-container') || document.body).addEventListener('change', handleInventoryFiltersChange);

    // 5. Vyhledávací vstupy
    const gamesFilterInput = document.getElementById('games-filter');
    if (gamesFilterInput) {
        gamesFilterInput.addEventListener('input', handleGamesFilterInput);
    }

    const gameSearchInput = document.getElementById('inventory-game-search');
    if (gameSearchInput) {
        gameSearchInput.addEventListener('focus', handleGameSearchFocus);
        gameSearchInput.addEventListener('input', handleGameSearchInput);
        gameSearchInput.addEventListener('keydown', handleGameSearchKeydown);
    }

    // 6. Globální kliknutí mimo dropdown
    document.addEventListener('click', handleOutsideClick);

    // 7. Inicializace dat
    fetchAndPopulateLanguages();
    fetchAndApplyTranslations();

    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
});
