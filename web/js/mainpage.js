///////////////////////////////////////////////////////////////////////////////////////
// MAIN PAGE --- MAIN LOGIC & PARSERS /////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////

// ===================================================================================
//          EVENTY A SOKETOVÁ LOGIKA
// ===================================================================================

// Odchytávání přicházejících dat z WebSocketu
if (typeof socket !== 'undefined' && socket) {
    socket.on('state', handle_state);

    // Pravidelná obnova stavu (každých 60 sekund)
    setInterval(() => {
        if (socket && socket.connected) {
            socket.emit('state');
        } else {
            console.warn('⚠️ Soket není připojen, přesakuji emit.');
        }
    }, 60000); // 👈 Změněno z 5000ms na 60000ms (60 sekund), jak máš v komentáři
}

/**
 * Hlavní handler pro přicházející soketová data
 */
function handle_state(data) {
    if (!data || typeof data !== 'object') {
        console.error('❌ [State] Přijata neplatná nebo prázdná data ze serveru:', data);
        return;
    }

    // 1. Logování RAW příchozích dat ze soketu
    console.log('📥 [WebSocket] RAW příchozí data ze serveru:', data);

    // 💡 Skenujeme přesně pod klíčem 'detail':
    window.dispatchEvent(new CustomEvent('stateUpdated', {
        detail: data // 👈 OPRAVENO: Musí být detail, aby fungovalo e.detail v listeneru!
    }));

    console.log('🚀 [WebSocket] CustomEvent (stateUpdated) úspěšně emitován.');
}
