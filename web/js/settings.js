// ==================== UI & Settings Updates ====================

function updateSettingsUI(settings) {
    state.settings = settings || {};
    
    const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = Boolean(val); };
    const setValue = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

    setChecked('dark-mode', settings.dark_mode);
    setChecked('auto-sort-by-end', settings.auto_sort_by_end);
    setChecked('mine-badges-first', settings.mine_badges_first);
    setChecked('auto-add-all-games', settings.auto_add_all_games);
    setValue('connection-quality', settings.connection_quality || 1);
    setValue('minimum-refresh-interval', settings.minimum_refresh_interval_minutes || 30);

    const proxyUrl = settings.proxy || '';
    const proxyInput = document.getElementById('proxy-url');
    if (proxyInput) proxyInput.value = proxyUrl;

    const proxyIndicator = document.getElementById('proxy-indicator');
    if (proxyIndicator) {
        proxyIndicator.style.display = proxyUrl ? 'inline-flex' : 'none';
        proxyIndicator.title = proxyUrl ? `Proxy active: ${proxyUrl}` : 'Proxy disabled';
    }

    if (settings.language) {
        const languageSelect = document.getElementById('language');
        if (languageSelect) languageSelect.value = settings.language;
    }

    if (settings.dark_mode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }

    if (settings.games_available) {
        availableGames = new Set(settings.games_available);
        if (settings.games_to_watch) {
            settings.games_to_watch.forEach(game => availableGames.add(game));
        }
    }

    if (settings.inventory_filters) {
        setChecked('filter-active', settings.inventory_filters.show_active);
        setChecked('filter-not-linked', settings.inventory_filters.show_not_linked);
        setChecked('filter-upcoming', settings.inventory_filters.show_upcoming);
        setChecked('filter-expired', settings.inventory_filters.show_expired);
        setChecked('filter-finished', settings.inventory_filters.show_finished);

        selectedInventoryGames = Array.isArray(settings.inventory_filters.game_name_search)
            ? [...settings.inventory_filters.game_name_search]
            : [];
        updateGameTagsDisplay();

        setChecked('filter-benefit-item', settings.inventory_filters.show_benefit_item !== false);
        setChecked('filter-benefit-badge', settings.inventory_filters.show_benefit_badge !== false);
        setChecked('filter-benefit-emote', settings.inventory_filters.show_benefit_emote !== false);
        setChecked('filter-benefit-other', settings.inventory_filters.show_benefit_other !== false);
    }

    if (settings.mining_benefits) {
        setChecked('mining-benefit-item', settings.mining_benefits.DIRECT_ENTITLEMENT);
        setChecked('mining-benefit-badge', settings.mining_benefits.BADGE);
        setChecked('mining-benefit-emote', settings.mining_benefits.EMOTE);
        setChecked('mining-benefit-unknown', settings.mining_benefits.UNKNOWN);
    }

    renderGamesToWatch();
    if (typeof renderChannels === 'function') renderChannels();
    if (typeof renderInventory === 'function') renderInventory();
    
    applyAutoAddIfNeeded();
    console.debug('[Settings] UI elements updated from settings state.');
}

function updateManualModeUI(manualModeInfo) {
    const manualBadge = document.getElementById('manual-mode-badge');
    const autoBadge = document.getElementById('auto-mode-badge');
    const manualGameName = document.getElementById('manual-game-name');
    const manualControls = document.getElementById('manual-mode-controls');
    const manualModeGame = document.getElementById('manual-mode-game');

    if (!manualBadge || !autoBadge) return;

    if (manualModeInfo && manualModeInfo.active) {
        manualBadge.classList.remove('hidden');
        autoBadge.classList.add('hidden');
        if (manualGameName) manualGameName.textContent = manualModeInfo.game_name || '';

        if (manualControls) {
            manualControls.classList.remove('hidden');
            if (manualModeGame) manualModeGame.textContent = manualModeInfo.game_name || '';
        }
    } else {
        manualBadge.classList.add('hidden');
        autoBadge.classList.remove('hidden');

        if (manualControls) {
            manualControls.classList.add('hidden');
        }
    }
}
