// services/deepseek.js
// Updated to use conversationManager.js for unified intent+state+flow

const axios = require('axios');
const { getKnowledge } = require('./knowledgeLoader');
const { getSupplementaryInfo } = require('../utils/brochures');
const { searchWebsite, fetchProductPageAndLinks } = require('../config/botConfig');
const { getProductPrice, formatPriceResponse, getProductSlug: getPriceApiSlug } = require('./priceApi');
const { getPhoneNumber } = require('../utils/contactCache');
const { processMessage, clearContext } = require('./conversationManager');

// Product slug normalization helper
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
    return productName.toLowerCase()
        .replace(/\s*(plus|capsule|capsules|tablet|softgel)\s*/gi, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');
}

// Helper: get product image URL
function getProductImageUrl(kb, productName) {
    const product = kb.products?.[productName];
    if (typeof product === 'object' && Array.isArray(product.images) && product.images.length > 0) {
        return product.images[0];
    }
    return null;
}

// Helper: get product URL
function getProductUrl(kb, productName) {
    const product = kb.products?.[productName];
    if (typeof product === 'object' && product.url) return product.url;
    return null;
}

// ==================== DeepSeek API Calls ====================

async function callDeepSeek(messages, apiKey) {
    console.log(`Ì†ΩÌ¥µ Calling DeepSeek API with ${messages.length} messages...`);
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
        console.log(`Ì†ΩÌ¥µ DeepSeek response (${content.length} chars): "${content.substring(0, 150)}..."`);
        return content;
    } catch (err) {
        console.error('‚ùå DeepSeek API error:', err.message);
        return null;
    }
}

async function callDeepSeekWithRetry(messages, apiKey, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await callDeepSeek(messages, apiKey);
            return result;
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = 1000 * Math.pow(2, attempt - 1);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`‚ùå All ${maxRetries} retries failed:`, lastError?.message);
    return null;
}

// ==================== Keyword Extraction ====================

async function extractKeywordsWithDeepSeek(userMessage, apiKey) {
    console.log(`Ì†ΩÌ¥ç Asking DeepSeek to extract keywords from: "${userMessage}"`);
    if (!apiKey) return userMessage;

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
        if (!keywords || keywords.split(/\s+/).length === 0 || keywords.length < 3) {
            return userMessage;
        }
        return keywords;
    } catch (err) {
        console.error('‚ùå Keyword extraction failed:', err.message);
        return userMessage;
    }
}

// ==================== DuckDuckGo Search ====================

async function searchInternet(query) {
    console.log(`Ì†ºÌºê DuckDuckGo API search: "${query}"`);
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const { data } = await axios.get(url, { timeout: 8000 });
        let text = data.AbstractText || '';
        if (data.RelatedTopics) {
            const firstTopics = data.RelatedTopics.slice(0, 3).map(t => t.Text || '').join(' ');
            text = (text + ' ' + firstTopics).trim();
        }
        console.log(`Ì†ºÌºê DuckDuckGo returned ${text.length} chars`);
        return text.length > 50 ? text : null;
    } catch (err) {
        console.error(`Ì†ºÌºê DuckDuckGo error: ${err.message}`);
        return null;
    }
}

// ==================== Build Prompts ====================

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

        // Add brochure content for detected product
        if (detectedProduct) {
            const lowerDetected = detectedProduct.toLowerCase();
            const lowerName = name.toLowerCase();
            const nameWithoutSuffix = lowerName.replace(/[-_\s]*(capsule|plus|capsules?)$/i, '');

            if (lowerName === lowerDetected || nameWithoutSuffix === lowerDetected) {
                const brochureInfo = getSupplementaryInfo(nameWithoutSuffix);
                if (brochureInfo) prompt += brochureInfo;
            }
        }

        prompt += '\n';
    }

    const guidelinesRaw = kb.guidelines?.general || '';
    const storeLocatorGuidelines = `STORE LOCATOR GUIDELINES:
When users ask about where to buy products or store locations:
1. ALWAYS ask for their location/area first if they don't provide one
2. Accept locations in various formats: "near X", "in X", "I'm in X"
3. Support common Malaysia/Singapore areas: KL, PJ, Subang Jaya, Shah Alam, Penang, Johor, Singapore, etc.
4. Once location is provided, the system will find nearest stores`;

    prompt += `\n${guidelinesRaw}\n${storeLocatorGuidelines}`;
    return prompt;
}

