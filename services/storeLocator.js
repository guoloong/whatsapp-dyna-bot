// services/storeLocator.js
// LLM-based Store Locator - Uses AI to understand user intent, extract locations, and parse store data

const axios = require('axios');
const path = require('path');
const fs = require('fs');

// Load store locator config
const configPath = path.join(__dirname, '../config/storeLocatorConfig.json');
let storeLocatorConfig = { regionsWithPhysicalStores: [], onlineStoreUrl: '', storeNotAvailableMessage: '' };
try {
    const configData = fs.readFileSync(configPath, 'utf8');
    storeLocatorConfig = JSON.parse(configData);
} catch (err) {
    console.warn('[STORE] Could not load storeLocatorConfig.json, using defaults');
}

// API configuration
const STORE_API_BASE = 'https://www.dyna-nutrition.com/wp-json/mlp-api/v1';
const PRODUCT_API_URL = 'https://www.dyna-nutrition.com/wp-json/mlp-api/v1/products';

// Product cache
let productsCache = null;
let productsCacheTime = 0;
const PRODUCTS_CACHE_TTL = 5184000000; // 2 months

// Store cache (per product)
const storeCache = new Map();
const STORE_CACHE_TTL = 5184000000; // 2 months

// Session state for multi-step store queries
let pendingProductSlug = null;
let pendingTimestamp = 0;
const PENDING_TTL = 5184000000; // 2 months

// Track last mentioned product
let lastMentionedProductSlug = null;
let lastMentionedTimestamp = 0;
const LAST_MENTIONED_TTL = 5184000000; // 2 months

// Known product slug mappings
const PRODUCT_SLUG_MAP = {
    'bionatto': 'bionatto',
    'bio-natto': 'bionatto',
    'bionatto plus': 'bionatto',
    'men guard': 'men-guard',
    'men-guard': 'men-guard',
    'men guard capsule': 'men-guard',
    'menguard': 'men-guard',
    'ashiguard': 'ashiguard',
    'ashislim': 'ashislim-plus',
    'black elderberry': 'black-elderberry-juice',
    'elderola': 'elderola',
    'glucopal': 'glucopal',
    'hairegain': 'hairegain',
    'hp-floragut': 'hp-floragut',
    'liveprotein': 'liveprotein',
    'marinecal-plus': 'marinecal-plus',
    'nustem': 'nustem',
    'optiberries': 'optiberries',
    'optivue': 'optivue',
    'organic-ashitaba': 'organic-ashitaba',
    'super-bio-organic': 'super-bio-organic',
    'tibetan-seaberry': 'tibetan-seaberry',
    'tricollagen': 'tricollagen',
    'uri-comfort': 'uri-comfort',
    'vitamune': 'vitamune-cdz',
    'riflex': 'riflex-360',
    'riflex 360': 'riflex-360',
    'live berries': 'liveberries',
    'liveessence': 'liveessence',
    'livezymes': 'livezymes',
    'nitrovar': 'nitrovar-plus'
};

/**
 * Normalize product name to API slug
 */
