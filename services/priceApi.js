// services/priceApi.js
const axios = require('axios');

const API_BASE_URL = 'https://www.dyna-nutrition.com/wp-json/woo-country-price/v1';

// Product slug normalization (same as in deepseek.js)
const PRODUCT_SLUG_MAP = {
    'BioNatto Plus': 'bionatto',
    'Men Guard': 'men-guard-capsule',
    'Men Guard Capsule': 'men-guard-capsule',
    'Ashislim': 'ashislim',
    'Black Elderberry Juice': 'black-elderberry-juice',
    'Elderola': 'elderola',
    'Glucopal': 'glucopal',
    'Hairegain': 'hairegain',
    'HP-Floragut': 'hp-floragut',
    'Liveprotein': 'liveprotein',
    'Marinecal Plus': 'marinecal-plus',
    'Nustem': 'nustem',
    'Optiberries': 'optiberries',
    'Optivue': 'optivue',
    'Organic Ashitaba': 'organic-ashitaba',
    'Super Bio Organic': 'super-bio-organic',
    'Tibetan Seaberry': 'tibetan-seaberry',
    'Tricollagen': 'tricollagen',
    'Uri Comfort': 'uri-comfort',
    'Vitamune CDZ': 'vitamune-cdz',
    'Riflex 360': 'riflex-360'
};

// Country code to phone prefix mapping
const COUNTRY_PHONE_PREFIXES = {
    'MY': ['60'],      // Malaysia
    'SG': ['65'],      // Singapore
    'ID': ['62'],      // Indonesia
    'TH': ['66'],      // Thailand
    'PH': ['63'],      // Philippines
    'VN': ['84'],      // Vietnam
    'US': ['1'],       // United States
    'GB': ['44'],      // United Kingdom
    'AU': ['61'],      // Australia
    'HK': ['852'],     // Hong Kong
    'TW': ['886'],     // Taiwan
    'BND': ['673']     // Brunei
};

// Map phone prefix to currency
const PREFIX_TO_CURRENCY = {
    '60': 'MYR',   // Malaysia
    '65': 'SGD',   // Singapore
    '62': 'IDR',   // Indonesia
    '66': 'THB',   // Thailand
    '63': 'PHP',   // Philippines
    '84': 'VND',   // Vietnam
    '1': 'USD',    // United States
    '44': 'GBP',   // United Kingdom
    '61': 'AUD',   // Australia
    '852': 'HKD',  // Hong Kong
    '886': 'TWD',  // Taiwan
    '673': 'BND'   // Brunei
};