// ==================== Product Detection ====================

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

    for (const name of productNames) {
        const lowerName = name.toLowerCase();
        let index = lowerText.lastIndexOf(lowerName);

        if (index === -1) {
            const shortName = lowerName.replace(' capsule', '').replace(' plus', '').trim();
            if (shortName !== lowerName) {
                index = lowerText.lastIndexOf(shortName);
            }
        }
        if (index > lastIndex) {
            lastIndex = index;
            lastProduct = name;
        }
    }

    return lastProduct;
}

// ==================== Main Response Generator ====================

async function generateResponse(userMessage, _, apiKey, history = [], userId = null, phoneNumber = null) {
    console.log(`Ì†ΩÌ≤¨ NEW QUERY: "${userMessage}"`);
    console.log(`Ì†ΩÌ≤¨ History length: ${history.length} messages`);
    console.log(`Ì†ΩÌ≤¨ Phone number: ${phoneNumber || 'NOT PROVIDED'}`);

    const kb = getKnowledge();
    const productNames = Object.keys(kb.products);

    // ==================== USE NEW CONVERSATION MANAGER ====================
    if (userId && apiKey) {
        try {
            console.log(`Ì†ΩÌ≤¨ [NEW FLOW] Using conversationManager for unified intent+state+flow`);

            const result = await processMessage(userMessage, history, userId, apiKey, phoneNumber);

            // If the manager handled it completely, return
            if (result.text && result.text.trim().length > 0) {
                // Try to get product image
                const imageProduct = result.product || findLastProductName(userMessage, productNames);
                const imageUrl = imageProduct ? getProductImageUrl(kb, imageProduct) : null;

                // If needs escalation, handle it
                if (result.needsEscalation) {
                    console.log(`Ì†ΩÌ≤¨ [ESCALATION] User requested human agent`);
                    return {
                        text: result.text,
                        imageUrl: null,
                        productName: null
                    };
                }

                return {
                    text: result.text,
                    imageUrl: imageUrl,
                    productName: result.product
                };
            }
        } catch (err) {
            console.error(`Ì†ΩÌ≤¨ [NEW FLOW] Failed, falling back to legacy: ${err.message}`);
        }
    }
    // ==================== END NEW FLOW ====================

    // ==================== LEGACY FALLBACK ====================
    console.log(`Ì†ΩÌ≤¨ [LEGACY] Using traditional multi-tier response`);

    // Quick knowledge lookup (TIER 1)
    const directAnswer = await quickKnowledgeLookup(userMessage, apiKey, userId, phoneNumber);
    if (directAnswer) {
        const productsInMsg = findAllProductNames(userMessage, productNames);
        const detectedProduct = productsInMsg.length > 0 ? findLastProductName(userMessage, productNames) : null;
        const imageUrl = detectedProduct ? getProductImageUrl(kb, detectedProduct) : null;
        return { text: directAnswer, imageUrl, productName: detectedProduct };
    }

    // TIER 1.5: DeepSeek with knowledge base
    console.log(`Ì†ΩÌ≤¨ [TIER 1.5] Calling DeepSeek with knowledge base...`);

    let detectedProductForBrochure = null;
    const productsInMsg = findAllProductNames(userMessage, productNames);
    if (productsInMsg.length > 0) {
        detectedProductForBrochure = findLastProductName(userMessage, productNames);
    }

    const kbPrompt = buildKnowledgePrompt(detectedProductForBrochure);
    const messages = [
        { role: "system", content: kbPrompt },
        ...history.slice(-6),
        { role: "user", content: userMessage }
    ];
    let reply = await callDeepSeekWithRetry(messages, apiKey);

    // Check if AI is uncertain
    const unknownPhrases = ["don't have that information", "not in the knowledge base", "i don't know", "can't answer", "cannot answer", "not sure", "unclear"];
    const isUncertain = !reply || unknownPhrases.some(k => reply.toLowerCase().includes(k));

    if (isUncertain) {
        console.log(`Ì†ΩÌ≤¨ Starting fallback cascade...\n`);

        // Detect product from message and history
        let detectedProduct = null;
        const productsInCurrent = findAllProductNames(userMessage, productNames);
        if (productsInCurrent.length > 0) {
            detectedProduct = findLastProductName(userMessage, productNames);
        } else {
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].role === 'user') {
                    const historyProducts = findAllProductNames(history[i].content, productNames);
                    if (historyProducts.length > 0) {
                        detectedProduct = findLastProductName(history[i].content, productNames);
                        break;
                    }
                }
            }
        }

        const imageUrl = detectedProduct ? getProductImageUrl(kb, detectedProduct) : null;

        // TIER 2: Product page + internal links search
        if (detectedProduct) {
            const productUrl = getProductUrl(kb, detectedProduct);
            if (productUrl) {
                console.log(`\nÌ†ΩÌ≤¨ [TIER 2] Fetching product page: ${productUrl}`);
                const productPageContent = await fetchProductPageAndLinks(productUrl, 3);
                if (productPageContent) {
                    const tier15Prompt = `You are DynaBot. Answer the user based ONLY on the product page content below. Start with YES/NO and one sentence. If answer not found, say exactly "I cannot find the answer on the product page."\nUSER: ${userMessage}\nPRODUCT PAGE CONTENT: ${productPageContent.substring(0, 2500)}`;
                    const tier15Messages = [
                        { role: "system", content: tier15Prompt },
                        ...history.slice(-6),
                        { role: "user", content: userMessage }
                    ];
                    const tier15Reply = await callDeepSeekWithRetry(tier15Messages, apiKey);

                    if (tier15Reply && !tier15Reply.toLowerCase().includes("cannot find the answer on the product page")) {
                        return { text: tier15Reply, imageUrl, productName: detectedProduct };
                    }
                }
            }
        }

        // Build search query
        console.log(`\nÌ†ΩÌ≤¨ [ANALYSIS] Extracting search keywords...`);
        const deepseekKeywords = await extractKeywordsWithDeepSeek(userMessage, apiKey);
        let searchQuery = deepseekKeywords;

        if (detectedProduct) {
            if (!deepseekKeywords.toLowerCase().includes(detectedProduct.toLowerCase())) {
                searchQuery = detectedProduct + ' ' + deepseekKeywords;
            }
        }

        // TIER 3: Website search
        console.log(`\nÌ†ΩÌ≤¨ [TIER 3] Searching website: dyna-nutrition.com`);
        const siteResults = await searchWebsite(searchQuery);
        if (siteResults && siteResults.length > 100) {
            const tier2Prompt = `You are DynaBot. Answer the user based ONLY on the search results below. Start with YES/NO and one sentence. If answer not found, say exactly "I cannot find the answer in the search results."\nUSER: ${userMessage}\nRESULTS: ${siteResults.substring(0, 2000)}`;
            const tier2Messages = [
                { role: "system", content: tier2Prompt },
                ...history.slice(-6),
                { role: "user", content: userMessage }
            ];
            const tier2Reply = await callDeepSeekWithRetry(tier2Messages, apiKey);

            if (tier2Reply && !tier2Reply.toLowerCase().includes("cannot find the answer")) {
                return { text: tier2Reply, imageUrl, productName: detectedProduct };
            }
        }

        // TIER 4: Internet search
        console.log(`\nÌ†ΩÌ≤¨ [TIER 4] Searching internet via DuckDuckGo...`);
        const internetResults = await searchInternet(searchQuery);
        if (internetResults) {
            const tier3Prompt = `You are DynaBot. Answer the user based on these internet search results. Start with YES/NO and one sentence. If not available, say exactly "I cannot find reliable information online."\nUSER: ${userMessage}\nRESULTS: ${internetResults}`;
            const tier3Messages = [
                { role: "system", content: tier3Prompt },
                ...history.slice(-6),
                { role: "user", content: userMessage }
            ];
            const tier3Reply = await callDeepSeekWithRetry(tier3Messages, apiKey);

            if (tier3Reply && !tier3Reply.toLowerCase().includes("cannot find reliable")) {
                return { text: tier3Reply, imageUrl, productName: detectedProduct };
            }
        }

        return { text: "I'm sorry, I couldn't find an answer. A human representative will be happy to help you.", imageUrl: null, productName: null };
    }

    // Detect product for image
    const allProductsInMsg = findAllProductNames(userMessage, productNames);
    const imageProduct = allProductsInMsg.length > 0 ? findLastProductName(userMessage, productNames) : null;
    const imageUrl = imageProduct ? getProductImageUrl(kb, imageProduct) : null;

    return { text: reply || "I'm having trouble responding right now.", imageUrl, productName: imageProduct };
}

