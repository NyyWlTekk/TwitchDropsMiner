///////////////////////////////////////////////////////////////////////////////
// WANTED QUEUE MODULE ////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Listener na event ze state manageru
window.addEventListener('stateUpdated', (e) => {
    const data = e.detail?.wanted_items || window.state?.wanted_items; 
    if (data !== undefined && data !== null) {
        renderWantedItems(data);
    }
});

/**
 * Pomocná funkce pro formátování ISO datumu do čitelného formátu
 */
function formatDateTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;

    return d.toLocaleString([], {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Převede minuty na nejvyšší časové jednotky (dny, hodiny, minuty)
 */
function formatRemainingTime(totalMinutes) {
    if (!totalMinutes || totalMinutes <= 0) return '0m';

    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const mins = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);

    return parts.join(' ');
}

// Pomocná funkce pro ochranu před XSS
const escapeHtml = (str) => String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * 1. Renderuje jednotlivou položku dropu (Wanted)
 */
function renderWantedDropItem(drop) {
    const isClaimed = Boolean(drop.is_claimed);
    const canClaim = Boolean(drop.can_claim);
    const name = drop.name || 'Drop';
    const rawName = name.toLowerCase();
    const imgUrl = drop.image_url || drop.icon_url;

    // Vyčištění a vyfiltrování duplicitních benefitů
    const benefits = (Array.isArray(drop.benefits) ? drop.benefits : [])
        .map(b => (typeof b === 'string' ? b : b?.name)?.trim())
        .filter(b => b && !rawName.includes(b.toLowerCase()));

    // Výpočet časů a pokroku
    const cur = formatRemainingTime(drop.current_minutes) ?? '0m';
    const req = formatRemainingTime(drop.required_minutes) ?? '0m';
    const pct = drop.progress ?? 0;
    const reqMin = drop.required_minutes ?? 0;

    const isReady = canClaim || (reqMin > 0 && pct >= 100);

    let statusTagHTML = '';
    if (isClaimed) {
        statusTagHTML = `<span class="status-tag tag-claimed">${getStatusIconSVG('claimed')} Claimed (100%)</span>`;
    } else if (isReady) {
        statusTagHTML = `<span class="status-tag tag-ready">${getStatusIconSVG('ready')} Ready (100%)</span>`;
    } else {
        statusTagHTML = `<span class="status-tag tag-progress wanted-drop-text">${getStatusIconSVG('active')} ${cur} / ${req} (${pct}%)</span>`;
    }

    const fillWidth = isClaimed || canClaim ? 100 : pct;
    const itemClass = `wanted-drop-item ${isClaimed ? 'is-claimed' : ''} ${canClaim ? 'can-claim' : ''}`.trim();
    const dataAttr = drop.id ? `data-drop-id="${escapeHtml(drop.id)}"` : '';

    const html = `
        <div class="${itemClass}" ${dataAttr}>
            ${imgUrl 
                ? `<img class="wanted-drop-icon" src="${escapeHtml(imgUrl)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.display='none'">` 
                : `<div class="wanted-drop-icon-fallback">${getStatusIconSVG('box')}</div>`
            }
            <div class="wanted-drop-info">
                <span class="wanted-drop-name">${escapeHtml(name)}</span>
                ${benefits.length > 0 ? `
                    <div class="wanted-drop-benefits-wrapper">
                        ${benefits.map(b => `<span class="wanted-benefit-pill">${escapeHtml(b)}</span>`).join('')}
                    </div>
                ` : ''}
            </div>
            <div class="wanted-drop-status">
                ${statusTagHTML}
                <div class="wanted-drop-progress-bar">
                    <div class="wanted-drop-progress-fill" style="width: ${fillWidth}%;"></div>
                </div>
            </div>
        </div>
    `;

    return document.createRange().createContextualFragment(html).firstElementChild;
}

/**
 * 2. Renderuje kartu jedné kampaně (Wanted)
 */
function renderWantedCampaignCard(campaign) {
    const drops = campaign.drops || [];
    const claimedCount = campaign.claimed_drops_count
    const totalCount = campaign.total_drops_count


    // Určení vizuálního stavu karty a badge
    let cardStateClass = 'is-queued';
    let headerStateClass = 'queued';
    let statusBadgeClass = 'tag-queued';
    let statusText = 'Queued';

    const hasMining = drops.some(d => d.is_mining);
    const hasReady = drops.some(d => d.can_claim);
    const hasInProgress = drops.some(d => d.is_in_progress);
    const allClaimed = drops.length > 0 && drops.every(d => d.is_claimed);

    if (allClaimed) {
        cardStateClass = 'is-claimed';
        headerStateClass = 'claimed';
        statusBadgeClass = 'tag-claimed';
        statusText = 'Claimed';
    } else if (hasMining) {
        cardStateClass = 'is-mining';
        headerStateClass = 'mining';
        statusBadgeClass = 'tag-mining';
        statusText = 'Mining';
    } else if (hasReady) {
        cardStateClass = 'is-ready';
        headerStateClass = 'ready';
        statusBadgeClass = 'tag-ready';
        statusText = 'Ready';
    } else if (hasInProgress) {
        cardStateClass = 'in-progress';
        headerStateClass = 'in-progress';
        statusBadgeClass = 'tag-in-progress';
        statusText = 'In Progress';
    }

    const campaignName = campaign.name || 'Neznámá kampaň';
    const campaignUrl = campaign.url || '#';

    // Formátování dat kampaně
    let datesHTML = '<div></div>';
    if (campaign.starts_at && campaign.ends_at) {
        const startFmt = formatDateTime(campaign.starts_at);
        const endFmt = formatDateTime(campaign.ends_at);
        datesHTML = `
            <div class="wanted-campaign-dates">
                ${getStatusIconSVG('upcoming')} ${escapeHtml(startFmt)} – ${escapeHtml(endFmt)}
            </div>
        `;
    }

    const badgeHTML = drops.length > 0 
        ? `<span class="wanted-campaign-badge">${claimedCount}/${totalCount} Drops</span>` 
        : '';

    const card = document.createElement('div');
    card.className = `wanted-card ${cardStateClass}`;
    if (campaign.id) card.setAttribute('data-campaign-id', campaign.id);

    const cardHeaderHTML = `
        <div class="wanted-card-header ${headerStateClass}">
            <div class="wanted-card-header-top">
                <a class="wanted-card-campaign-link" href="${escapeHtml(campaignUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(campaignName)}">
                    ${escapeHtml(campaignName)}
                </a>
                <span class="wanted-status-badge ${statusBadgeClass}">
                    ${getStatusIconSVG(statusText)} ${statusText}
                </span>
            </div>
            <div class="wanted-card-header-bottom">
                ${datesHTML}
                ${badgeHTML}
            </div>
        </div>
    `;

    card.appendChild(document.createRange().createContextualFragment(cardHeaderHTML));

    // Vložení dropů do těla karty
    if (drops.length > 0) {
        const cardBody = document.createElement('div');
        cardBody.className = 'wanted-card-body';
        drops.forEach(drop => {
            cardBody.appendChild(renderWantedDropItem(drop));
        });
        card.appendChild(cardBody);
    }

    return card;
}

/**
 * 3. Renderuje celou skupinu pro jednu hru (Wanted)
 */
function renderWantedGameGroup(game, index) {
    const gameGroup = document.createElement('div');
    gameGroup.className = 'wanted-game-group';
    if (game.name) gameGroup.setAttribute('data-game-name', game.name);

    const campaigns = game.campaigns || [];

    // Výpočet celkového času a pokroku pro hlavičku hry
    let totalCurrentMin = 0;
    let totalRequiredMin = 0;
    let totalRemainingMin = 0;

    campaigns.forEach(campaign => {
        totalRemainingMin += (campaign.remaining_minutes || 0);
        (campaign.drops || []).forEach(drop => {
            totalCurrentMin += (drop.current_minutes || 0);
            totalRequiredMin += (drop.required_minutes || 0);
        });
    });

    let badgeContainerHTML = '';
    if (totalRequiredMin > 0) {
        const gameProgressVal = Math.min(100, Math.round((totalCurrentMin / totalRequiredMin) * 100));
        const formattedRemaining = formatRemainingTime(totalRemainingMin);

        badgeContainerHTML = `
            <div class="wanted-game-badge-container">
                <span class="wanted-game-time-badge">
                    ${getStatusIconSVG('active')} zbývá ${escapeHtml(formattedRemaining)}
                </span>
                <div class="wanted-game-progress-bar">
                    <div class="wanted-game-progress-fill" style="width: ${gameProgressVal}%;"></div>
                </div>
            </div>
        `;
    }

    const gameName = game.name || 'Neznámá hra';
    const gameIconSrc = game.icon_url || '';

    const gameHeaderHTML = `
        <div class="wanted-game-header">
            <span class="wanted-game-index">#${index + 1}</span>
            <img class="wanted-game-icon" src="${escapeHtml(gameIconSrc)}" alt="${escapeHtml(gameName)}" onerror="this.style.opacity='0.3'">
            <span class="wanted-game-title">${escapeHtml(gameName)}</span>
            ${badgeContainerHTML}
        </div>
    `;

    gameGroup.appendChild(document.createRange().createContextualFragment(gameHeaderHTML));

    // Seznam kampaní pod hlavičkou hry
    const campaignList = document.createElement('div');
    campaignList.className = 'wanted-campaign-list';

    campaigns.forEach(campaign => {
        campaignList.appendChild(renderWantedCampaignCard(campaign));
    });

    gameGroup.appendChild(campaignList);
    return gameGroup;
}

/**
 * Hlavní renderovací funkce s podporou Morphdomu
 * @param {Array} gamesData - Pole her z backendu
 */
function renderWantedItems(gamesData) {
    const container = document.getElementById('wanted-items-list');
    if (!container) return;

    const tempContainer = container.cloneNode(false);

    if (!Array.isArray(gamesData) || gamesData.length === 0) {
        tempContainer.innerHTML = '<p class="empty-message-small">No wanted drops queued...</p>';
        updateWithMorph(container, tempContainer);
        return;
    }

    gamesData.forEach((game, index) => {
        tempContainer.appendChild(renderWantedGameGroup(game, index));
    });

    // Plynulá aktualizace DOMu přes Morphdom
    updateWithMorph(container, tempContainer);
}

/**
 * Pomocná funkce pro vložení SVG ikon přesně podle názvů z CSS předlohy
 */
function getStatusIconSVG(statusName) {
    const status = String(statusName || '').toLowerCase().trim();

    const svgCheck = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
    const svgBox = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M20 6h-4c0-2.21-1.79-4-4-4S8 3.79 8 6H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM12 4c1.1 0 2 .89 2 2h-4c0-1.11.9-2 2-2zM4 20V8h4v2h2V8h4v2h2V8h4v12H4z"/></svg>`;
    const svgClock = `<svg class="status-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`;
    const svgMining = `<svg class="status-icon icon-mining" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`;

    switch (status) {
        case 'mining':
            return svgMining;
        case 'ready':
        case 'ready to claim':
        case 'box':
            return svgBox;
        case 'claimed':
        case 'completed':
            return svgCheck;
        case 'in progress':
        case 'in-progress':
        case 'progress':
        case 'active':
        case 'upcoming':
        case 'queued':
        default:
            return svgClock;
    }
}