// Get product slug from product name
function getProductSlug(productName) {
    const mapped = PRODUCT_SLUG_MAP[productName];
    if (mapped) return mapped;
    // Smart stripping - but keep "capsule" for Men Guard since API uses it
    const lowerName = productName.toLowerCase();
    if (lowerName.includes('men guard')) {
        return 'men-guard-capsule';
    }
    return lowerName
        .replace(/\s*(plus|capsules|tablet|softgel)\s*/gi, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');
}

// Get country/currency from phone number
function getCurrencyFromPhone(phoneNumber) {
    if (!phoneNumber) return null;
    
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    
    // Try to match prefixes (longer prefixes first for accuracy)
    const prefixes = Object.keys(PREFIX_TO_CURRENCY).sort((a, b) => b.length - a.length);
    
    for (const prefix of prefixes) {
        if (cleanPhone.startsWith(prefix)) {
            return PREFIX_TO_CURRENCY[prefix];
        }
    }
    
    return null; // Unknown country
}

// Fetch all product slugs from API
async function fetchProductSlugs() {
    try {
        const response = await axios.get(`${API_BASE_URL}/product-slugs`, { timeout: 10000 });
        return response.data.slugs || [];
    } catch (err) {
        console.error('❌ Failed to fetch product slugs:', err.message);
        return [];
    }
}

// Fetch product data from API
async function fetchProductData(productSlug) {
    try {
        const response = await axios.get(`${API_BASE_URL}/product-data`, {
            params: { product_slug: productSlug },
            timeout: 10000
        });
        return response.data;
    } catch (err) {
        console.error(`❌ Failed to fetch product data for ${productSlug}:`, err.message);
        return null;
    }
}

// Check if a variation is a subscription plan (using LLM parsing preference, but simple heuristic as fallback)
function isSubscriptionPlan(variationSet) {
    if (!variationSet) return false;
    
    const lowerSet = variationSet.toLowerCase();
    
    // Subscription indicators: contains "per X weeks" pattern
    const subscriptionPatterns = [
        /per\s*\d+\s*weeks?/i,
        /per\s*\d+\s*months?/i,
        /subscription/i,
        /auto[- ]?deliver/i,
        /recurring/i
    ];
    
    for (const pattern of subscriptionPatterns) {
        if (pattern.test(lowerSet)) {
            return true;
        }
    }
    
    return false;
}

// Parse product price data using LLM (preferred method)
async function parsePriceWithLLM(productData, currency, apiKey) {
    console.log(`   🔍 [LLM PARSER] parsePriceWithLLM called:`);
    console.log(`      - productData present: ${!!productData}`);
    console.log(`      - currency: ${currency || 'NULL'}`);
    console.log(`      - apiKey present: ${!!apiKey}`);
    
    if (!productData || !apiKey) {
        console.log(`   ⚠️ [LLM PARSER] No product data or API key, using manual parser`);
        console.log(`   🔑 [LLM PARSER DEBUG] apiKey present: ${!!apiKey}, productData present: ${!!productData}`);
        // Fallback to manual parsing if no LLM available
        return parsePriceManually(productData, currency);
    }
    
    try {
        console.log(`   🤖 [LLM PARSER] Parsing price data with LLM...`);
        console.log(`   🔑 [LLM PARSER DEBUG] Using API key: ${apiKey.substring(0, 10)}...`);
        const prompt = `You are a price data parser. Analyze this product price data from an API response and extract the relevant pricing information.

PRODUCT DATA:
${JSON.stringify(productData, null, 2)}

USER'S CURRENCY: ${currency || 'Not specified (use default_currency)'}

IMPORTANT RULES:
1. Filter OUT any variations that are subscription plans. Subscription plans contain phrases like "per 4 weeks", "per 6 weeks", "per 8 weeks", "per 12 weeks", "subscription", "auto-deliver", or "recurring".
2. Only include regular purchase options (e.g., "1 Box", "2 boxes", "3 boxes", "Buy 1 Free 1").
3. If the user's currency is specified, show prices in that currency ONLY IF it exists in the currency_prices object. If not available, use the default_currency.
4. Format the output as a clear, readable price list.

Return ONLY a JSON object with this format:
{
    "productName": "Product Name",
    "currency": "Currency code used",
    "prices": [
        {"option": "1 Box", "price": 100, "discount": "none"},
        {"option": "2 boxes", "price": 180, "discount": "5% off"}
    ],
    "defaultCurrency": "MYR"
}

If no valid non-subscription prices are found, return:
{
    "productName": "Product Name",
    "currency": null,
    "prices": [],
    "defaultCurrency": "MYR",
    "note": "Only subscription plans available"
}`;

        console.log(`   📝 [LLM PARSER] Sending request to DeepSeek API...`);
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a price data parser. Respond only with valid JSON.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 500
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 15000
            }
        );

        console.log(`   ✅ [LLM PARSER] DeepSeek API responded with status: ${response.status}`);
        const content = response.data.choices[0].message.content.trim();
        console.log(`   🤖 [LLM PARSER] LLM response: ${content.substring(0, 500)}...`);
        
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            console.log(`   ✅ [LLM PARSER] Successfully parsed with LLM`);
            console.log(`   📊 [LLM PARSER] Result:`, JSON.stringify(result));
            return result;
        }
        
        throw new Error('Invalid JSON from LLM');
    } catch (err) {
        console.error(`   ❌ [LLM PARSER] LLM price parsing failed: ${err.message}, falling back to manual`);
        console.error(`   🔍 [LLM PARSER] Error details:`, err.response?.data || err.code || err.message);
        // Fallback to manual parsing
        return parsePriceManually(productData, currency);
    }
}