function normalizeProductSlug(productName) {
    const lower = productName.toLowerCase().trim();

    if (PRODUCT_SLUG_MAP[lower]) {
        return PRODUCT_SLUG_MAP[lower];
    }

    let slug = lower
        .replace(/\s*(plus|capsule|capsules|tablet|softgel)\s*/gi, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');

    return slug;
}

/**
 * Check if location is a country that needs more specific area
 */
function isBigRegion(location) {
    if (!location) return false;
    const lowerLoc = location.toLowerCase();
    if (lowerLoc.includes('malaysia') || lowerLoc === 'kl' || lowerLoc.includes('kuala lumpur')) {
        return true;
    }
    return false;
}

function getSpecificAreasMessage(location) {
    const lowerLoc = location.toLowerCase();
    if (lowerLoc.includes('malaysia') || lowerLoc.includes('kuala lumpur') || lowerLoc === 'kl') {
        return `Malaysia is a large country. Could you please share a more specific area?\n\nFor example:\n• "in Subang Jaya"\n• "near KLCC"\n• "in Shah Alam"\n• "in Petaling Jaya"`;
    }
    return `Could you share a more specific area?\n\nFor example:\n• "in [area name]"\n• "near [landmark]"`;
}

// Known locations for reference
const KNOWN_LOCATIONS = [
    'kuala lumpur', 'kl', 'petaling jaya', 'pj', 'subang jaya', 'subang', 'usj',
    'shah alam', 'selangor', 'puchong', 'kajang', 'cheras', 'klang', 'ampang',
    'rawang', 'seri kembangan', 'ipoh', 'penang', 'george town', 'johor', 'johor bahru', 'jb',
    'melaka', 'malacca', 'seremban', 'sabah', 'kota kinabalu', 'kk', 'sarawak', 'kuching',
    'langkawi', 'singapore', 'sg', 'changi', 'klia'
];

/**
 * Track a product mentioned by the user
 */
function trackMentionedProduct(productSlug) {
    if (productSlug) {
        lastMentionedProductSlug = productSlug;
        lastMentionedTimestamp = Date.now();
    }
}

/**
 * Get the last mentioned product if still valid
 */
function getLastMentionedProduct() {
    const now = Date.now();
    if (lastMentionedProductSlug && (now - lastMentionedTimestamp < LAST_MENTIONED_TTL)) {
        return lastMentionedProductSlug;
    }
    return null;
}

/**
 * Use LLM to analyze user message and extract location + product intent
 */
async function analyzeUserIntent(userMessage, apiKey) {
    const prompt = `You are a store locator assistant for a health products chatbot. Analyze the user message.

Extract:
1. PRODUCT: Is the user asking about a specific product? Return the product slug or null if no product mentioned.
2. LOCATION: Where does the user want to find stores? Return the location/area name or null if not specified.
3. NEEDS_LOCATION: Should we ask for location? (true if user mentions product but no location)
4. INTENT: What is the user trying to do? ("find_stores", "change_location", "general_inquiry")

Products we carry: bionatto, men-guard, ashiguard, ashislim, black-elderberry-juice, elderola, glucopal, hairegain, hp-floragut, liveprotein, marinecal-plus, nustem, optiberries, optivue, organic-ashitaba, super-bio-organic, tibetan-seaberry, tricollagen, uri-comfort, vitamune-cdz, riflex-360

Known locations: Kuala Lumpur, Selangor, Subang Jaya, Shah Alam, Petaling Jaya, Penang, Johor, Singapore, Klang, Cheras, Puchong, Ipoh, Melaka

Return JSON only:
{"product": "bionatto", "location": "Singapore", "needsLocation": false, "intent": "find_stores"}

User message: "${userMessage}"`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a JSON parser. Return ONLY valid JSON, no markdown.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 200
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: controller.signal,
                timeout: 12000
            }
        );

        clearTimeout(timeoutId);
        const content = response.data.choices[0].message.content.trim();

        let jsonStr = content.replace(/```json\n?|```\n?/gi, '').trim();
        const parsed = JSON.parse(jsonStr);

        if (parsed.product) {
            trackMentionedProduct(parsed.product);
        }

        return {
            productSlug: parsed.product || null,
            location: parsed.location || null,
            needsLocation: parsed.needsLocation || false,
            intent: parsed.intent || 'find_stores'
        };
    } catch (err) {
        console.log(`[STORE] LLM intent analysis failed: ${err.message}`);
        return fallbackIntentDetection(userMessage);
    }
}

/**
 * Fallback intent detection when LLM fails
 */
function fallbackIntentDetection(userMessage) {
    const lowerText = userMessage.toLowerCase();

    const storeKeywords = ['where to buy', 'where can i buy', 'store', 'stores', 'pharmacy', 'buy', 'sell', 'near', 'singapore', 'malaysia'];
    const isStoreQuery = storeKeywords.some(k => lowerText.includes(k));

    if (!isStoreQuery) {
        return { productSlug: null, location: null, needsLocation: false, intent: 'general_inquiry' };
    }

    let productSlug = null;
    for (const [name, slug] of Object.entries(PRODUCT_SLUG_MAP)) {
        if (lowerText.includes(name)) {
            productSlug = slug;
            break;
        }
    }

    let location = null;
    for (const loc of KNOWN_LOCATIONS) {
        if (lowerText.includes(loc)) {
            location = loc;
            break;
        }
    }

    return {
        productSlug,
        location,
        needsLocation: productSlug && !location,
        intent: 'find_stores'
    };
}

