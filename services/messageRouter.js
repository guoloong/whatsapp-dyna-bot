// services/messageRouter.js
// LLM-based message routing - determines intent and routes to appropriate handler
// Routes: price (priceApi), store (storeLocator), or general (deepseek)

const axios = require('axios');
const { getContext, updatePriceContext, updateStoreContext, updateMentionedProduct, clearPriceContext, clearStoreContext } = require('./contextManager');

// Known products list for the LLM
const KNOWN_PRODUCTS = [
    'bionatto', 'men-guard', 'ashiguard', 'ashislim', 'black-elderberry-juice',
    'elderola', 'glucopal', 'hairegain', 'hp-floragut', 'liveprotein',
    'marinecal-plus', 'nustem', 'optiberries', 'optivue', 'organic-ashitaba',
    'super-bio-organic', 'tibetan-seaberry', 'tricollagen', 'uri-comfort',
    'vitamune-cdz', 'riflex-360', 'liveberries', 'liveessence', 'livezymes',
    'nitrovar', 'bone-builder', 'liver-detox'
];

/**
 * Build conversation context string from history
 */
function buildConversationContext(history, maxMessages = 10) {
    if (!history || history.length === 0) return '';

    const recentMessages = history.slice(-maxMessages);
    const lines = [];

    for (const msg of recentMessages) {
        const role = msg.role === 'user' ? 'User' : 'Bot';
        const content = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content;
        lines.push(`${role}: "${content}"`);
    }

    return lines.join('\n');
}

/**
 * Use LLM to analyze user message and determine intent
 * Now includes conversation history for better context understanding
 */
async function analyzeIntent(userMessage, userId, phoneNumber, apiKey, history = []) {
    console.log(`[ROUTER] Analyzing intent for: "${userMessage}"`);
    console.log(`[ROUTER] History messages: ${history.length}`);

    if (!apiKey) {
        console.warn('[ROUTER] No API key - using fallback intent detection');
        return fallbackIntentDetection(userMessage, history);
    }

    // Build conversation context
    const conversationContext = buildConversationContext(history, 10);

    // Get context for follow-up handling
    const ctx = getContext(userId);

    const contextInfo = ctx ? `
EXISTING CONTEXT (use when current message is a follow-up):
- Last product user asked about for price: ${ctx.lastPriceProduct || 'none'}
- Last currency used: ${ctx.lastPriceCurrency || 'none'}
- Last product user mentioned: ${ctx.lastMentionedProduct || 'none'}
- Pending store product: ${ctx.pendingStoreProduct || 'none'}` : '';

    const prompt = `Analyze this user message for a WhatsApp health products chatbot.

${conversationContext ? `CONVERSATION HISTORY (last ${Math.min(history.length, 10)} messages):
${conversationContext}
---` : ''}

CURRENT MESSAGE: "${userMessage}"
${contextInfo}

TASK:
Determine the user's INTENT and extract relevant information.

Return ONLY a JSON object with this exact format:
{
    "intent": "price" | "store" | "general",
    "product": "product slug or null",
    "currency": "SGD" | "MYR" | "IDR" | "THB" | "PHP" | "VND" | null,
    "location": "location name or null",
    "needsMoreInfo": true | false,
    "reasoning": "brief explanation"
}

INTENT DEFINITIONS:
- "price": User asks about product cost, pricing, how much, etc.
- "store": User asks where to buy, find stores, pharmacy, etc.
- "general": Any other question (benefits, dosage, shipping, etc.)

FOLLOW-UP HANDLING:
- If user says "Price?" or "how much?" and they mentioned a product in history → use that product
- If user says "Where to buy?" and they mentioned a product in history → use that product
- If user says "How about Malaysia?" after price query → change currency to MYR
- If user says "How about JB?" after store query → change location to JB

CURRENCY DETECTION:
- "SGD", "MYR", "IDR", "THB", "PHP", "VND", etc. based on location mentioned
- If user mentions a country, use that country's currency
- If phone is from Singapore (65...), default to SGD
- If phone is from Malaysia (60...), default to MYR

LOCATION DETECTION:
- Countries: Malaysia, Singapore, Indonesia, Thailand, Philippines, Vietnam
- Areas: KL, Kuala Lumpur, PJ, Petaling Jaya, Subang Jaya, Shah Alam, Penang, Johor, JB, Singapore, SG, etc.

PRODUCT DETECTION (important!):
- Detect product names: BioNatto, Men Guard, Riflex 360, Ashislim, Optiberries, Tricollagen, etc.
- If user mentions a product in current message OR in recent history, extract it
- Product slugs: bionatto, men-guard, riflex-360, ashislim, optiberries, tricollagen, vitamune-cdz, hairegain, hp-floragut, glucopal, elderola, nustem, uri-comfort

User message: "${userMessage}"
Response:`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a JSON parser. Return ONLY valid JSON, no markdown, no explanation.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0,
                max_tokens: 300
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: controller.signal,
                timeout: 20000
            }
        );

        clearTimeout(timeoutId);
        const content = response.data.choices[0].message.content.trim();

        // Parse JSON
        let jsonStr = content.replace(/```json\n?|```\n?/gi, '').trim();
        const result = JSON.parse(jsonStr);

        console.log(`[ROUTER] LLM detected: intent=${result.intent}, product=${result.product}, currency=${result.currency}, location=${result.location}`);

        return {
            intent: result.intent || 'general',
            product: result.product || null,
            currency: result.currency || null,
            location: result.location || null,
            needsMoreInfo: result.needsMoreInfo || false,
            reasoning: result.reasoning || ''
        };

    } catch (err) {
        console.error(`[ROUTER] LLM analysis failed: ${err.message}`);
        return fallbackIntentDetection(userMessage, history);
    }
}

