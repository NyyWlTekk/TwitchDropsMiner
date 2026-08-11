///////////////////////////////////////////////////////////////////////////////
// ==================== Active Drop & Campaign Rotation ====================
///////////////////////////////////////////////////////////////////////////////

let dropRotationIndex = 0;
let currentActiveDrop = null;

window.addEventListener('stateUpdated', (e) => {
//    console.log('🎯 [Rotation] Odchycen stateUpdated event:', e.detail);
    executeRotationStep(e.detail);
    renderAllProgressBars(e.detail);
});

function executeRotationStep(rawAppState = window.state) {
//    console.log('🔥 [Rotation] Spuštěna funkce executeRotationStep s daty:', rawAppState);

    if (!rawAppState) {
//        console.warn('⚠️ [Rotation] rawAppState je prázdné/null!');
        return;
    }

    const rawGames = rawAppState.wantedTree || rawAppState.games || [];
    const rawCampaigns = rawAppState.campaigns || [];
//    console.log('📦 [Rotation] Načtené rawGames:', rawGames.length, 'rawCampaigns:', rawCampaigns.length);

    const validDrops = [];

    const evaluateDrop = (drop, campaign, gameInfo = {}) => {
        if (!drop) return;
        if (Boolean(drop.isClaimed)) return;

        const current = Number(drop.current) || 0;
        const required = Number(drop.required) || 0;

        // Pomocné stavy odvozené z parserů / dat dropu
        const isMining = Boolean(drop.isMining || drop.is_mining || drop.isWatching || drop.is_watching);
        const canClaim = Boolean(drop.canClaim || drop.can_claim || drop.isReady || drop.is_ready);

        // Drop je validní pro rotaci, pokud ještě není plně hotový (nebo se dá vyzvednout/těží se)
        if (required === 0 || current < required || canClaim || isMining) {
            const gameIcon = gameInfo.game_icon || gameInfo.iconUrl || gameInfo.icon_url || campaign.game_icon || campaign.image_url || '';
            
            // Správné vytažení URL obrázku odměny včetně fallbacku na benefits
            const dropImg = drop.imageUrl || drop.image_url || drop.benefit_icon || drop.benefitIcon || (Array.isArray(drop.benefits) ? drop.benefits[0]?.image_url : null) || '';
            const campaignImg = campaign.image_url || campaign.imageUrl || campaign.game_icon || '';
            const finalGameIcon = gameIcon || campaignImg;

            const processedDrop = {
                ...drop,
                id: drop.id || drop.drop_id,
                current,
                required,
                campaign_id: campaign.id,
                campaign_name: campaign.name || campaign.title,
                campaign_url: campaign.url,
                game_name: gameInfo.name || gameInfo.title || campaign.game_name || 'Unknown',
                game_icon: finalGameIcon,
                image_url: dropImg || campaignImg || finalGameIcon,
                isMining,
                canClaim
            };
            validDrops.push(processedDrop);
        }
    };

    // 1. Průchod stromem her (wantedTree)
    if (Array.isArray(rawGames) && rawGames.length > 0) {
        for (const game of rawGames) {
            if (!game) continue;
            const campaigns = game.campaigns || [];
            for (const campaign of campaigns) {
                if (!campaign) continue;
                if (Boolean(campaign.isClaimed)) continue;
                const drops = campaign.drops || [];
                for (const drop of drops) {
                    evaluateDrop(drop, campaign, game);
                }
            }
        }
    }

    // 2. Fallback: Průchod plochým seznamem kampaní
    if (validDrops.length === 0 && Array.isArray(rawCampaigns) && rawCampaigns.length > 0) {
//        console.log('🔄 [Rotation] Zkouším fallback přes rawCampaigns...');
        for (const campaign of rawCampaigns) {
            if (!campaign || Boolean(campaign.isClaimed)) continue;
            const drops = campaign.drops || [];
            for (const drop of drops) {
                evaluateDrop(drop, campaign, campaign);
            }
        }
    }

//    console.log('🎯 [Rotation] Celkem nalezeno validních dropů:', validDrops.length, validDrops);

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');

    if (!validDrops.length) {
//        console.warn('⚠️ [Rotation] Pole validDrops je prázdné! Žádné aktivní dropy ke zobrazení.');
        if (noDropMessage) noDropMessage.style.display = 'block';
        if (dropInfo) dropInfo.style.display = 'none';
        return;
    }

    if (dropRotationIndex >= validDrops.length) {
        dropRotationIndex = 0;
    }

    const activeDrop = validDrops[dropRotationIndex];
    currentActiveDrop = activeDrop;

//    console.log('✨ [Rotation] Aktivní drop vybrán:', { index: dropRotationIndex, activeDrop });

    if (noDropMessage) noDropMessage.style.display = 'none';
    if (dropInfo) dropInfo.style.display = 'block';

    if (typeof renderDropCardLayout === 'function') {
        renderDropCardLayout(activeDrop, activeDrop.image_url);
    } else {
//        console.warn('⚠️ renderDropCardLayout není definována!');
    }
}