/**
 * Basic address cleanup
 */
function cleanAddress(raw) {
    if (!raw) return 'Address not available';
    let cleaned = raw.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/\+\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\/\s].*$/, '');
    cleaned = cleaned.replace(/\d:\d\d\s*(am|pm)\s*-\s*\d:\d\d\s*(am|pm)\s*$/gi, '');
    return cleaned || 'Address not available';
}

/**
 * Basic phone cleanup
 */
function cleanPhone(raw) {
    if (!raw) return 'Phone not available';
    const match = raw.match(/(\+?\d[\s\-]?)?(\d[\s\-]?){8,12}/);
    if (match) {
        let phone = match[0].replace(/[^\d\+]/g, '');
        if (phone.startsWith('65') && phone.length === 10) {
            return `+65 ${phone.slice(2, 4)} ${phone.slice(4)}`;
        } else if (phone.startsWith('60') && phone.length === 11) {
            return `+60 ${phone.slice(2, 3)}-${phone.slice(3)}`;
        } else if (phone.startsWith('0') && phone.length === 10) {
            return `${phone.slice(0, 3)}-${phone.slice(3)}`;
        }
        return phone;
    }
    return raw || 'Phone not available';
}

/**
 * Parse store data
 */
async function parseStoresWithLLM(stores, apiKey) {
    // Primary path: Direct cleanup (fast, accurate, zero API cost)
    if (!stores || stores.length === 0) return stores;

    return stores.map(s => ({
        ...s,
        address: cleanAddress(s.address || s.raw_address || ''),
        phone: cleanPhone(s.phone || s.raw_phone || '')
    }));
}

/**
 * Manual store formatting
 */
function formatStoresManually(productName, stores, location) {
    let message = `Here are stores for ${productName || 'our products'}`;
    if (location) message += ` in ${location}`;
    message += ':\n\n';

    stores.forEach((store, i) => {
        message += `${i + 1}. ${store.name || 'Store'}\n`;
        message += `   Address: ${store.address || store.raw_address || 'N/A'}\n`;
        message += `   Phone: ${store.phone || store.raw_phone || 'N/A'}\n\n`;
    });

    message += `Tip: Call ahead to confirm availability before visiting.`;
    return message;
}

/**
 * Fetch products from API
 */
async function fetchProducts(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && productsCache && (now - productsCacheTime < PRODUCTS_CACHE_TTL)) {
        return productsCache;
    }

    try {
        const response = await axios.get(PRODUCT_API_URL, { timeout: 10000 });
        if (response.data && response.data.products) {
            productsCache = response.data.products;
            productsCacheTime = now;
            return productsCache;
        }
        return productsCache || [];
    } catch (err) {
        console.error(`[STORE] Failed to fetch products: ${err.message}`);
        return productsCache || [];
    }
}

/**
 * Fetch stores for a product
 */
async function fetchStoresForProduct(productSlug, forceRefresh = false) {
    const now = Date.now();
    const cacheKey = productSlug;

    if (!forceRefresh && storeCache.has(cacheKey)) {
        const cached = storeCache.get(cacheKey);
        if (now - cached.time < STORE_CACHE_TTL) {
            return cached.data;
        }
    }

    try {
        const url = `${STORE_API_BASE}/stores?product=${encodeURIComponent(productSlug)}`;
        const response = await axios.get(url, { timeout: 10000 });

        if (response.data && response.data.stores) {
            storeCache.set(cacheKey, { data: response.data.stores, time: now });
            return response.data.stores;
        }
        return [];
    } catch (err) {
        console.error(`[STORE] Failed to fetch stores for ${productSlug}: ${err.message}`);
        if (storeCache.has(cacheKey)) {
            return storeCache.get(cacheKey).data;
        }
        return [];
    }
}

/**
 * Main function: Find and return store information
 * routeParams: { productName, location } from messageRouter
 */
