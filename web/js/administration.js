/**
 * administration.js - Diagnostic & Developer Controls Module
 * Plochý styl - globální proměnné a funkce bez obalovacích modulů/tříd.
 */

// Globální proměnné
let currentState = {};
let elements = {};
let viewMode = 'tree'; // 'tree' nebo 'raw'
let searchQuery = '';
const logThrottleMap = new Map();

function cacheElements() {
    elements = {
        socketStatus: document.getElementById('debug-socket-status'),
        queueCount: document.getElementById('debug-queue-count'),
        rotationIndex: document.getElementById('debug-rotation-index'),
        stateContainer: document.getElementById('debug-state-container'),
        stateJson: document.getElementById('debug-state-json'),
        searchInput: document.getElementById('debug-state-search'),
        btnToggleView: document.getElementById('debug-btn-toggle-view'),
        btnCopyJson: document.getElementById('debug-btn-copy-json'),
        btnResync: document.getElementById('debug-btn-resync'),
        btnRestartRot: document.getElementById('debug-btn-restart-rot'),
        btnDumpState: document.getElementById('debug-btn-dump-state'),
        btnClearLogs: document.getElementById('debug-btn-clear-logs'),
        btnRefreshJson: document.getElementById('debug-btn-refresh-json')
    };
}

function bindEvents() {
    if (elements.btnResync) {
        elements.btnResync.addEventListener('click', function () {
            console.log('[Admin] Force state resync requested.');
            if (typeof socket !== 'undefined' && socket.emit) socket.emit('admin:force_resync');
        });
    }

    if (elements.btnRestartRot) {
        elements.btnRestartRot.addEventListener('click', function () {
            console.log('[Admin] Restarting rotation engine...');
            if (typeof socket !== 'undefined' && socket.emit) socket.emit('admin:restart_rotation');
        });
    }

    if (elements.btnDumpState) {
        elements.btnDumpState.addEventListener('click', function () {
            console.log('[Admin] Current App State Dump:', currentState);
        });
    }

    if (elements.btnClearLogs) {
        elements.btnClearLogs.addEventListener('click', function () {
            console.clear();
            console.log('[Admin] Console cleared.');
        });
    }

    if (elements.btnRefreshJson) {
        elements.btnRefreshJson.addEventListener('click', function () {
            renderState();
        });
    }

    // Přepínání stromu a raw JSONu
    if (elements.btnToggleView) {
        elements.btnToggleView.addEventListener('click', function () {
            viewMode = (viewMode === 'tree') ? 'raw' : 'tree';
            elements.btnToggleView.textContent = `Mode: ${viewMode === 'tree' ? 'Tree' : 'Raw'}`;
            renderState();
        });
    }

    // Kopírování JSONu do schránky
    if (elements.btnCopyJson) {
        elements.btnCopyJson.addEventListener('click', function () {
            try {
                const jsonText = JSON.stringify(currentState, null, 2);
                navigator.clipboard.writeText(jsonText).then(() => {
                    const originalText = elements.btnCopyJson.textContent;
                    elements.btnCopyJson.textContent = 'Copied!';
                    setTimeout(() => {
                        elements.btnCopyJson.textContent = originalText;
                    }, 2000);
                }).catch(err => {
                    console.error('[Admin] Failed to copy state:', err);
                });
            } catch (err) {
                console.error('[Admin] Serialization error during copy:', err);
            }
        });
    }

    // Vyhledávání v reálném čase
    if (elements.searchInput) {
        elements.searchInput.addEventListener('input', function (e) {
            searchQuery = e.target.value.trim().toLowerCase();
            renderState();
        });
    }
}

/**
 * Recursively builds collapsible HTML tree from object (Lazy Loaded & Zero Parse HTML)
 */