// ==================== Legacy Quick Knowledge Lookup ====================

async function quickKnowledgeLookup(userMessage, apiKey = null, userId = null, phoneNumber = null) {
    const kb = getKnowledge();
    const lowerMsg = userMessage.toLowerCase();
    const productNames = Object.keys(kb.products);

    // Try LLM-based intent detection
    const intentResult = await detectIntentWithLLM(userMessage, apiKey);
    if (!intentResult) {
        intentResult = detectIntentWithRegex(userMessage, productNames);
    }

    const { intent, product: llmProduct } = intentResult;

    // Handle general topics
    if (['shipping', 'returns', 'payment'].includes(intent)) {
        return kb.general?.[intent] || null;
    }

    // Use LLM-detected product if available
    let matchedProduct = llmProduct || findLastProductName(userMessage, productNames);

    if (!matchedProduct) {
        return null;
    }

    const product = kb.products[matchedProduct];
    if (!product) return null;

    // Price check - NOW FETCHES FROM API
    if (intent === 'price' || /\b(price|cost|how much|money)\b/.test(lowerMsg)) {
        const priceInfo = await getProductPrice(matchedProduct, phoneNumber, apiKey);
        if (priceInfo && priceInfo.prices?.length > 0) {
            return formatPriceResponse(matchedProduct, priceInfo);
        }
        return `I'm sorry, I don't have access to the current pricing information for ${matchedProduct}.`;
    }

    // Direct field answers
    if (intent === 'benefits' || /\b(benefits?|good for|does it|help|summary)\b/.test(lowerMsg)) {
        if (Array.isArray(product.benefits) && product.benefits.length) {
            return `Benefits of ${matchedProduct}: ${product.benefits.join(', ')}.`;
        }
    }

    if (intent === 'ingredients' || /\b(ingredients?|contains?|made of|formulation)\b/.test(lowerMsg)) {
        if (Array.isArray(product.ingredients) && product.ingredients.length) {
            return `${matchedProduct} contains: ${product.ingredients.join(', ')}.`;
        }
    }

    if (intent === 'dosage' || /\b(dosage|how (much|many)|take|consume|before|after).{0,15}\b(meal|food|eat)\b/i.test(lowerMsg)) {
        if (typeof product.dosage === 'object') {
            const parts = Object.entries(product.dosage)
                .filter(([key]) => key !== 'general')
                .map(([k, v]) => `${k}: ${v}`);
            if (product.dosage.general) parts.push(product.dosage.general);
            if (parts.length) return `For ${matchedProduct}:\n${parts.join('\n')}`;
        }
    }

    if (intent === 'suitability' || /\b(suitable|who can|who cannot|women|men|children|adult|pregnant|nursing)\b/.test(lowerMsg)) {
        let answer = '';
        if (product.who_can_consume) answer += `Suitable for: ${product.who_can_consume}. `;
        if (product.who_cannot_consume) answer += `Not recommended for: ${product.who_cannot_consume}.`;
        if (answer) return answer.trim();
    }

    return null;
}

