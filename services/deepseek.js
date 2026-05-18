// services/deepseek.js
// General LLM response generation using DeepSeek
// Handles knowledge base queries, web search, and general conversation

const axios = require('axios');
const { getKnowledge } = require('./knowledgeLoader');
const { getSupplementaryInfo } = require('../utils/brochures');
const { searchWebsite, fetchProductPageAndLinks } = require('../config/botConfig');

// Product slug normalization helper
const PRODUCT_SLUG_MAP = {
    'BioNatto Plus': 'bionatto',
    'Men Guard': 'men-guard',
    'Men Guard Capsule': 'men-guard',
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

function getProductSlug(productName) {
    const mapped = PRODUCT_SLUG_MAP[productName];
    if (mapped) return mapped;
    return productName.toLowerCase()
        .replace(/\s*(plus|capsule|capsules|tablet|softgel)\s*/gi, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');
}

// Extract keywords using LLM
async function extractKeywordsWithDeepSeek(userMessage, apiKey) {
    console.log(`[DEEPSEEK] Extracting keywords from: "${userMessage}"`);
    if (!apiKey) {
        return userMessage;
    }

    const prompt = `Extract the most important keywords from this user message for a web search.
Return ONLY the keywords separated by spaces, no punctuation, no extra text.
Focus on product names, ingredients, health terms, key concepts.

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
        console.error('[DEEPSEEK] Keyword extraction failed:', err.message);
        return userMessage;
    }
}

// Retry wrapper for HTTP requests
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
                const delay = 1000 * Math.pow(2, attempt - 1);
                console.log(`[DEEPSEEK] Retry ${attempt}/${maxRetries} for ${url} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`[DEEPSEEK] All retries failed for ${url}:`, lastError?.message);
    throw lastError;
}

// DuckDuckGo API search
async function searchInternet(query) {
    console.log(`[DEEPSEEK] Internet search: "${query}"`);
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
        return text.length > 50 ? text : null;
    } catch (err) {
        console.error('[DEEPSEEK] Internet search error:', err.message);
        return null;
    }
}

// Product detection helpers
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

// Helper: get product description
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
        return product.images[0];
    }
    return null;
}

// Jaccard similarity for Q&A matching
function jaccardSimilarity(str1, str2) {
    const words1 = new Set(str1.toLowerCase().split(/\W+/).filter(w => w.length > 1));
    const words2 = new Set(str2.toLowerCase().split(/\W+/).filter(w => w.length > 1));
    if (words1.size === 0 || words2.size === 0) return 0;
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    return intersection.size / union.size;
}

// Build guidelines prompt
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

// Build knowledge prompt
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

        // Add brochure content if detected product matches
        if (detectedProduct) {
            const lowerDetected = detectedProduct.toLowerCase();
            const lowerName = name.toLowerCase();
            const nameWithoutSuffix = lowerName.replace(/[-_\s]*(capsule|plus|capsules?)$/i, '');
            const detectedWithoutSuffix = lowerDetected.replace(/[-_\s]*(capsule|plus|capsules?)$/i, '');

            const matches = lowerName === lowerDetected || nameWithoutSuffix === detectedWithoutSuffix;

            if (matches) {
                const brochureInfo = getSupplementaryInfo(nameWithoutSuffix);
                if (!brochureInfo) {
                    const brochureInfo2 = getSupplementaryInfo(name.toLowerCase());
                    if (brochureInfo2) prompt += brochureInfo2;
                } else {
                    prompt += brochureInfo;
                }
            }
        }

        prompt += '\n';
    }

    const shipping = kb.general?.shipping || 'Not available';
    const payment = kb.general?.payment || 'Not available';
    const returns = kb.general?.returns || 'Not available';

    const guidelinesRaw = buildGuidelinesPrompt(kb.guidelines)
        .replace(/\{shipping\}/g, shipping)
        .replace(/\{payment\}/g, payment)
        .replace(/\{returns\}/g, returns);

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
    console.log(`[DEEPSEEK] Calling API with ${messages.length} messages...`);
    if (!apiKey) {
        console.error('[DEEPSEEK] No API key provided');
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
        return content;
    } catch (err) {
        console.error('[DEEPSEEK] API error:', err.message);
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
                console.log(`[DEEPSEEK] Retry ${attempt}/${maxRetries} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`[DEEPSEEK] All retries failed:`, lastError?.message);
    return null;
}

// Main response generator
async function generateResponse(userMessage, _, apiKey, history = []) {
    console.log(`\n[DEEPSEEK] NEW QUERY: "${userMessage}"`);
    console.log(`[DEEPSEEK] History length: ${history.length} messages`);

    const kb = getKnowledge();
    const productNames = Object.keys(kb.products);

    // Detect product for image
    const productsInMsg = findAllProductNames(userMessage, productNames);
    const imageProduct = productsInMsg.length > 0 ? findLastProductName(userMessage, productNames) : null;
    const imageUrl = imageProduct ? getProductImageUrl(kb, imageProduct) : null;

    // Build knowledge prompt
    let detectedProductForBrochure = null;
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
        console.log(`[DEEPSEEK] AI uncertain, starting fallback cascade...`);

        // Extract keywords
        const deepseekKeywords = await extractKeywordsWithDeepSeek(userMessage, apiKey);
        let searchQuery = deepseekKeywords;

        if (imageProduct) {
            if (!deepseekKeywords.toLowerCase().includes(imageProduct.toLowerCase())) {
                searchQuery = imageProduct + ' ' + deepseekKeywords;
            }
        }

        // Try website search
        console.log(`[DEEPSEEK] Searching website: dyna-nutrition.com`);
        const siteResults = await searchWebsite(searchQuery);
        if (siteResults && siteResults.length > 100) {
            const tier2Prompt = `You are DynaBot. Answer the user based ONLY on the search results below. Start with YES/NO and one sentence.\nUSER: ${userMessage}\nRESULTS: ${siteResults.substring(0, 2000)}`;
            const tier2Messages = [
                { role: "system", content: tier2Prompt },
                ...history.slice(-6),
                { role: "user", content: userMessage }
            ];
            const tier2Reply = await callDeepSeekWithRetry(tier2Messages, apiKey);

            if (tier2Reply && !tier2Reply.toLowerCase().includes("cannot find the answer")) {
                console.log(`[DEEPSEEK] Found answer in website search`);
                return { text: tier2Reply, imageUrl, productName: imageProduct };
            }
        }

        // Try internet search
        console.log(`[DEEPSEEK] Searching internet via DuckDuckGo...`);
        const internetResults = await searchInternet(searchQuery);
        if (internetResults) {
            const tier3Prompt = `You are DynaBot. Answer the user based on these internet search results.\nUSER: ${userMessage}\nRESULTS: ${internetResults}`;
            const tier3Messages = [
                { role: "system", content: tier3Prompt },
                ...history.slice(-6),
                { role: "user", content: userMessage }
            ];
            const tier3Reply = await callDeepSeekWithRetry(tier3Messages, apiKey);

            if (tier3Reply && !tier3Reply.toLowerCase().includes("cannot find reliable")) {
                console.log(`[DEEPSEEK] Found answer via internet search`);
                return { text: tier3Reply, imageUrl, productName: imageProduct };
            }
        }

        console.log(`[DEEPSEEK] All tiers failed, returning fallback message`);
        return { text: "I'm sorry, I couldn't find an answer. A human representative will be happy to help you.", imageUrl: null, productName: null };
    }

    console.log(`[DEEPSEEK] SUCCESS - Direct response`);
    return { text: reply || "I'm having trouble responding right now.", imageUrl, productName: imageProduct };
}

module.exports = { generateResponse };