function renderAllProgressBars(rawAppState = window.state) {
//    console.log('📊 [Debug Progress] renderAllProgressBars spuštěna s:', rawAppState);

    if (!rawAppState) {
//        console.warn('⚠️ [Debug Progress] rawAppState je prázdné/null!');
        return;
    }

    const dropData = rawAppState.currentDrop || null;
    const validCurrentMins = Number(dropData?.current) || 0;
    const targetDropId = dropData?.id || null;

    // Jednotný odběr kampaní ze stromu her nebo plochého seznamu
    const rawGames = rawAppState.wantedTree || rawAppState.games || [];
    let allCampaigns = [];

    if (Array.isArray(rawGames) && rawGames.length > 0) {
        rawGames.forEach(item => {
            if (!item) return;
            if (Array.isArray(item.campaigns)) {
                item.campaigns.forEach(campaign => {
                    allCampaigns.push({ campaign, game: item });
                });
            } else if (Array.isArray(item.drops) || item.drops) {
                allCampaigns.push({ 
                    campaign: item, 
                    game: { 
                        name: item.game_name || dropData?.game_name || 'Unknown', 
                        iconUrl: item.game_icon || item.image_url 
                    } 
                });
            }
        });
    }

    // Fallback na plochý seznam kampaní, pokud strom her nic nenašel
    if (allCampaigns.length === 0 && Array.isArray(rawAppState.campaigns)) {
        rawAppState.campaigns.forEach(campaign => {
            if (!campaign) return;
            allCampaigns.push({ 
                campaign, 
                game: { 
                    name: campaign.game_name || 'Unknown', 
                    iconUrl: campaign.game_icon || campaign.image_url 
                } 
            });
        });
    }

    let totalCurrent = 0;
    let totalRequired = 0;
    let activeGame = {};
    let activeCampaign = {};
    let activeDropVisualIndex = 1;
    let maxCampaignRequired = 0;

    // Zpracování všech kampaní a výpočet celkových statistik
    allCampaigns.forEach(({ campaign, game }) => {
        if (!campaign) return;

        const drops = Array.isArray(campaign.drops) ? campaign.drops : Object.values(campaign.drops || {});
        let isTargetCampaign = false;
        let currentCampaignMaxReq = 0;

        drops.forEach((drop, idx) => {
            if (!drop) return;
            const dropId = drop.id || drop.drop_id;
            let dropCurrent = Number(drop.current) || 0;
            const dropRequired = Number(drop.required) || 0;

            if (targetDropId && dropId === targetDropId) {
                dropCurrent = validCurrentMins;
                isTargetCampaign = true;
                activeDropVisualIndex = idx + 1;
            }

            if (dropRequired > currentCampaignMaxReq) {
                currentCampaignMaxReq = dropRequired;
            }

            if (!Boolean(drop.isClaimed)) {
                totalCurrent += dropCurrent;
                totalRequired += dropRequired;
            }
        });

        if (isTargetCampaign) {
            activeGame = game;
            activeCampaign = campaign;
            maxCampaignRequired = currentCampaignMaxReq;
        }
    });

//    console.log(`📊 [Debug Finále] Celkem spočteno -> totalCurrent: ${totalCurrent}, totalRequired: ${totalRequired}`);

    // Vykreslení hlavičky a aktivního dropu
    if (dropData) {
        if (typeof renderDropGameHeader === 'function') {
            renderDropGameHeader({
                game_name: activeGame.name || activeGame.title || dropData.game_name,
                campaign_name: activeCampaign.name || activeCampaign.title || dropData.campaign_name,
                campaign_url: activeCampaign.url || dropData.campaign_url,
                game_icon: activeGame.iconUrl || activeGame.game_icon || activeGame.image_url || dropData.game_icon
            });
        }

        const reqMins = dropData.required || 1;
        const dropPct = Math.min(100, Math.max(0, (validCurrentMins / reqMins) * 100));

        const fill = document.getElementById('progress-fill');
        if (fill) {
            fill.style.width = `${dropPct.toFixed(1)}%`;
            fill.textContent = `${Math.round(dropPct)}%`;
        }

        const progressText = document.getElementById('progress-text');
        if (progressText) {
            progressText.textContent = `${validCurrentMins} / ${reqMins} min`;
        }

        const campaignFill = document.getElementById('campaign-progress-fill');
        if (campaignFill) {
            const cardContainer = campaignFill.closest('.secondary-progress-card');
            const totalCampReq = maxCampaignRequired || reqMins;

            if (totalCampReq > 0 && cardContainer) {
                cardContainer.style.display = 'block';
                const campPct = Math.min(100, Math.round((validCurrentMins / totalCampReq) * 100));

                campaignFill.style.width = `${campPct}%`;
                campaignFill.textContent = campPct > 0 ? `${campPct}%` : '';

                const campText = document.getElementById('campaign-progress-text');
                if (campText) campText.textContent = `${validCurrentMins} / ${totalCampReq} min`;

                const campTitle = document.getElementById('campaign-progress-title');
                if (campTitle && activeCampaign.name) {
                    const totalDrops = (activeCampaign.drops || []).length || 1;
                    campTitle.textContent = `${activeCampaign.name} • Drop ${activeDropVisualIndex}/${totalDrops}`;
                }
            } else if (cardContainer) {
                cardContainer.style.display = 'none';
            }
        }
    } else {
        if (typeof renderDropGameHeader === 'function') {
            renderDropGameHeader({});
        }
    }

    // Vykreslení celkového progressu (Overall)
    const overallFill = document.getElementById('overall-progress-fill');
    const overallText = document.getElementById('overall-progress-text');
    const overallTime = document.getElementById('overall-progress-time');

    if (totalRequired > 0) {
        const percentage = Math.min(100, Math.round((totalCurrent / totalRequired) * 100));
        if (overallFill) {
            overallFill.style.width = `${percentage}%`;
            overallFill.textContent = percentage > 5 ? `${percentage}%` : '';
        }
        if (overallText) {
            overallText.textContent = `${percentage}% (${totalCurrent} / ${totalRequired} min)`;
        }
    } else {
        if (overallFill) {
            overallFill.style.width = '0%';
            overallFill.textContent = '';
        }
        if (overallText) {
            overallText.textContent = '0% (0 / 0 min)';
        }
    }

    // Zbývající čas – preferujeme serverová data s fallbackem na spočítaný zbytek
    const totalRemainingMins = rawAppState.totalRemaining 
        ?? rawAppState.total_remaining 
        ?? Math.max(0, totalRequired - totalCurrent);

    if (overallTime) {
        const formattedTime = typeof formatTime === 'function' ? formatTime(totalRemainingMins) : `${totalRemainingMins} min`;
        overallTime.textContent = `Zbývá celkem: ${formattedTime}`;
    }
}