/**
 * Extract product from message text
 */
function extractProductFromText(text) {
    const lowerText = text.toLowerCase();

    const productPatterns = [
        { name: 'bionatto', patterns: ['bionatto', 'bio-natto'] },
        { name: 'men-guard', patterns: ['men guard', 'menguard', 'men-guard'] },
        { name: 'riflex-360', patterns: ['riflex', 'riflex 360', 'riflex-360', 'vitalguard'] },
        { name: 'ashislim', patterns: ['ashislim', 'ashi slim'] },
        { name: 'optiberries', patterns: ['optiberries', 'opti berries'] },
        { name: 'tricollagen', patterns: ['tricollagen', 'tri collagen'] },
        { name: 'vitamune', patterns: ['vitamune', 'cdz'] },
        { name: 'hairegain', patterns: ['hairegain', 'hair gain'] },
        { name: 'hp-floragut', patterns: ['hp-floragut', 'hp floragut', 'floragut'] },
        { name: 'glucopal', patterns: ['glucopal', 'gluco pal'] },
        { name: 'elderola', patterns: ['elderola'] },
        { name: 'nustem', patterns: ['nustem', 'nu stem'] },
        { name: 'uri-comfort', patterns: ['uri comfort', 'uri-comfort'] },
        { name: 'liveprotein', patterns: ['liveprotein', 'live protein'] },
        { name: 'marinecal-plus', patterns: ['marinecal', 'marine cal'] },
        { name: 'optivue', patterns: ['optivue', 'opti vue'] },
        { name: 'organic-ashitaba', patterns: ['ashitaba', 'organic ashitaba'] },
        { name: 'black-elderberry-juice', patterns: ['elderberry', 'black elderberry'] },
        { name: 'tibetan-seaberry', patterns: ['seaberry', 'sea berry', 'tibetan'] },
        { name: 'super-bio-organic', patterns: ['super bio', 'super bio organic'] },
    ];

    for (const { name, patterns } of productPatterns) {
        for (const pattern of patterns) {
            if (lowerText.includes(pattern)) {
                return name;
            }
        }
    }

    return null;
}

/**
 * Find most recent product mention in history
 */
function findProductInHistory(history) {
    if (!history || history.length === 0) return null;

    // Look at last 10 messages (user + bot pairs)
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role === 'user') {
            const product = extractProductFromText(msg.content);
            if (product) {
                console.log(`[ROUTER] Found product in history: ${product}`);
                return product;
            }
        }
    }

    return null;
}

/**
 * Fallback intent detection when LLM fails
 */
function fallbackIntentDetection(userMessage, history = []) {
    const lowerMsg = userMessage.toLowerCase();

    // Price keywords
    const priceKeywords = ['price', 'cost', 'how much', 'rm', 'sg$', 'dollars', 'cheap'];
    const isPrice = priceKeywords.some(k => lowerMsg.includes(k));

    // Store keywords
    const storeKeywords = ['where to buy', 'where can i buy', 'store', 'stores', 'pharmacy', 'buy', 'watsons', 'guardian', 'caring', 'retail'];
    const isStore = storeKeywords.some(k => lowerMsg.includes(k));

    // Detect currency
    let currency = null;
    if (lowerMsg.includes('singapore') || lowerMsg.includes('sg')) currency = 'SGD';
    else if (lowerMsg.includes('malaysia') || lowerMsg.includes('kl') || lowerMsg.includes('rm')) currency = 'MYR';
    else if (lowerMsg.includes('indonesia') || lowerMsg.includes('rp')) currency = 'IDR';
    else if (lowerMsg.includes('thailand') || lowerMsg.includes('thb')) currency = 'THB';
    else if (lowerMsg.includes('philippines') || lowerMsg.includes('php')) currency = 'PHP';
    else if (lowerMsg.includes('vietnam') || lowerMsg.includes('vnd')) currency = 'VND';

    // Detect location
    let location = null;
    const locations = ['singapore', 'malaysia', 'kl', 'kuala lumpur', 'pj', 'petaling jaya', 'subang', 'subang jaya',
        'shah alam', 'penang', 'johor', 'jb', 'johor bahru', 'ipoh', 'melaka', 'seremban',
        'indonesia', 'thailand', 'philippines', 'vietnam', 'sabah', 'sarawak'];

    for (const loc of locations) {
        if (lowerMsg.includes(loc)) {
            location = loc;
            break;
        }
    }

    // Detect product from current message OR history
    let product = extractProductFromText(userMessage);

    if (!product) {
        product = findProductInHistory(history);
    }

    let intent = 'general';
    if (isPrice) intent = 'price';
    else if (isStore) intent = 'store';

    console.log(`[ROUTER] Fallback detected: intent=${intent}, product=${product}, currency=${currency}, location=${location}`);

    return {
        intent,
        product,
        currency,
        location,
        needsMoreInfo: false,
        reasoning: 'fallback'
    };
}

