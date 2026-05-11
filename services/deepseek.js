// services/deepseek.js
const axios = require('axios');
const { getKnowledge } = require('./knowledgeLoader');
const { getSupplementaryInfo } = require('../utils/brochures');
const { searchWebsite, fetchProductPageAndLinks } = require('../config/botConfig');
const { isStoreQuery, isStoreQueryWithLLM, findStores, fetchProducts, clearPendingProduct, trackMentionedProduct, getLastMentionedProduct } = require('./storeLocator');
const { getProductPrice, formatPriceResponse, getCurrencyFromPhone, getProductSlug: getPriceApiSlug } = require('./priceApi');
const { getPhoneNumber } = require('../utils/contactCache');
const { processIntent, generateActionResponse, clearUserState, INTENT_TYPES } = require('./intentManager');

// Product slug normalization helper
// Based on actual API slugs from: https://www.dyna-nutrition.com/wp-json/woo-country-price/v1/product-slugs
const PRODUCT_SLUG_MAP = {
    'BioNatto Plus': 'bionatto',
    'BioNatto': 'bionatto',
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
    'Optiberries': 'optiberries-chewable',
    'Optiberries Chewable': 'optiberries-chewable',
    'Optivue': 'optivue',
    'Organic Ashitaba': 'ashitaba',
    'Super Bio Organic': 'super-bio-organic',
    'Tibetan Seaberry': 'tibetan-seaberry',
    'Tricollagen': 'tricollagen',
    'Uri Comfort': 'uri-comfort',
    'Vitamune CDZ': 'vitamune-cdz',
    'Riflex 360': 'vitalguard-riflex-360-capsule',
    'Vitalguard Riflex 360': 'vitalguard-riflex-360-capsule',
    'Vitalguard Riflex 360 Capsule': 'vitalguard-riflex-360-capsule',
    'Cordyzyme': 'cordyzyme',
    'AshiGuard': 'ashiguard',
    'ResWell': 'reswell-capsule',
    'ResWell Capsule': 'reswell-capsule',
    'Organic Volcanic Triple Green': 'organic-volcanic-triple-green',
    'Organic Volcanic Wheatgrass': 'organic-volcanic-wheatgrass-juice-powder',
    'Organic Volcanic Barley Grass': 'organic-volcanic-barley-grass-juice-powder',
    'Vitalguard Royal Cordyceps': 'vitalguard-royal-cordyceps-capsule',
    'Premium Organic Red Beet': 'premium-organic-red-beet',
    'LiveAcerola': 'liveacerola',
    'NitroVar': 'nitrovar',
    'LiveEssence': 'liveessence',
    'LiveZymes': 'livezymes',
    'LiveBerries': 'liveberries',
    'Bone Builder Bundle': 'bone-builder-bundle',
    'Liver Detoxification Bundle': 'liver-detoxification-bundle'
};

function getProductSlug(productName) {
    const mapped = PRODUCT_SLUG_MAP[productName];
    if (mapped) return mapped;
    // Smart stripping
    return productName.toLowerCase()
        .replace(/\s*(plus|capsule|capsules|tablet|softgel)\s*/gi, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');
}

// ------------------- DeepSeek keyword extraction -----------------------
async function extractKeywordsWithDeepSeek(userMessage, apiKey) {
    console.log(`Ì†æÌ¥ñ Asking DeepSeek to extract keywords from: "${userMessage}"`);
    if (!apiKey) {
        console.warn('‚ö†Ô∏è No API key for keyword extraction ‚Äì falling back to raw message');
        return userMessage;
    }

    const prompt = `Extract the most important keywords from this user message for a web search.
Return ONLY the keywords separated by spaces, no punctuation, no extra text.
Focus on product names, ingredients, health terms, key concepts.
Remove filler words like "can", "does", "what", "is", "the", "should", "we", "have", etc.

User message: "${userMessage}"
Keywords:`;

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a keyword extraction tool. Respond only with the keywords.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 50
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 10000
            }
        );

        const keywords = response.data.choices[0].message.content.trim();
        console.log(`Ì†ΩÌ¥ë DeepSeek extracted keywords: "${keywords}"`);

        if (!keywords || keywords.split(/\s+/).length === 0 || keywords.length < 3) {
            return userMessage;
        }
        return keywords;
    } catch (err) {
        console.error('‚ùå Keyword extraction failed:', err.message);
        return userMessage;
    }
}

// Retry wrapper for HTTP requests (used for DuckDuckGo)
async function httpGetWithRetry(url, options = {}, maxRetries = 3) {
    let lastError;
    const defaultOptions = { timeout: 8000 };
    const mergedOptions = { ...defaultOptions, ...options };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url, mergedOptions);
            return response;
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`‚ùå All ${maxRetries} retries failed for ${url}:`, lastError?.message);
    throw lastError;
}

// ------------------- DuckDuckGo API (no key required) ------------------
async function searchInternet(query) {
    console.log(`Ì†ºÌºê DuckDuckGo API search: "${query}"`);
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const { data } = await httpGetWithRetry(url);
        let text = data.AbstractText || '';
        if (data.RelatedTopics) {
            const firstTopics = data.RelatedTopics.slice(0, 3)
                .map(t => t.Text || '')
                .join(' ');
            text = (text + ' ' + firstTopics).trim();
        }
        console.log(`Ì†ºÌºê DuckDuckGo returned ${text.length} chars`);
        return text.length > 50 ? text : null;
    } catch (err) {
        console.error('Ì†ºÌºê DuckDuckGo error:', err.message);
        return null;
    }
}

// ------------------- Product detection (original robust logic) ----------
function findAllProductNames(text, productNames) {
    const found = [];
    const lowerText = text.toLowerCase();
    for (const name of productNames) {
        const lowerName = name.toLowerCase();
        if (lowerText.includes(lowerName)) {
            found.push(name);
        } else {
            const shortName = lowerName.replace(' capsule', '').replace(' plus', '').trim();
            if (shortName !== lowerName && lowerText.includes(shortName)) {
                found.push(name);
            }
        }
    }
    return found;
}