function renderDropGameHeader(data = {}) {
    const dropGameEl = document.getElementById('drop-game');
    if (!dropGameEl) return;

    // Kompletní kaskáda pro ikonu hry včetně boxart klíčů
    const gameIcon = data.game_icon 
        || data.gameIcon 
        || data.iconUrl 
        || data.icon_url 
        || data.box_art_url 
        || data.boxArtUrl 
        || data.game?.game_icon 
        || data.game?.iconUrl 
        || data.game?.box_art_url 
        || '';

    const gameName = data.game_name || data.game?.name || 'Neznámá hra';
    
    // OPRAVA: Nepoužívat data.name (to je název dropu), ale čistě kampaňové klíče
    const campaignName = data.campaign_name || data.campaign?.name || data.title || '';
    
    // Upřednostnění rewardUrl / reward_url před campaign_url
    const rewardUrl = data.rewardUrl 
        || data.reward_url 
        || data.campaign_url 
        || data.url 
        || '#';

    const html = `
        <div id="drop-game" class="drop-game-header">
            <div class="game-icon-container">
                ${gameIcon ? `<img src="${gameIcon}" alt="${gameName}" class="drop-header-img" />` : ''}
            </div>
            <div class="drop-game-text-info">
                <div class="drop-header-title">${gameName}</div>
                ${rewardUrl && rewardUrl !== '#' ? `
                    <a class="drop-header-subtitle" href="${rewardUrl}" target="_blank" rel="noopener noreferrer">
                        ${campaignName}
                    </a>
                ` : `
                    <span class="drop-header-subtitle disabled">
                        ${campaignName}
                    </span>
                `}
            </div>
        </div>
    `;

    if (typeof morphdom === 'function') {
        morphdom(dropGameEl, html);
    } else {
        dropGameEl.outerHTML = html;
    }
}

