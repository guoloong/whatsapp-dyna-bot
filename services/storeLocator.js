// services/storeLocator.js
// LLM-based Store Locator - Uses AI to understand user intent, extract locations, and parse store data
const axios = require('axios');

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
const PENDING_TTL = 5184000000; // 2 months to respond with location

// Track if we just completed a search (don't clear pending immediately)
let justCompletedSearch = false;

// Track last mentioned product (for general context - not just store queries)
let lastMentionedProductSlug = null;
let lastMentionedTimestamp = 0;
const LAST_MENTIONED_TTL = 5184000000; // 2 months to remember product

// Known product slug mappings (lowercase → API slug)
const PRODUCT_SLUG_MAP = {
    'bionatto': 'bionatto',
    'bio-natto': 'bionatto',
    'bionatto plus': 'bionatto',
    'men guard': 'men-guard',
    'men-guard': 'men-guard',
    'men guard capsule': 'men-guard',
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
 * Normalize product name to API slug using mapping
 */
function normalizeProductSlug(productName) {
    const lower = productName.toLowerCase().trim();

    // Check mapping first
    if (PRODUCT_SLUG_MAP[lower]) {
        return PRODUCT_SLUG_MAP[lower];
    }

    // Smart stripping of common suffixes
    let slug = lower
        .replace(/\s*(plus|capsule|capsules|tablet|tablets|tablet|softgel)\s*/gi, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');

    return slug;
}

/**
 * Check if location is a country that needs more specific area
 * Stores only exist in Malaysia and Singapore - only Malaysia is too broad
 */
function isBigRegion(location) {
    if (!location) return false;
    const lowerLoc = location.toLowerCase();
    // Only Malaysia is too broad - Singapore is small enough
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
 * Track a product mentioned by the user (for context across messages)
 */
function trackMentionedProduct(productSlug) {
    if (productSlug) {
        lastMentionedProductSlug = productSlug;
        lastMentionedTimestamp = Date.now();
        console.log(`������ [STORE LOCATOR] Tracked last mentioned product: ${productSlug}`);
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
 * Returns: { productSlug, location, needsLocation, intent }
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

        // Extract JSON
        let jsonStr = content.replace(/```json\n?|```\n?/gi, '').trim();
        const parsed = JSON.parse(jsonStr);

        // Track product if found (for context across messages)
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
        console.log(`⚠️ LLM intent analysis failed: ${err.message}`);
        // Fallback: basic detection
        return fallbackIntentDetection(userMessage);
    }
}

/**
 * Fallback intent detection when LLM fails
 */
function fallbackIntentDetection(userMessage) {
    const lowerText = userMessage.toLowerCase();

    // Check for store-related keywords
    const storeKeywords = ['where to buy', 'where can i buy', 'store', 'stores', 'pharmacy', 'buy', 'sell', 'near', 'singapore', 'malaysia'];
    const isStoreQuery = storeKeywords.some(k => lowerText.includes(k));

    if (!isStoreQuery) {
        return { productSlug: null, location: null, needsLocation: false, intent: 'general_inquiry' };
    }

    // Extract product
    let productSlug = null;
    for (const [name, slug] of Object.entries(PRODUCT_SLUG_MAP)) {
        if (lowerText.includes(name)) {
            productSlug = slug;
            break;
        }
    }

    // Extract location
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
 * Use LLM to parse raw store data into clean, readable format
 */
async function parseStoresWithLLM(stores, apiKey) {
    if (!stores || stores.length === 0) return stores;

    // Prepare ALL store data for LLM (no limit)
    const storeData = stores.map((s, i) => {
        return `${i + 1}. Name: ${s.name || 'Unknown'}, Address: ${s.address || s.raw_address || 'N/A'}, Phone: ${s.phone || s.raw_phone || 'N/A'}`;
    }).join('\n');

    const prompt = `Parse these store records and return clean information. For each store, extract:
- name: Clean store name (e.g., "R Pharmacy", "Caring Pharmacy")
- address: Full address with city/state (e.g., "123 Main St, Petaling Jaya, Selangor")
- phone: Clean phone number (format: 01X-XXX XXXX for Malaysia, +65 XXXX XXXX for Singapore)
- state: The state/region (e.g., "Selangor", "Singapore", "Kuala Lumpur")
- area: The specific area (e.g., "Subang Jaya", "Orchard")

Return ONLY a valid JSON array:
[{"name": "R Pharmacy", "address": "...", "phone": "...", "state": "...", "area": "..."}]

STORES:
${storeData}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a data parsing assistant. Return ONLY valid JSON array, no explanation.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 8000
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: controller.signal,
                timeout: 18000
            }
        );

        clearTimeout(timeoutId);
        const content = response.data.choices[0].message.content.trim();

        // Extract JSON
        let jsonStr = content.replace(/```json\n?|```\n?/gi, '').trim();
        const parsedStores = JSON.parse(jsonStr);

        // Merge with original data
        return stores.map((store, i) => {
            if (parsedStores[i]) {
                return {
                    ...store,
                    name: parsedStores[i].name || store.name,
                    address: parsedStores[i].address || store.address,
                    phone: parsedStores[i].phone || store.phone,
                    state: parsedStores[i].state || store.state,
                    area: parsedStores[i].area || ''
                };
            }
            return store;
        });
    } catch (err) {
        if (err.code === 'ECONNABORTED' || err.name === 'CanceledError' || err.message.includes('abort')) {
            console.log(`⚠️ LLM store parsing timed out (${err.message}) - using basic cleanup`);
        } else {
            console.log(`⚠️ LLM store parsing failed: ${err.message}`);
        }
        // Fallback: basic cleanup
        return stores.map(s => ({
            ...s,
            address: cleanAddress(s.address || s.raw_address || ''),
            phone: cleanPhone(s.phone || s.raw_phone || '')
        }));
    }
}

/**
 * Basic address cleanup (fallback when LLM fails)
 */
function cleanAddress(raw) {
    if (!raw) return 'Address not available';
    // Remove extra whitespace
    let cleaned = raw.replace(/\s+/g, ' ').trim();
    // Remove trailing phone numbers
    cleaned = cleaned.replace(/\+\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\/\s].*$/, '');
    // Remove time patterns
    cleaned = cleaned.replace(/\d:\d\d\s*(am|pm)\s*-\s*\d:\d\d\s*(am|pm)\s*$/gi, '');
    return cleaned || 'Address not available';
}

/**
 * Basic phone cleanup (fallback when LLM fails)
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
            return `${phone.slice(0, 3)}-${phone.slice(3)} ${phone.slice(6)}`;
        }
        return phone;
    }
    return raw || 'Phone not available';
}

/**
 * Use LLM to generate response message from store data
 */
async function generateStoreResponse(productName, stores, location, apiKey, hasMoreStores = false, totalCount = 0) {
    if (!stores || stores.length === 0) {
        return `Sorry, I couldn't find any stores selling ${productName} in ${location || 'your area'}.\n\nPlease try a different location or product, or contact our support for assistance.`;
    }

    // Format stores for LLM
    const storeList = stores.map((s, i) =>
        `${i + 1}. ${s.name || 'Store'}: ${s.address || s.raw_address || 'N/A'}, Phone: ${s.phone || s.raw_phone || 'N/A'}`
    ).join('\n');

    // Build the more results note if needed
    const moreResultsNote = hasMoreStores
        ? `\n\nNOTE: There are actually ${totalCount} stores in this area. I'm showing you the top 7. To see more specific stores, please provide a more specific location (e.g., "in Subang Jaya" or "near KLCC").`
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
- NO emojis (WhatsApp compatibility issues)
- NO distances or directions
- If there are more results, mention it at the end

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
            console.log(`⚠️ LLM response generation timed out - using manual formatting`);
        } else {
            console.log(`⚠️ LLM response generation failed: ${err.message}`);
        }
        // Fallback: format ourselves
        return formatStoresManually(productName, stores, location);
    }
}

/**
 * Manual store formatting (fallback when LLM fails)
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
 * Fetch products from API (with caching)
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
        console.error(`❌ Failed to fetch products: ${err.message}`);
        return productsCache || [];
    }
}

/**
 * Fetch stores for a product (with caching)
 */
async function fetchStoresForProduct(productSlug, forceRefresh = false) {
    const now = Date.now();
    const cacheKey = productSlug;

    // Check cache
    if (!forceRefresh && storeCache.has(cacheKey)) {
        const cached = storeCache.get(cacheKey);
        if (now - cached.time < STORE_CACHE_TTL) {
            console.log(`������ [STORE LOCATOR] Using cached stores for ${productSlug}`);
            return cached.data;
        }
    }

    try {
        const url = `${STORE_API_BASE}/stores?product=${encodeURIComponent(productSlug)}`;
        const response = await axios.get(url, { timeout: 10000 });

        if (response.data && response.data.stores) {
            storeCache.set(cacheKey, { data: response.data.stores, time: now });
            console.log(`������ [STORE LOCATOR] Cached ${response.data.stores.length} stores for ${productSlug}`);
            return response.data.stores;
        }
        return [];
    } catch (err) {
        console.error(`❌ Failed to fetch stores for ${productSlug}: ${err.message}`);
        // Return cache if exists (even expired)
        if (storeCache.has(cacheKey)) {
            return storeCache.get(cacheKey).data;
        }
        return [];
    }
}

/**
 * Main function: Find and return store information
 * @param {string} userMessage - The user's message
 * @param {string} apiKey - API key
 * @param {boolean} hasProductContext - If true, user already mentioned a product (e.g., "Where can I buy X in Y")
 */
async function findStores(userMessage, apiKey, hasProductContext = false) {
    console.log(`������ [STORE LOCATOR] Analyzing: "${userMessage}"`);

    // Check for pending product from previous interaction
    const now = Date.now();
    const hasPendingProduct = pendingProductSlug && (now - pendingTimestamp < PENDING_TTL);

    // Step 1: Use LLM to understand user intent
    const intent = await analyzeUserIntent(userMessage, apiKey);
    console.log(`������ [STORE LOCATOR] Intent:`, intent);

    // Check if this is a location-only response (user just sent location)
    const isLocationOnly = !intent.productSlug && intent.location && hasPendingProduct;

    if (isLocationOnly) {
        console.log(`������ [STORE LOCATOR] Using pending product: ${pendingProductSlug}`);
        // Use the pending product with this location
        intent.productSlug = pendingProductSlug;
        intent.needsLocation = false;
        intent.intent = 'find_stores';
    }

    // Store pending product if we have one (for next message)
    // Keep it even after successful search - user might want to change location
    if (intent.productSlug && (intent.needsLocation || intent.location)) {
        pendingProductSlug = intent.productSlug;
        pendingTimestamp = now;
        console.log(`������ [STORE LOCATOR] Stored pending product: ${pendingProductSlug}`);
    }

    // Step 2: If needs location but none provided, ask for it
    if (intent.needsLocation && !intent.location) {
        return {
            needsLocation: true,
            text: `To find stores, please share your location/area.\n\nExample responses:\n- "in Singapore"\n- "near Subang Jaya"\n- "I'm in Shah Alam"\n- "Selangor area"`,
            productSlug: intent.productSlug
        };
    }

    // Step 2.5: Check if location is too broad (big country/region)
    // If user says "Malaysia" or "KL" or "Johor" without specific area, ask for more specific area
    // BUT: If user already mentioned a product (like "Where to buy BioNatto in Malaysia"), skip this check
    if (intent.location && isBigRegion(intent.location) && !hasProductContext) {
        console.log(`������ [STORE LOCATOR] Location "${intent.location}" is too broad, asking for specific area`);
        return {
            needsLocation: true,
            text: getSpecificAreasMessage(intent.location),
            productSlug: intent.productSlug,
            location: intent.location
        };
    }

    // Step 3: If no product identified, return error
    if (!intent.productSlug) {
        // Check if this is a follow-up location change with pending product
        if (intent.location && hasPendingProduct) {
            console.log(`������ [STORE LOCATOR] Using pending product: ${pendingProductSlug}`);
            intent.productSlug = pendingProductSlug;
            intent.needsLocation = false;
            intent.intent = 'find_stores';
        }
        // Also check last mentioned product (context from earlier messages)
        else if (!intent.productSlug && intent.location) {
            const lastProduct = getLastMentionedProduct();
            if (lastProduct) {
                console.log(`������ [STORE LOCATOR] Using last mentioned product: ${lastProduct}`);
                intent.productSlug = lastProduct;
                intent.needsLocation = false;
                intent.intent = 'find_stores';
            }
        }

        // If still no product, return success with noContext message (don't fall through to TIER 1.5)
        if (!intent.productSlug) {
            // Try ONE MORE time - check last mentioned product again
            const lastProduct = getLastMentionedProduct();
            if (lastProduct) {
                console.log(`������ [STORE LOCATOR] Using last mentioned product: ${lastProduct}`);
                intent.productSlug = lastProduct;
                intent.needsLocation = false;
                intent.intent = 'find_stores';
            } else {
                // No context - return message but DON'T fall through to TIER 1.5
                return {
                    success: true,
                    stores: [],
                    noContext: true,
                    text: `To help you find stores, please mention which product you're looking for.\n\nFor example: "Where can I buy Men Guard in Singapore?"\n\nOr if you mentioned a product earlier in our chat, just share your location!`
                };
            }
        }
    }

    // Keep pending product for follow-up location changes (don't clear here)
    // Only clear when: 1) timeout expires, 2) user asks unrelated, 3) user completes search

    // Step 4: Fetch stores for the product
    console.log(`������ [STORE LOCATOR] Fetching stores for: ${intent.productSlug}`);
    const stores = await fetchStoresForProduct(intent.productSlug);

    if (stores.length === 0) {
        return {
            success: true,
            stores: [],
            text: `Sorry, I couldn't find any stores selling this product.\n\nPlease try a different product or contact our support.`,
            productSlug: intent.productSlug
        };
    }

    console.log(`������ [STORE LOCATOR] Found ${stores.length} stores, parsing with LLM...`);

    // Step 5: Parse store data with LLM
    const parsedStores = await parseStoresWithLLM(stores, apiKey);

    // Get product display name for use in messages
    let productDisplayName = 'our products';
    try {
        const products = await fetchProducts();
        const product = products.find(p => p.slug === intent.productSlug);
        if (product) productDisplayName = product.name;
    } catch (e) {
        console.log(`⚠️ Could not fetch product name`);
    }

    // Step 6: Filter by location if provided
    let filteredStores = parsedStores;
    let noStoresInArea = false;
    if (intent.location) {
        const lowerLoc = intent.location.toLowerCase();
        filteredStores = parsedStores.filter(s => {
            const state = (s.state || '').toLowerCase();
            const area = (s.area || '').toLowerCase();
            const address = (s.address || '').toLowerCase();
            return state.includes(lowerLoc) || area.includes(lowerLoc) || address.includes(lowerLoc);
        });

        if (filteredStores.length === 0) {
            // No stores in that location - tell user instead of showing all
            console.log(`������ [STORE LOCATOR] No stores in ${intent.location}`);
            noStoresInArea = true;
        } else {
            // Store total count for "more results" message
            console.log(`������ [STORE LOCATOR] Found ${filteredStores.length} stores in ${intent.location}`);
        }
    } else {
        // No location filter - show all (will be limited to 7 in response)
        console.log(`������ [STORE LOCATOR] Found ${parsedStores.length} total stores`);
    }

    // Handle no stores in area - return friendly message, don't fall through to TIER 1.5
    if (noStoresInArea) {
        return {
            success: true,
            stores: [],
            noStoresInArea: true,
            text: `Sorry, I couldn't find any ${productDisplayName} stores in ${intent.location}.\n\nOur products are currently available in major cities like Singapore, Kuala Lumpur, Penang, Johor, and other areas. Would you like to try a different location?`,
            productSlug: intent.productSlug
        };
    }

    // Limit to 7 stores for display
    const displayLimit = 7;
    const hasMoreStores = filteredStores.length > displayLimit;
    const storesToDisplay = filteredStores.slice(0, displayLimit);

    // Step 7: Generate response
    const responseText = await generateStoreResponse(productDisplayName, storesToDisplay, intent.location, apiKey, hasMoreStores, filteredStores.length);

    // Mark as just completed - keep pending product for follow-up location changes
    justCompletedSearch = true;
    pendingTimestamp = Date.now(); // Refresh timestamp

    // Also refresh last mentioned product (staying in same conversation)
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
 * Check if this is a store-related query using LLM with conversation context
 * Returns: { isStoreQuery: boolean, reasoning: string }
 */
async function isStoreQueryWithLLM(userText, apiKey) {
    const prompt = `You are a store locator assistant for a health products chatbot. Analyze the user message and conversation context.

Determine if this message is a store locator query (asking about where to buy products or find retail stores).

Check for:
1. Explicit store/buy keywords: "where to buy", "store", "pharmacy", "retail", "watsons", "guardian", "caring"
2. Location changes in store conversations: "How about [location]?" or just "[location]?" after a store search
3. Product + location patterns: "BioNatto in Singapore", "buy men guard in KL"
4. Follow-up location changes after a store search: user previously asked about stores and is now changing location

IMPORTANT CONTEXT:
- If the user has mentioned a product recently (in this conversation) and is now mentioning a location, it might be a store query
- "How about [location]?" often means "find stores in [location] for the product we discussed"
- Single location words like "melaka?" or "singapore?" might be follow-up location changes

User message: "${userText}"

Return JSON:
{"isStoreQuery": true/false, "reasoning": "brief explanation"}

Examples:
- "Where can I buy BioNatto?" → {"isStoreQuery": true, "reasoning": "explicit buy question"}
- "How about melaka?" → {"isStoreQuery": true, "reasoning": "location change in store conversation"}
- "singapore?" → {"isStoreQuery": true, "reasoning": "location follow-up"}
- "What are the ingredients?" → {"isStoreQuery": false, "reasoning": "product info query"}`;

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

        console.log(`������ [STORE LOCATOR] LLM isStoreQuery: ${parsed.isStoreQuery} - ${parsed.reasoning}`);
        return {
            isStoreQuery: parsed.isStoreQuery === true,
            reasoning: parsed.reasoning || ''
        };
    } catch (err) {
        console.log(`⚠️ [STORE LOCATOR] LLM isStoreQuery failed: ${err.message}`);
        // Fallback to keyword matching
        return { isStoreQuery: fallbackIsStoreQuery(userText), reasoning: 'fallback' };
    }
}

/**
 * Fallback keyword matching (used when LLM fails)
 */
function fallbackIsStoreQuery(userText) {
    const lowerText = userText.toLowerCase();

    // First check for explicit store keywords
    const storeKeywords = [
        'where to buy', 'where can i buy', 'where to get', 'can i buy',
        'store', 'stores', 'retail', 'retailer', 'pharmacy', 'watsons', 'guardian', 'caring',
        'sell', 'selling', 'available', 'in singapore', 'in malaysia', 'in kl'
    ];
    if (storeKeywords.some(k => lowerText.includes(k))) {
        return true;
    }

    // Check for location-based patterns like "How about [location]?"
    if (lowerText.startsWith('how about ') && !lowerText.includes('?')) {
        const location = lowerText.replace('how about ', '').trim();
        const locations = [
            'singapore', 'kl', 'kuala lumpur', 'pj', 'petaling jaya', 'subang', 'subang jaya',
            'shah alam', 'selangor', 'puchong', 'kajang', 'cheras', 'klang', 'ampang',
            'rawang', 'seri kembangan', 'ipoh', 'penang', 'george town', 'johor', 'johor bahru', 'jb',
            'melaka', 'malacca', 'seremban', 'sabah', 'kota kinabalu', 'kk', 'sarawak', 'kuching',
            'langkawi', 'sg', 'changi', 'klia', 'usj', 'bandar sunway'
        ];
        return locations.some(loc => location.includes(loc));
    }

    // Also check for direct location mentions followed by "?"
    if (lowerText.endsWith('?') && !lowerText.includes(' ')) {
        const loc = lowerText.replace('?', '').trim();
        const singleWordLocations = [
            'singapore', 'kl', 'subang', 'shah', 'alam', 'pj', 'johor', 'penang',
            'melaka', 'ipoh', 'malacca', 'seremban', 'sabah', 'sarawak', 'langkawi',
            'klang', 'cheras', 'kajang', 'puchong', 'rawang', 'ampang', 'usj'
        ];
        return singleWordLocations.includes(loc);
    }

    return false;
}

/**
 * Check if this is a store-related query (quick check - synchronous fallback)
 * Note: Use isStoreQueryWithLLM for full LLM-based detection with context
 */
function isStoreQuery(userText) {
    // Quick synchronous check for high-traffic scenarios
    // For full LLM-based detection, use isStoreQueryWithLLM in the main flow
    return fallbackIsStoreQuery(userText);
}

/**
 * Clear pending product state (call when user asks something unrelated)
 */
function clearPendingProduct() {
    pendingProductSlug = null;
    pendingTimestamp = 0;
    justCompletedSearch = false;
    // Note: We don't clear lastMentionedProductSlug here intentionally
    // - let it expire naturally after 3 minutes
    // - This allows "Where to buy?" -> "Singapore" to still use last mentioned product
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