function findLastProductName(text, productNames) {
    let lastProduct = null;
    let lastIndex = -1;
    const lowerText = text.toLowerCase();

    console.log(`Ì†ΩÌ¥ç [DEBUG] findLastProductName: searching in "${text}"`);
    console.log(`Ì†ΩÌ¥ç [DEBUG] Available products: ${productNames.join(', ')}`);

    for (const name of productNames) {
        const lowerName = name.toLowerCase();
        let index = lowerText.lastIndexOf(lowerName);

        console.log(`  Ì†ΩÌ¥é Checking "${name}" (lower: "${lowerName}"): index=${index}`);

        if (index === -1) {
            const shortName = lowerName.replace(' capsule', '').replace(' plus', '').trim();
            if (shortName !== lowerName) {
                index = lowerText.lastIndexOf(shortName);
                console.log(`    Ì†ΩÌ¥é Also tried short name "${shortName}": index=${index}`);
            }
        }
        if (index > lastIndex) {
            lastIndex = index;
            lastProduct = name;
        }
    }

    console.log(`Ì†ΩÌ¥ç [DEBUG] Final matched product: "${lastProduct}"`);
    return lastProduct;
}

// Helper: get product description string (works with both new object and old string)
function getProductDescription(kb, productName) {
    const product = kb.products?.[productName];
    if (!product) return '';
    if (typeof product === 'object') return product.description || '';
    return typeof product === 'string' ? product : '';
}

// Helper: get product URL
function getProductUrl(kb, productName) {
    const product = kb.products?.[productName];
    if (typeof product === 'object' && product.url) return product.url;
    return null;
}

// Helper: get product image URL
function getProductImageUrl(kb, productName) {
    const product = kb.products?.[productName];
    if (typeof product === 'object' && Array.isArray(product.images) && product.images.length > 0) {
        return product.images[0];  // Return first image
    }
    return null;
}

// Simple Jaccard-based word similarity for Q&A matching
function jaccardSimilarity(str1, str2) {
    const words1 = new Set(str1.toLowerCase().split(/\W+/).filter(w => w.length > 1));
    const words2 = new Set(str2.toLowerCase().split(/\W+/).filter(w => w.length > 1));
    if (words1.size === 0 || words2.size === 0) return 0;
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    return intersection.size / union.size;
}

// ------------------- LLM-based Intent Detection ---------------------------
async function detectIntentWithLLM(userMessage, apiKey) {
    console.log(`Ì†æÌ¥ñ Asking DeepSeek to detect intent for: "${userMessage}"`);
    if (!apiKey) {
        console.warn('‚ö†Ô∏è No API key for intent detection ‚Äì falling back to regex');
        return null;
    }

    const prompt = `Analyze this user query about health products and determine:
1. The intent category (choose one: shipping, returns, payment, price, dosage, benefits, ingredients, suitability, retail_outlets, general_inquiry)
2. The product name mentioned (if any, otherwise null)

Return ONLY a JSON object with this exact format:
{"intent": "category_name", "product": "Product Name or null"}

Do not include any other text, explanations, or markdown formatting.

User query: "${userMessage}"
Response:`;

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are an intent classification tool. Respond only with valid JSON.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 100
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 10000
            }
        );

        const content = response.data.choices[0].message.content.trim();
        console.log(`Ì†ΩÌ¥ë DeepSeek intent detection: "${content}"`);

        // Parse JSON response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.intent && typeof result.intent === 'string') {
                return {
                    intent: result.intent.toLowerCase(),
                    product: result.product || null
                };
            }
        }
        return null;
    } catch (err) {
        console.error('‚ùå Intent detection failed:', err.message);
        return null;
    }
}

// Regex-based intent detection (fallback)
function detectIntentWithRegex(userMessage) {
    const lowerMsg = userMessage.toLowerCase();

    // General topics
    if (/\b(shipping|delivery|ship)\b/.test(lowerMsg)) {
        return { intent: 'shipping', product: null };
    }
    if (/\b(return|refund|exchange)\b/.test(lowerMsg)) {
        return { intent: 'returns', product: null };
    }
    if (/\b(payment|pay|card|visa|mastercard|bank transfer|paypal)\b/.test(lowerMsg)) {
        return { intent: 'payment', product: null };
    }

    // Product-specific intents - detect product first
    const kb = getKnowledge();
    const productNames = Object.keys(kb.products);
    const matchedProduct = findLastProductName(userMessage, productNames);

    if (matchedProduct) {
        if (/\b(price|cost|how much|money)\b/.test(lowerMsg)) {
            return { intent: 'price', product: matchedProduct };
        }
        if (/\b(dosage|how (much|many)|take|consume|before|after).{0,15}\b(meal|food|eat)\b/i.test(lowerMsg)) {
            return { intent: 'dosage', product: matchedProduct };
        }
        if (/\b(benefits?|good for|does it|help|summary)\b/.test(lowerMsg)) {
            return { intent: 'benefits', product: matchedProduct };
        }
        if (/\b(ingredients?|contains?|made of|formulation)\b/.test(lowerMsg)) {
            return { intent: 'ingredients', product: matchedProduct };
        }
        if (/\b(suitable|who can|who cannot|women|men|children|adult|pregnant|nursing)\b/.test(lowerMsg)) {
            return { intent: 'suitability', product: matchedProduct };
        }
        if (/\b(where to buy|retail|outlets|store|pharmacy|guardian|watsons)\b/.test(lowerMsg)) {
            return { intent: 'retail_outlets', product: matchedProduct };
        }
    }

    return { intent: 'general_inquiry', product: matchedProduct };
}