/**
 * Unified drop card layout rendering function.
 */
function renderDropCardLayout(data, rewardImgUrl) {
//    console.log("[DropCard] Rendering layout for drop:", data, "with provided rewardImgUrl:", rewardImgUrl);

    const currentDropLabel = document.getElementById('current-drop-label');
    if (!currentDropLabel) {
//        console.warn("[DropCard] Element #current-drop-label not found in DOM.");
        return;
    }

    if (!data || typeof data !== 'object') {
//        console.warn("[DropCard] Invalid data passed to renderDropCardLayout.");
        currentDropLabel.textContent = '';
        return;
    }

    // Získání názvu dropu – záloha na benefits[0].name
    const dropName = data.drop_name || data.name || data.benefits?.[0]?.name || 'Drop';
    
    // Čisté získání URL: přednost má předaný rewardImgUrl, pak vlastnosti z objektu data
    const finalImgUrl = rewardImgUrl || data.image_url || data.imageUrl || data.benefits?.[0]?.image_url || '';

    currentDropLabel.textContent = `⚡ Drop: ${dropName}`;

    // Najdeme rodičovský kontejner
    const container = currentDropLabel.parentElement;
    if (!container) {
//        console.warn("[DropCard] Parent container of currentDropLabel not found.");
        return;
    }

    // Odstranění předchozích obrázků, aby nedocházelo k duplicitám
    const oldImages = container.querySelectorAll('.drop-card-left-img');
    oldImages.forEach(img => img.remove());

    // Vložení nového obrázku, pokud URL existuje
    if (finalImgUrl) {
        const img = document.createElement('img');
        img.className = 'benefit-icon drop-reward-icon drop-card-left-img';
        img.alt = dropName;
        img.src = finalImgUrl;
        
        Object.assign(img.style, {
            width: '72px', 
            height: '72px', 
            objectFit: 'contain', 
            borderRadius: '6px', 
            flexShrink: '0', 
            display: 'inline-block',
            verticalAlign: 'middle',
            marginRight: '12px'
        });

        container.insertBefore(img, container.firstChild);
    }
}

/**
 * Updates the single active drop display with caching, queue matching, and DOM rendering.
 */