function createTreeDOM(data, keyName = 'root') {
    if (data === null || data === undefined) {
        const wrapper = document.createElement('div');
        wrapper.style.marginLeft = '12px';

        const keySpan = document.createElement('span');
        keySpan.style.color = '#ce9178';
        keySpan.textContent = keyName;

        const valSpan = document.createElement('span');
        valSpan.style.color = '#569cd6';
        valSpan.textContent = `: ${data}`;

        wrapper.appendChild(keySpan);
        wrapper.appendChild(valSpan);
        return wrapper;
    }

    const isArray = Array.isArray(data);
    const isObject = typeof data === 'object';

    if (isObject) {
        const keys = Object.keys(data);
        const count = keys.length;

        if (searchQuery && !keyName.toLowerCase().includes(searchQuery)) {
            const matchesChild = keys.some(k => k.toLowerCase().includes(searchQuery));
            if (!matchesChild) return null;
        }

        const details = document.createElement('details');
        details.style.margin = '2px 0';

        const summary = document.createElement('summary');
        summary.style.cursor = 'pointer';
        summary.style.color = '#4ec9b0';

        const strong = document.createElement('strong');
        strong.textContent = keyName;

        const countSpan = document.createElement('span');
        countSpan.style.color = '#888';
        countSpan.style.fontSize = '0.9em';
        countSpan.textContent = ` (${isArray ? `${count} items` : `${count} keys`})`;

        summary.appendChild(strong);
        summary.appendChild(countSpan);
        details.appendChild(summary);

        let isRendered = false;

        // Helper function to render children into a DocumentFragment
        const renderChildren = () => {
            if (isRendered) return;
            const fragment = document.createDocumentFragment();

            keys.forEach(k => {
                const childNode = createTreeDOM(data[k], k);
                if (childNode) fragment.appendChild(childNode);
            });

            details.appendChild(fragment);
            isRendered = true;
        };

        // If search query is active, render immediately and auto-expand
        if (searchQuery) {
            renderChildren();
            details.open = true;
        } else {
            // Lazy load children only when user expands the section
            details.addEventListener('toggle', () => {
                if (details.open) {
                    renderChildren();
                }
            }, { once: true });
        }

        return details;
    } else {
        if (searchQuery && !keyName.toLowerCase().includes(searchQuery) && !String(data).toLowerCase().includes(searchQuery)) {
            return null;
        }

        const wrapper = document.createElement('div');
        wrapper.style.marginLeft = '12px';

        let valColor = '#b5cea8';
        if (typeof data === 'string') valColor = '#ce9178';

        const keySpan = document.createElement('span');
        keySpan.style.color = '#9cdcfe';
        keySpan.textContent = keyName;

        const valSpan = document.createElement('span');
        valSpan.style.color = valColor;
        valSpan.textContent = JSON.stringify(data);

        wrapper.appendChild(keySpan);
        wrapper.appendChild(document.createTextNode(': '));
        wrapper.appendChild(valSpan);

        return wrapper;
    }
}

function initAdmin() {
    console.log('[Admin] Administration module initializing...');
    cacheElements();
    bindEvents();
}

function updateDiagnostics(info) {
    if (!info) return;

    if (elements.socketStatus && info.connected !== undefined) {
        elements.socketStatus.textContent = info.connected ? 'Connected' : 'Disconnected';
        elements.socketStatus.style.color = info.connected ? '#4caf50' : '#f44336';
    }

    if (elements.queueCount && info.queueCount !== undefined) {
        elements.queueCount.textContent = `${info.queueCount} campaigns`;
    }

    if (elements.rotationIndex && info.rotationIndex !== undefined) {
        elements.rotationIndex.textContent = info.rotationIndex;
    }
}

function setState(state) {
    currentState = state || {};
    renderState();
}

function renderState() {
    if (!elements.stateContainer) return;

    if (viewMode === 'raw') {
        elements.stateContainer.innerHTML = '';
        const pre = document.createElement('pre');
        pre.style.margin = '0';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-all';
        try {
            pre.textContent = JSON.stringify(currentState, null, 2);
        } catch (err) {
            pre.textContent = '// Error formatting JSON state';
        }
        elements.stateContainer.appendChild(pre);
    } else {
        elements.stateContainer.innerHTML = '';
        const tree = createTreeDOM(currentState, 'state');
        if (tree) {
            elements.stateContainer.appendChild(tree);
        } else {
            elements.stateContainer.innerHTML = '<span style="color: #888;">No matching state properties found.</span>';
        }
    }
}

function addConsoleLineRaw(line) {
    const consoleEl = document.getElementById('console-output');
    if (!consoleEl) return;

    const div = document.createElement('div');
    div.textContent = line;
    consoleEl.appendChild(div);
    consoleEl.scrollTop = consoleEl.scrollHeight;

    while (consoleEl.children.length > 1000) {
        consoleEl.removeChild(consoleEl.firstChild);
    }
}

function addConsoleLine(message) {
    addConsoleLineRaw(message);
}

function logOnce(key, message, isWarn = false) {
    const now = Date.now();
    const lastLog = logThrottleMap.get(key) || 0;
    if (now - lastLog > 3000) {
        if (isWarn) {
            console.warn(`[THROTTLED] ${message}`);
        } else {
            console.log(`[THROTTLED] ${message}`);
        }
        logThrottleMap.set(key, now);
    }
}

// Odkazy pro skripty, které volají volání skrze window.Administration
window.Administration = {
    init: initAdmin,
    updateDiagnostics: updateDiagnostics,
    setState: setState,
    renderState: renderState,
    addConsoleLine: addConsoleLine,
    addConsoleLineRaw: addConsoleLineRaw,
    logOnce: logOnce
};

document.addEventListener('DOMContentLoaded', function () {
    initAdmin();
});