// ------------------- Direct knowledge lookup ---------------------------
async function quickKnowledgeLookup(userMessage, apiKey = null, userId = null, phoneNumber = null) {
    console.log(`Ì†ΩÌ≥ö === DIRECT LOOKUP ===`);
    const kb = getKnowledge();
    const lowerMsg = userMessage.toLowerCase();
    const productNames = Object.keys(kb.products);

    // Try LLM-based intent detection first
    let intentResult = await detectIntentWithLLM(userMessage, apiKey);

    // Fallback to regex if LLM fails or returns null
    if (!intentResult) {
        intentResult = detectIntentWithRegex(userMessage);
        console.log(`Ì†ΩÌ≥ö Using regex intent detection: ${intentResult.intent}, product: ${intentResult.product}`);
    } else {
        console.log(`Ì†ΩÌ≥ö Using LLM intent detection: ${intentResult.intent}, product: ${intentResult.product}`);
    }

    const { intent, product: llmProduct } = intentResult;

    // Handle general topics (no product needed)
    if (['shipping', 'returns', 'payment'].includes(intent)) {
        console.log(`Ì†ΩÌ≥ö ‚úì General: ${intent}`);
        return kb.general?.[intent] || null;
    }

    // Use LLM-detected product if available, otherwise fall back to regex detection or context
    let matchedProduct = llmProduct || findLastProductName(userMessage, productNames);

    // If still no product found, check context (last mentioned product)
    if (!matchedProduct && intent === 'price') {
        const lastProduct = getLastMentionedProduct();
        if (lastProduct) {
            console.log(`Ì†ΩÌ≥ö [DEBUG] Using context: last mentioned product = "${lastProduct}"`);
            // Convert slug back to product name for lookup
            for (const [productName, productData] of Object.entries(kb.products)) {
                const slug = getPriceApiSlug(productName);
                if (slug === lastProduct) {
                    matchedProduct = productName;
                    console.log(`Ì†ΩÌ≥ö [DEBUG] Resolved context slug "${lastProduct}" to product name "${matchedProduct}"`);
                    break;
                }
            }
        }
    }

    if (!matchedProduct) {
        console.log('Ì†ΩÌ≥ö ‚úó No known product detected');
        return null;
    }

    console.log(`Ì†ΩÌ≥ö Matched product: "${matchedProduct}"`);
    console.log(`Ì†ΩÌ≥ö [DEBUG] Intent detected: ${intent}`);

    // First try direct lookup
    let product = kb.products[matchedProduct];
    console.log(`Ì†ΩÌ≥ö [DEBUG] Product object exists (direct): ${!!product}`);
    console.log(`Ì†ΩÌ≥ö [DEBUG] Looking for: "${matchedProduct}"`);
    console.log(`Ì†ΩÌ≥ö [DEBUG] Available products: ${Object.keys(kb.products).join(', ')}`);

    // If not found, try to find a product that contains the matched name
    if (!product) {
        console.log(`Ì†ΩÌ¥ç [DEBUG] Direct lookup failed, trying partial match for "${matchedProduct}"...`);
        const lowerMatched = matchedProduct.toLowerCase();
        let foundPartial = false;
        for (const [productName, productData] of Object.entries(kb.products)) {
            const lowerProductName = productName.toLowerCase();
            // Check if matched product is contained in the actual product name
            const match1 = lowerProductName.includes(lowerMatched);
            const match2 = lowerMatched.includes(lowerProductName);
            console.log(`   Ì†ΩÌ¥ç Checking "${productName}": includes("${lowerMatched}")=${match1}, "${lowerMatched}".includes="${match2}"`);
            if (match1 || match2) {
                product = productData;
                foundPartial = true;
                break;
            }
        }
        if (!foundPartial) {
        }
    }

    if (!product) {
        return null;
    }

    // --- Direct field answers (new structured fields) ---
    // Price - NOW FETCHES FROM API INSTEAD OF KNOWLEDGE BASE
    if (intent === 'price' || /\b(price|cost|how much|money)\b/.test(lowerMsg)) {

        // Get user's phone number to determine country/currency
        // Priority: 1) Passed phoneNumber parameter, 2) Cache lookup by userId
        let phoneNumberForLookup = phoneNumber || null;


        if (!phoneNumberForLookup && userId) {
            phoneNumberForLookup = getPhoneNumber(userId);

            // Debug: Show cache contents for this user
            const { getContact } = require('../utils/contactCache');
            const contactData = getContact(userId);
        } else if (phoneNumberForLookup) {
        } else {
        }


        // CRITICAL: Ensure apiKey is passed to getProductPrice

        // Check if user specified a currency/country in their message
        let forcedCurrency = null;
        const currencyMatch = lowerMsg.match(/\b(myr|rm|malaysia|singapore|sgd|usd|bnd|hkd|idr|twd)\b/i);
        if (currencyMatch) {
            const currencyText = currencyMatch[0].toLowerCase();
            if (currencyText === 'myr' || currencyText === 'rm' || currencyText === 'malaysia') {
                forcedCurrency = 'MYR';
            } else if (currencyText === 'sgd' || currencyText === 'singapore') {
                forcedCurrency = 'SGD';
            } else if (currencyText === 'usd') {
                forcedCurrency = 'USD';
            } else if (currencyText === 'bnd') {
                forcedCurrency = 'BND';
            } else if (currencyText === 'hkd') {
                forcedCurrency = 'HKD';
            } else if (currencyText === 'idr') {
                forcedCurrency = 'IDR';
            } else if (currencyText === 'twd') {
                forcedCurrency = 'TWD';
            }
        }

        // Fetch price from API (with optional forced currency)
        const priceInfo = await getProductPrice(matchedProduct, phoneNumberForLookup, apiKey, forcedCurrency);

        if (priceInfo) {

            // Check if requested currency was available
            if (forcedCurrency && priceInfo.currency !== forcedCurrency) {
            }
        }

        if (priceInfo && priceInfo.prices && priceInfo.prices.length > 0) {
            const formattedResponse = formatPriceResponse(matchedProduct, priceInfo, forcedCurrency);
            return formattedResponse;
        } else {
            // Do NOT fall back to knowledge base - prices MUST come from API only
            return `I'm sorry, but I don't have access to the current pricing information for ${matchedProduct}. Please visit our website or contact our customer service for the latest prices.`;
        }
    }

    // Dosage / how to take / before/after meal
    if (intent === 'dosage' || /\b(dosage|how (much|many)|take|consume|before|after).{0,15}\b(meal|food|eat)\b/i.test(lowerMsg)) {
        console.log('Ì†ΩÌ≥ö Checking dosage/meal timing...');
        if (typeof product.dosage === 'object') {
            const parts = Object.entries(product.dosage)
                .filter(([key]) => key !== 'general')
                .map(([k, v]) => `${k}: ${v}`);
            if (product.dosage.general) parts.push(product.dosage.general);
            return `For ${matchedProduct}:\n${parts.join('\n')}`;
        }
        // fallback to description
        const desc = getProductDescription(kb, matchedProduct);
        const doseMatch = desc.match(/Dosage[^.]*?:([^.]*\.)/i);
        if (doseMatch) return `For ${matchedProduct}: ${doseMatch[1].trim()}`;
    }

    // Benefits
    if (intent === 'benefits' || /\b(benefits?|good for|does it|help|summary)\b/.test(lowerMsg)) {
        console.log('Ì†ΩÌ≥ö Checking benefits...');
        if (Array.isArray(product.benefits) && product.benefits.length) {
            return `Benefits of ${matchedProduct}: ${product.benefits.join(', ')}.`;
        }
        const desc = getProductDescription(kb, matchedProduct);
        const benMatch = desc.match(/(?:benefits|summary)[^:]*?:([\s\S]*?)(?=\n\n|\n[A-Z]|$)/i);
        if (benMatch) return `${matchedProduct} benefits:\n${benMatch[1].trim()}`;
    }

    // Ingredients
    if (intent === 'ingredients' || /\b(ingredients?|contains?|made of|formulation)\b/.test(lowerMsg)) {
        console.log('Ì†ΩÌ≥ö Checking ingredients...');
        if (Array.isArray(product.ingredients) && product.ingredients.length) {
            return `${matchedProduct} contains: ${product.ingredients.join(', ')}.`;
        }
        const desc = getProductDescription(kb, matchedProduct);
        const ingMatch = desc.match(/Ingredients[^:]*?:([^.]*\.)/i);
        if (ingMatch) return `${matchedProduct} ingredients: ${ingMatch[1].trim()}`;
    }

    // Suitability (who can/cannot consume)
    if (intent === 'suitability' || /\b(suitable|who can|who cannot|women|men|children|adult|pregnant|nursing)\b/.test(lowerMsg)) {
        console.log('Ì†ΩÌ≥ö Checking suitability...');
        let answer = '';
        if (product.who_can_consume) answer += `Suitable for: ${product.who_can_consume}. `;
        if (product.who_cannot_consume) answer += `Not recommended for: ${product.who_cannot_consume}.`;
        if (answer) return answer.trim();
        // fallback description
        const desc = getProductDescription(kb, matchedProduct);
        const suitMatch = desc.match(/Suitable for[^:]*?:([^.]*\.)/i);
        const notRecMatch = desc.match(/Not recommended for[^:]*?:([^.]*\.)/i);
        if (suitMatch || notRecMatch) {
            const t = [];
            if (suitMatch) t.push(suitMatch[1].trim());
            if (notRecMatch) t.push(notRecMatch[1].trim());
            return `${matchedProduct}: ${t.join(' ')}`;
        }
    }

    // Retail outlets
    if (intent === 'retail_outlets' || /\b(where to buy|retail|outlets|store|pharmacy|guardian|watsons)\b/.test(lowerMsg)) {
        console.log('Ì†ΩÌ≥ö Checking retail outlets...');
        if (Array.isArray(product.retail_outlets) && product.retail_outlets.length) {
            return `${matchedProduct} available at: ${product.retail_outlets.join(', ')}.`;
        }
    }

    // Q&A direct match
    if (Array.isArray(product.qa) && product.qa.length) {
        console.log('Ì†ΩÌ≥ö Checking Q&A...');
        for (const pair of product.qa) {
            const similarity = jaccardSimilarity(lowerMsg, pair.question.toLowerCase());
            if (similarity > 0.5) {
                console.log(`Ì†ΩÌ≥ö Q&A match (${similarity.toFixed(2)}): "${pair.question}"`);
                return pair.answer;
            }
        }
    }

    // Fallback to string description matching for any remaining queries
    const desc = getProductDescription(kb, matchedProduct);
    if (desc) {
        if (/\b(price|cost|how much|money)\b/.test(lowerMsg)) {
            const priceMatch = desc.match(/Price[^.]*?:[^.]*?(\d+\.?\d*)/i);
            if (priceMatch) return `The price of ${matchedProduct} is ${priceMatch[1]}.`;
        }
        if (/\b(dosage|how (much|many)|take|consume)\b/.test(lowerMsg)) {
            const doseMatch = desc.match(/Dosage[^.]*?:([^.]*\.)/i);
            if (doseMatch) return `For ${matchedProduct}: ${doseMatch[1].trim()}`;
        }
        if (/\b(benefits?|good for|does it|help|summary)\b/.test(lowerMsg)) {
            const benMatch = desc.match(/Benefits[^:]*?:([^.]*\.)/i);
            if (benMatch) return `Benefits of ${matchedProduct}: ${benMatch[1].trim()}`;
        }
        if (/\b(ingredients?|contains?|made of|formulation)\b/.test(lowerMsg)) {
            const ingMatch = desc.match(/Ingredients[^:]*?:([^.]*\.)/i);
            if (ingMatch) return `${matchedProduct} ingredients: ${ingMatch[1].trim()}`;
        }
        if (/\b(suitable|who can|who cannot|women|men|children|adult|pregnant|nursing)\b/.test(lowerMsg)) {
            const suitMatch = desc.match(/Suitable for[^:]*?:([^.]*\.)/i);
            const notRecMatch = desc.match(/Not recommended for[^:]*?:([^.]*\.)/i);
            if (suitMatch || notRecMatch) {
                const parts = [];
                if (suitMatch) parts.push(suitMatch[1].trim());
                if (notRecMatch) parts.push(notRecMatch[1].trim());
                return `${matchedProduct}: ${parts.join(' ')}`;
            }
        }
    }

    console.log('Ì†ΩÌ≥ö ‚úó No direct pattern matched');
    return null;
}