function updateSingleDropDisplay(data, isFromRotation = false) {
    if (!data || typeof data !== 'object') return;

    const targetId = data.drop_id || data.id;
    if (!targetId) return;

    const activeDrop = typeof getSafeActiveDrop === 'function' ? getSafeActiveDrop() : null;
    const activeId = activeDrop ? (activeDrop.drop_id || activeDrop.id) : null;
    const isCurrentDrop = activeId != null && String(activeId) === String(targetId);

    if (!isFromRotation && activeId != null && !isCurrentDrop) {
        return;
    }

    const dropsQueue = Array.isArray(state?.activeDropsQueue) ? state.activeDropsQueue : [];

    if (activeDrop && isCurrentDrop) {
        data = { ...activeDrop, ...data };
    } else if (dropsQueue.length > 0) {
        const queueItem = dropsQueue.find(d => (d?.drop_id || d?.id) === targetId);
        if (queueItem) {
            data = { ...queueItem, ...data };
        }
    }

    const freshQueueItem = dropsQueue.find(d => (d?.drop_id || d?.id) === targetId);
    if (freshQueueItem?.current_minutes !== undefined) {
        data.current_minutes = freshQueueItem.current_minutes;
    }

    if (activeDrop?.current_minutes !== undefined && !data.is_claimed) {
        const isSameContext = (data.campaign_id && activeDrop.campaign_id && String(data.campaign_id) === String(activeDrop.campaign_id)) ||
                            (data.game_name && activeDrop.game_name && data.game_name === activeDrop.game_name);

        if (isSameContext) {
            const liveMins = Math.max(Number(data.current_minutes || 0), Number(activeDrop.current_minutes));
            data.current_minutes = liveMins;
        }
    }

    const reqMins = Number(data.required_minutes || data.total_minutes || data.required || 0);
    const curMins = Number(data.current_minutes || data.current || 0);

    const isDropClaimed = typeof isClaimed === 'function' ? isClaimed(data) : Boolean(data.is_claimed);

    if (isDropClaimed || (reqMins > 0 && curMins >= reqMins)) {
        if (Array.isArray(state?.activeDropsQueue)) {
            state.activeDropsQueue = state.activeDropsQueue.filter(d => (d?.drop_id || d?.id) !== targetId);
        }
        if (typeof startCombinedRotation === 'function') {
            startCombinedRotation(true);
        }
        return;
    }

    let remSecs;
    if (data.remaining_seconds != null && !isFromRotation) {
        remSecs = Number(data.remaining_seconds);
    } else if (isCurrentDrop && activeDrop?.remaining_seconds != null && !isFromRotation) {
        remSecs = Number(activeDrop.remaining_seconds);
    } else {
        remSecs = Math.max(0, (reqMins - curMins) * 60);
    }

    data.remaining_seconds = remSecs;

    if (typeof debugTime === 'function') {
        debugTime('2. DISPLAY_UPDATE', data);
    }

    if (state && typeof state === 'object') {
        state.currentDrop = data;
        state.current_drop = data;
    }

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'none';
    if (dropInfo) dropInfo.style.display = 'block';

    // Extrakce obrázku odměny s prioritním zohledněním pole benefits
    const rewardImgUrl = typeof resolveDropRewardImageUrl === 'function' 
        ? resolveDropRewardImageUrl(data, targetId) 
        : (data.benefits?.[0]?.image_url || data.imageUrl || data.image_url || data.drop_icon || '');

    // Uložení finální URL i do objektu data, aby k ní měla funkce renderDropCardLayout snadný přístup
    if (rewardImgUrl && !data.image_url) {
        data.image_url = rewardImgUrl;
    }

    if (typeof updateDropTitle === 'function') updateDropTitle(data);
    if (typeof renderDropGameHeader === 'function') renderDropGameHeader(data);
    if (typeof renderDropCardLayout === 'function') renderDropCardLayout(data, rewardImgUrl);
}

/**
 * Switches current campaign display, filters active drops queue, and triggers UI updates.
 */