/**
 * Determine currency from phone number prefix
 */
function getCurrencyFromPhone(phoneNumber) {
    if (!phoneNumber) return null;

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');

    // Check for country prefixes
    if (cleanPhone.startsWith('65')) return 'SGD';
    if (cleanPhone.startsWith('60')) return 'MYR';
    if (cleanPhone.startsWith('62')) return 'IDR';
    if (cleanPhone.startsWith('66')) return 'THB';
    if (cleanPhone.startsWith('63')) return 'PHP';
    if (cleanPhone.startsWith('84')) return 'VND';

    return null;
}

/**
 * Main routing function - analyzes message and routes to appropriate handler
 * Now accepts history for better context understanding
 */
async function routeMessage(userMessage, userId, phoneNumber, apiKey, history = []) {
    const ctx = getContext(userId);

    // Analyze intent with LLM (now including history)
    const intent = await analyzeIntent(userMessage, userId, phoneNumber, apiKey, history);

    // Determine default currency from phone if not specified
    if (!intent.currency && phoneNumber) {
        intent.currency = getCurrencyFromPhone(phoneNumber);
    }

    // Handle follow-ups using context + history
    if (intent.intent === 'price') {
        // Try: LLM-detected product > context lastPriceProduct > history
        if (!intent.product) {
            if (ctx && ctx.lastPriceProduct) {
                intent.product = ctx.lastPriceProduct;
                console.log(`[ROUTER] Using context price product: ${intent.product}`);
            } else if (ctx && ctx.lastMentionedProduct) {
                intent.product = ctx.lastMentionedProduct;
                console.log(`[ROUTER] Using context mentioned product: ${intent.product}`);
            } else {
                const historyProduct = findProductInHistory(history);
                if (historyProduct) {
                    intent.product = historyProduct;
                    console.log(`[ROUTER] Using history product: ${intent.product}`);
                }
            }
        }

        // Update contexts
        if (intent.product) {
            updatePriceContext(userId, intent.product, intent.currency);
            updateMentionedProduct(userId, intent.product);
        }

        return {
            handler: 'priceApi',
            params: {
                productName: intent.product,
                currency: intent.currency,
                phoneNumber: phoneNumber
            }
        };
    }

    if (intent.intent === 'store') {
        // Try: LLM-detected product > context pendingStoreProduct > context lastMentionedProduct > history
        if (!intent.product) {
            if (ctx && ctx.pendingStoreProduct) {
                intent.product = ctx.pendingStoreProduct;
                console.log(`[ROUTER] Using context store product: ${intent.product}`);
            } else if (ctx && ctx.lastMentionedProduct) {
                intent.product = ctx.lastMentionedProduct;
                console.log(`[ROUTER] Using context mentioned product for store: ${intent.product}`);
            } else {
                const historyProduct = findProductInHistory(history);
                if (historyProduct) {
                    intent.product = historyProduct;
                    console.log(`[ROUTER] Using history product for store: ${intent.product}`);
                }
            }
        }

        // Update contexts
        if (intent.product) {
            updateStoreContext(userId, intent.product);
            updateMentionedProduct(userId, intent.product);
        }

        return {
            handler: 'storeLocator',
            params: {
                productName: intent.product,
                location: intent.location,
                needsLocation: intent.needsMoreInfo || (!intent.location && intent.product)
            }
        };
    }

    // General query - track mentioned product for future follow-ups
    const mentionedProduct = extractProductFromText(userMessage) || findProductInHistory(history);
    if (mentionedProduct) {
        updateMentionedProduct(userId, mentionedProduct);
        console.log(`[ROUTER] Tracked mentioned product: ${mentionedProduct}`);
    }

    return {
        handler: 'deepseek',
        params: {}
    };
}

module.exports = {
    analyzeIntent,
    routeMessage,
    getCurrencyFromPhone,
    KNOWN_PRODUCTS,
    extractProductFromText,
    buildConversationContext
};