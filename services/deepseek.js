// services/deepseek.js
const axios = require('axios');
const { getKnowledge } = require('./knowledgeLoader');
const { getSupplementaryInfo } = require('../utils/brochures');
const { searchWebsite, fetchProductPageAndLinks } = require('../config/botConfig');
const { isStoreQuery, isStoreQueryWithLLM, findStores, fetchProducts, clearPendingProduct, trackMentionedProduct } = require('./storeLocator');

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
    // Smart stripping
    return productName.toLowerCase()
        .replace(/\s*(plus|capsule|capsules|tablet|softgel)\s*/gi, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-]/g, '');
}

// ------------------- DeepSeek keyword extraction -----------------------
async function extractKeywordsWithDeepSeek(userMessage, apiKey) {
    console.log(`🤖 Asking DeepSeek to extract keywords from: "${userMessage}"`);
    if (!apiKey) {
        console.warn('⚠️ No API key for keyword extraction – falling back to raw message');
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
        console.log(`🔑 DeepSeek extracted keywords: "${keywords}"`);

        if (!keywords || keywords.split(/\s+/).length === 0 || keywords.length < 3) {
            console.log('⚠️ Empty or too-short keywords – using original message');
            return userMessage;
        }
        return keywords;
    } catch (err) {
        console.error('❌ Keyword extraction failed:', err.message);
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
                console.log(`⚠️ HTTP retry ${attempt}/${maxRetries} for ${url} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`❌ All ${maxRetries} retries failed for ${url}:`, lastError?.message);
    throw lastError;
}

// ------------------- DuckDuckGo API (no key required) ------------------
async function searchInternet(query) {
    console.log(`🌐 DuckDuckGo API search: "${query}"`);
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
        console.log(`🌐 DuckDuckGo returned ${text.length} chars`);
        return text.length > 50 ? text : null;
    } catch (err) {
        console.error('🌐 DuckDuckGo error:', err.message);
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

// ------------------- Direct knowledge lookup ---------------------------
function quickKnowledgeLookup(userMessage) {
    console.log(`📚 === DIRECT LOOKUP ===`);
    const kb = getKnowledge();
    const lowerMsg = userMessage.toLowerCase();
    const productNames = Object.keys(kb.products);

    // General topics
    if (/\b(shipping|delivery|ship)\b/.test(lowerMsg)) {
        console.log('📚 ✓ General: shipping');
        return kb.general?.shipping || null;
    }
    if (/\b(return|refund|exchange)\b/.test(lowerMsg)) {
        console.log('📚 ✓ General: returns');
        return kb.general?.returns || null;
    }
    if (/\b(payment|pay|card|visa|mastercard|bank transfer|paypal)\b/.test(lowerMsg)) {
        console.log('📚 ✓ General: payment');
        return kb.general?.payment || null;
    }

    // Product detection
    const productsFound = findAllProductNames(userMessage, productNames);
    const matchedProduct = productsFound.length > 0 ? findLastProductName(userMessage, productNames) : null;
    if (!matchedProduct) {
        console.log('📚 ✗ No known product detected');
        return null;
    }

    console.log(`📚 Matched product: "${matchedProduct}"`);
    const product = kb.products[matchedProduct];
    if (!product) return null;

    // --- Direct field answers (new structured fields) ---
    // Price
    if (/\b(price|cost|how much|money)\b/.test(lowerMsg)) {
        console.log('📚 Checking price...');
        if (typeof product.price === 'object') {
            const sg = product.price.singapore;
            if (sg) {
                return `${matchedProduct} price (Singapore): 1 bottle SGD ${sg['1_bottle']}, 2 bottles SGD ${sg['2_bottle']}, 3 bottles SGD ${sg['3_bottle']}.`;
            }
        }
        // Fallback to description string
        const desc = getProductDescription(kb, matchedProduct);
        const priceMatch = desc.match(/Price[^.]*?:[^.]*?(\d+\.?\d*)/i);
        if (priceMatch) return `The price of ${matchedProduct} is ${priceMatch[1]}.`;
    }

    // Dosage / how to take / before/after meal
    if (/\b(dosage|how (much|many)|take|consume|before|after).{0,15}\b(meal|food|eat)\b/i.test(lowerMsg)) {
        console.log('📚 Checking dosage/meal timing...');
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
    if (/\b(benefits?|good for|does it|help|summary)\b/.test(lowerMsg)) {
        console.log('📚 Checking benefits...');
        if (Array.isArray(product.benefits) && product.benefits.length) {
            return `Benefits of ${matchedProduct}: ${product.benefits.join(', ')}.`;
        }
        const desc = getProductDescription(kb, matchedProduct);
        const benMatch = desc.match(/(?:benefits|summary)[^:]*?:([\s\S]*?)(?=\n\n|\n[A-Z]|$)/i);
        if (benMatch) return `${matchedProduct} benefits:\n${benMatch[1].trim()}`;
    }

    // Ingredients
    if (/\b(ingredients?|contains?|made of|formulation)\b/.test(lowerMsg)) {
        console.log('📚 Checking ingredients...');
        if (Array.isArray(product.ingredients) && product.ingredients.length) {
            return `${matchedProduct} contains: ${product.ingredients.join(', ')}.`;
        }
        const desc = getProductDescription(kb, matchedProduct);
        const ingMatch = desc.match(/Ingredients[^:]*?:([^.]*\.)/i);
        if (ingMatch) return `${matchedProduct} ingredients: ${ingMatch[1].trim()}`;
    }

    // Suitability (who can/cannot consume)
    if (/\b(suitable|who can|who cannot|women|men|children|adult|pregnant|nursing)\b/.test(lowerMsg)) {
        console.log('📚 Checking suitability...');
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
    if (/\b(where to buy|retail|outlets|store|pharmacy|guardian|watsons)\b/.test(lowerMsg)) {
        console.log('📚 Checking retail outlets...');
        if (Array.isArray(product.retail_outlets) && product.retail_outlets.length) {
            return `${matchedProduct} available at: ${product.retail_outlets.join(', ')}.`;
        }
    }

    // Q&A direct match
    if (Array.isArray(product.qa) && product.qa.length) {
        console.log('📚 Checking Q&A...');
        for (const pair of product.qa) {
            const similarity = jaccardSimilarity(lowerMsg, pair.question.toLowerCase());
            if (similarity > 0.5) {
                console.log(`📚 Q&A match (${similarity.toFixed(2)}): "${pair.question}"`);
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

    console.log('📚 ✗ No direct pattern matched');
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
    console.log(`🤖 Calling DeepSeek API with ${messages.length} messages...`);
    if (!apiKey) {
        console.error('❌ No API key provided');
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
        console.log(`🤖 DeepSeek response (${content.length} chars): "${content.substring(0, 150)}..."`);
        return content;
    } catch (err) {
        console.error('❌ DeepSeek API error:', err.message);
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
                console.log(`⚠️ Retry ${attempt}/${maxRetries} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    console.error(`❌ All ${maxRetries} retries failed:`, lastError?.message);
    return null;
}

// ------------------- Main response generator ---------------------------
// Returns: { text: string, imageUrl: string|null, productName: string|null }
async function generateResponse(userMessage, _, apiKey, history = []) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`💬 NEW QUERY: "${userMessage}"`);
    console.log(`📜 History length: ${history.length} messages`);
    console.log(`${'='.repeat(60)}`);

    const kb = getKnowledge();
    const productNames = Object.keys(kb.products);

    // ==================== STORE LOCATOR CHECK ====================
    // Check if this is a store/location query using LLM for better context detection
    console.log(`📍 [STORE LOCATOR] Checking if this is a store query...`);
    const llmCheck = await isStoreQueryWithLLM(userMessage, apiKey);

    if (llmCheck.isStoreQuery) {
        console.log(`📍 [STORE LOCATOR] Store query detected (${llmCheck.reasoning})`);

        try {
            // Use LLM-based store finder (handles location detection + store lookup + response generation)
            const storeResult = await findStores(userMessage, apiKey);

            // If needs location, ask for it
            if (storeResult.needsLocation) {
                console.log(`📍 [STORE LOCATOR] No location provided - asking user`);
                return {
                    text: storeResult.text,
                    imageUrl: null,
                    productName: null
                };
            }

            // If error (e.g., no product identified), continue to AI
            if (storeResult.error) {
                console.log(`📍 [STORE LOCATOR] Error: ${storeResult.text}`);
                // Clear pending since we're giving up on store lookup
                clearPendingProduct();
                // Continue to AI for help
            }
            // If noContext (no product context), still return message without falling through
            else if (storeResult.noContext) {
                console.log(`📍 [STORE LOCATOR] No product context - returning message`);
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
                    console.log(`📍 [STORE LOCATOR] No stores in area - returning message`);
                    return {
                        text: storeResult.text,
                        imageUrl: null,
                        productName: null
                    };
                }
                console.log(`📍 [STORE LOCATOR] Returning store info`);
                // DON'T clear pending - user might want to change location ("How about in Subang Jaya?")
                // The store locator marks justCompletedSearch to keep pending for follow-ups
                return {
                    text: storeResult.text,
                    imageUrl: null,
                    productName: storeResult.productSlug || null
                };
            }
        } catch (err) {
            console.error(`📍 [STORE LOCATOR] Error: ${err.message}`);
            clearPendingProduct();
            // On error, continue to normal processing
        }
    } else {
        console.log(`📍 [STORE LOCATOR] Not a store query (${llmCheck.reasoning})`);
        // User asked something unrelated - clear any pending product
        clearPendingProduct();
    }
    // ==================== END STORE LOCATOR CHECK ====================

    // 1. Direct knowledge lookup (TIER 1)
    console.log(`\n📚 [TIER 1] Checking direct knowledge base...`);
    const directAnswer = quickKnowledgeLookup(userMessage);
    if (directAnswer) {
        console.log(`✅✅ [TIER 1] SUCCESS - Found direct answer`);
        console.log(`   Answer preview: "${directAnswer.substring(0, 100)}..."`);
        // Try to detect product for image
        const productsInMsg = findAllProductNames(userMessage, productNames);
        const detectedProduct = productsInMsg.length > 0 ? findLastProductName(userMessage, productNames) : null;

        // Track mentioned product for store locator context
        if (detectedProduct) {
            const slug = getProductSlug(detectedProduct);
            trackMentionedProduct(slug);
        }

        const imageUrl = detectedProduct ? getProductImageUrl(kb, detectedProduct) : null;
        console.log(`${'='.repeat(60)}\n`);
        return { text: directAnswer, imageUrl, productName: detectedProduct };
    }
    console.log(`❌ [TIER 1] FAILED - No direct match in knowledge base`);
    console.log(`➡️ Proceeding to AI tier...\n`);

    // 2. AI tier (TIER 1.5 fallback)
    console.log(`🤖 [TIER 1.5] Calling DeepSeek with knowledge base...`);

    // Detect product for brochure inclusion
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
    console.log(`   📤 Sending ${messages.length} messages to DeepSeek`);
    let reply = await callDeepSeekWithRetry(messages, apiKey);

    // Check if AI is uncertain
    const unknownPhrases = ["don't have that information", "not in the knowledge base", "i don't know", "can't answer", "cannot answer", "not sure", "unclear"];
    const isUncertain = !reply || unknownPhrases.some(k => reply.toLowerCase().includes(k));

    if (isUncertain) {
        console.log(`❌ [TIER 1.5] FAILED - AI uncertain or no response`);
        if (reply) {
            console.log(`   AI response: "${reply.substring(0, 100)}..."`);
        }
        console.log(`🔁 Starting fallback cascade...\n`);

        // ---- HISTORY-BASED PRODUCT DETECTION ----
        console.log(`🔍 [ANALYSIS] Detecting product from message and history...`);
        let detectedProduct = null;
        const productsInCurrent = findAllProductNames(userMessage, productNames);
        if (productsInCurrent.length > 0) {
            detectedProduct = findLastProductName(userMessage, productNames);
            console.log(`   ✅ Found product in current message: "${detectedProduct}"`);
            console.log(`   📦 All products detected: [${productsInCurrent.join(', ')}]`);
        } else {
            console.log(`   ⚠️ No product in current message, scanning history...`);
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].role === 'user') {
                    const historyProducts = findAllProductNames(history[i].content, productNames);
                    if (historyProducts.length > 0) {
                        detectedProduct = findLastProductName(history[i].content, productNames);
                        console.log(`   ✅ Found product in history[${i}]: "${detectedProduct}"`);
                        console.log(`   📜 History message: "${history[i].content.substring(0, 50)}..."`);
                        break;
                    }
                }
            }
            if (!detectedProduct) {
                console.log(`   ❌ No product found in current message or history`);
            }
        }

        const imageUrl = detectedProduct ? getProductImageUrl(kb, detectedProduct) : null;

        // ---- TIER 2: Product page + internal links search ----
        if (detectedProduct) {
            // Track for store locator context
            trackMentionedProduct(getProductSlug(detectedProduct));

            const productUrl = getProductUrl(kb, detectedProduct);
            if (productUrl) {
                console.log(`\n📄 [TIER 2] Fetching product page: ${productUrl}`);
                const productPageContent = await fetchProductPageAndLinks(productUrl, 3);
                if (productPageContent) {
                    console.log(`   ✅ Fetched ${productPageContent.length} chars from product page`);
                    const tier15Prompt = `You are DynaBot. Answer the user based ONLY on the product page content below. Start with YES/NO and one sentence. If answer not found, say exactly "I cannot find the answer on the product page."\nUSER: ${userMessage}\nPRODUCT PAGE CONTENT: ${productPageContent.substring(0, 2500)}`;
                    const tier15Messages = [
                        { role: "system", content: tier15Prompt },
                        ...history.slice(-6),  // Consistent 6 messages
                        { role: "user", content: userMessage }
                    ];
                    console.log(`   📤 Sending ${tier15Messages.length} messages to DeepSeek (product page context)`);
                    const tier15Reply = await callDeepSeekWithRetry(tier15Messages, apiKey);

                    if (tier15Reply) {
                        const containsCannotFind = tier15Reply.toLowerCase().includes("cannot find the answer on the product page");
                        if (!containsCannotFind) {
                            console.log(`✅✅ [TIER 2] SUCCESS - Found answer on product page`);
                            console.log(`   Response preview: "${tier15Reply.substring(0, 100)}..."`);
                            console.log(`${'='.repeat(60)}\n`);
                            return { text: tier15Reply, imageUrl, productName: detectedProduct };
                        } else {
                            console.log(`   ❌ [TIER 2] FAILED - AI says cannot find on product page`);
                            console.log(`   AI response: "${tier15Reply.substring(0, 100)}..."`);
                        }
                    } else {
                        console.log(`   ❌ [TIER 2] FAILED - No response from DeepSeek`);
                    }
                } else {
                    console.log(`   ❌ [TIER 2] FAILED - Insufficient content from product page`);
                }
            } else {
                console.log(`   ⚠️ [TIER 2] SKIPPED - No URL found for product "${detectedProduct}"`);
            }
        } else {
            console.log(`\n⏭️ [TIER 2] SKIPPED - No product detected`);
        }

        // Build search query: DeepSeek keywords + optional product prefix
        console.log(`\n🔑 [ANALYSIS] Extracting search keywords...`);
        const deepseekKeywords = await extractKeywordsWithDeepSeek(userMessage, apiKey);
        let searchQuery = deepseekKeywords;

        if (detectedProduct) {
            if (!deepseekKeywords.toLowerCase().includes(detectedProduct.toLowerCase())) {
                searchQuery = detectedProduct + ' ' + deepseekKeywords;
                console.log(`   🔍 Product "${detectedProduct}" added to keywords`);
            } else {
                console.log(`   🔍 Product already in keywords`);
            }
        }
        console.log(`   📝 Final search query: "${searchQuery}"`);

        // Tier 3: Website search
        console.log(`\n🔎 [TIER 3] Searching website: dyna-nutrition.com`);
        const siteResults = await searchWebsite(searchQuery);
        if (siteResults && siteResults.length > 100) {
            console.log(`   ✅ Found ${siteResults.length} chars of content`);
            const tier2Prompt = `You are DynaBot. Answer the user based ONLY on the search results below. Start with YES/NO and one sentence. If answer not found, say exactly "I cannot find the answer in the search results."\nUSER: ${userMessage}\nRESULTS: ${siteResults.substring(0, 2000)}`;
            const tier2Messages = [
                { role: "system", content: tier2Prompt },
                ...history.slice(-6),  // Consistent 6 messages
                { role: "user", content: userMessage }
            ];
            console.log(`   📤 Sending ${tier2Messages.length} messages to DeepSeek (website search context)`);
            const tier2Reply = await callDeepSeekWithRetry(tier2Messages, apiKey);

            if (tier2Reply) {
                const containsCannotFind = tier2Reply.toLowerCase().includes("cannot find the answer");
                if (!containsCannotFind) {
                    console.log(`✅✅ [TIER 3] SUCCESS - Found answer in website search`);
                    console.log(`   Response preview: "${tier2Reply.substring(0, 100)}..."`);
                    console.log(`${'='.repeat(60)}\n`);
                    return { text: tier2Reply, imageUrl, productName: detectedProduct };
                } else {
                    console.log(`   ❌ [TIER 3] FAILED - AI says cannot find in search results`);
                    console.log(`   AI response: "${tier2Reply.substring(0, 100)}..."`);
                }
            } else {
                console.log(`   ❌ [TIER 3] FAILED - No response from DeepSeek`);
            }
        } else {
            console.log(`   ❌ [TIER 3] FAILED - No results from website search (${siteResults?.length || 0} chars)`);
        }

        // Tier 4: Internet search (DuckDuckGo)
        console.log(`\n🌐 [TIER 4] Searching internet via DuckDuckGo...`);
        const internetResults = await searchInternet(searchQuery);
        if (internetResults) {
            console.log(`   ✅ Found ${internetResults.length} chars from internet`);
            const tier3Prompt = `You are DynaBot. Answer the user based on these internet search results. Start with YES/NO and one sentence. If not available, say exactly "I cannot find reliable information online."\nUSER: ${userMessage}\nRESULTS: ${internetResults}`;
            const tier3Messages = [
                { role: "system", content: tier3Prompt },
                ...history.slice(-6),  // Consistent 6 messages
                { role: "user", content: userMessage }
            ];
            console.log(`   📤 Sending ${tier3Messages.length} messages to DeepSeek (internet context)`);
            const tier3Reply = await callDeepSeekWithRetry(tier3Messages, apiKey);

            if (tier3Reply) {
                const containsCannotFind = tier3Reply.toLowerCase().includes("cannot find reliable");
                if (!containsCannotFind) {
                    console.log(`✅✅ [TIER 4] SUCCESS - Found answer via internet search`);
                    console.log(`   Response preview: "${tier3Reply.substring(0, 100)}..."`);
                    console.log(`${'='.repeat(60)}\n`);
                    return { text: tier3Reply, imageUrl, productName: detectedProduct };
                } else {
                    console.log(`   ❌ [TIER 4] FAILED - AI says cannot find reliable info online`);
                    console.log(`   AI response: "${tier3Reply.substring(0, 100)}..."`);
                }
            } else {
                console.log(`   ❌ [TIER 4] FAILED - No response from DeepSeek`);
            }
        } else {
            console.log(`   ❌ [TIER 4] FAILED - No results from DuckDuckGo`);
        }

        console.log(`\n❌❌ ALL TIERS FAILED`);
        console.log(`   Falling back to human representative message`);
        console.log(`${'='.repeat(60)}\n`);
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

    console.log(`✅✅ [TIER 1.5] SUCCESS - AI answered directly`);
    console.log(`   Response preview: "${reply.substring(0, 100)}..."`);
    console.log(`${'='.repeat(60)}\n`);
    return { text: reply || "I'm having trouble responding right now.", imageUrl, productName: imageProduct };
}

module.exports = { generateResponse };