// watching.js
// Active stream watching, progress tracking, and watching UI management

import { state } from './index.js';

/**
 * Updates the UI elements related to the currently watched stream/channel.
 */
export function updateWatchingUI() {
    const watchingContainer = document.getElementById('watching-container');
    if (!watchingContainer) return;

    const currentStream = state.watchingStream || state.activeStream;

    if (!currentStream) {
        renderIdleWatchingState(watchingContainer);
        return;
    }

    renderActiveWatchingState(watchingContainer, currentStream);
}

/**
 * Renders the placeholder view when no stream is actively being watched.
 * @param {HTMLElement} container 
 */
function renderIdleWatchingState(container) {
    container.innerHTML = '';
    
    const emptyBox = makeElement('div', { class: 'watching-empty-state' }, '', el => {
        el.appendChild(makeElement('div', { class: 'empty-icon' }, '📺'));
        el.appendChild(makeElement('h3', {}, state.translations?.gui?.watching?.no_stream || 'No active stream'));
        el.appendChild(makeElement('p', {}, 'Select a campaign or wait for automatic channel assignment.'));
    });

    container.appendChild(emptyBox);
}

/**
 * Renders detailed view for the active stream being watched.
 * @param {HTMLElement} container 
 * @param {Object} streamData 
 */
function renderActiveWatchingState(container, streamData) {
    container.innerHTML = '';

    const wrapper = makeElement('div', { class: 'watching-active-card' });

    // Stream Header Info (Avatar, Name, Game, Live Badge)
    const header = makeElement('div', { class: 'watching-header' }, '', el => {
        if (streamData.avatar_url) {
            el.appendChild(makeImageElement(streamData.avatar_url, streamData.channel_name || 'Streamer', 'streamer-avatar'));
        }

        el.appendChild(makeElement('div', { class: 'streamer-details' }, '', details => {
            details.appendChild(makeElement('h3', { class: 'channel-name' }, streamData.channel_name || 'Unknown Channel'));
            details.appendChild(makeElement('span', { class: 'stream-game' }, streamData.game_name || 'No Game Specified'));
        }));

        // Live status badge
        const statusBadge = makeElement('span', { class: 'live-badge' }, '● LIVE');
        el.appendChild(statusBadge);
    });

    wrapper.appendChild(header);

    // Progress and Drop Info
    const progressSection = makeElement('div', { class: 'watching-progress-section' });

    if (streamData.current_drop) {
        const drop = streamData.current_drop;
        const progressPercent = Math.min(100, Math.max(0, Math.round((drop.progress || 0) * 100)));

        progressSection.appendChild(makeElement('div', { class: 'drop-title' }, `Tracking Drop: ${drop.name || 'Active Drop'}`));
        
        // Progress bar container
        const progressBarContainer = makeElement('div', { class: 'progress-bar-container' }, '', containerEl => {
            containerEl.appendChild(makeElement('div', { 
                class: 'progress-bar-fill',
                style: `width: ${progressPercent}%;`
            }));
        });

        progressSection.appendChild(progressBarContainer);

        // Time & percentage label
        const textInfo = makeElement('div', { class: 'progress-text-info' }, '', infoEl => {
            infoEl.appendChild(makeElement('span', {}, `${drop.current_minutes || 0} / ${drop.required_minutes || 0} min`));
            infoEl.appendChild(makeElement('span', { class: 'percent' }, `${progressPercent}%`));
        });

        progressSection.appendChild(textInfo);
    } else {
        progressSection.appendChild(makeElement('p', { class: 'no-active-drop' }, 'No active drop progression available for this channel.'));
    }

    wrapper.appendChild(progressSection);

    // Actions / Controls
    const actionsRow = makeElement('div', { class: 'watching-actions-row' }, '', row => {
        row.appendChild(makeElement('button', { class: 'btn btn-danger btn-stop' }, 'Stop Watching', btn => {
            btn.addEventListener('click', stopWatchingStream);
        }));
    });

    wrapper.appendChild(actionsRow);
    container.appendChild(wrapper);
}

/**
 * Updates watch time progress based on active ticker interval.
 * @param {number} minutesElapsed 
 */
export function updateWatchProgress(minutesElapsed) {
    if (!state.watchingStream || !state.watchingStream.current_drop) return;

    const drop = state.watchingStream.current_drop;
    drop.current_minutes = (drop.current_minutes || 0) + minutesElapsed;

    if (drop.required_minutes && drop.required_minutes > 0) {
        drop.progress = drop.current_minutes / drop.required_minutes;
        if (drop.current_minutes >= drop.required_minutes) {
            drop.can_claim = true;
            console.log(`[Watching] Target minutes reached for drop: ${drop.name}`);
        }
    }

    updateWatchingUI();
}

/**
 * Sets the active stream to watch and updates UI.
 * @param {Object} streamData 
 */
export function startWatchingStream(streamData) {
    if (!streamData) return;
    
    console.log(`[Watching] Started watching channel: ${streamData.channel_name || 'Unknown'}`);
    state.watchingStream = streamData;
    updateWatchingUI();
}

/**
 * Stops current stream watching process and resets state.
 */
export function stopWatchingStream() {
    console.log('[Watching] Stopping current watch process.');
    state.watchingStream = null;
    updateWatchingUI();
}