// ------------------- Build guidelines prompt (supports object with categories) ---------
function buildGuidelinesPrompt(guidelines) {
    if (typeof guidelines === 'string') return guidelines;
    if (typeof guidelines !== 'object') return '';

    let text = '';
    if (guidelines.general) text += `GENERAL GUIDELINES:\n${guidelines.general}\n\n`;
    if (guidelines.product_info) text += `PRODUCT INFO GUIDELINES:\n${guidelines.product_info}\n\n`;
    if (guidelines.shipping) text += `SHIPPING GUIDELINES:\n${guidelines.shipping}\n\n`;
    if (guidelines.order_inquiry) text += `ORDER INQUIRY GUIDELINES:\n${guidelines.order_inquiry}\n\n`;
    if (guidelines.payment) text += `PAYMENT GUIDELINES:\n${guidelines.payment}\n\n`;
    if (guidelines.returns) text += `RETURNS GUIDELINES:\n${guidelines.returns}\n\n`;
    if (guidelines.answer_presentation) text += `ANSWER PRESENTATION GUIDELINES:\n${guidelines.answer_presentation}\n\n`;
    return text;
}

// ------------------- Build knowledge prompt (structured + guidelines) ------------------
function buildKnowledgePrompt(detectedProduct = null) {
    const kb = getKnowledge();
    let prompt = `You are DynaBot, the friendly assistant for Dyna-Nutrition.\n\n`;
    for (const [name, product] of Object.entries(kb.products)) {
        prompt += `## ${name}\n`;
        if (typeof product === 'object') {
            if (product.description) prompt += `${product.description}\n`;
            if (Array.isArray(product.benefits) && product.benefits.length) prompt += `Benefits: ${product.benefits.join(', ')}\n`;
            if (typeof product.dosage === 'object') {
                const dosageParts = Object.entries(product.dosage)
                    .filter(([key]) => key !== 'general')
                    .map(([k, v]) => `${k}: ${v}`);
                if (product.dosage.general) dosageParts.push(product.dosage.general);
                if (dosageParts.length) prompt += `Dosage: ${dosageParts.join('; ')}\n`;
            }
            if (product.who_can_consume) prompt += `Suitable for: ${product.who_can_consume}\n`;
            if (product.who_cannot_consume) prompt += `Not suitable for: ${product.who_cannot_consume}\n`;
        } else {
            prompt += `${product}\n`;
        }

        // Add brochure content if this is the detected product
        // Try multiple matching strategies for product ID
        if (detectedProduct) {
            const lowerDetected = detectedProduct.toLowerCase();
            const lowerName = name.toLowerCase();

            // Strategy 1: Direct match (name == detectedProduct)
            // Strategy 2: Strip common suffixes/prefixes
            const nameWithoutSuffix = lowerName.replace(/[-_\s]*(capsule|plus|capsules?)$/i, '');
            const detectedWithoutSuffix = lowerDetected.replace(/[-_\s]*(capsule|plus|capsules?)$/i, '');

            // Strategy 3: Extract key word (e.g., "riflex" from "riflex360-capsule")
            const keyWordMatch = nameWithoutSuffix.match(/^([a-z]+)/i);
            const keyWord = keyWordMatch ? keyWordMatch[1] : nameWithoutSuffix;

            // Check if any strategy matches
            const matches = lowerName === lowerDetected ||
                           nameWithoutSuffix === detectedWithoutSuffix ||
                           keyWord === detectedWithoutSuffix ||
                           keyWord === lowerDetected;

            if (matches) {
                const brochureInfo = getSupplementaryInfo(nameWithoutSuffix);
                if (!brochureInfo) {
                    // Try with original name
                    const brochureInfo2 = getSupplementaryInfo(name.toLowerCase());
                    if (brochureInfo2) {
                        prompt += brochureInfo2;
                    }
                } else {
                    prompt += brochureInfo;
                }
            }
        }

        prompt += '\n';
    }

    // Insert general store information for dynamic placeholders
    const shipping = kb.general?.shipping || 'Not available';
    const payment = kb.general?.payment || 'Not available';
    const returns = kb.general?.returns || 'Not available';

    // Build guidelines and replace placeholders
    const guidelinesRaw = buildGuidelinesPrompt(kb.guidelines)
        .replace(/\{shipping\}/g, shipping)
        .replace(/\{payment\}/g, payment)
        .replace(/\{returns\}/g, returns);

    // Add store locator guidelines
    const storeLocatorGuidelines = `STORE LOCATOR GUIDELINES:
When users ask about where to buy products or store locations:
1. ALWAYS ask for their location/area first if they don't provide one
2. Accept locations in various formats: "near X", "in X", "I'm in X", "near X airport"
3. Support common Malaysia/Singapore areas: KL, PJ, Subang Jaya, Shah Alam, Penang, Johor, Singapore, etc.
4. Once location is provided, the system will find nearest stores with addresses and phone numbers
5. Always confirm with user to ask if they want to find stores for a specific product

Example responses for location requests:
- "To find the nearest store, please share your location. Example: 'near Subang Jaya' or 'I'm in Shah Alam'"
- "I can help you find nearby stores! Please tell me your area."`;

    prompt += `\n${guidelinesRaw}\n${storeLocatorGuidelines}`;
    return prompt;
}

