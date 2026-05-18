// services/priceApi.js
// Real-time price lookup from WooCommerce API
// Handles multi-currency pricing and product slug normalization

const axios = require('axios');

const API_BASE_URL = 'https://www.dyna-nutrition.com/wp-json/woo-country-price/v1';

// Product slug normalization - verified against API
// Key: user-facing name or partial slug, Value: WooCommerce slug (from API)
const PRODUCT_SLUG_MAP = {
    // BioNatto
    'BioNatto': 'bionatto',
    'BioNatto Plus': 'bionatto',
    'bionatto': 'bionatto',

    // Men Guard - WooCommerce slug is 'men-guard-capsule'
    'Men Guard': 'men-guard-capsule',
    'Men Guard Capsule': 'men-guard-capsule',
    'MenGuard': 'men-guard-capsule',
    'men guard': 'men-guard-capsule',
    'men-guard': 'men-guard-capsule',

    // Ashislim
    'Ashislim': 'ashislim',
    'AshiSlim': 'ashislim',
    'ashi slim': 'ashislim',

    // Ashiguard
    'Ashiguard': 'ashiguard',
    'Ashi Guard': 'ashiguard',

    // Black Elderberry Juice
    'Black Elderberry Juice': 'black-elderberry-juice',
    'Black Elderberry': 'black-elderberry-juice',
    'elderberry': 'black-elderberry-juice',

    // Cordyceps
    'Cordyceps': 'vitalguard-royal-cordyceps-capsule',
    'Royal Cordyceps': 'vitalguard-royal-cordyceps-capsule',
    'Cordyceps Capsule': 'vitalguard-royal-cordyceps-capsule',

    // Cordzyme
    'Cordzyme': 'cordyzyme',
    'Cord Zyme': 'cordyzyme',

    // Elderola
    'Elderola': 'elderola',

    // Glucopal
    'Glucopal': 'glucopal',
    'GlucoPal': 'glucopal',

    // Hairegain
    'Hairegain': 'hairegain',
    'HairGain': 'hairegain',
    'Hair Regain': 'hairegain',

    // HP-Floragut
    'HP-Floragut': 'hp-floragut',
    'HP Floragut': 'hp-floragut',
    'Floragut': 'hp-floragut',

    // Liveprotein
    'Liveprotein': 'liveprotein',
    'Live Protein': 'liveprotein',

    // Marinecal Plus
    'Marinecal Plus': 'marinecal-plus',
    'Marine Cal Plus': 'marinecal-plus',

    // Nustem
    'Nustem': 'nustem',

    // Optiberries
    'Optiberries': 'optiberries-chewable',
    'Optiberries Chewable': 'optiberries-chewable',

    // Optivue
    'Optivue': 'optivue',

    // Organic Ashitaba
    'Organic Ashitaba': 'ashitaba',
    'Ashitaba': 'ashitaba',

    // Super Bio Organic
    'Super Bio Organic': 'super-bio-organic',

    // Tibetan Seaberry
    'Tibetan Seaberry': 'tibetan-seaberry',
    'Sea Berry': 'tibetan-seaberry',
    'Seaberry': 'tibetan-seaberry',

    // Tricollagen
    'Tricollagen': 'tricollagen',
    'TriCollagen': 'tricollagen',

    // Uri Comfort
    'Uri Comfort': 'uri-comfort',

    // Vitamune CDZ
    'Vitamune CDZ': 'vitamune-cdz',
    'Vitamune': 'vitamune-cdz',

    // Riflex 360 - WooCommerce slug is 'vitalguard-riflex-360-capsule'
    'Riflex 360': 'vitalguard-riflex-360-capsule',
    'Riflex360': 'vitalguard-riflex-360-capsule',
    'Riflex': 'vitalguard-riflex-360-capsule',
    'riflex-360': 'vitalguard-riflex-360-capsule',

    // Barleygrass
    'Barleygrass': 'organic-volcanic-barley-grass-juice-powder',
    'Barley Grass': 'organic-volcanic-barley-grass-juice-powder',

    // Wheatgrass
    'Wheatgrass': 'organic-volcanic-wheatgrass-juice-powder',
    'Wheat Grass': 'organic-volcanic-wheatgrass-juice-powder',

    // Premium Organic Beetroot Juice
    'Premium Organic Beetroot Juice': 'premium-organic-red-beet',
    'Beetroot Juice': 'premium-organic-red-beet',
    'Organic Beetroot': 'premium-organic-red-beet',

    // Reswell - WooCommerce slug is 'reswell-capsule'
    'Reswell': 'reswell-capsule',
    'Reswell Capsule': 'reswell-capsule',
    'reswell': 'reswell-capsule',

    // Triple Green
    'Triple Green': 'organic-volcanic-triple-green',

    // Nitrovar
    'Nitrovar': 'nitrovar',
    'Nitrovar Plus': 'nitrovar',

    // Live Acerola
    'Live Acerola': 'liveacerola',
    'Liveacerola': 'liveacerola',

    // Liveberries
    'Liveberries': 'liveberries',
    'Live Berries': 'liveberries',

    // Liveessence
    'Liveessence': 'liveessence',
    'Live Essence': 'liveessence',

    // Livezymes
    'Livezymes': 'livezymes',
    'Live Zymes': 'livezymes',

    // Bone Builder Bundle
    'Bone Builder': 'bone-builder-bundle',

    // Liver Detox Bundle
    'Liver Detox': 'liver-detoxification-bundle',
};

