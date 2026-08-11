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
    }, 1000); // 👈 Změněno z 5000ms na 60000ms (60 sekund), jak máš v komentáři
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


/////////// HELPERS ///////////////////

/**
 * Univerzální pomocník pro plynulou aktualizaci jakéhokoliv DOM kontejneru přes Morphdom.
 * 
 * @param {HTMLElement|string} target - Cílový element nebo jeho ID
 * @param {HTMLElement|DocumentFragment|string} newContent - Nový obsah (HTML string, DOM element nebo fragment)
 * @param {Object} [options={}] - Volitelné nastavení pro morphdom
 */
function updateWithMorph(target, newContent, options = {}) {
    const targetEl = typeof target === 'string' ? document.getElementById(target) : target;
    if (!targetEl) return;

    // Příprava zdrojového elementu podle typu newContent
    let sourceEl;
    if (typeof newContent === 'string') {
        sourceEl = targetEl.cloneNode(false);
        sourceEl.innerHTML = newContent;
    } else if (newContent instanceof DocumentFragment) {
        sourceEl = targetEl.cloneNode(false);
        sourceEl.appendChild(newContent);
    } else {
        sourceEl = newContent;
    }

    // Výchozí univerzální logíka identifikace uzlů
    const defaultGetNodeKey = function (node) {
		if (!node || node.nodeType !== 1) return;

		// 1. Explicitní univerzální klíče (nejvyšší priorita)
		if (node.hasAttribute('data-key')) return node.getAttribute('data-key');
		if (node.hasAttribute('data-id')) return node.getAttribute('data-id');
		if (node.id) return node.id;

		// 2. Dynamická detekce: Automaticky najde jakýkoliv data-*-id nebo data-*-key
		// Odchytí: data-drop-id, data-campaign-id, data-user-id, data-whatever-id...
		for (let i = 0; i < node.attributes.length; i++) {
			const attrName = node.attributes[i].name;
			if (attrName.startsWith('data-') && (attrName.endsWith('-id') || attrName.endsWith('-key'))) {
				return node.attributes[i].value;
			}
		}

		// Žádný klíč nenalezen -> Morphdom porovná podle pozice a typu elementu
		return undefined;
	};

    // Výchozí ochrana vizuálních a formulářových prvků
    const defaultOnBeforeElUpdated = function (fromEl, toEl) {
        // 1. Zamezení problikávání načtených obrázků
        if (fromEl.tagName === 'IMG' && fromEl.src === toEl.src) {
            return false;
        }

        // 2. Zachování fokusu a rozepsaného textu ve formulářích
        if (fromEl === document.activeElement && (fromEl.tagName === 'INPUT' || fromEl.tagName === 'TEXTAREA')) {
            toEl.value = fromEl.value;
        }

        // 3. Volitelně: spuštění custom callbacku, pokud byl předán v options
        if (typeof options.customBeforeUpdate === 'function') {
            return options.customBeforeUpdate(fromEl, toEl);
        }

        return true;
    };

    const morphOptions = {
        childrenOnly: true,
        getNodeKey: options.getNodeKey || defaultGetNodeKey,
        onBeforeElUpdated: defaultOnBeforeElUpdated,
        ...options // Umožní přebít jakékoliv jiné nastavení podle potřeby
    };

    morphdom(targetEl, sourceEl, morphOptions);
}