function switchCampaignDisplay(data, isManualSwitch = false, shouldUpdateDisplay = true) {
    if (data && typeof data === 'object') {
        const now = Date.now();

        if (data.ends_at) {
            const endTime = new Date(data.ends_at).getTime();
            if (!isNaN(endTime) && endTime <= now) {
                if (typeof clearDropProgress === 'function') {
                    clearDropProgress();
                }
                return;
            }
        }

        const curMins = data.current_minutes;
        const reqMins = data.required_minutes;
        if (curMins !== undefined && reqMins !== undefined && reqMins > 0 && curMins >= reqMins) {
            if (typeof clearDropProgress === 'function') {
                clearDropProgress();
            }
            return;
        }
    }

    if (typeof cleanupClaimedCampaigns === 'function') {
        cleanupClaimedCampaigns();
    }

    if (!Array.isArray(state?.activeCampaignsQueue) || state.activeCampaignsQueue.length === 0) {
        if (Array.isArray(state?._lastValidActiveCampaignsQueue) && state._lastValidActiveCampaignsQueue.length > 0) {
            state.activeCampaignsQueue = state._lastValidActiveCampaignsQueue;
        }
    } else if (state && typeof state === 'object') {
        state._lastValidActiveCampaignsQueue = state.activeCampaignsQueue;
    }

    const activeDrop = typeof getSafeActiveDrop === 'function' ? getSafeActiveDrop() : null;
    const previousDropId = activeDrop ? (activeDrop.drop_id || activeDrop.id) : null;

    const { drops = [] } = typeof getCampaignAndDrops === 'function'
        ? getCampaignAndDrops(data)
        : { drops: [] };

    if (drops.length > 0) {
        const targetDropId = data?.drop_id;

        if (targetDropId) {
            const targetDrop = drops.find(d => (d?.id || d?.drop_id) === targetDropId);
            if (targetDrop) {
                if (data.current_minutes !== undefined) targetDrop.current_minutes = data.current_minutes;
                if (data.required_minutes !== undefined) targetDrop.required_minutes = data.required_minutes;
                if (data.remaining_seconds !== undefined) targetDrop.remaining_seconds = data.remaining_seconds;
                if (data.is_claimed !== undefined) targetDrop.is_claimed = data.is_claimed;
            }
        }

        const unclaimedDrops = drops.filter(d => (typeof isClaimed === 'function' ? !isClaimed(d) : !d.is_claimed));
        const targetDrops = unclaimedDrops.length > 0 ? unclaimedDrops : drops;

        if (state && typeof state === 'object') {
            state.activeDropsQueue = typeof mapDropsForQueue === 'function'
                ? mapDropsForQueue(targetDrops, data)
                : targetDrops;
        }

        if (isManualSwitch) {
            const activeQueue = state?.activeDropsQueue ?? [];
            const idx = activeQueue.findIndex(d => (d?.drop_id || d?.id) === targetDropId);
            if (idx !== -1 && state) {
                state.dropRotationIndex = idx;
            }

            setTimeout(() => {
                if (typeof startCombinedRotation === 'function') {
                    startCombinedRotation(true);
                }
            }, 0);
        }
    } else if (state && typeof state === 'object') {
        state.activeDropsQueue = data ? [data] : [];
    }

    if (typeof preloadQueueImages === 'function' && Array.isArray(state?.activeDropsQueue)) {
        preloadQueueImages(state.activeDropsQueue);
    }

    const rotationIdx = state?.dropRotationIndex ?? 0;
    const initialActiveDrop = state?.activeDropsQueue?.[rotationIdx]
        ?? state?.activeDropsQueue?.[0]
        ?? data;

    if (initialActiveDrop) {
        // Zajištění správné URL obrázku včetně prioritního prohledání pole benefits
        const resolvedImgUrl = typeof resolveDropRewardImageUrl === 'function'
            ? resolveDropRewardImageUrl(initialActiveDrop, initialActiveDrop.drop_id || initialActiveDrop.id)
            : (initialActiveDrop.benefits?.[0]?.image_url || initialActiveDrop.image_url || initialActiveDrop.imageUrl || '');

        if (resolvedImgUrl && !initialActiveDrop.image_url) {
            initialActiveDrop.image_url = resolvedImgUrl;
        }
    }

    const newDropId = initialActiveDrop ? (initialActiveDrop.drop_id || initialActiveDrop.id) : null;
    const dropChanged = !previousDropId || !newDropId || String(previousDropId) !== String(newDropId);

    if (shouldUpdateDisplay && typeof updateSingleDropDisplay === 'function') {
        updateSingleDropDisplay(initialActiveDrop, dropChanged);
    }
}

/**
 * Updates UI and state with incoming drop progress data from tick/socket
 */
