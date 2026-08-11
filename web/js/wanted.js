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

/**
 * Hlavní renderovací funkce
 * @param {Array} gamesData - Pole her z backendu
 */
function renderWantedItems(gamesData) {
    const container = document.getElementById('wanted-items-list');
    if (!container) return;

    container.innerHTML = '';

    if (!Array.isArray(gamesData) || gamesData.length === 0) {
        container.innerHTML = '<p class="empty-message-small">No wanted drops queued...</p>';
        return;
    }

    gamesData.forEach((game, index) => {
        const gameGroup = document.createElement('div');
        gameGroup.className = 'wanted-game-group';
        if (game.name) gameGroup.setAttribute('data-game-name', game.name);

        // --- 1. HLAVIČKA HRY ---
        const gameHeader = document.createElement('div');
        gameHeader.className = 'wanted-game-header';

        const gameIndex = document.createElement('span');
        gameIndex.className = 'wanted-game-index';
        gameIndex.textContent = `#${index + 1}`;

        const gameIcon = document.createElement('img');
        gameIcon.className = 'wanted-game-icon';
        gameIcon.src = game.icon_url || '';
        gameIcon.alt = game.name || 'Game Icon';

        const gameTitle = document.createElement('span');
        gameTitle.className = 'wanted-game-title';
        gameTitle.textContent = game.name || 'Neznámá hra';

        gameHeader.appendChild(gameIndex);
        gameHeader.appendChild(gameIcon);
        gameHeader.appendChild(gameTitle);

		// --- VÝPOČET CELKOVÉHO ČASU A POKROKU HRY ---
		let totalCurrentMin = 0;
		let totalRequiredMin = 0;
		let totalRemainingMin = 0;
		let earliestEndsAt = null;

		const campaigns = game.campaigns || [];
		campaigns.forEach(campaign => {
			totalRemainingMin += (campaign.remaining_minutes || 0);

			if (campaign.ends_at) {
				if (!earliestEndsAt || new Date(campaign.ends_at) < new Date(earliestEndsAt)) {
					earliestEndsAt = campaign.ends_at;
				}
			}

			(campaign.drops || []).forEach(drop => {
				totalCurrentMin += (drop.current_minutes || 0);
				totalRequiredMin += (drop.required_minutes || 0);
			});
		});

		if (totalRequiredMin > 0) {
			const gameProgressVal = Math.min(100, Math.round((totalCurrentMin / totalRequiredMin) * 100));

			const badgeContainer = document.createElement('div');
			badgeContainer.className = 'wanted-game-badge-container';

			const timeBadge = document.createElement('span');
			timeBadge.className = 'wanted-game-time-badge';
			
			// Převod minut na dny/hodiny/minuty
			const formattedRemaining = formatRemainingTime(totalRemainingMin);
			const formattedEndDate = formatDateTime(earliestEndsAt);
			const endsText = formattedEndDate ? ` (do ${formattedEndDate})` : '';

			timeBadge.innerHTML = `${getStatusIconSVG('active')} zbývá ${formattedRemaining}`;

			const gameProgressBar = document.createElement('div');
			gameProgressBar.className = 'wanted-game-progress-bar';

			const gameProgressFill = document.createElement('div');
			gameProgressFill.className = 'wanted-game-progress-fill';
			gameProgressFill.style.width = `${gameProgressVal}%`;

			gameProgressBar.appendChild(gameProgressFill);
			badgeContainer.appendChild(timeBadge);
			badgeContainer.appendChild(gameProgressBar);

			gameHeader.appendChild(badgeContainer);
		}

		gameGroup.appendChild(gameHeader);
	
        // --- 2. KAMPANĚ ---
        const campaignList = document.createElement('div');
        campaignList.className = 'wanted-campaign-list';

        campaigns.forEach(campaign => {
            const card = document.createElement('div');
            if (campaign.id) card.setAttribute('data-campaign-id', campaign.id);

            const drops = campaign.drops || [];
            const claimedCount = drops.filter(d => d.is_claimed).length;

            // Určení stavu karty a tagu
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

            card.className = `wanted-card ${cardStateClass}`;

            // --- HLAVIČKA KAMPANĚ (DVOUŘÁDKOVÁ MŘÍŽKA) ---
            const cardHeader = document.createElement('div');
            cardHeader.className = `wanted-card-header ${headerStateClass}`;

            // 1. ŘÁDEK: Název vlevo, Status badge vpravo
            const headerTop = document.createElement('div');
            headerTop.className = 'wanted-card-header-top';

            const campaignLink = document.createElement('a');
            campaignLink.className = 'wanted-card-campaign-link';
            campaignLink.href = campaign.url || '#';
            campaignLink.target = '_blank';
            campaignLink.rel = 'noopener noreferrer';
            campaignLink.title = campaign.name || 'Neznámá kampaň';
            campaignLink.textContent = campaign.name || 'Neznámá kampaň';

            const statusBadge = document.createElement('span');
            statusBadge.className = `wanted-status-badge ${statusBadgeClass}`;
            statusBadge.innerHTML = `${getStatusIconSVG(statusText)} ${statusText}`;

            headerTop.appendChild(campaignLink);
            headerTop.appendChild(statusBadge);
            cardHeader.appendChild(headerTop);

            // 2. ŘÁDEK: Datum vlevo, Počet dropů vpravo
            const headerBottom = document.createElement('div');
            headerBottom.className = 'wanted-card-header-bottom';

            if (campaign.starts_at && campaign.ends_at) {
                const datesDiv = document.createElement('div');
                datesDiv.className = 'wanted-campaign-dates';
                const startFmt = formatDateTime(campaign.starts_at);
                const endFmt = formatDateTime(campaign.ends_at);
                datesDiv.innerHTML = `${getStatusIconSVG('upcoming')} ${startFmt} – ${endFmt}`;
                headerBottom.appendChild(datesDiv);
            } else {
                // Prázdný prvek pro zachování flexbox layoutu vpravo, pokud chybí datum
                headerBottom.appendChild(document.createElement('div'));
            }

            if (drops.length > 0) {
                const campaignBadge = document.createElement('span');
                campaignBadge.className = 'wanted-campaign-badge';
                campaignBadge.textContent = `${claimedCount}/${drops.length} Drops`;
                headerBottom.appendChild(campaignBadge);
            }

            cardHeader.appendChild(headerBottom);
            card.appendChild(cardHeader);

            // --- 3. JEDNOTLIVÉ DROPY ---
            if (drops.length > 0) {
                const cardBody = document.createElement('div');
                cardBody.className = 'wanted-card-body';

                drops.forEach(drop => {
                    const dropItem = document.createElement('div');
                    dropItem.className = `wanted-drop-item ${drop.is_claimed ? 'is-claimed' : ''} ${drop.can_claim ? 'can-claim' : ''}`.trim();
                    if (drop.id) dropItem.setAttribute('data-drop-id', drop.id);

                    // --- IKONA DROPU (Kompaktní 28x28) ---
                    const imgUrl = drop.image_url || drop.icon_url;
                    if (imgUrl) {
                        const dropImg = document.createElement('img');
                        dropImg.className = 'wanted-drop-icon';
                        dropImg.src = imgUrl;
                        dropImg.alt = drop.name || 'Drop';
                        dropImg.loading = 'lazy';
                        dropImg.style.width = '28px';
                        dropImg.style.height = '28px';
                        dropImg.style.objectFit = 'contain';
                        dropImg.style.flexShrink = '0';
                        dropImg.style.borderRadius = '4px';
                        dropImg.onerror = function() { this.style.display = 'none'; };
                        dropItem.appendChild(dropImg);
                    } else {
                        const dropIconWrapper = document.createElement('div');
                        dropIconWrapper.className = 'wanted-drop-icon-fallback';
                        dropIconWrapper.style.width = '28px';
                        dropIconWrapper.style.height = '28px';
                        dropIconWrapper.style.flexShrink = '0';
                        dropIconWrapper.style.display = 'flex';
                        dropIconWrapper.style.alignItems = 'center';
                        dropIconWrapper.style.justifyContent = 'center';
                        dropIconWrapper.innerHTML = getStatusIconSVG('box');
                        dropItem.appendChild(dropIconWrapper);
                    }

                    // Název dropu a Benefity (pills)
                    const dropInfo = document.createElement('div');
                    dropInfo.className = 'wanted-drop-info';

                    const dropName = document.createElement('span');
                    dropName.className = 'wanted-drop-name';
                    dropName.textContent = drop.name || 'Drop';
                    dropInfo.appendChild(dropName);

                    const rawName = String(drop.name || '').toLowerCase();
                    if (Array.isArray(drop.benefits)) {
                        drop.benefits.forEach(benefit => {
                            const benefitText = typeof benefit === 'string' ? benefit : benefit?.name;
                            if (!benefitText) return;
                            const cleanBenefit = benefitText.trim().toLowerCase();
                            
                            // Vyfiltrování duplicitního textu v benefitech
                            if (cleanBenefit && cleanBenefit !== rawName && !rawName.includes(cleanBenefit)) {
                                const pill = document.createElement('span');
                                pill.className = 'wanted-benefit-pill';
                                pill.textContent = benefitText;
                                dropInfo.appendChild(pill);
                            }
                        });
                    }

                    dropItem.appendChild(dropInfo);

                    // Pravá část: Stav a progress bar dropu
                    const dropStatus = document.createElement('div');
                    dropStatus.className = 'wanted-drop-status';

                    const cur = formatRemainingTime(drop.current_minutes) ?? 0;
					const req = formatRemainingTime(drop.required_minutes) ?? 0;
                    let pct = drop.progress ?? 0;

                    const statusTextSpan = document.createElement('span');
                    
                    if (drop.is_claimed) {
                        statusTextSpan.className = 'status-tag tag-claimed';
                        statusTextSpan.innerHTML = `${getStatusIconSVG('claimed')} Claimed (100%)`;
                    } else if (drop.can_claim || (req > 0 && pct >= 100)) {
                        statusTextSpan.className = 'status-tag tag-ready';
                        statusTextSpan.innerHTML = `${getStatusIconSVG('ready')} Ready (100%)`;
                    } else {
                        statusTextSpan.className = 'status-tag tag-progress wanted-drop-text';
                        statusTextSpan.innerHTML = `${getStatusIconSVG('active')} ${cur} / ${req} (${pct}%)`;
                    }
                    
                    dropStatus.appendChild(statusTextSpan);

                    const progressBar = document.createElement('div');
                    progressBar.className = 'wanted-drop-progress-bar';

                    const progressFill = document.createElement('div');
                    progressFill.className = 'wanted-drop-progress-fill';
                    progressFill.style.width = `${drop.is_claimed || drop.can_claim ? 100 : pct}%`;

                    progressBar.appendChild(progressFill);
                    dropStatus.appendChild(progressBar);
                    dropItem.appendChild(dropStatus);

                    cardBody.appendChild(dropItem);
                });

                card.appendChild(cardBody);
            }

            campaignList.appendChild(card);
        });

        gameGroup.appendChild(campaignList);
        container.appendChild(gameGroup);
    });
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