// Manual price parsing (fallback when LLM unavailable)
function parsePriceManually(productData, preferredCurrency) {
    console.log(`   🔧 [MANUAL PARSER] Using manual price parser`);
    console.log(`   🔍 [MANUAL PARSER DEBUG] Input - productData present: ${!!productData}, preferredCurrency: ${preferredCurrency || 'NULL'}`);
    
    if (!productData || !productData.variations || productData.variations.length === 0) {
        console.log(`   ⚠️ [MANUAL PARSER] No variations found in product data`);
        return null;
    }
    
    // Determine currency to use
    let currency = preferredCurrency || productData.default_currency;
    console.log(`   💱 [MANUAL PARSER] Requested currency: ${preferredCurrency || 'NULL'}, using: ${currency}`);
    
    const prices = [];
    
    for (const variation of productData.variations) {
        const setAttr = variation.attributes?.set || '';
        console.log(`   🔍 [MANUAL PARSER] Processing variation: "${setAttr}"`);
        
        // Skip subscription plans
        if (isSubscriptionPlan(setAttr)) {
            console.log(`   ⏭️ [MANUAL PARSER] Skipping subscription plan: "${setAttr}"`);
            continue;
        }
        
        // Get price for the preferred currency ONLY if it exists
        // If preferred currency doesn't exist, fall back to default currency
        let price = null;
        let usedCurrency = currency;
        
        if (variation.currency_prices && variation.currency_prices[currency]) {
            // Preferred currency exists, use it
            price = variation.currency_prices[currency];
            console.log(`   💰 [MANUAL PARSER] Found price for requested currency ${currency}: ${price} (option: "${setAttr}")`);
        } else if (preferredCurrency && productData.default_currency && variation.currency_prices[productData.default_currency]) {
            // Preferred currency was requested but doesn't exist, use default instead
            price = variation.currency_prices[productData.default_currency];
            usedCurrency = productData.default_currency;
            console.log(`   ⚠️ [MANUAL PARSER] Requested currency ${currency} not available, using default ${productData.default_currency}: ${price} (option: "${setAttr}")`);
        } else if (!preferredCurrency && productData.default_currency && variation.currency_prices[productData.default_currency]) {
            // No preferred currency specified, use default
            price = variation.currency_prices[productData.default_currency];
            console.log(`   💰 [MANUAL PARSER] Using default currency ${productData.default_currency}: ${price} (option: "${setAttr}")`);
        } else {
            console.log(`   ⚠️ [MANUAL PARSER] No price found for ${currency} or default, skipping`);
        }
        
        if (price !== null) {
            // Extract discount info from the set attribute
            let discount = 'none';
            const discountMatch = setAttr.match(/(\d+)%\s*off/i);
            if (discountMatch) {
                discount = `${discountMatch[1]}% off`;
            } else if (/free/i.test(setAttr)) {
                discount = 'Buy 1 Free 1';
            }
            
            prices.push({
                option: setAttr,
                price: price,
                discount: discount
            });
            console.log(`   ✅ [MANUAL PARSER] Added price: ${setAttr} = ${price} (${discount}) in ${usedCurrency}`);
        }
    }
    
    console.log(`   ✅ [MANUAL PARSER] Parsed ${prices.length} non-subscription prices`);
    if (prices.length > 0) {
        console.log(`   📊 [MANUAL PARSER] Final prices:`, JSON.stringify(prices));
    }
    
    return {
        productName: productData.slug,
        currency: currency,
        prices: prices,
        defaultCurrency: productData.default_currency
    };
}