// Country code to phone prefix mapping
const COUNTRY_PHONE_PREFIXES = {
    'MY': ['60'],
    'SG': ['65'],
    'ID': ['62'],
    'TH': ['66'],
    'PH': ['63'],
    'VN': ['84'],
    'US': ['1'],
    'GB': ['44'],
    'AU': ['61'],
    'HK': ['852'],
    'TW': ['886'],
    'BND': ['673']
};

// Map phone prefix to currency
const PREFIX_TO_CURRENCY = {
    '60': 'MYR',
    '65': 'SGD',
    '62': 'IDR',
    '66': 'THB',
    '63': 'PHP',
    '84': 'VND',
    '1': 'USD',
    '44': 'GBP',
    '61': 'AUD',
    '852': 'HKD',
    '886': 'TWD',
    '673': 'BND'
};

/**
 * Get product slug from product name
 */
function getProductSlug(productName) {
    if (!productName) return null;

    // Check exact match first
    const mapped = PRODUCT_SLUG_MAP[productName];
    if (mapped) return mapped;

    // Check case-insensitive match
    const lowerName = productName.toLowerCase();
    const lowerMapped = PRODUCT_SLUG_MAP[lowerName];
    if (lowerMapped) return lowerMapped;

    // If it's already a valid WooCommerce slug, return as-is
    if (VALID_WOOCOMMERCE_SLUGS.has(lowerName)) {
        return lowerName;
    }

    // Last resort: try to normalize with generic rules
    return lowerName
        .replace(/\s*(plus|capsules?|tablet|softgel|chewable)\s*/gi, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');
}

// Set of valid WooCommerce slugs from API (for validation)
const VALID_WOOCOMMERCE_SLUGS = new Set([
    'glucopal', 'bone-builder-bundle', 'liver-detoxification-bundle', 'vitamune-cdz',
    'optiberries-chewable', 'hairegain', 'marinecal-plus', 'tricollagen',
    'vitalguard-riflex-360-capsule', 'men-guard-capsule', 'reswell-capsule',
    'nustem', 'liveprotein', 'optivue', 'elderola', 'organic-volcanic-triple-green',
    'organic-volcanic-wheatgrass-juice-powder', 'organic-volcanic-barley-grass-juice-powder',
    'tibetan-seaberry', 'hp-floragut', 'vitalguard-royal-cordyceps-capsule',
    'cordyzyme', 'ashiguard', 'bionatto-subscription-plan', 'uri-comfort',
    'premium-organic-red-beet', 'black-elderberry-juice', 'ashislim', 'bionatto',
    'ashitaba', 'super-bio-organic', 'liveacerola', 'nitrovar', 'liveessence',
    'livezymes', 'liveberries'
]);

/**
 * Get currency from phone number
 */
function getCurrencyFromPhone(phoneNumber) {
    if (!phoneNumber) return null;

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    const prefixes = Object.keys(PREFIX_TO_CURRENCY).sort((a, b) => b.length - a.length);

    for (const prefix of prefixes) {
        if (cleanPhone.startsWith(prefix)) {
            return PREFIX_TO_CURRENCY[prefix];
        }
    }

    return null;
}

/**
 * Fetch product data from API
 */
async function fetchProductData(productSlug) {
    try {
        const response = await axios.get(`${API_BASE_URL}/product-data`, {
            params: { product_slug: productSlug },
            timeout: 10000
        });
        return response.data;
    } catch (err) {
        console.error(`[PRICE API] Failed to fetch product data for ${productSlug}:`, err.message);
        return null;
    }
}

/**
 * Check if a variation is a subscription plan
 */
function isSubscriptionPlan(variationSet) {
    if (!variationSet) return false;

    const lowerSet = variationSet.toLowerCase();
    const subscriptionPatterns = [
        /per\s*\d+\s*weeks?/i,
        /per\s*\d+\s*months?/i,
        /subscription/i,
        /auto[- ]?deliver/i,
        /recurring/i
    ];

    return subscriptionPatterns.some(p => p.test(lowerSet));
}

/**
 * Parse product price data using LLM
 */
async function parsePriceWithLLM(productData, currency, apiKey) {
    if (!productData || !apiKey) {
        return parsePriceManually(productData, currency);
    }

    try {
        const prompt = `You are a price data parser. Analyze this product price data and extract pricing information.

PRODUCT DATA:
${JSON.stringify(productData, null, 2)}

USER'S CURRENCY: ${currency || 'Not specified (use default_currency)'}

IMPORTANT RULES:
1. Separate regular prices from subscription plans.
2. Regular prices: "1 Box", "2 boxes", "3 boxes", "Buy 1 Free 1", etc.
3. Subscription plans contain phrases like "per 4 weeks", "per 6 weeks", "per 12 weeks".
4. If the user's currency is specified, show prices in that currency ONLY IF it exists.
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
            if (!result.subscriptions) result.subscriptions = [];
            return result;
        }

        throw new Error('Invalid JSON from LLM');
    } catch (err) {
        console.error(`[PRICE API] LLM parsing failed: ${err.message}, falling back to manual`);
        return parsePriceManually(productData, currency);
    }
}

/**
 * Manual price parsing (fallback)
 */
function parsePriceManually(productData, preferredCurrency) {
    if (!productData || !productData.variations || productData.variations.length === 0) {
        return null;
    }

    let currency = preferredCurrency || productData.default_currency;
    const prices = [];
    const subscriptions = [];

    for (const variation of productData.variations) {
        const setAttr = variation.attributes?.set || '';

        let price = null;
        let usedCurrency = currency;

        if (variation.currency_prices && variation.currency_prices[currency]) {
            price = variation.currency_prices[currency];
        } else if (preferredCurrency && productData.default_currency && variation.currency_prices[productData.default_currency]) {
            price = variation.currency_prices[productData.default_currency];
            usedCurrency = productData.default_currency;
        } else if (!preferredCurrency && productData.default_currency && variation.currency_prices[productData.default_currency]) {
            price = variation.currency_prices[productData.default_currency];
        }

        if (price !== null) {
            let discount = 'none';
            const discountMatch = setAttr.match(/(\d+)%\s*off/i);
            if (discountMatch) {
                discount = `${discountMatch[1]}% off`;
            } else if (/free/i.test(setAttr)) {
                discount = 'Buy 1 Free 1';
            }

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
        subscriptions: subscriptions,
        defaultCurrency: productData.default_currency
    };
}

/**
 * Main function to get product price
 */
async function getProductPrice(productName, phoneNumber, apiKey = null, forcedCurrency = null) {
    const productSlug = getProductSlug(productName);

    let currency = forcedCurrency;
    if (!currency) {
        currency = getCurrencyFromPhone(phoneNumber);
    }

    const productData = await fetchProductData(productSlug);
    if (!productData) {
        return null;
    }

    const priceInfo = await parsePriceWithLLM(productData, currency, apiKey);
    return priceInfo;
}

/**
 * Format price response for user
 */
function formatPriceResponse(productName, priceInfo, requestedCurrency = null) {
    if (!priceInfo || (!priceInfo.prices || priceInfo.prices.length === 0) && (!priceInfo.subscriptions || priceInfo.subscriptions.length === 0)) {
        return `I'm sorry, I couldn't find pricing information for ${productName}. Please contact our support team for assistance.`;
    }

    const currency = priceInfo.currency || priceInfo.defaultCurrency || 'MYR';
    const currencySymbol = getCurrencySymbol(currency);

    let response = `Here are the prices for *${productName}*:\n\n`;

    const nonSubscriptionPrices = (priceInfo.prices || []).filter(price => !isSubscriptionPlan(price.option));
    const sortedPrices = [...nonSubscriptionPrices].sort((a, b) => a.price - b.price);

    for (const price of sortedPrices) {
        const formattedPrice = price.price.toFixed(2);
        const priceStr = `${currencySymbol}${formattedPrice}`;
        let discountStr = '';

        if (price.discount !== 'none') {
            const optionLower = price.option.toLowerCase();
            const discountLower = price.discount.toLowerCase();
            if (!optionLower.includes(discountLower.replace('% off', ''))) {
                discountStr = ` (${price.discount})`;
            }
        }
        response += `• ${price.option}: ${priceStr}${discountStr}\n`;
    }

    return response;
}

/**
 * Get currency symbol
 */
function getCurrencySymbol(currency) {
    const symbols = {
        'MYR': 'RM ',
        'SGD': 'S$ ',
        'USD': '$ ',
        'EUR': '€ ',
        'GBP': '£ ',
        'AUD': 'A$ ',
        'HKD': 'HK$ ',
        'TWD': 'NT$ ',
        'BND': 'B$ ',
        'IDR': 'Rp ',
        'THB': '฿ ',
        'PHP': '₱ ',
        'VND': '₫ '
    };
    return symbols[currency] || `${currency} `;
}

module.exports = {
    getProductPrice,
    getProductSlug,
    getCurrencyFromPhone,
    fetchProductData,
    formatPriceResponse,
    getCurrencySymbol,
    PRODUCT_SLUG_MAP,
    VALID_WOOCOMMERCE_SLUGS
};