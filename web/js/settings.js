///////////////////////////////////////////////////////////////////////////////
// SETTINGS & MANUAL MODE MODULE (settings.js) ////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// 1. EVENT LISTENER NA ZAČÁTKU SOUBORU
// Odchytává událost a předává data přímo z detailu CustomEventu
window.addEventListener('stateUpdated', (e) => {
    const state = e.detail || window.state || {};
    const settings = state.settings;
    const manualMode = state.manualMode ?? state.manual_mode;

    if (settings) {
        updateSettingsUI(settings);
    }

    updateManualModeUI(manualMode);
});

/**
 * Aktualizuje nastavení formulářů a vizuální prvky UI podle stavu settings
 */
function updateSettingsUI(settings) {
    // Bezpečnostní pojistka
    if (!settings || typeof settings !== 'object') return;

    // Synchronizace do globálního window.state (pokud existuje)
    if (!window.state) window.state = {};
    window.state.settings = settings;

    // Pomocné funkce pro bezpečný zápis do DOMu
    const setChecked = (id, val) => { 
        const el = document.getElementById(id); 
        if (el) el.checked = Boolean(val); 
    };
    const setValue = (id, val) => { 
        const el = document.getElementById(id); 
        if (el) el.value = val ?? ''; 
    };

    // Základní přepínače a vstupy (s podporou camelCase i snake_case)
    const darkModeActive = Boolean(settings.dark_mode ?? settings.darkMode);
    setChecked('dark-mode', darkModeActive);
    setChecked('auto-sort-by-end', settings.auto_sort_by_end ?? settings.autoSortByEnd);
    setChecked('mine-badges-first', settings.mine_badges_first ?? settings.mineBadgesFirst);
    setChecked('auto-add-all-games', settings.auto_add_all_games ?? settings.autoAddAllGames);
    setValue('connection-quality', settings.connection_quality ?? settings.connectionQuality ?? 1);
    setValue('minimum-refresh-interval', settings.minimum_refresh_interval_minutes ?? settings.minimumRefreshIntervalMinutes ?? 30);

    // Proxy nastavení
    const proxyUrl = settings.proxy || '';
    setValue('proxy-url', proxyUrl);

    const proxyIndicator = document.getElementById('proxy-indicator');
    if (proxyIndicator) {
        proxyIndicator.style.display = proxyUrl ? 'inline-flex' : 'none';
        proxyIndicator.title = proxyUrl ? `Proxy active: ${proxyUrl}` : 'Proxy disabled';
    }

    // Jazyk
    if (settings.language) {
        setValue('language', settings.language);
    }

    // Dark Mode class na <body>
    document.body.classList.toggle('dark-mode', darkModeActive);

    // Dostupné a sledované hry
    const gamesAvailable = settings.games_available ?? settings.gamesAvailable;
    if (gamesAvailable) {
        window.availableGames = new Set(gamesAvailable);
        const gamesToWatch = settings.games_to_watch ?? settings.gamesToWatch;
        if (Array.isArray(gamesToWatch)) {
            gamesToWatch.forEach(game => window.availableGames.add(game));
        }
    }

    // Filtry inventáře
    const invFilters = settings.inventory_filters ?? settings.inventoryFilters;
    if (invFilters) {
        setChecked('filter-active', invFilters.show_active ?? invFilters.showActive);
        setChecked('filter-not-linked', invFilters.show_not_linked ?? invFilters.showNotLinked);
        setChecked('filter-upcoming', invFilters.show_upcoming ?? invFilters.showUpcoming);
        setChecked('filter-expired', invFilters.show_expired ?? invFilters.showExpired);
        setChecked('filter-finished', invFilters.show_finished ?? invFilters.showFinished);

        const gameSearch = invFilters.game_name_search ?? invFilters.gameNameSearch;
        window.selectedInventoryGames = Array.isArray(gameSearch) ? [...gameSearch] : [];
            
        if (typeof updateGameTagsDisplay === 'function') updateGameTagsDisplay();

        setChecked('filter-benefit-item', (invFilters.show_benefit_item ?? invFilters.showBenefitItem) !== false);
        setChecked('filter-benefit-badge', (invFilters.show_benefit_badge ?? invFilters.showBenefitBadge) !== false);
        setChecked('filter-benefit-emote', (invFilters.show_benefit_emote ?? invFilters.showBenefitEmote) !== false);
        setChecked('filter-benefit-other', (invFilters.show_benefit_other ?? invFilters.showBenefitOther) !== false);
    }

    // Těžební benefity
    const miningBenefits = settings.mining_benefits ?? settings.miningBenefits;
    if (miningBenefits) {
        setChecked('mining-benefit-item', miningBenefits.DIRECT_ENTITLEMENT);
        setChecked('mining-benefit-badge', miningBenefits.BADGE);
        setChecked('mining-benefit-emote', miningBenefits.EMOTE);
        setChecked('mining-benefit-unknown', miningBenefits.UNKNOWN);
    }

    // Volání externích vykreslovacích funkcí (pokud jsou definovány v DOMu)
    if (typeof renderGamesToWatch === 'function') renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    if (typeof renderInventory === 'function') renderInventory();
    if (typeof applyAutoAddIfNeeded === 'function') applyAutoAddIfNeeded();

    console.log('[Settings] UI elements updated from settings state.');
}

/**
 * Aktualizuje indikátory Manuálního / Automatického režimu v UI
 */
function updateManualModeUI(manualModeInfo) {
    const manualBadge = document.getElementById('manual-mode-badge');
    const autoBadge = document.getElementById('auto-mode-badge');
    const manualGameName = document.getElementById('manual-game-name');
    const manualControls = document.getElementById('manual-mode-controls');
    const manualModeGame = document.getElementById('manual-mode-game');

    if (!manualBadge || !autoBadge) return;

    const isActive = Boolean(manualModeInfo && manualModeInfo.active);
    const gameName = manualModeInfo?.game_name ?? manualModeInfo?.gameName ?? '';

    // Přepínání odznaků
    manualBadge.classList.toggle('hidden', !isActive);
    autoBadge.classList.toggle('hidden', isActive);

    if (manualGameName) {
        manualGameName.textContent = isActive ? gameName : '';
    }

    // Přepínání ovládacích prvků
    if (manualControls) {
        manualControls.classList.toggle('hidden', !isActive);
        if (manualModeGame) {
            manualModeGame.textContent = isActive ? gameName : '';
        }
    }
}