function updateDropProgress(dropData) {
    if (typeof debugTime === 'function') {
        debugTime('1. INCOMING_TICK', dropData);
    }

    if (!dropData || typeof dropData !== 'object' || Object.keys(dropData).length === 0) {
        if (typeof clearDropProgress === 'function') {
            clearDropProgress();
        }
        return;
    }

    const validDrop = dropData;
    const dropGame = validDrop.game_name || validDrop.game || '';

    if (!Array.isArray(state?.liveMiningQueue)) {
        if (state && typeof state === 'object') {
            state.liveMiningQueue = [];
        }
    }

    const activeCampId = validDrop.campaign_id;

    if (activeCampId && state?.campaigns?.[activeCampId]) {
        if (!state.liveMiningQueue.includes(activeCampId)) {
            state.liveMiningQueue.push(activeCampId);
        }
    }

    if (state?.campaigns) {
        state.liveMiningQueue = state.liveMiningQueue.filter(cid => {
            const camp = state.campaigns[cid];
            if (!camp || (typeof isClaimed === 'function' ? isClaimed(camp) : camp.is_claimed)) return false;

            const drops = typeof extractCampaignDrops === 'function' 
                ? extractCampaignDrops(camp) 
                : (camp.drops ?? []);

            return drops.some(d => (typeof isClaimed === 'function' ? !isClaimed(d) : !d.is_claimed));
        });

        state.activeCampaignsQueue = state.liveMiningQueue
            .map(cid => state.campaigns[cid])
            .filter(Boolean);
    }

    const incomingIdStr = String(validDrop.drop_id || validDrop.id || '');
    const currentMins = Math.round(Number(validDrop.current_minutes || 0));
    const reqMins = Number(validDrop.required_minutes || 0);

    const remSecs = validDrop.remaining_seconds != null
        ? Number(validDrop.remaining_seconds)
        : Math.max(0, (reqMins - currentMins) * 60);

    validDrop.current_minutes = currentMins;
    validDrop.remaining_seconds = remSecs;

    if (state && typeof state === 'object') {
        state.currentDrop = { ...validDrop };
        state.current_drop = { ...validDrop };
    }

    const noDropMessage = document.getElementById('no-drop-message');
    const dropInfo = document.getElementById('drop-info');
    if (noDropMessage) noDropMessage.style.display = 'none';
    if (dropInfo) dropInfo.style.display = 'block';

    const campaignTitleEl = document.getElementById('campaign-title') || document.querySelector('.campaign-header-title');
    if (campaignTitleEl && dropGame) {
        campaignTitleEl.textContent = dropGame;
    }

    const dropGameEl = document.getElementById('drop-game');
    if (dropGameEl) {
        dropGameEl.style.display = 'block';
    }
    if (typeof renderDropGameHeader === 'function') {
        renderDropGameHeader(validDrop);
    }

    const secondaryProgressBars = document.querySelectorAll('.secondary-progress-card, #fallback-drop-card');
    secondaryProgressBars.forEach(card => {
        card.style.display = 'none';
    });

    const timeRemainingEl = document.getElementById('progress-time');
    if (timeRemainingEl) {
        timeRemainingEl.style.display = 'block';
    }

    if (typeof syncAnyDropProgress === 'function') {
        syncAnyDropProgress(incomingIdStr, validDrop);
    } else if (typeof renderAllProgressBars === 'function') {
        renderAllProgressBars(currentMins, validDrop);
    }

    if (typeof updateSingleDropDisplay === 'function') {
        updateSingleDropDisplay(validDrop, false);
    }

    if (typeof updateCampaignProgressData === 'function') {
        updateCampaignProgressData(validDrop, currentMins);
    }
}

/**
 * Executes rotation step safely with a concurrency lock to prevent overlapping ticks.
 */
function runRotationStepSafely() {
    if (isRotationRunning) return;
    isRotationRunning = true;
    try {
        executeRotationStep();
    } catch (err) {
//        console.error('Error in rotation step:', err);
    } finally {
        isRotationRunning = false;
    }
}

/**
 * Initializes drop rotation interval safely with concurrency locks.
 */
function startCombinedRotation(forceRestart = true) {
    if (!state || typeof state !== 'object') return;

    if (state.rotationTimer && !forceRestart) return;

    if (state.rotationTimer) {
        clearInterval(state.rotationTimer);
        state.rotationTimer = null;
    }

    state.rotationTimer = setInterval(runRotationStepSafely, 4000);

    if (document.querySelector('.wanted-drop-item') !== null || (Array.isArray(state.wantedItemsTree) && state.wantedItemsTree.length > 0)) {
        setTimeout(runRotationStepSafely, 0);
    }
}