// Main function to get product price for a user
async function getProductPrice(productName, phoneNumber, apiKey = null, forcedCurrency = null) {
    console.log(`💰 [PRICE API] Getting price for "${productName}" (phone: ${phoneNumber || 'NULL'}, forcedCurrency: ${forcedCurrency || 'NULL'})`);
    console.log(`🔑 [PRICE API DEBUG] apiKey parameter: ${apiKey ? 'PRESENT (' + apiKey.substring(0, 10) + '...)' : 'MISSING'}`);
    
    const productSlug = getProductSlug(productName);
    console.log(`   📦 Normalized slug: "${productSlug}"`);
    
    // Determine currency from phone number or use forced currency
    let currency = forcedCurrency;
    if (!currency) {
        currency = getCurrencyFromPhone(phoneNumber);
        console.log(`   💱 Detected currency from phone "${phoneNumber}": ${currency || 'Not detected (will use default)'}`);
    } else {
        console.log(`   💱 Using forced currency: ${currency}`);
    }
    
    // Fetch product data from API
    console.log(`   🌐 Fetching product data from API...`);
    const productData = await fetchProductData(productSlug);
    
    if (!productData) {
        console.log(`   ❌ No product data found for "${productSlug}"`);
        return null;
    }
    
    console.log(`   ✅ Product data received, default currency: ${productData.default_currency}`);
    console.log(`   📊 Product data variations count: ${productData.variations?.length || 0}`);
    
    // Debug: Show full product data structure
    console.log(`   🔍 [DEBUG] Full product data structure:`);
    console.log(JSON.stringify(productData, null, 2).substring(0, 2000));
    
    // Parse prices (prefer LLM, fallback to manual)
    console.log(`   🔧 [PRICE API] Calling parsePriceWithLLM with apiKey: ${!!apiKey}`);
    const priceInfo = await parsePriceWithLLM(productData, currency, apiKey);
    
    console.log(`   💰 [DEBUG] Final priceInfo:`, priceInfo ? `currency=${priceInfo.currency}, prices count=${priceInfo.prices?.length || 0}` : 'NULL');
    if (priceInfo && priceInfo.prices) {
        console.log(`   💰 [DEBUG] Price details:`, JSON.stringify(priceInfo.prices));
    }
    
    return priceInfo;
}

// Format price response for user
function formatPriceResponse(productName, priceInfo, requestedCurrency = null) {
    if (!priceInfo || !priceInfo.prices || priceInfo.prices.length === 0) {
        return `I'm sorry, I couldn't find pricing information for ${productName}. Please contact our support team for assistance.`;
    }
    
    const currency = priceInfo.currency || priceInfo.defaultCurrency || 'MYR';
    const currencySymbol = getCurrencySymbol(currency);
    
    let response = `Here are the prices for *${productName}*:\n\n`;
    
    // Sort prices in ascending order by price value
    const sortedPrices = [...priceInfo.prices].sort((a, b) => a.price - b.price);
    
    for (const price of sortedPrices) {
        // Always format price with 2 decimal places
        const formattedPrice = price.price.toFixed(2);
        const priceStr = `${currencySymbol}${formattedPrice}`;
        // Only add discount info once, avoid repeating "(x% off)" if already in option
        let discountStr = '';
        if (price.discount !== 'none') {
            // Check if the discount is already mentioned in the option text
            const optionLower = price.option.toLowerCase();
            const discountLower = price.discount.toLowerCase();
            // Avoid duplication like "2 boxes (5% off): S$ 132.80 (5% off)"
            if (!optionLower.includes(discountLower.replace('% off', ''))) {
                discountStr = ` (${price.discount})`;
            }
        }
        response += `• ${price.option}: ${priceStr}${discountStr}\n`;
    }
    
    // Show currency note if:
    // 1. User requested a specific currency different from default, OR
    // 2. The returned currency is different from the phone-based default
    if (requestedCurrency && requestedCurrency !== priceInfo.defaultCurrency) {
        response += `\n_(Prices shown in ${requestedCurrency})_`;
    } else if (priceInfo.currency && priceInfo.currency !== priceInfo.defaultCurrency) {
        response += `\n_(Prices shown in ${priceInfo.currency})_`;
    }
    
    return response;
}

// Get currency symbol
function getCurrencySymbol(currency) {
    const symbols = {
        'MYR': 'RM ',
        'SGD': 'S$ ',
        'USD': '$ ',
        'EUR': '€ ',
        'GBP': '£ ',
        'AUD': 'A$ ',
        'CAD': 'C$ ',
        'HKD': 'HK$ ',
        'TWD': 'NT$ ',
        'BND': 'B$ ',
        'IDR': 'Rp ',
        'THB': '฿ ',
        'PHP': '₱ ',
        'VND': '₫ ',
        'JPY': '¥ '
    };
    return symbols[currency] || `${currency} `;
}

module.exports = {
    getProductPrice,
    getProductSlug,
    getCurrencyFromPhone,
    fetchProductSlugs,
    fetchProductData,
    parsePriceWithLLM,
    parsePriceManually,
    formatPriceResponse,
    isSubscriptionPlan,
    getCurrencySymbol,
    PRODUCT_SLUG_MAP,
    COUNTRY_PHONE_PREFIXES,
    PREFIX_TO_CURRENCY
};
