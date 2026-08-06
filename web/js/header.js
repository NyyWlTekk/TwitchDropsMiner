//////////////////////////////////////////////////
//////////// HEADER FUNCTIONS ////////////////////
//////////////////////////////////////////////////

/**
 * Centrální Master Updater pro stav připojení a diagnostiku UI.
 * @param {boolean|object} input - Přijímá bud true/false nebo diagnostický objekt info
 */
function updateConnectionStatus(input) {
    // 1. Zjistíme přesný stav připojení ze všech možných zdrojů
    let isConnected = false;

    if (typeof input === 'boolean') {
        isConnected = input;
    } else if (input && typeof input.connected === 'boolean') {
        isConnected = input.connected;
    } else {
        isConnected = Boolean(
            (typeof state !== 'undefined' && state?.connected) ||
            (typeof socket !== 'undefined' && socket?.connected) ||
            (typeof socketInstance !== 'undefined' && socketInstance?.connected)
        );
    }

    // Uložíme do globálního state (pokud existuje)
    if (typeof state !== 'undefined') {
        state.connected = isConnected;
    }

    // -------------------------------------------------------------
    // A. HORNÍ INDIKÁTOR V HLAVIČCE (#connection-indicator)
    // -------------------------------------------------------------
    const connIndicator = document.getElementById('connection-indicator');
    if (connIndicator) {
        // Načteme překlady z window nebo state
        const t = window.currentTranslations || (typeof state !== 'undefined' ? state?.translations : null);
        const statusLabel = isConnected 
            ? (t?.gui?.websocket?.connected || 'Connected') 
            : (t?.gui?.websocket?.disconnected || 'Disconnected');

        connIndicator.textContent = `● ${statusLabel}`;
        connIndicator.classList.toggle('connected', isConnected);
        connIndicator.classList.toggle('disconnected', !isConnected);
    }

    // -------------------------------------------------------------
    // B. DIAGNOSTIKA & ADMIN PANEL (socketStatus, queue, rotation)
    // -------------------------------------------------------------
    const socketStatusEl = (typeof elements !== 'undefined' && elements?.socketStatus) 
        || document.getElementById('socket-status');

    if (socketStatusEl) {
        socketStatusEl.textContent = isConnected ? 'Connected' : 'Disconnected';
        socketStatusEl.style.color = isConnected ? '#4caf50' : '#f44336';
    }

    // Pokud byly v objektu předány doplňující diagnostické údaje
    if (typeof input === 'object' && input !== null) {
        const queueCountEl = (typeof elements !== 'undefined' && elements?.queueCount) 
            || document.getElementById('queue-count');
        if (queueCountEl && input.queueCount !== undefined) {
            queueCountEl.textContent = `${input.queueCount} campaigns`;
        }

        const rotationIndexEl = (typeof elements !== 'undefined' && elements?.rotationIndex) 
            || document.getElementById('rotation-index');
        if (rotationIndexEl && input.rotationIndex !== undefined) {
            rotationIndexEl.textContent = input.rotationIndex;
        }
    }
}

// Zpřístupníme funkci globálně pro všechny soubory (sockets.js, administration.js atd.)
window.updateConnectionStatus = updateConnectionStatus;
window.updateDiagnostics = updateConnectionStatus; // Zpětná kompatibilita