// ==================== Intent Detection ====================

async function detectIntentWithLLM(userMessage, apiKey) {
    if (!apiKey) return null;

    const prompt = `Analyze this user query about health products and determine:
1. The intent category (choose one: shipping, returns, payment, price, dosage, benefits, ingredients, suitability, retail_outlets, general_inquiry)
2. The product name mentioned (if any, otherwise null)

Return ONLY a JSON object with this exact format:
{"intent": "category_name", "product": "Product Name or null"}

User query: "${userMessage}"`;

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

function detectIntentWithRegex(userMessage, productNames) {
    const lowerMsg = userMessage.toLowerCase();

    if (/\b(shipping|delivery|ship)\b/.test(lowerMsg)) return { intent: 'shipping', product: null };
    if (/\b(return|refund|exchange)\b/.test(lowerMsg)) return { intent: 'returns', product: null };
    if (/\b(payment|pay|card|visa|mastercard|bank transfer|paypal)\b/.test(lowerMsg)) return { intent: 'payment', product: null };

    const matchedProduct = findLastProductName(userMessage, productNames);

    if (matchedProduct) {
        if (/\b(price|cost|how much|money)\b/.test(lowerMsg)) return { intent: 'price', product: matchedProduct };
        if (/\b(dosage|how (much|many)|take|consume|before|after).{0,15}\b(meal|food|eat)\b/i.test(lowerMsg)) return { intent: 'dosage', product: matchedProduct };
        if (/\b(benefits?|good for|does it|help|summary)\b/.test(lowerMsg)) return { intent: 'benefits', product: matchedProduct };
        if (/\b(ingredients?|contains?|made of|formulation)\b/.test(lowerMsg)) return { intent: 'ingredients', product: matchedProduct };
        if (/\b(suitable|who can|who cannot|women|men|children|adult|pregnant|nursing)\b/.test(lowerMsg)) return { intent: 'suitability', product: matchedProduct };
        if (/\b(where to buy|retail|outlets|store|pharmacy|guardian|watsons)\b/.test(lowerMsg)) return { intent: 'retail_outlets', product: matchedProduct };
    }

    return { intent: 'general_inquiry', product: matchedProduct };
}

module.exports = {
    generateResponse,
    quickKnowledgeLookup,
    detectIntentWithLLM,
    detectIntentWithRegex,
    getProductSlug
};