async function callDeepSeek(messages, apiKey) {
    console.log(`Ì†æÌ¥ñ Calling DeepSeek API with ${messages.length} messages...`);
    if (!apiKey) {
        console.error('‚ùå No API key provided');
        return null;
    }
    try {
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: "deepseek-chat",
            messages,
            temperature: 0.2,
            max_tokens: 500
        }, { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 20000 });
        const content = response.data.choices[0].message.content;
        console.log(`Ì†æÌ¥ñ DeepSeek response (${content.length} chars): "${content.substring(0, 150)}..."`);
        return content;
    } catch (err) {
        console.error('‚ùå DeepSeek API error:', err.message);
        return null;
    }
}

// Retry wrapper with exponential backoff for DeepSeek API calls
async function callDeepSeekWithRetry(messages, apiKey, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await callDeepSeek(messages, apiKey);
            return result;
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`‚ùå All ${maxRetries} retries failed:`, lastError?.message);
    return null;
}

// ------------------- Main response generator ---------------------------
// Returns: { text: string, imageUrl: string|null, productName: string|null }
async function generateResponse(userMessage, _, apiKey, history = [], userId = null, phoneNumber = null) {
    console.log(`Ì†ΩÌ≤¨ NEW QUERY: "${userMessage}"`);
    console.log(`Ì†ΩÌ≥ú History length: ${history.length} messages`);
    console.log(`Ì†ΩÌ≥û Phone number passed to generateResponse: ${phoneNumber || 'NOT PROVIDED'}`);

    const kb = getKnowledge();
    const productNames = Object.keys(kb.products);

    // ==================== LLM INTENT ANALYSIS (State Machine) ====================
    // Use LLM-driven intent manager for natural conversation flow
    let intentResult = null;
    let actionResponse = null;

    if (userId) {
        console.log(`Ì†æÌ∑† [INTENT MANAGER] Processing with state machine...`);

        // Convert history to format expected by intent manager
        const conversationHistory = history.map(msg => ({
            sender: msg.fromMe ? 'bot' : 'user',
            text: msg.body || msg.text || ''
        }));

        // Process intent with state machine
        intentResult = await processIntent(userMessage, userId, apiKey, productNames, conversationHistory);

        console.log(`Ì†ºÌæØ [INTENT MANAGER] Result: intent=${intentResult.intent}, action=${intentResult.action}, state=${intentResult.state}`);

        // Generate action response if needed
        if (intentResult.action && intentResult.action !== 'execute') {
            actionResponse = generateActionResponse(intentResult.action, intentResult.intent, intentResult.context);

            if (actionResponse && !actionResponse.shouldContinue) {
                console.log(`Ì†ΩÌ≤¨ [INTENT MANAGER] Returning action response: ${actionResponse.text.substring(0, 100)}...`);
                return {
                    text: actionResponse.text,
                    imageUrl: null,
                    productName: intentResult.context?.product || null
                };
            }
        }

        // Update local variables based on intent context
        if (intentResult.context?.product && !intentResult.detectedProduct) {
            intentResult.detectedProduct = intentResult.context.product;
        }
    } else {
    }
    // ==================== END INTENT MANAGER ====================

    // Use intent result if available, otherwise fall back to legacy price query detection
    const isPriceQuery = intentResult?.intent === 'price_check' ||
                         /\b(price|cost|how much|money)\b/i.test(userMessage) ||
                         /\b(myr|rm|malaysia|singapore|sgd|usd|bnd|hkd|idr|twd)\b/i.test(userMessage) ||
                         /\b(in|at|for)\s+(malaysia|singapore|usa|brunei|hongkong|indonesia|taiwan)\b/i.test(userMessage);

    // Use detected product from intent manager if available
    let intentDetectedProduct = intentResult?.detectedProduct || null;

    if (isPriceQuery) {

        // Use product from intent manager if available, otherwise use legacy detection
        let detectedProduct = intentDetectedProduct;
        if (!detectedProduct) {
            const productsInMsg = findAllProductNames(userMessage, productNames);
            if (productsInMsg.length > 0) {
                detectedProduct = findLastProductName(userMessage, productNames);

                // Update context: new product replaces old product
                const slug = getProductSlug(detectedProduct);
                trackMentionedProduct(slug);
            }
        }

        // Step 2: If no new product, use last mentioned product
        let productToUse = detectedProduct;
        if (!productToUse) {
            const lastProduct = getLastMentionedProduct();
            if (lastProduct) {
                productToUse = lastProduct;

            }
        }

        // Step 3: If still no product, ask user to specify
        if (!productToUse) {

            return {
                text: "Could you please specify which product you'd like to know the price for? Ì†ΩÌ∏ä\n\nFor example: *BioNatto Plus*, *GlucoPal*, *AshiSlim Plus*, etc.",
                imageUrl: null,
                productName: null
            };
        }

        // Step 4: Extract forced currency from message
        let forcedCurrency = null;
        const currencyMatch = userMessage.match(/\b(MYR|RM|SGD|USD|BND|HKD|IDR|TWD)\b/i);
        const countryMatch = userMessage.match(/\b(malaysia|singapore|usa|brunei|hongkong|indonesia|taiwan)\b/i);

        if (currencyMatch) {
            forcedCurrency = currencyMatch[0].toUpperCase();
            if (forcedCurrency === 'RM') forcedCurrency = 'MYR';
        } else if (countryMatch) {
            const countryMap = {
                'malaysia': 'MYR',
                'singapore': 'SGD',
                'usa': 'USD',
                'brunei': 'BND',
                'hongkong': 'HKD',
                'indonesia': 'IDR',
                'taiwan': 'TWD'
            };
            forcedCurrency = countryMap[countryMatch[0].toLowerCase()];
        }



        // Step 5: Call price API with resolved product and currency
        try {
            const priceInfo = await getProductPrice(productToUse, phoneNumber, apiKey, forcedCurrency);

            if (priceInfo && priceInfo.currency && priceInfo.prices && priceInfo.prices.length > 0) {
                const formattedResponse = formatPriceResponse(productToUse, priceInfo, forcedCurrency);


                // Ensure product is tracked for image
                if (!detectedProduct) {
                    trackMentionedProduct(productToUse);
                }

                return {
                    text: formattedResponse,
                    imageUrl: productToUse,
                    productName: typeof productToUse === 'string' ? findLastProductName(productToUse, productNames) || productToUse : productToUse
                };
            } else {

            }
        } catch (err) {
            console.error(`‚ö†Ô∏è [PRICE] Error: ${err.message}`);
        }

        // If we reach here, API call failed - continue to normal processing
    } else {
        // ==================== STORE LOCATOR CHECK ====================
        // Check if this is a store/location query using LLM for better context detection
        console.log(`Ì†ΩÌ≥ç [STORE LOCATOR] Checking if this is a store query...`);
        const llmCheck = await isStoreQueryWithLLM(userMessage, apiKey);

        if (llmCheck.isStoreQuery) {
            console.log(`Ì†ΩÌ≥ç [STORE LOCATOR] Store query detected (${llmCheck.reasoning})`);

            try {
                // Use LLM-based store finder (handles location detection + store lookup + response generation)
                const storeResult = await findStores(userMessage, apiKey);

                // If needs location, ask for it
                if (storeResult.needsLocation) {
                    console.log(`Ì†ΩÌ≥ç [STORE LOCATOR] No location provided - asking user`);
                    return {
                        text: storeResult.text,
                        imageUrl: null,
                        productName: null
                    };
                }

                // If error (e.g., no product identified), continue to AI
                if (storeResult.error) {
                    console.log(`Ì†ΩÌ≥ç [STORE LOCATOR] Error: ${storeResult.text}`);
                    // Clear pending since we're giving up on store lookup
                    clearPendingProduct();
                    // Continue to AI for help
                }
                // If noContext (no product context), still return message without falling through
                else if (storeResult.noContext) {
                    console.log(`Ì†ΩÌ≥ç [STORE LOCATOR] No product context - returning message`);
                    return {
                        text: storeResult.text,
                        imageUrl: null,
                        productName: null
                    };
                }
                // If success, return store info
                else if (storeResult.success) {
                    // If no stores in that area, still return the message - don't fall through to TIER 1.5
                    if (storeResult.noStoresInArea) {
                        console.log(`Ì†ΩÌ≥ç [STORE LOCATOR] No stores in area - returning message`);
                        return {
                            text: storeResult.text,
                            imageUrl: null,
                            productName: null
                        };
                    }
                    console.log(`Ì†ΩÌ≥ç [STORE LOCATOR] Returning store info`);
                    // DON'T clear pending - user might want to change location ("How about in Subang Jaya?")
                    // The store locator marks justCompletedSearch to keep pending for follow-ups
                    return {
                        text: storeResult.text,
                        imageUrl: null,
                        productName: storeResult.productSlug || null
                    };
                }
            } catch (err) {
                console.error(`Ì†ΩÌ≥ç [STORE LOCATOR] Error: ${err.message}`);
                clearPendingProduct();
                // On error, continue to normal processing
            }
        } else {
            console.log(`Ì†ΩÌ≥ç [STORE LOCATOR] Not a store query (${llmCheck.reasoning})`);
            // User asked something unrelated - clear any pending product
            clearPendingProduct();
        }
    }
    // ==================== END STORE LOCATOR CHECK ====================

    // 1. Direct knowledge lookup (TIER 1)
    const directAnswer = await quickKnowledgeLookup(userMessage, apiKey, userId, phoneNumber);
    if (directAnswer) {
        // Try to detect product for image
        const productsInMsg = findAllProductNames(userMessage, productNames);
        const detectedProduct = productsInMsg.length > 0 ? findLastProductName(userMessage, productNames) : null;

        // Track mentioned product for store locator context
        if (detectedProduct) {
            const slug = getProductSlug(detectedProduct);
            trackMentionedProduct(slug);
        }

        const imageUrl = detectedProduct ? getProductImageUrl(kb, detectedProduct) : null;
        return { text: directAnswer, imageUrl, productName: detectedProduct };
    console.log(`Ì†æÌ¥ñ [TIER 1.5] Calling DeepSeek with knowledge base...`);

    let detectedProductForBrochure = null;
    const productsInMsg = findAllProductNames(userMessage, productNames);
    if (productsInMsg.length > 0) {
        detectedProductForBrochure = findLastProductName(userMessage, productNames);
    }

    const kbPrompt = buildKnowledgePrompt(detectedProductForBrochure);
    const messages = [
        { role: "system", content: kbPrompt },
        ...history.slice(-6),  // Use consistent 6 messages for AI tier
        { role: "user", content: userMessage }
    ];
    console.log(`   Ì†ΩÌ≥§ Sending ${messages.length} messages to DeepSeek`);
    let reply = await callDeepSeekWithRetry(messages, apiKey);

    // Check if AI is uncertain
    const unknownPhrases = ["don't have that information", "not in the knowledge base", "i don't know", "can't answer", "cannot answer", "not sure", "unclear"];
    const isUncertain = !reply || unknownPhrases.some(k => reply.toLowerCase().includes(k));

    if (isUncertain) {
        if (reply) {
        }
        console.log(`Ì†ΩÌ¥Å Starting fallback cascade...\n`);

        // ---- HISTORY-BASED PRODUCT DETECTION ----
        console.log(`Ì†ΩÌ¥ç [ANALYSIS] Detecting product from message and history...`);
        let detectedProduct = null;
        const productsInCurrent = findAllProductNames(userMessage, productNames);
        if (productsInCurrent.length > 0) {
            detectedProduct = findLastProductName(userMessage, productNames);
            console.log(`   Ì†ΩÌ≥¶ All products detected: [${productsInCurrent.join(', ')}]`);
        } else {
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].role === 'user') {
                    const historyProducts = findAllProductNames(history[i].content, productNames);
                    if (historyProducts.length > 0) {
                        detectedProduct = findLastProductName(history[i].content, productNames);
                        console.log(`   Ì†ΩÌ≥ú History message: "${history[i].content.substring(0, 50)}..."`);
                        break;
                    }
                }
            }
            if (!detectedProduct) {
            }
        }

        const imageUrl = detectedProduct ? getProductImageUrl(kb, detectedProduct) : null;

        // ---- TIER 2: Product page + internal links search ----
        if (detectedProduct) {
            // Track for store locator context
            trackMentionedProduct(getProductSlug(detectedProduct));

            const productUrl = getProductUrl(kb, detectedProduct);
            if (productUrl) {
                console.log(`\nÌ†ΩÌ≥Ñ [TIER 2] Fetching product page: ${productUrl}`);
                const productPageContent = await fetchProductPageAndLinks(productUrl, 3);
                if (productPageContent) {
                    const tier15Prompt = `You are DynaBot. Answer the user based ONLY on the product page content below. Start with YES/NO and one sentence. If answer not found, say exactly "I cannot find the answer on the product page."\nUSER: ${userMessage}\nPRODUCT PAGE CONTENT: ${productPageContent.substring(0, 2500)}`;
                    const tier15Messages = [
                        { role: "system", content: tier15Prompt },
                        ...history.slice(-6),  // Consistent 6 messages
                        { role: "user", content: userMessage }
                    ];
                    console.log(`   Ì†ΩÌ≥§ Sending ${tier15Messages.length} messages to DeepSeek (product page context)`);
                    const tier15Reply = await callDeepSeekWithRetry(tier15Messages, apiKey);

                    if (tier15Reply) {
                        const containsCannotFind = tier15Reply.toLowerCase().includes("cannot find the answer on the product page");
                        if (!containsCannotFind) {
                            return { text: tier15Reply, imageUrl, productName: detectedProduct };
                        } else {
                        }
                    } else {
                    }
                } else {
                }
            } else {
            }
        } else {
        }

        // Build search query: DeepSeek keywords + optional product prefix
        console.log(`\nÌ†ΩÌ¥ë [ANALYSIS] Extracting search keywords...`);
        const deepseekKeywords = await extractKeywordsWithDeepSeek(userMessage, apiKey);
        let searchQuery = deepseekKeywords;

        if (detectedProduct) {
            if (!deepseekKeywords.toLowerCase().includes(detectedProduct.toLowerCase())) {
                searchQuery = detectedProduct + ' ' + deepseekKeywords;
                console.log(`   Ì†ΩÌ¥ç Product "${detectedProduct}" added to keywords`);
            } else {
                console.log(`   Ì†ΩÌ¥ç Product already in keywords`);
            }
        }
        console.log(`   Ì†ΩÌ≥ù Final search query: "${searchQuery}"`);

        // Tier 3: Website search
        console.log(`\nÌ†ΩÌ¥é [TIER 3] Searching website: dyna-nutrition.com`);
        const siteResults = await searchWebsite(searchQuery);
        if (siteResults && siteResults.length > 100) {
            const tier2Prompt = `You are DynaBot. Answer the user based ONLY on the search results below. Start with YES/NO and one sentence. If answer not found, say exactly "I cannot find the answer in the search results."\nUSER: ${userMessage}\nRESULTS: ${siteResults.substring(0, 2000)}`;
            const tier2Messages = [
                { role: "system", content: tier2Prompt },
                ...history.slice(-6),  // Consistent 6 messages
                { role: "user", content: userMessage }
            ];
            console.log(`   Ì†ΩÌ≥§ Sending ${tier2Messages.length} messages to DeepSeek (website search context)`);
            const tier2Reply = await callDeepSeekWithRetry(tier2Messages, apiKey);

            if (tier2Reply) {
                const containsCannotFind = tier2Reply.toLowerCase().includes("cannot find the answer");
                if (!containsCannotFind) {
                    return { text: tier2Reply, imageUrl, productName: detectedProduct };
                } else {
                }
            } else {
            }
        } else {
        }

        // Tier 4: Internet search (DuckDuckGo)
        console.log(`\nÌ†ºÌºê [TIER 4] Searching internet via DuckDuckGo...`);
        const internetResults = await searchInternet(searchQuery);
        if (internetResults) {
            const tier3Prompt = `You are DynaBot. Answer the user based on these internet search results. Start with YES/NO and one sentence. If not available, say exactly "I cannot find reliable information online."\nUSER: ${userMessage}\nRESULTS: ${internetResults}`;
            const tier3Messages = [
                { role: "system", content: tier3Prompt },
                ...history.slice(-6),  // Consistent 6 messages
                { role: "user", content: userMessage }
            ];
            console.log(`   Ì†ΩÌ≥§ Sending ${tier3Messages.length} messages to DeepSeek (internet context)`);
            const tier3Reply = await callDeepSeekWithRetry(tier3Messages, apiKey);

            if (tier3Reply) {
                const containsCannotFind = tier3Reply.toLowerCase().includes("cannot find reliable");
                if (!containsCannotFind) {
                    return { text: tier3Reply, imageUrl, productName: detectedProduct };
                } else {
                }
            } else {
            }
        } else {
        }

        return { text: "I'm sorry, I couldn't find an answer. A human representative will be happy to help you.", imageUrl: null, productName: null };
    }

    // Detect product for image from AI response
    const allProductsInMsg = findAllProductNames(userMessage, productNames);
    const imageProduct = allProductsInMsg.length > 0 ? findLastProductName(userMessage, productNames) : null;
    const imageUrl = imageProduct ? getProductImageUrl(kb, imageProduct) : null;

    // Track product for store locator context (if found in message)
    if (imageProduct) {
        const slug = getProductSlug(imageProduct);
        trackMentionedProduct(slug);
    }

    return { text: reply || "I'm having trouble responding right now.", imageUrl, productName: imageProduct };
}

module.exports = { generateResponse, quickKnowledgeLookup, detectIntentWithLLM, detectIntentWithRegex };