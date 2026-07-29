// utils.js
// Utility helper functions for DOM manipulation

/**
 * Creates a standard HTML element with attributes and children.
 */
export function makeElement(tag, props = {}, ...children) {
    const el = document.createElement(tag);

    if (typeof props === 'string') {
        el.className = props;
    } else if (props && typeof props === 'object') {
        const { className, classList, style, text, html, dataset, ...attrs } = props;

        if (className) el.className = className;
        if (classList && Array.isArray(classList)) el.classList.add(...classList);
        if (style && typeof style === 'object') Object.assign(el.style, style);
        if (text !== undefined && text !== null) el.textContent = text;
        if (html !== undefined && html !== null) el.innerHTML = html;

        if (dataset && typeof dataset === 'object') {
            Object.assign(el.dataset, dataset);
        }

        Object.entries(attrs).forEach(([key, val]) => {
            if (key.startsWith('on') && typeof val === 'function') {
                const eventName = key.slice(2).toLowerCase();
                el.addEventListener(eventName, val);
            } else if (val !== undefined && val !== null) {
                el.setAttribute(key, val);
            }
        });
    }

    children.flat().forEach(child => {
        if (child === null || child === undefined) return;
        if (typeof child === 'string' || typeof child === 'number') {
            el.appendChild(document.createTextNode(String(child)));
        } else if (child instanceof Node) {
            el.appendChild(child);
        }
    });

    return el;
}

/**
 * Helper utility for creating image DOM elements safely.
 */
export function makeImageElement(src, alt = '', className = '') {
    const img = document.createElement('img');
    img.src = src || '';
    img.alt = alt || '';
    if (className) img.className = className;
    return img;
}
