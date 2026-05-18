// utils/brochures.js
// Supplementary information from product brochures

const fs = require('fs');
const path = require('path');

const BROCHURES_DIR = path.join(__dirname, '..', 'config', 'brochures');

// Brochure cache
let brochureCache = new Map();

/**
 * Load brochure content for a product
 */
function getSupplementaryInfo(productSlug) {
    // Check cache first
    if (brochureCache.has(productSlug)) {
        return brochureCache.get(productSlug);
    }

    // Try to load from file
    const possiblePaths = [
        path.join(BROCHURES_DIR, `${productSlug}.txt`),
        path.join(BROCHURES_DIR, `${productSlug.toLowerCase()}.txt`),
        path.join(BROCHURES_DIR, `${productSlug.replace(/-/g, '')}.txt`),
    ];

    for (const filePath of possiblePaths) {
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                brochureCache.set(productSlug, content);
                return content;
            }
        } catch (err) {
            // Continue to next path
        }
    }

    return null;
}

/**
 * Clear brochure cache
 */
function clearBrochureCache() {
    brochureCache.clear();
}

/**
 * Add brochure content to cache
 */
function addToCache(slug, content) {
    brochureCache.set(slug, content);
}

module.exports = {
    getSupplementaryInfo,
    clearBrochureCache,
    addToCache
};