async function findStores(userMessage, apiKey, routeParams = {}) {
    console.log(`[STORE] Analyzing: "${userMessage}"`);
    console.log(`[STORE] Route params:`, routeParams);

    const now = Date.now();
    const hasPendingProduct = pendingProductSlug && (now - pendingTimestamp < PENDING_TTL);

    // Step 1: Use LLM to understand user intent
    const intent = await analyzeUserIntent(userMessage, apiKey);
    console.log(`[STORE] Intent from LLM:`, intent);

    // Step 1.5: Use routeParams.productName from router FIRST if available
    if (routeParams.productName) {
        intent.productSlug = routeParams.productName;
        console.log(`[STORE] Using product from router: ${intent.productSlug}`);
    }

    // Check if this is a location-only response (user only provided location, product was pending)
    const isLocationOnly = !intent.productSlug && intent.location && hasPendingProduct;

    if (isLocationOnly) {
        console.log(`[STORE] Using pending product: ${pendingProductSlug}`);
        intent.productSlug = pendingProductSlug;
        intent.needsLocation = false;
        intent.intent = 'find_stores';
    }

    // Use location from routeParams if available
    if (routeParams.location && !intent.location) {
        intent.location = routeParams.location;
    }

    // Store pending product
    if (intent.productSlug && (intent.needsLocation || intent.location)) {
        pendingProductSlug = intent.productSlug;
        pendingTimestamp = now;
    }

    // Step 2: If needs location but none provided, ask for it
    if (intent.needsLocation && !intent.location) {
        return {
            needsLocation: true,
            text: `To find stores, please share your location/area.\n\nExample responses:\n- "in Singapore"\n- "near Subang Jaya"\n- "I'm in Shah Alam"\n- "Selangor area"`,
            productSlug: intent.productSlug
        };
    }

    // Step 2.5: Check if location is too broad
    if (intent.location && isBigRegion(intent.location)) {
        console.log(`[STORE] Location "${intent.location}" is too broad, asking for specific area`);
        return {
            needsLocation: true,
            text: getSpecificAreasMessage(intent.location),
            productSlug: intent.productSlug,
            location: intent.location
        };
    }

    // Step 3: If no product identified, check pending/last mentioned
    if (!intent.productSlug) {
        if (intent.location && hasPendingProduct) {
            intent.productSlug = pendingProductSlug;
            intent.needsLocation = false;
            intent.intent = 'find_stores';
        } else if (!intent.productSlug && intent.location) {
            const lastProduct = getLastMentionedProduct();
            if (lastProduct) {
                intent.productSlug = lastProduct;
                intent.needsLocation = false;
                intent.intent = 'find_stores';
            }
        }

        if (!intent.productSlug) {
            const lastProduct = getLastMentionedProduct();
            if (lastProduct) {
                intent.productSlug = lastProduct;
                intent.needsLocation = false;
                intent.intent = 'find_stores';
            } else {
                return {
                    success: true,
                    stores: [],
                    noContext: true,
                    text: `To help you find stores, please mention which product you're looking for.\n\nFor example: "Where can I buy Men Guard in Singapore?"\n\nOr if you mentioned a product earlier in our chat, just share your location!`
                };
            }
        }
    }

    // Step 4: Check if location is in a supported region
    // If not, skip API call and go straight to online purchase suggestion
    const locationLower = intent.location?.toLowerCase() || '';
    const isKnownRegionWithStores = storeLocatorConfig.regionsWithPhysicalStores.some(
        r => locationLower.includes(r)
    );

    if (intent.location && !isKnownRegionWithStores) {
        console.log(`[STORE] Location "${intent.location}" is not in supported regions, suggesting online purchase`);
        return {
            success: true,
            stores: [],
            noStoresInArea: true,
            text: `Sorry, we don't have physical stores in ${intent.location}.\n\nYou can purchase online from our official store: ${storeLocatorConfig.onlineStoreUrl}`,
            productSlug: intent.productSlug
        };
    }

    // Step 5: Fetch stores for the product
    console.log(`[STORE] Fetching stores for: ${intent.productSlug}`);
    const stores = await fetchStoresForProduct(intent.productSlug);
    console.log(`[STORE] Raw stores returned from API: ${stores.length}`);

    if (stores.length === 0) {
        console.log(`[STORE] No stores found for product: ${intent.productSlug}`);
        return {
            success: true,
            stores: [],
            text: `Sorry, I couldn't find any stores selling this product.\n\nPlease try a different product or contact our support.`,
            productSlug: intent.productSlug
        };
    }

    // Step 5: Parse store data
    const parsedStores = await parseStoresWithLLM(stores, apiKey);
    console.log(`[STORE] Parsed stores from LLM: ${parsedStores.length}`);

    // Get product display name
    let productDisplayName = 'our products';
    try {
        const products = await fetchProducts();
        const product = products.find(p => p.slug === intent.productSlug);
        if (product) productDisplayName = product.name;
    } catch (e) {
        // ignore
    }

    // Step 6: Filter by location if provided
    let filteredStores = parsedStores;
    let noStoresInArea = false;

    if (intent.location) {
        const lowerLoc = intent.location.toLowerCase();
        console.log(`[STORE] Filtering for location: "${intent.location}" (${lowerLoc})`);
        console.log(`[STORE] Total parsed stores: ${parsedStores.length}`);

        filteredStores = parsedStores.filter(s => {
            const state = (s.state || '').toLowerCase();
            const area = (s.area || '').toLowerCase();
            const address = (s.address || '').toLowerCase();
            return state.includes(lowerLoc) || area.includes(lowerLoc) || address.includes(lowerLoc);
        });

        console.log(`[STORE] Stores matching location "${intent.location}": ${filteredStores.length}`);

        if (filteredStores.length === 0) {
            noStoresInArea = true;
        }
    } else {
        console.log(`[STORE] No location filter applied, showing all ${parsedStores.length} stores`);
    }

    // Handle no stores in area
    if (noStoresInArea) {
        let text;

        if (isKnownRegionWithStores) {
            // Known region (Malaysia/Singapore) but no stores for this product
            text = `Sorry, I couldn't find any ${productDisplayName} stores in ${intent.location}.\n\nOur products are available in major cities like Singapore, Kuala Lumpur, Penang, Johor, and other areas.\n\nWould you like to try a different location?`;
        } else {
            // Region without physical stores (HK, etc) - suggest online purchase
            text = `Sorry, we don't have physical stores in ${intent.location}.\n\nYou can purchase online from our official store: ${storeLocatorConfig.onlineStoreUrl}`;
        }

        return {
            success: true,
            stores: [],
            noStoresInArea: true,
            text: text,
            productSlug: intent.productSlug
        };
    }

    // Limit to 7 stores for display
    const displayLimit = 7;
    const hasMoreStores = filteredStores.length > displayLimit;
    const storesToDisplay = filteredStores.slice(0, displayLimit);

    console.log(`[STORE] Returning ${storesToDisplay.length} stores for display (${hasMoreStores ? 'more available' : 'showing all'})`);

    // Step 7: Generate response
    const responseText = await generateStoreResponse(productDisplayName, storesToDisplay, intent.location, apiKey, hasMoreStores, filteredStores.length);

    pendingTimestamp = Date.now();
    if (intent.productSlug) {
        trackMentionedProduct(intent.productSlug);
    }

    return {
        success: true,
        stores: storesToDisplay,
        hasMoreStores,
        totalStores: filteredStores.length,
        text: responseText,
        productSlug: intent.productSlug
    };
}

