// services/knowledgeLoader.js
// Loads and caches the knowledge base from files

const fs = require('fs');
const path = require('path');

const MAIN_KB_FILE = path.join(__dirname, '..', 'config', 'knowledgeBase.json');
const PRODUCTS_DIR = path.join(__dirname, '..', 'config', 'products');

let cachedKnowledge = null;
let mainFileMtime = 0;
let productsDirMtime = 0;
let watcher = null;

function fileMtime(filePath) {
    try { return fs.statSync(filePath).mtimeMs; } catch (_) { return 0; }
}

function dirMtime(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    let latest = 0;
    for (const f of files) {
        const m = fileMtime(path.join(dirPath, f));
        if (m > latest) latest = m;
    }
    return latest;
}

function loadProductsFromDir(dirPath) {
    const products = {};
    if (!fs.existsSync(dirPath)) return products;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
            if (data.name) {
                products[data.name] = data;
            }
        } catch (err) {
            console.error(`[KB] Error loading product file ${file}:`, err.message);
        }
    }
    return products;
}

function loadKnowledge() {
    try {
        const mainData = JSON.parse(fs.readFileSync(MAIN_KB_FILE, 'utf8'));
        let products = {};

        const dirProducts = loadProductsFromDir(PRODUCTS_DIR);
        if (Object.keys(dirProducts).length > 0) {
            products = dirProducts;
        } else if (mainData.products) {
            products = mainData.products;
        }

        let guidelines = mainData.guidelines;
        if (typeof guidelines === 'string') {
            guidelines = { general: guidelines };
        }

        cachedKnowledge = {
            products,
            general: mainData.general || {},
            guidelines: guidelines || {}
        };

        mainFileMtime = fileMtime(MAIN_KB_FILE);
        productsDirMtime = dirMtime(PRODUCTS_DIR);

        console.log(`[KB] Knowledge base loaded (${Object.keys(products).length} products)`);
        return cachedKnowledge;
    } catch (err) {
        console.error('[KB] Failed to load knowledge base:', err.message);
        return cachedKnowledge || { products: {}, general: {}, guidelines: {} };
    }
}

function getKnowledge() {
    if (!cachedKnowledge ||
        fileMtime(MAIN_KB_FILE) > mainFileMtime ||
        dirMtime(PRODUCTS_DIR) > productsDirMtime) {
        cachedKnowledge = loadKnowledge();
    }
    return cachedKnowledge;
}

function startWatcher() {
    if (watcher) return;
    try {
        watcher = fs.watch(MAIN_KB_FILE, () => {
            console.log('[KB] knowledgeBase.json changed - reloading...');
            mainFileMtime = 0;
        });
        if (fs.existsSync(PRODUCTS_DIR)) {
            fs.watch(PRODUCTS_DIR, (eventType, filename) => {
                if (filename && filename.endsWith('.json')) {
                    console.log(`[KB] Product file ${filename} changed - reloading...`);
                    productsDirMtime = 0;
                }
            });
        }
        console.log('[KB] Watching knowledge base files for changes...');
    } catch (err) {
        console.warn('[KB] File watcher could not be set up:', err.message);
    }
}
startWatcher();

module.exports = { getKnowledge };