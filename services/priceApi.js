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
    if (!productData || !apiKey) {
        // Fallback to manual parsing if no LLM available
        return parsePriceManually(productData, currency);
    }

    try {
        const prompt = `You are a price data parser. Analyze this product price data from an API response and extract the relevant pricing information.

PRODUCT DATA:
${JSON.stringify(productData, null, 2)}

USER'S CURRENCY: ${currency || 'Not specified (use default_currency)'}

IMPORTANT RULES:
1. Separate regular prices from subscription plans.
2. Regular prices: "1 Box", "2 boxes", "3 boxes", "Buy 1 Free 1", etc.
3. Subscription plans contain phrases like "per 4 weeks", "per 6 weeks", "per 8 weeks", "per 12 weeks", "subscription", "auto-deliver", or "recurring". Include these in "subscriptions" array.
4. If the user's currency is specified, show prices in that currency ONLY IF it exists in the currency_prices object. If not available, use the default_currency.
5. Format the output as a clear, readable price list.

Return ONLY a JSON object with this format:
{
    "productName": "Product Name",
    "currency": "Currency code used",
    "prices": [
        {"option": "1 Box", "price": 100, "discount": "none"},
        {"option": "2 boxes", "price": 180, "discount": "5% off"}
    ],
    "subscriptions": [
        {"option": "Subscription per 4 weeks", "price": 85, "discount": "none"}
    ],
    "defaultCurrency": "MYR"
}

If no valid prices are found, return:
{
    "productName": "Product Name",
    "currency": null,
    "prices": [],
    "subscriptions": [],
    "defaultCurrency": "MYR"
}`;

        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a price data parser. Respond only with valid JSON.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 600
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 15000
            }
        );

        const content = response.data.choices[0].message.content.trim();

        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            // Ensure subscriptions array exists
            if (!result.subscriptions) {
                result.subscriptions = [];
            }
            return result;
        }

        throw new Error('Invalid JSON from LLM');
    } catch (err) {
        console.error(`   ❌ [LLM PARSER] LLM price parsing failed: ${err.message}, falling back to manual`);
        // Fallback to manual parsing
        return parsePriceManually(productData, currency);
    }
}

// Manual price parsing (fallback when LLM unavailable)
function parsePriceManually(productData, preferredCurrency) {
    if (!productData || !productData.variations || productData.variations.length === 0) {
        return null;
    }

    // Determine currency to use
    let currency = preferredCurrency || productData.default_currency;

    const prices = [];
    const subscriptions = [];  // Separate list for subscriptions

    for (const variation of productData.variations) {
        const setAttr = variation.attributes?.set || '';

        // Get price for the preferred currency ONLY if it exists
        // If preferred currency doesn't exist, fall back to default currency
        let price = null;
        let usedCurrency = currency;

        if (variation.currency_prices && variation.currency_prices[currency]) {
            // Preferred currency exists, use it
            price = variation.currency_prices[currency];
        } else if (preferredCurrency && productData.default_currency && variation.currency_prices[productData.default_currency]) {
            // Preferred currency was requested but doesn't exist, use default instead
            price = variation.currency_prices[productData.default_currency];
            usedCurrency = productData.default_currency;
        } else if (!preferredCurrency && productData.default_currency && variation.currency_prices[productData.default_currency]) {
            // No preferred currency specified, use default
            price = variation.currency_prices[productData.default_currency];
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

            // Separate subscriptions from regular prices
            if (isSubscriptionPlan(setAttr)) {
                subscriptions.push({
                    option: setAttr,
                    price: price,
                    discount: discount,
                    isSubscription: true
                });
            } else {
                prices.push({
                    option: setAttr,
                    price: price,
                    discount: discount
                });
            }
        }
    }

    return {
        productName: productData.slug,
        currency: currency,
        prices: prices,
        subscriptions: subscriptions,  // Include subscriptions in response
        defaultCurrency: productData.default_currency
    };
}

// Main function to get product price for a user
async function getProductPrice(productName, phoneNumber, apiKey = null, forcedCurrency = null) {
    const productSlug = getProductSlug(productName);
    
    // Determine currency from phone number or use forced currency
    let currency = forcedCurrency;
    if (!currency) {
        currency = getCurrencyFromPhone(phoneNumber);
    }
    
    // Fetch product data from API
    const productData = await fetchProductData(productSlug);
    
    if (!productData) {
        return null;
    }
    
    // Parse prices (prefer LLM, fallback to manual)
    const priceInfo = await parsePriceWithLLM(productData, currency, apiKey);
    
    return priceInfo;
}

// Format price response for user
function formatPriceResponse(productName, priceInfo, requestedCurrency = null) {
    if (!priceInfo || (!priceInfo.prices || priceInfo.prices.length === 0) && (!priceInfo.subscriptions || priceInfo.subscriptions.length === 0)) {
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