/**
 * Use LLM to generate response message from store data
 */
async function generateStoreResponse(productName, stores, location, apiKey, hasMoreStores = false, totalCount = 0) {
    if (!stores || stores.length === 0) {
        return `Sorry, I couldn't find any stores selling ${productName} in ${location || 'your area'}.\n\nPlease try a different location or product, or contact our support for assistance.`;
    }

    const storeList = stores.map((s, i) =>
        `${i + 1}. ${s.name || 'Store'}: ${s.address || 'N/A'}, Phone: ${s.phone || 'N/A'}`
    ).join('\n');

    const moreResultsNote = hasMoreStores
        ? `\n\nNOTE: There are actually ${totalCount} stores in this area. I'm showing you the top 7. To see more specific stores, please provide a more specific location.`
        : '';

    const prompt = `Generate a friendly WhatsApp message listing stores for ${productName || 'our products'}${location ? ` in ${location}` : ''}.

Stores available:
${storeList}
${moreResultsNote}

Requirements:
- Start with a brief intro line
- List each store with number, name, address, and phone
- Keep it concise and readable
- Add a friendly closing tip
- NO emojis
- NO distances or directions

Example format:
"Here are stores where you can find BioNatto in Singapore:

1. R Pharmacy
   Address: 123 Orchard Road, Singapore
   Phone: +65 6234 5678

2. Caring Pharmacy
   Address: 456 Somerset Road, Singapore
   Phone: +65 6234 9012

Tip: Call ahead to confirm availability before visiting."`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a helpful store locator assistant. Generate a clean, readable message.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 800
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: controller.signal,
                timeout: 15000
            }
        );

        clearTimeout(timeoutId);
        return response.data.choices[0].message.content.trim();
    } catch (err) {
        if (err.code === 'ECONNABORTED' || err.name === 'CanceledError' || err.message.includes('abort')) {
            console.log(`[STORE] LLM response generation timed out - using manual formatting`);
        } else {
            console.log(`[STORE] LLM response generation failed: ${err.message}`);
        }
        return formatStoresManually(productName, stores, location);
    }
}

