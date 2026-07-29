// Global application state
export const state = {
    connected: false,
    channels: {},
    campaigns: {},
    settings: {},
    currentDrop: null,
    countdownTimer: null,
    translations: {}
};

export let selectedInventoryGames = [];
export const availableGames = new Set();
export let draggedElement = null;

const imageCache = new Map();

/**
 * Returns cached image element or creates and caches a new one
 */
export function getCachedImage(url, alt, className, styles = {}) {
    if (!url) return null;
    
    if (imageCache.has(url)) {
        const cachedImg = imageCache.get(url).cloneNode(true);
        Object.assign(cachedImg.style, styles);
        return cachedImg;
    }

    const imgEl = document.createElement('img');
    imgEl.src = url;
    if (alt) imgEl.alt = alt;
    if (className) imgEl.className = className;
    Object.assign(imgEl.style, styles);

    imageCache.set(url, imgEl);
    return imgEl.cloneNode(true);
}
