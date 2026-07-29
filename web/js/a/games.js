// games.js
// Module for rendering and managing game filter tags in inventory

import { selectedInventoryGames } from './state.js';
import { onInventoryFilterChange } from './inventory.js';

/**
 * Renders selected game filter tags in the UI
 */
export function updateGameTagsDisplay() {
    console.log('[Games] Updating game tags display...');
    const container = document.getElementById('selected-game-tags');
    if (!container) return;

    container.innerHTML = '';

    selectedInventoryGames.forEach((game, index) => {
        const tag = document.createElement('span');
        tag.className = 'game-tag';
        tag.textContent = game;

        const removeBtn = document.createElement('span');
        removeBtn.className = 'remove-tag';
        removeBtn.textContent = ' ×';
        removeBtn.style.cursor = 'pointer';
        
        removeBtn.addEventListener('click', () => {
            selectedInventoryGames.splice(index, 1);
            updateGameTagsDisplay();
            if (typeof onInventoryFilterChange === 'function') {
                onInventoryFilterChange();
            }
        });

        tag.appendChild(removeBtn);
        container.appendChild(tag);
    });
}