/**
 * Check if this is a store-related query
 */
async function isStoreQueryWithLLM(userText, apiKey) {
    const prompt = `You are a store locator assistant. Analyze the user message and determine if this is a store locator query.

User message: "${userText}"

Check for:
1. Explicit store/buy keywords: "where to buy", "store", "pharmacy", "retail", "watsons", "guardian", "caring"
2. Location changes in store conversations: "How about [location]?" or just "[location]?" after a store search
3. Follow-up location changes after a store search

Return JSON:
{"isStoreQuery": true/false, "reasoning": "brief explanation"}`;

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a JSON parser. Return ONLY valid JSON, no markdown.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 200
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 12000
            }
        );

        const content = response.data.choices[0].message.content.trim();
        let jsonStr = content.replace(/```json\n?|```\n?/gi, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            isStoreQuery: parsed.isStoreQuery === true,
            reasoning: parsed.reasoning || ''
        };
    } catch (err) {
        return { isStoreQuery: fallbackIsStoreQuery(userText), reasoning: 'fallback' };
    }
}

/**
 * Fallback keyword matching
 */
function fallbackIsStoreQuery(userText) {
    const lowerText = userText.toLowerCase();

    const storeKeywords = [
        'where to buy', 'where can i buy', 'where to get', 'can i buy',
        'store', 'stores', 'retail', 'pharmacy', 'watsons', 'guardian', 'caring',
        'sell', 'available', 'in singapore', 'in malaysia', 'in kl'
    ];
    if (storeKeywords.some(k => lowerText.includes(k))) {
        return true;
    }

    if (lowerText.startsWith('how about ') && !lowerText.includes('?')) {
        const location = lowerText.replace('how about ', '').trim();
        const locations = [
            'singapore', 'kl', 'kuala lumpur', 'pj', 'petaling jaya', 'subang', 'subang jaya',
            'shah alam', 'selangor', 'puchong', 'kajang', 'johor', 'jb', 'penang', 'melaka'
        ];
        return locations.some(loc => location.includes(loc));
    }

    return false;
}

/**
 * Check if this is a store-related query (quick check)
 */
function isStoreQuery(userText) {
    return fallbackIsStoreQuery(userText);
}

/**
 * Clear pending product state
 */
function clearPendingProduct() {
    pendingProductSlug = null;
    pendingTimestamp = 0;
}

module.exports = {
    findStores,
    isStoreQuery,
    isStoreQueryWithLLM,
    fetchProducts,
    fetchStoresForProduct,
    analyzeUserIntent,
    clearPendingProduct,
    trackMentionedProduct,
    getLastMentionedProduct,
    normalizeProductSlug
};