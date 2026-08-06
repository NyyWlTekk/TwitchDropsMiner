///////////////////////////////////////////////////////////////////////////////
// MAIN PAGE FUNCTION HELPERS
///////////////////////////////////////////////////////////////////////////////

/////////////////////////////////////////////////////////
/////////////////  STATUS BAR /////////////////
////////////////////////////////////////////////////////

// Pomocné proměnné pro plánování v animačním rámci (rAF)
let pendingStatusText = null;
let isRafScheduled = false;

/**
 * Plánuje aktualizaci statusu na nejbližší renderovací snímek prohlížeče.
 */
function scheduleStatusUpdate(statusText) {
    pendingStatusText = statusText;

    if (!isRafScheduled) {
        isRafScheduled = true;
        requestAnimationFrame(() => {
            if (pendingStatusText !== null) {
                updateStatus(pendingStatusText);
                pendingStatusText = null;
            }
            isRafScheduled = false;
        });
    }
}

// ============================================================================
// 3. CHANNELS INITIALIZATION
// ============================================================================

/**
 * Handles channels received from the server.
 */
function handleInitialChannels(channelsData) {
    if (typeof state === 'undefined') return;

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

// ----------------------------------------------------------------------------
// DATA EXTRACTORS (PARSER & SANITIZER)
// ----------------------------------------------------------------------------

////////////////////////////////////////////////
///// OVERALL QUEUE DATA - MULTIFUINCTIONAL ///////
/////<<<>>>>>/////////<<<<//////////////////////

/**
 * Resolves the currently watched channel object from state or getter helper.
 */
 // active state heler
function getWatchedChannelContext() {
    if (typeof getWatchedChannelObject === 'function') {
        const channel = getWatchedChannelObject();
        if (channel) return channel;
    }
    
    const ch = state?.watchedChannel || state?.currentChannel || state?.watching_channel;
    
    if (typeof ch === 'string' && state?.channels) {
        const chList = Array.isArray(state.channels) ? state.channels : Object.values(state.channels);
        const cleanCh = ch.trim().toLowerCase();
        
        const found = chList.find(c => {
            if (!c) return false;
            const id = String(c.id || c.username || c.name || c.displayName || '').trim().toLowerCase();
            return id === cleanCh;
        });
        
        if (found) return found;
    }
    
    return ch && typeof ch === 'object' ? ch : null;
}

/**
 * Extracts and normalizes wanted items data from raw campaigns state.
 */
function extractWantedItemsData(rawData) {
    console.log('🔄 Redrawing wanted panel:', new Date().toLocaleTimeString());
    if (!rawData) return [];
    const list = Array.isArray(rawData) ? rawData : Object.values(rawData);

    const slugify = (text) => {
        return String(text || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/g, '_')
            .replace(/_+/g, '_');
    };

    const watchedChannel = typeof getWatchedChannelContext === 'function' ? getWatchedChannelContext() : null;
    const currentDrop = (typeof state !== 'undefined') ? (state?.currentDrop || state?.current_drop) : null;

    return list
        .filter(g => {
            if (!g || typeof g !== 'object') return false;
            const name = g.game_name || g.game || g.game_title;
            return typeof isGameIgnored === 'function' ? !isGameIgnored(name) : true;
        })
        .map((g, gIndex) => {
            const gameName = g.game_name || g.game || g.game_title || 'Unknown Game';
            const gameSlug = slugify(gameName);
            const gameId = String(g.game_id || g.id || `game_${gameSlug}_${gIndex + 1}`);
            const gameIcon = g.game_icon || g.icon || g.box_art_url || g.image_url || null;
            const gameTotalRemainingMins = Number(g.total_remaining_minutes ?? g.totalRemainingMinutes ?? g.remaining_minutes ?? 0);

            return {
                id: gameId,
                game_id: gameId,
                game_slug: gameSlug,
                game_name: gameName,
                game_icon: gameIcon,
                total_remaining_minutes: gameTotalRemainingMins,
                campaigns: (g.campaigns || g.campaign_list || []).map((c, cIndex) => {
                    const campaignName = c.name || c.title || 'Campaign';
                    const campaignSlug = slugify(campaignName);
                    const campaignId = String(c.id || c.campaign_id || `${gameSlug}_camp_${cIndex + 1}`);
                    const campaignTotalRemainingMins = Number(c.total_remaining_minutes ?? c.totalRemainingMinutes ?? c.remaining_minutes ?? 0);

                    const rawDropsList = c.drops || c.time_based_drops || [];

                    const mappedDrops = rawDropsList.map((d, dIndex) => {
                        const currentMins = Number(d.current_minutes ?? d.currMins ?? 0);
                        const requiredMins = Number(d.required_minutes ?? 0);
                        const isClaimed = Boolean(d.is_claimed || d.claimed || d.status === 'CLAIMED');
                        const dropName = d.name || d.title || `Drop ${dIndex + 1}`;
                        const dropSlug = slugify(dropName);
                        const safeDropId = String(d.id || d.drop_id || d.uuid || `${campaignId}_drop_${dropSlug}_${dIndex + 1}`);

                        let progressPct = 0;
                        if (requiredMins > 0) {
                            progressPct = Math.min(100, Math.max(0, Math.round((currentMins / requiredMins) * 100)));
                        }
                        if (typeof d.progress === 'number' && d.progress > 0) {
                            progressPct = d.progress <= 1 
                                ? Math.min(100, Math.max(0, Math.round(d.progress * 100)))
                                : Math.min(100, Math.max(0, Math.round(d.progress)));
                        }

                        let imageUrl = d.image_url || d.preview_url || d.badge_url || d.box_art_url || null;
                        if (!imageUrl && Array.isArray(d.benefits) && d.benefits.length > 0) {
                            const firstBenefit = d.benefits[0];
                            if (typeof firstBenefit === 'object' && firstBenefit !== null) {
                                imageUrl = firstBenefit.image_url || firstBenefit.icon_url || firstBenefit.preview_url || null;
                            }
                        }

                        return {
                            id: safeDropId,
                            drop_id: safeDropId,
                            drop_slug: dropSlug,
                            campaign_id: campaignId,
                            campaign_name: campaignName,
                            game_name: gameName,
                            game_icon: gameIcon,
                            name: dropName,
                            current_minutes: currentMins,
                            required_minutes: requiredMins,
                            progress: progressPct,
                            is_claimed: isClaimed,
                            can_claim: Boolean(d.can_claim ?? (!isClaimed && requiredMins > 0 && currentMins >= requiredMins)),
                            benefits: d.benefits || d.rewards || [],
                            image_url: imageUrl
                        };
                    });

                    let isActivelyMining = false;
                    if (currentDrop) {
                        const curCampId = String(currentDrop.campaign_id || currentDrop.raw?.campaign_id || '').trim();
                        const curDropId = String(currentDrop.drop_id || currentDrop.id || currentDrop.dropId || currentDrop.raw?.drop_id || '').trim();
                        const curCampName = (currentDrop.campaign_name || currentDrop.raw?.campaign_name || '').trim().toLowerCase();

                        if (campaignId && curCampId && curCampId === campaignId) {
                            isActivelyMining = true;
                        } else if (curCampName && campaignName.trim().toLowerCase() === curCampName) {
                            isActivelyMining = true;
                        } else if (curDropId && mappedDrops.some(d => String(d.id) === curDropId || String(d.drop_id) === curDropId)) {
                            isActivelyMining = true;
                        }
                    }

                    if (!isActivelyMining && watchedChannel) {
                        const channelCampId = String(watchedChannel.campaign_id || watchedChannel.campaignId || '').trim();
                        if (campaignId && channelCampId && channelCampId === campaignId) {
                            isActivelyMining = true;
                        }
                    }

                    const hasProgress = !isActivelyMining && mappedDrops.some(d => !d.is_claimed && (d.progress > 0 || d.current_minutes > 0));
                    const isReadyToClaim = mappedDrops.some(d => d.can_claim);
                    const totalDrops = mappedDrops.length;
                    const claimedDrops = mappedDrops.filter(d => d.is_claimed).length;
                    const isClaimed = totalDrops > 0 && claimedDrops === totalDrops;
                    const isExpired = c.status === 'EXPIRED' || (c.ends_at && new Date(c.ends_at) < new Date());

                    let classList = ['wanted-card'];
                    if (isActivelyMining) classList.push('is-mining', 'active-mining');
                    else if (isReadyToClaim) classList.push('is-ready', 'ready', 'ready-to-claim');
                    else if (isClaimed) classList.push('is-claimed', 'completed');
                    else if (hasProgress) classList.push('in-progress');
                    else if (isExpired) classList.push('expired');

                    if (c.status) classList.push(String(c.status).toLowerCase());

                    return {
                        id: campaignId,
                        campaign_id: campaignId,
                        campaign_slug: campaignSlug,
                        name: campaignName,
                        game_name: gameName,
                        game_icon: gameIcon,
                        total_remaining_minutes: campaignTotalRemainingMins,
                        status: c.status || null,
                        url: c.url || c.campaign_url || '#',
                        starts_at: c.starts_at || c.start_at || c.start_time || '',
                        ends_at: c.ends_at || c.end_at || c.end_time || '',
                        claimed_drops_count: Number(c.claimed_drops_count ?? c.claimedDropsCount ?? 0),
                        total_drops_count: Number(c.total_drops_count ?? c.totalDropsCount ?? mappedDrops.length),
                        is_mining: isActivelyMining,
                        has_progress: hasProgress,
                        is_ready: isReadyToClaim,
                        is_claimed: isClaimed,
                        card_classes: classList.join(' '),
                        drops: mappedDrops
                    };
                })
            };
        });
}


////////////////////////////////////////////////////////////////////////////
// ----------------------------------------------------------------------------
// 2. EVENT HANDLERS (SUB-FUNKCE)/////////////////////////////////////////
// ----------------------------------------------------------------------------
///////////////////////////////////////////////////////////////////////////

/**
 * Hlavní rozcestník pro veškerá příchozí data.
 */
function handleAllData(type, rawData) {
    if (!rawData) return;

    switch (type) {
        case 'drop_progress':
            handleDropProgress(rawData);
            break;
        case 'wanted_items':
        case 'campaigns':
            handleWantedItemsUpdate(rawData);
            break;
        case 'campaign_update':
            handleCampaignUpdate(rawData);
            break;
        case 'status':
            handleStatusUpdate(rawData);
            break;
        default:
            console.warn('[handleAllData] Neznámý typ události:', type);
    }
}

//////////////////
// DROP DATA//////
/////////////////

function handleDropProgress(rawData) {
    if (!rawData) return;

    if (typeof state !== 'undefined') {
        state.currentDrop = rawData;
        state.current_drop = rawData;

        // 🔥 Uložení aktuálních minut do liveDropsCache pro calculateOverallStats
        const dropId = String(rawData.id || rawData.drop_id || rawData.dropId || '');
        if (dropId) {
            if (!state.liveDropsCache) state.liveDropsCache = {};
            state.liveDropsCache[dropId] = {
                current_minutes: Number(rawData.current_minutes ?? rawData.currentMinutes ?? rawData.currMins ?? 0),
                is_claimed: Boolean(rawData.is_claimed || rawData.claimed || rawData.can_claim || rawData.status === 'CLAIMED')
            };
        }
    }

    // Okamžité překreslení, aby se zelený rámeček rozsvítil hned při změně
    if (typeof renderWantedItems === 'function' && typeof state !== 'undefined' && state.wantedItemsTree) {
        renderWantedItems(state.wantedItemsTree);
    }

    // Updatujeme samotný banner pro aktivní drop
    if (typeof updateDropProgress === 'function') {
        updateDropProgress(rawData);
    }

    // 🔥 AUTOMATICKÝ PŘEPOČET A PŘEKRESLENÍ CELKOVÉHO PROGRESS BARU
    if (typeof calculateOverallStats === 'function') {
        calculateOverallStats();
    }
}

///////////////////////////////////
/////   CAMPAIGN DATA ///////////
////////////////////////////////////

function handleCampaignUpdate(rawData) {
    if (!rawData) return;

    // Správný alias na addCampaign
    if (typeof addCampaign === 'function') {
        addCampaign(rawData);
    }

    // 🔥 AUTOMATICKÝ PŘEPOČET CELKOVÉHO PROGRESS BARU PŘI ZMĚNĚ KAMPAŇOVÝCH DAT
    if (typeof calculateOverallStats === 'function') {
        calculateOverallStats();
    }
}

////////////////////////////////////////////
//////////////// WANTED DATA //////////
/////////////////////////////////

/**
 * Zpracování aktualizace Wanted Items stromu ze soketu.
 * Místo určení: wanted.js
 */
function handleWantedItemsUpdate(rawData) {
    if (!rawData) return;

    const cleanTree = typeof extractWantedItemsData === 'function' 
        ? extractWantedItemsData(rawData) 
        : rawData;

    if (typeof state !== 'undefined') {
        state.wantedItemsTree = cleanTree;
    }

    // 1. Vykreslení kartiček do panelu
    if (typeof renderWantedItems === 'function') {
        renderWantedItems(cleanTree);
    }

    // 2. 🎯 NAJÍT AKTIVNĚ TĚŽENÝ DROP ZE STROMU DATA
    let activeDrop = null;

    if (Array.isArray(cleanTree)) {
        for (const game of cleanTree) {
            if (!game || !Array.isArray(game.campaigns)) continue;

            for (const campaign of game.campaigns) {
                if (campaign.is_mining && Array.isArray(campaign.drops)) {
                    // Najdeme v ní první nevyzvednutý (unclaimed) drop
                    const currentMiningDrop = campaign.drops.find(d => !d.is_claimed) || campaign.drops[0];
                    if (currentMiningDrop) {
                        activeDrop = currentMiningDrop;
                        break;
                    }
                }
            }
            if (activeDrop) break;
        }
    }

    // 3. ZÁLOŽKA: Pokud se nenašel přes is_mining, zkusíme globální state
    if (!activeDrop && typeof state !== 'undefined') {
        activeDrop = state.currentDrop || state.current_drop;
    }

    // 4. PROPOJENÍ S HORNÍM BANNEREM (Progress Barem)
    if (activeDrop && typeof updateSingleDropDisplay === 'function') {
        // Zavoláme existující funkci pro update banneru (false = není to z rotace)
        updateSingleDropDisplay(activeDrop, false);
    } else if (!activeDrop && typeof clearDropProgress === 'function') { // OPRAVENO: satypeof -> typeof
        // Pokud se vážně nic netěží, vynulujeme
        clearDropProgress(true); // true = resetuje jen UI, nemění state
    }

    // 5. AUTOMATICKÝ PŘEPOČET CELKOVÉHO PROGRESS BARU ZE STROMU DATA
    if (typeof calculateOverallStats === 'function') {
        calculateOverallStats();
    }

    // 6. Sync do Admin rozhraní
    if (typeof syncAdminState === 'function') {
        syncAdminState();
    }
}

///////////////////////////////////////////////////////////////
// ----------------------------------------------------------------------------
// 4. SOCKET POLLER & INITIALIZER (AUTOMATIC FETCH)///////////////////////////////
// ----------------------------------------------------------------------------
////////////////////////////////////////////////////////////

let wantedItemsPollerInterval = null;

/**
 * Initializes wanted items and drop progress socket listeners and starts periodic polling.
 */
function initWantedItemsPoller(socketInstance, intervalMs = 30000) {
    if (!socketInstance) {
        console.error('[WantedPoller] Cannot initialize: Socket instance is missing.');
        return;
    }

    // 1. Attach listeners
    socketInstance.off('campaign_update', handleCampaignUpdate);
    socketInstance.on('campaign_update', handleCampaignUpdate);

    socketInstance.off('drop_progress', handleDropProgress);
    socketInstance.on('drop_progress', handleDropProgress);

    // 2. Fetch data immediately if already connected
    if (socketInstance.connected) {
        console.log('[WantedPoller] Emitting initial payload requests...');
        socketInstance.emit('get_wanted_items');
        socketInstance.emit('get_drop_progress');
    }

    // 3. Clear any existing interval before setting a new one
    if (wantedItemsPollerInterval) {
        clearInterval(wantedItemsPollerInterval);
    }

    // 4. Periodically request fresh data
    wantedItemsPollerInterval = setInterval(() => {
        if (socketInstance.connected) {
            console.log('[WantedPoller] Fetching fresh wanted items and drop progress payload...');
            socketInstance.emit('get_wanted_items');
            socketInstance.emit('get_drop_progress');
        }
    }, intervalMs);
}

/**
 * Clears the polling interval timer.
 */
function stopWantedItemsPoller() {
    if (wantedItemsPollerInterval) {
        clearInterval(wantedItemsPollerInterval);
        wantedItemsPollerInterval = null;
        console.log('[WantedPoller] Polling stopped.');
    }
}

/////////////////////////////////////////////////////////////////////////
// ----------------------------------------------------------------------------
// AUTO-START ON SOCKET CONNECTION - EVENT LISENERS//////////////////////////
// ----------------------------------------------------------------------------
/////////////////////////////////////////////////////////////////////////////

// main.js – Reaguje na události soketu pro Wanted logiku

window.addEventListener('app:socket-connected', () => {
    console.log('[Main] Socket connected -> starting wanted items poller...');
    if (typeof initWantedItemsPoller === 'function' && typeof socket !== 'undefined') {
        initWantedItemsPoller(socket, 30000);
    }
});

window.addEventListener('app:socket-disconnected', () => {
    console.warn('[Main] Socket disconnected -> pausing wanted items poller...');
    if (typeof stopWantedItemsPoller === 'function') {
        stopWantedItemsPoller();
    }
});

// ----------------------------------------------------------------------------
// 3. UTILITY & CLEANUP
// ----------------------------------------------------------------------------

function safeClearDrop() {
    if (typeof state !== 'undefined') {
        state.currentDrop = null;
        state.current_drop = null;

        // Vypnutí rotace při idle/offline stavu
        if (state.rotationTimer) {
            clearInterval(state.rotationTimer);
            state.rotationTimer = null;
        }
    }
    if (typeof clearDropProgress === 'function') {
        clearDropProgress();
    }
}
