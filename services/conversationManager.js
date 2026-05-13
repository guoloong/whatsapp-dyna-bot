// services/conversationManager.js
// LLM-Driven Unified Intent + State + Flow Manager
// Fixed: Better fallback, shorter prompts, direct product handling

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Import existing services
const { getProductPrice, formatPriceResponse } = require('./priceApi');
const { getRecommendation } = require('./recommendationEngine');
const { findStores, clearPendingProduct, trackMentionedProduct, getLastMentionedProduct, normalizeProductSlug } = require('./storeLocator');
const { getKnowledge } = require('./knowledgeLoader');
const { getSupplementaryInfo } = require('../utils/brochures');
const { getPhoneNumber } = require('../utils/contactCache');
const { getProductUrl, getProductImageUrl, callDeepSeekWithRetry, searchWebsite, fetchProductPageAndLinks, extractKeywordsWithDeepSeek } = require('./deepseek');

// Context persistence
const CONTEXT_FILE = path.join(__dirname, '..', 'conversation_context.json');
const CONTEXT_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_TURNS_PER_TOPIC = 5;

let userContexts = new Map();
let saveTimer = null;

// Popular products for quick reference (no need to load all 29)
const POPULAR_PRODUCTS = ['BioNatto Plus', 'GlucoPal', 'Tricollagen', 'Men Guard', 'Vitamune CDZ', 'Hairegain', 'Optiberries'];

// ==================== Context Management ====================

function saveContexts() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const obj = Object.fromEntries(userContexts);
            fs.writeFileSync(CONTEXT_FILE, JSON.stringify(obj, null, 2));
        } catch (err) {
            console.error('Context save error:', err.message);
        }
    }, 500);
}

function loadContexts() {
    try {
        if (fs.existsSync(CONTEXT_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
            userContexts = new Map(Object.entries(data));
            console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Loaded ${userContexts.size} conversation contexts`);
        }
    } catch (err) {
        console.error('Context load error:', err.message);
    }
}

function getContext(userId) {
    const now = Date.now();
    const ctx = userContexts.get(userId);
    if (ctx && ctx.lastUpdated && (now - ctx.lastUpdated > CONTEXT_TTL)) {
        userContexts.delete(userId);
        return null;
    }
    return ctx || null;
}

function updateContext(userId, updates) {
    let ctx = userContexts.get(userId);
    const now = Date.now();
    if (!ctx) {
        ctx = { currentIntent: null, product: null, location: null, currency: null, missingInfo: [], conversationStage: 'start', turnsOnTopic: 0, previousActions: [], lastUpdated: now };
    }
    if (updates.currentIntent) ctx.currentIntent = updates.currentIntent;
    if (updates.product !== undefined) ctx.product = updates.product;
    if (updates.location !== undefined) ctx.location = updates.location;
    if (updates.currency !== undefined) ctx.currency = updates.currency;
    if (updates.missingInfo) ctx.missingInfo = updates.missingInfo;
    if (updates.conversationStage) ctx.conversationStage = updates.conversationStage;
    if (updates.turnsOnTopic !== undefined) ctx.turnsOnTopic = updates.turnsOnTopic;
    if (updates.previousActions) ctx.previousActions = updates.previousActions;
    ctx.lastUpdated = now;
    userContexts.set(userId, ctx);
    saveContexts();
    return ctx;
}

function clearContext(userId) {
    userContexts.delete(userId);
    saveContexts();
}

// ==================== Product Detection (Fast, No API) ====================

function detectProduct(userMessage, ctx) {
    const kb = getKnowledge();
    const productNames = Object.keys(kb.products || {});
    const lowerMsg = userMessage.toLowerCase();

    // First: Search message for products (priority)
    for (const name of productNames) {
        const lowerName = name.toLowerCase();
        if (lowerMsg.includes(lowerName)) return name;
        // Also check without suffixes
        const shortName = lowerName.replace(/\s*(plus|capsule|capsules|tablet|softgel)\s*/gi, '').trim();
        if (shortName !== lowerName && lowerMsg.includes(shortName)) return name;
    }

    // Second: Fall back to context if no product in message
    if (ctx?.product) return ctx.product;

    return null;
}

function detectLocation(userMessage, ctx) {
    const lowerMsg = userMessage.toLowerCase();

    // First: Search message for locations (priority)
    const locations = ['singapore', 'kl', 'kuala lumpur', 'pj', 'petaling jaya', 'subang', 'subang jaya', 'shah alam', 'penang', 'johor', 'johor bahru', 'ipoh', 'melaka', 'selangor', 'klang', 'cheras', 'puchong', 'kajang', 'seremban', 'langkawi', 'malacca'];
    for (const loc of locations) {
        if (lowerMsg.includes(loc)) return loc;
    }

    // Second: Fall back to context if no location in message
    if (ctx?.location) return ctx.location;

    return null;
}

// ==================== Intent Detection (Fast, No API) ====================

function detectIntent(userMessage, ctx) {
    const lowerMsg = userMessage.toLowerCase();

    // Check for escalation keywords first
    const escalationKeywords = ['talk to human', 'speak to human', 'real person', 'agent', 'customer service', 'representative', 'not bot', 'real person'];
    if (escalationKeywords.some(k => lowerMsg.includes(k))) {
        return { intent: 'escalation', confidence: 1.0 };
    }

    // NEW: Check for implicit recommendation signals (before other intents)
    const recommendationSignals = [
        /\b(joint|hair|skin|immune|blood sugar|energy|digestion|sleep|stress)\b.*\b(pain|problem|issue|weak|low|loss|support)\b/i,
        /\b(want|need|looking for|help with|something for)\b.*\b(hair|skin|joint|immune|health|anti|aging)\b/i,
        /\b(collagen|vitamin|mineral|supplement|probiotic|zinc|omega)\b.*\b(good|best|help|need|want)\b/i,
        /\b(prevent|treat|reduce|support|boost|improve)\b.*\b(hair|skin|joint|immune|bone|energy)\b/i,
        /\b(hair\s*fall|hair\s*loss|hair\s*growth|joint\s*pain|immune\s*system|anti\s*aging)\b/i
    ];

    for (const pattern of recommendationSignals) {
        if (pattern.test(lowerMsg)) {
            return { intent: 'recommendation', confidence: 0.75 };
        }
    }

    // Price check - check BEFORE store locator to catch "price in Malaysia" type queries
    if (/\b(price|cost|how much|money|amount)\b/.test(lowerMsg)) {
        return { intent: 'price_check', confidence: 0.9 };
    }

    // Also detect price-related phrases even without "price" keyword
    // e.g., "malaysia?", "in Malaysia", "rm ", "rm" alone (Malaysian currency)
    if (/\b(rm\s|malaysia\s*\?|in\s+malaysia|in\s+sg|in\s+singapore|in\s+kl|in\s+kuala)\b/.test(lowerMsg) && ctx?.currentIntent === 'price_check') {
        return { intent: 'price_check', confidence: 0.85 };
    }

    // Store locator - ONLY if it explicitly mentions buy/where/store
    const storeKeywords = ['where to buy', 'where can i buy', 'where to get', 'store', 'stores', 'shop', 'pharmacy', 'watsons', 'guardian', 'caring', 'retail'];
    if (storeKeywords.some(k => lowerMsg.includes(k))) {
        return { intent: 'store_locator', confidence: 0.85 };
    }

    // Product info - various question patterns
    const infoKeywords = ['benefit', 'ingredient', 'dosage', 'suitable', 'how to take', 'how many', 'what is', 'what does', 'tell me', 'know more', 'more about', 'information', 'details', 'about'];
    if (infoKeywords.some(k => lowerMsg.includes(k))) {
        return { intent: 'product_info', confidence: 0.8 };
    }

    // If user just says a product name OR general questions about a product
    const product = detectProduct(userMessage, null);
    if (product) {
        // Check if it's just the product name (like "BioNatto" or "Tricollagen")
        const justProduct = lowerMsg === product.toLowerCase() ||
                           lowerMsg === product.toLowerCase().replace(/\s*(plus|capsule)\s*/gi, '') ||
                           lowerMsg.trim() === product.toLowerCase().split(' ')[0].toLowerCase();
        if (justProduct) {
            return { intent: 'product_info', confidence: 0.7 };
        }
        // Also treat product name + generic words as product info
        if (/\b(tell|about|more|info|what|how)\b/.test(lowerMsg)) {
            return { intent: 'product_info', confidence: 0.75 };
        }
    }

    // Purchase intent
    if (/\b(buy|order|purchase|want|need|get)\b/.test(lowerMsg)) {
        return { intent: 'purchase_intent', confidence: 0.8 };
    }

    // Recommendation
    if (/\b(recommend|suggest|which.*best|what.*should|help.*choose)\b/.test(lowerMsg)) {
        return { intent: 'recommendation', confidence: 0.8 };
    }

    // General inquiry
    return { intent: 'general_inquiry', confidence: 0.5 };
}

// ==================== LLM Analysis (Simplified, Shorter Prompt) ====================

async function analyzeWithLLM(userMessage, history, userId, apiKey) {
    if (!apiKey) {
        return fallbackAnalysis(userMessage, getContext(userId));
    }

    const ctx = getContext(userId);

    // Quick context string
    const contextStr = ctx ?
        `Intent: ${ctx.currentIntent || 'none'}, Product: ${ctx.product || 'none'}, Location: ${ctx.location || 'none'}, Stage: ${ctx.conversationStage || 'start'}` :
        'New conversation';

    // Short history (last 3 messages max)
    const shortHistory = history.slice(-3).map(m =>
        `${m.role === 'assistant' ? 'Bot' : 'User'}: ${m.content.substring(0, 100)}`
    ).join('\n') || 'No previous messages';

    // Check if product is in context - if so, always use execute
    const hasProductContext = ctx?.product !== null && ctx?.product !== undefined;
    const hasLocationContext = ctx?.location !== null && ctx?.location !== undefined;
    const toolContextStr = hasProductContext ? ` (Product: ${ctx.product} in context)` : '';
    const toolContextStr2 = hasLocationContext ? ` (Location: ${ctx.location} in context)` : '';

    // Also extract product from current message for context
    const msgProduct = detectProduct(userMessage, ctx);
    const msgLocation = detectLocation(userMessage, ctx);
    const msgProductStr = msgProduct ? `User mentioned product: ${msgProduct}` : 'No product in message';
    const msgLocationStr = msgLocation ? `User mentioned location: ${msgLocation}` : 'No location in message';

    // Detect if this is a follow-up to a previous query
    const isFollowUp = ctx?.currentIntent && ctx?.currentIntent !== 'general_inquiry' && ctx?.currentIntent !== 'start';
    const followUpHint = isFollowUp ? `Previous intent was: ${ctx.currentIntent}` : '';

    // IMPORTANT: Special follow-up detection for recommendation context
    // When ctx.currentIntent = "recommendation" AND product is in context (e.g., BioNatto Plus),
    // AND user says a simple acknowledgment word (yes, yeah, sure, ok, more, interested),
    // this means user wants MORE INFO about the previously recommended product
    let recommendationFollowUpHint = '';
    if (ctx?.currentIntent === 'recommendation' && ctx?.product) {
        recommendationFollowUpHint = `CRITICAL: Context shows a product (${ctx.product}) was just recommended. User said: "${userMessage}". If this is an acknowledgment word â†’ they want product INFO â†’ intent="product_info", action="execute", product="${ctx.product}"`;
    }

    const systemPrompt = `You are DynaBot, a health supplement assistant for Dyna-Nutrition.

Decide what the user wants and what action to take.

INTENTS:
- price_check: asking about price/cost/money (NOT store locations!)
- store_locator: ONLY when explicitly asking where to buy/find stores (NOT price queries!)
- product_info: asking about benefits/ingredients/dosage/info
- purchase_intent: wanting to buy/order
- recommendation: asking for suggestions OR mentioning health conditions/needs (e.g., "I have joint pain", "need something for hair loss", "looking for immune support", "what should I take for [issue]")
- general_inquiry: greeting, thanks, casual
- escalation: asking for human agent

IMPORTANT: recommendation intent should be triggered when:
- User explicitly asks for recommendation
- User mentions health symptoms/conditions (joint pain, hair loss, weak immunity, skin issues, etc.)
- User describes desired outcomes (anti-aging, better skin, stronger hair)
- User mentions ingredient interests (collagen, vitamin c, zinc, probiotics)

CONTEXT-AWARE FOLLOW-UP RULES (IMPORTANT):
When the user says a brief acknowledgment ("yes", "yeah", "sure", "ok", "please", "more", "tell me more", etc.) WITHOUT other specific content:
1. Check the conversation history and previous bot message
2. Infer what the user is agreeing to based on context
3. Set the appropriate intent

Common scenarios:
- Bot asked "Want to know more?" â†’ User wants product details â†’ intent="product_info"
- Bot asked "Interested to know more?" â†’ User wants product details â†’ intent="product_info"
- Bot asked "Would you like to check price?" â†’ User wants price â†’ intent="price_check"
- Bot asked "Interested in where to buy?" â†’ User wants stores â†’ intent="store_locator"
- Bot asked "Want another option?" â†’ User wants alternative â†’ intent="recommendation"

SPECIAL RULE FOR RECOMMENDATION CONTEXT:
- If context shows currentIntent="recommendation" AND a product was mentioned (e.g., ${ctx?.product || "BioNatto Plus"})
- And user says "yes", "yeah", "sure", "ok", "more", "interested" â†’ intent="product_info", action="execute"
- This is because after recommending a product, user saying "yes" typically means "tell me more about it"

PRODUCT CONTEXT SWITCHING (CRITICAL - when a product is in context):
- If context shows a product was previously discussed (currentIntent is "recommendation", "product_info", or "purchase_intent")
  AND user asks "how much?", "price?", "cost?", "rm", "expensive?", "cheap?" â†’ intent="price_check", action="execute", use ctx.product
- If context shows a product was previously discussed
  AND user asks "where to buy?", "store?", "pharmacy?", "watsons?", "guardian?", "buy it?", "near me?" â†’ intent="store_locator", action="execute", use ctx.product
- The product from context should be used automatically - never leave product as null when ctx.product exists

Return: {intent, action, text, product, location}

ACTION RULES (IMPORTANT):
1. If intent is price_check, store_locator, OR product_info â†’ ALWAYS use action="execute"
2. If intent is purchase_intent and you know the product â†’ use action="execute"
3. Only use action="respond" for general_inquiry, escalation, or when truly done
4. NEVER use action="respond" for intents that need external data (prices, stores, product info)

Context: ${contextStr}${toolContextStr}${toolContextStr2}
${msgProductStr}
${msgLocationStr}
${followUpHint}
${recommendationFollowUpHint}

IMPORTANT RULES FOR CONTEXT:
- "How about Malaysia?" when previous was price_check â†’ intent=price_check (they want price for Malaysia)
- "Subang jaya" alone â†’ likely a location follow-up to a previous store query
- Location words alone (Singapore, KL, Subang) are often follow-ups, not new store queries

Return JSON: {intent, action, text, product: "name or null", location: "location or null"}

EXAMPLES:
- "Price?" â†’ {"intent": "price_check", "action": "execute", "product": null, "location": null}
- "How about Malaysia?" after price query â†’ {"intent": "price_check", "action": "execute", "product": null, "location": "malaysia"}
- "How about Singapore?" â†’ {"intent": "price_check", "action": "execute", "product": null, "location": "singapore"}
- "Where to buy BioNatto?" â†’ {"intent": "store_locator", "action": "execute", "product": "BioNatto", "location": null}
- "Subang jaya" after store query â†’ {"intent": "store_locator", "action": "execute", "product": null, "location": "subang jaya"}
- "I have joint pain" â†’ {"intent": "recommendation", "action": "execute", "product": null, "location": null}
- "my hair is falling out" â†’ {"intent": "recommendation", "action": "execute", "product": null, "location": null}
- "looking for something with collagen" â†’ {"intent": "recommendation", "action": "execute", "product": null, "location": null}
- "recommend something for immune support" â†’ {"intent": "recommendation", "action": "execute", "product": null, "location": null}
- "what should I take for anti-aging?" â†’ {"intent": "recommendation", "action": "execute", "product": null, "location": null}`;

    const userPrompt = `History:\n${shortHistory}\n\nCurrent: ${userMessage}\n\nWhat does user want? Return JSON with intent, action (respond/ask/execute/escalate), text (short reply if respond or ask), and product (detected product name or null). Example: {"intent": "product_info", "action": "execute", "product": "GlucoPal"}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 second timeout

        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.1,
                max_tokens: 300
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: controller.signal,
                timeout: 25000
            }
        );

        clearTimeout(timeoutId);
        const content = response.data.choices[0].message.content.trim();

        // Try to parse JSON
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const result = JSON.parse(jsonMatch[0]);
                console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] LLM: intent=${result.intent}, action=${result.action}, product=${result.product}, location=${result.location}`);

                // Force execute for tool-dependent intents
                const toolIntents = ['price_check', 'store_locator', 'product_info', 'purchase_intent', 'recommendation'];
                let finalAction = result.action;
                if (toolIntents.includes(result.intent) && result.action === 'respond') {
                    finalAction = 'execute';
                    console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] Forced action=execute for ${result.intent}`);
                }

                // Use LLM's product/location or fall back to detection
                const extractedProduct = result.product || msgProduct || ctx?.product;
                const extractedLocation = result.location || msgLocation || ctx?.location;

                // Follow-up detection: if user only sent a location and previous was store_locator, continue store_locator
                let finalIntent = result.intent;
                if (!msgProduct && msgLocation && ctx?.currentIntent === 'store_locator') {
                    finalIntent = 'store_locator';
                    console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] Follow-up: continuing store_locator with location ${msgLocation}`);
                }

                return {
                    text: result.text || null,
                    intent: finalIntent,
                    action: finalAction,
                    product: extractedProduct,
                    location: extractedLocation
                };
            } catch (e) {
                console.log(`âŒ [CONV MANAGER] JSON parse failed: ${e.message}`);
                // JSON parse failed, use content as text
            }
        }

        // If no valid JSON, treat as general response
        return { text: content, intent: 'general_inquiry', action: 'respond' };

    } catch (err) {
        console.error(`âŒ [CONV MANAGER] LLM failed: ${err.message}`);
        return fallbackAnalysis(userMessage, ctx);
    }
}

// ==================== Fallback Analysis (Improved) ====================

function fallbackAnalysis(userMessage, ctx) {
    const product = detectProduct(userMessage, ctx);
    const location = detectLocation(userMessage, ctx);
    const { intent, confidence } = detectIntent(userMessage, ctx);

    // If product detected from context but not from message, use context
    const finalProduct = product || ctx?.product || null;
    const finalLocation = location || ctx?.location || null;

    // Handle follow-up cases for price_check
    let finalIntent = intent;
    if (intent === 'general_inquiry' && ctx?.currentIntent === 'price_check' && finalProduct) {
        // User is following up on a price query (e.g., "How about Malaysia?" after "Price?")
        finalIntent = 'price_check';
    }

    // Handle follow-up cases for store_locator
    if (intent === 'general_inquiry' && ctx?.currentIntent === 'store_locator' && !finalProduct && finalLocation) {
        // User sent just a location as follow-up to store query
        finalIntent = 'store_locator';
    }

    // Handle "yes" after recommendation (fallback when no LLM)
    if (ctx?.currentIntent === 'recommendation' && finalIntent === 'general_inquiry') {
        const lowerMsg = userMessage.toLowerCase();
        if (/\b(yes|yeah|yep|sure|ok|yup|more|details|tell\s*me\s*more|want\s*to\s*know|interested)\b/.test(lowerMsg)) {
            finalIntent = 'product_info';
            console.log(`í ½í³Œ [CONV MANAGER] Follow-up: detected "yes" after recommendation â†’ product_info`);
        }
    }

    // Determine missing info
    const missing = [];
    if (finalIntent === 'price_check' && !finalProduct) missing.push('product');
    if (finalIntent === 'store_locator') {
        if (!finalProduct) missing.push('product');
        if (!finalLocation) missing.push('location');
    }
    if (finalIntent === 'product_info' && !finalProduct) missing.push('product');

    // If product detected but no specific intent, default to product_info
    if (finalProduct && finalIntent === 'general_inquiry') {
        finalIntent = 'product_info';
    }

    const action = missing.length > 0 ? 'ask' : (confidence >= 0.7 ? 'execute' : 'respond');

    console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] Fallback: intent=${finalIntent}, product=${finalProduct}, location=${finalLocation}, action=${action}, missing=${missing.join(',')}`);

    return {
        text: null,
        intent: finalIntent,
        product: finalProduct,
        location: finalLocation,
        missing,
        stage: missing.length > 0 ? 'gathering_info' : 'resolving',
        action,
        confidence
    };
}

// ==================== Tool Execution ====================

async function getProductInfoResponse(productName) {
    const kb = getKnowledge();
    const product = kb.products?.[productName];

    if (!product) return null;

    let response = `**${productName}**\n\n`;

    if (typeof product === 'object') {
        if (product.description) {
            response += `${product.description}\n\n`;
        }
        if (Array.isArray(product.benefits) && product.benefits.length) {
            response += `**Benefits:**\n${product.benefits.map(b => `â€¢ ${b}`).join('\n')}\n\n`;
        }
        if (Array.isArray(product.ingredients) && product.ingredients.length) {
            response += `**Ingredients:** ${product.ingredients.join(', ')}\n\n`;
        }
        if (typeof product.dosage === 'object') {
            response += `**Dosage:**\n`;
            for (const [key, value] of Object.entries(product.dosage)) {
                if (key !== 'general') response += `â€¢ ${key}: ${value}\n`;
            }
            if (product.dosage.general) response += `â€¢ General: ${product.dosage.general}\n`;
            response += '\n';
        }
        if (product.who_can_consume) {
            response += `**Suitable for:** ${product.who_can_consume}\n`;
        }
    }

    // Add brochure info
    const slug = productName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
    const brochureInfo = getSupplementaryInfo(slug);
    if (brochureInfo) {
        response += `---\n${brochureInfo}`;
    }

    return response.trim();
}

// ==================== Currency Detection (for price queries) ====================

const CURRENCY_MAP = {
    'malaysia': 'MYR',
    'my': 'MYR',
    'kl': 'MYR',
    'kuala lumpur': 'MYR',
    'selangor': 'MYR',
    'penang': 'MYR',
    'johor': 'MYR',
    'singapore': 'SGD',
    'sg': 'SGD',
    'indonesia': 'IDR',
    'id': 'IDR',
    'thailand': 'THB',
    'th': 'THB',
    'philippines': 'PHP',
    'ph': 'PHP',
    'vietnam': 'VND',
    'vn': 'VND',
    'hk': 'HKD',
    'hong kong': 'HKD'
};

function detectRequestedCurrency(userMessage, ctx) {
    const lowerMsg = userMessage.toLowerCase();

    // Check for explicit currency mentions
    for (const [key, currency] of Object.entries(CURRENCY_MAP)) {
        if (lowerMsg.includes(key)) {
            return currency;
        }
    }

    // Check for currency symbols in message
    if (lowerMsg.includes('rm ')) return 'MYR';
    if (lowerMsg.includes('s$') || lowerMsg.includes('sgd')) return 'SGD';

    return null;
}

// ==================== Helper Functions for Intent Switching ====================

// Check if message is asking about price
function isPriceQuery(msg) {
    const lowerMsg = msg.toLowerCase();
    return /\b(price|cost|how much|money|rm\s|s\$|sgd|expensive|cheap)\b/i.test(lowerMsg);
}

// Check if message is asking about where to buy/store
function isStoreQuery(msg) {
    const lowerMsg = msg.toLowerCase();
    const storeKeywords = ['where to buy', 'where can i buy', 'where to get', 'buy it', 'store', 'stores', 'shop', 'pharmacy', 'watsons', 'guardian', 'caring', 'retail', 'near me', 'nearby'];
    return storeKeywords.some(k => lowerMsg.includes(k));
}

async function executeTool(analysis, userMessage, userId, apiKey, phoneNumber) {
    // Get product and location from analysis OR from context
    const ctx = getContext(userId);
    const product = analysis.product || ctx?.product;
    const location = analysis.location || ctx?.location;

    switch (analysis.intent) {
        case 'price_check':
            if (product) {
                console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] Calling priceApi.getProductPrice(${product}, ${phoneNumber}, apiKey)`);

                // Detect if user requested a specific currency/location
                const requestedCurrency = detectRequestedCurrency(userMessage, ctx);
                if (requestedCurrency) {
                    console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] User requested currency: ${requestedCurrency}`);
                }

                const priceInfo = await getProductPrice(product, phoneNumber, apiKey, requestedCurrency);
                if (priceInfo && priceInfo.prices?.length > 0) {
                    return formatPriceResponse(product, priceInfo, requestedCurrency);
                }
                return `I don't have pricing info for ${product} right now. Would you like to know about the product instead?`;
            }
            break;

        case 'store_locator':
            // Track the product in storeLocator for context
            if (product) {
                const normalizedSlug = normalizeProductSlug(product);
                trackMentionedProduct(normalizedSlug);
            }

            if (product && location) {
                // Both product and location - search for stores
                // hasProductContext=true because user mentioned both product and location
                console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] Calling storeLocator.findStores("${product} near ${location}", apiKey, true)`);
                const result = await findStores(`${product} near ${location}`, apiKey, true);
                if (typeof result === 'string') {
                    return result;
                }
                if (result.noContext) {
                    return result.text;
                }
                if (result.needsLocation) {
                    return result.text;
                }
                if (!result.stores || result.stores.length === 0) {
                    return result.text || `Sorry, couldn't find stores for ${product} near ${location}.`;
                }
                return result.text;
            }
            if (product) {
                return `To find stores near you, please share your location (e.g., "in Singapore" or "near KL")`;
            }
            if (location) {
                return `Which product are you looking for? I have info on BioNatto Plus, GlucoPal, Tricollagen, and more.`;
            }
            return `Which product are you looking for, and where are you located?`;

        case 'product_info':
            if (product) {
                console.log(`í ½í´µ [CONV MANAGER] Getting product info for: ${product}`);

                // TIER 1: Knowledge Base (JSON + Brochure)
                //console.log(`   [TIER 1] Checking knowledge base...`);
                //const info = await getProductInfoResponse(product);
                //if (info) {
                //    console.log(`   [TIER 1] âœ… Found in knowledge base`);
                //    return info;
                //}

                // TIER 1.5: DeepSeek with knowledge base
                console.log(`   [TIER 1.5] Calling DeepSeek with knowledge base...`);
                const kb = getKnowledge();
                const kbPrompt = buildKnowledgePrompt(product);
                const tier15Messages = [
                    { role: "system", content: kbPrompt },
                    { role: "user", content: `Tell me about ${product}` }
                ];
                const tier15Reply = await callDeepSeekWithRetry(tier15Messages, apiKey);

                if (tier15Reply) {
                    const unknownPhrases = ["don't have", "not in the knowledge", "i don't know", "can't answer", "not sure"];
                    const isUncertain = unknownPhrases.some(k => tier15Reply.toLowerCase().includes(k));

                    if (!isUncertain) {
                        console.log(`   [TIER 1.5] âœ… DeepSeek responded successfully`);
                        return tier15Reply;
                    }
                }

                // TIER 2: Product page + internal links search
                console.log(`   [TIER 2] Checking product page...`);
                const productUrl = getProductUrl(kb, product);
                if (productUrl) {
                    const productPageContent = await fetchProductPageAndLinks(productUrl, 3);
                    if (productPageContent) {
                        const tier2Prompt = `You are DynaBot. Answer the user based ONLY on the product page content below. If answer not found, say exactly "I cannot find the answer on the product page."\nUSER: Tell me about ${product}\nPRODUCT PAGE CONTENT: ${productPageContent.substring(0, 2500)}`;
                        const tier2Messages = [
                            { role: "system", content: tier2Prompt },
                            { role: "user", content: `Tell me about ${product}` }
                        ];
                        const tier2Reply = await callDeepSeekWithRetry(tier2Messages, apiKey);

                        if (tier2Reply && !tier2Reply.toLowerCase().includes("cannot find the answer on the product page")) {
                            console.log(`   [TIER 2] âœ… Found on product page`);
                            return tier2Reply;
                        }
                    }
                }

                // TIER 3: Website search
                console.log(`   [TIER 3] Searching website...`);
                const searchQuery = `${product} health supplement benefits`;
                const siteResults = await searchWebsite(searchQuery);
                if (siteResults && siteResults.length > 100) {
                    const tier3Prompt = `You are DynaBot. Answer the user based ONLY on the search results below. If answer not found, say exactly "I cannot find the answer in the search results."\nUSER: Tell me about ${product}\nRESULTS: ${siteResults.substring(0, 2000)}`;
                    const tier3Messages = [
                        { role: "system", content: tier3Prompt },
                        { role: "user", content: `Tell me about ${product}` }
                    ];
                    const tier3Reply = await callDeepSeekWithRetry(tier3Messages, apiKey);

                    if (tier3Reply && !tier3Reply.toLowerCase().includes("cannot find the answer")) {
                        console.log(`   [TIER 3] âœ… Found via website search`);
                        return tier3Reply;
                    }
                }

                // Fallback if all tiers fail
                return `I have basic info for ${product}, but for more detailed information, please visit our website or speak with a consultant.`;
            }
            return `Which product would you like to know about? I have info on BioNatto Plus, GlucoPal, Tricollagen, and more.`;

        case 'purchase_intent':
            if (product) {
                return `Great choice! ${product} is available on our website. Would you like me to show you where to buy it or check the price?`;
            }
            return `What product are you interested in ordering?`;

        case 'recommendation':
            // Use the new LLM-driven recommendation engine
            const recResponse = await getRecommendation(userMessage, apiKey);
            if (recResponse) {
                // Extract product name and text from response (handles both string and object)
                const recText = typeof recResponse === 'string' ? recResponse : recResponse.text;
                const recProduct = typeof recResponse === 'object' ? recResponse.productName : null;

                // Store in context for follow-up handling (same pattern as price_check)
                if (recProduct) {
                    updateContext(userId, {
                        currentIntent: 'recommendation',
                        product: recProduct,
                        conversationStage: 'post_recommendation'
                    });
                    console.log(`í ½í³Œ [CONV MANAGER] Stored recommendation context: product=${recProduct}`);
                }

                return recText;
            }
            // Fallback if engine returns nothing
            return `I'd love to help! Could you tell me what health concern you're looking to address? For example:\nâ€¢ Joint health\nâ€¢ Blood sugar support\nâ€¢ Skin & beauty\nâ€¢ Immune support`;

        case 'escalation':
            return `I'll connect you with a human agent. Please hold on...`;

        case 'general_inquiry':
            // Generate a greeting/response based on context
            if (product) {
                return `You mentioned ${product}. Would you like to know more about it? I can help with:\nâ€¢ Price info\nâ€¢ Where to buy\nâ€¢ Product details`;
            }
            return null; // Let the main function handle this
    }

    return null;
}

// ==================== Main Processing Function ====================

async function processMessage(userMessage, history, userId, apiKey, phoneNumber) {
    console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] Processing: "${userMessage.substring(0, 50)}..."`);

    const ctx = getContext(userId);

    // Step 1: Try LLM analysis first, fall back to regex
    let analysis = await analyzeWithLLM(userMessage, history, userId, apiKey);

    // Ensure we have product/location from context
    if (!analysis.product && ctx?.product) analysis.product = ctx.product;
    if (!analysis.location && ctx?.location) analysis.location = ctx.location;

    // ==================== Post-LLM Follow-Up Detection (Fallback) ====================
    // Check if user gave a simple acknowledgment ("yes", "yeah", etc.) after recommendation
    // This is a fallback in case the LLM didn't detect the follow-up pattern
    const lowerMsg = userMessage.toLowerCase().trim();
    const isSimpleAck = /^(yes|yeah|yep|sure|ok|yup|more|details|tell\s*me\s*more|interested|yes\s+(please|do|tell))$/i.test(lowerMsg);

    // If previous was recommendation AND context has a product AND user just said "Yes" (or similar)
    // AND LLM returned recommendation (not product_info), switch to product_info
    if (ctx?.currentIntent === 'recommendation' && ctx?.product && isSimpleAck && analysis.intent !== 'product_info') {
        console.log(`í ½í³Œ [CONV MANAGER] Post-LLM Follow-up: "Yes" after recommendation â†’ switching to product_info for ${ctx.product}`);
        analysis.intent = 'product_info';
        analysis.action = 'execute';
        analysis.product = ctx.product; // Ensure product is set from context
    }

    // ==================== Intent Switching for Price/Store Follow-ups ====================
    // When context has a product (from recommendation or product_info) AND user asks about price/store
    // We need to switch the intent to price_check or store_locator

    // 1. Switch to price_check if context has product AND user asks about price
    if (ctx?.product && isPriceQuery(userMessage) && analysis.intent !== 'price_check') {
        console.log(`í ½í´„ [CONV MANAGER] Context has product (${ctx.product}) + price query â†’ switching to price_check`);
        analysis.intent = 'price_check';
        analysis.action = 'execute';
        analysis.product = ctx.product; // Use product from context
    }

    // 2. Switch to store_locator if context has product AND user asks where to buy
    if (ctx?.product && isStoreQuery(userMessage) && analysis.intent !== 'store_locator') {
        console.log(`í ½í´„ [CONV MANAGER] Context has product (${ctx.product}) + store query â†’ switching to store_locator`);
        analysis.intent = 'store_locator';
        analysis.action = 'execute';
        analysis.product = ctx.product; // Use product from context
    }

    // Step 2: Update context
    updateContext(userId, {
        currentIntent: analysis.intent,
        product: analysis.product,
        location: analysis.location,
        conversationStage: analysis.stage || 'resolving',
        turnsOnTopic: ctx ? ctx.turnsOnTopic + 1 : 1
    });

    // Step 3: Determine response
    let responseText = analysis.text;

    // Safety check: Force execute for tool-dependent intents (even if LLM returned respond)
    const toolIntents = ['price_check', 'store_locator', 'product_info', 'purchase_intent', 'recommendation'];
    if (toolIntents.includes(analysis.intent)) {
        const hasProduct = analysis.product || ctx?.product;
        const hasLocation = analysis.location || ctx?.location;
        const needsLocation = analysis.intent === 'store_locator';
        // Recommendation intent doesn't need product/location, so skip the check
        const needsProduct = analysis.intent !== 'recommendation';

        // If we have product (and location if needed), force execute
        if (!needsProduct || (hasProduct && (!needsLocation || hasLocation))) {
            analysis.action = 'execute';
            console.log(`ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ [CONV MANAGER] Safety override: forcing action=execute for ${analysis.intent}`);
        }
    }

    // If action is ask, generate the question
    if (analysis.action === 'ask' && analysis.missing?.length > 0) {
        const missing = analysis.missing[0];
        if (missing === 'product') {
            responseText = analysis.text || `I'd be happy to help! Which product are you interested in?\n\nYou can choose from BioNatto Plus, GlucoPal, Tricollagen, Men Guard, and more.`;
        } else if (missing === 'location') {
            responseText = analysis.text || `To find stores near you, please share your location.\n\nFor example: "in Singapore" or "near KL"`;
        }
    }

    // If action is execute, run the tool
    if (analysis.action === 'execute') {
        const toolResult = await executeTool(analysis, userMessage, userId, apiKey, phoneNumber);
        if (toolResult) {
            responseText = toolResult;
        }
    }

    // If action is escalate
    if (analysis.action === 'escalate') {
        responseText = analysis.text || `I'll connect you with a human agent. One moment please...`;
        clearContext(userId);
    }

    // If still no response (general inquiry with no product context)
    if (!responseText) {
        const lowerMsg = userMessage.toLowerCase();
        if (/\b(hi|hello|hey|good|hi there)\b/.test(lowerMsg)) {
            responseText = `Hi there! I'm DynaBot, your personal assistant for Dyna-Nutrition health supplements!

I'm here to help you with:

ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Product Information - Learn about our supplements including BioNatto Plus, Men Guard, Tricollagen, AshiSlim and more. I'll tell you about benefits, ingredients, recommended dosage, and who they're suitable for.

ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Pricing

ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Where to Buy - Find the nearest stores, pharmacies, and retailers carrying our products.

ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Recommendations - Not sure which product is right for you? Just tell me your health concern, and I'll suggest suitable options!

Feel free to ask me anything - whether it's about a specific product, pricing in your country, or where to buy near you. What would you like to know? ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½`;
        } else if (/\b(thank|thanks)\b/.test(lowerMsg)) {
            responseText = `You're welcome! It's my pleasure to help! If you have any more questions about our products, pricing, or where to find them, just let me know anytime. Take care! ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½`;
        } else if (/\b(goodbye|bye|see you)\b/.test(lowerMsg)) {
            responseText = `Goodbye! It was great chatting with you! Remember, Dyna-Nutrition is here to support your health journey. Feel free to come back anytime you have questions. Take care and stay healthy! ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½`;
        } else {
            responseText = `I'm here to help! Here's what I can do for you:

ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Product Info - Benefits, ingredients, dosage
ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Pricing - Latest product price
ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Store Locator - Find where to buy near you
ï¿½ï¿½ï¿½ï¿½ï¿½ï¿½ Recommendations - Suggest products for your needs

What would you like to know? Just ask!`;
        }
    }

    // Track product for store context
    if (analysis.product) {
        trackMentionedProduct(analysis.product.toLowerCase().replace(/\s+/g, '-'));
    }

    console.log(`âœ… [CONV MANAGER] Response: "${responseText.substring(0, 80)}..."`);

    return {
        text: responseText,
        intent: analysis.intent,
        product: analysis.product,
        imageUrl: null,
        needsEscalation: analysis.action === 'escalate'
    };
}

// ==================== Legacy Compatibility ====================

async function analyzeIntentWithLLM(userMessage, apiKey, productNames = [], conversationHistory = []) {
    const result = fallbackAnalysis(userMessage, getContext('legacy'));
    return {
        intent: result.intent || 'general_inquiry',
        confidence: result.confidence || 0.8,
        detectedProduct: result.product,
        detectedLocation: result.location,
        detectedCurrency: null,
        isFollowUp: conversationHistory.length > 2,
        missingInfo: result.missing || [],
        shouldSwitchIntent: true,
        reasoning: 'LLM-based analysis'
    };
}

// ==================== Initialization ====================

loadContexts();

// Periodic cleanup
setInterval(() => {
    const now = Date.now();
    for (const [userId, ctx] of userContexts.entries()) {
        if (ctx.lastUpdated && (now - ctx.lastUpdated > CONTEXT_TTL)) {
            userContexts.delete(userId);
        }
    }
    if (userContexts.size > 0) saveContexts();
}, 5 * 60 * 1000);

module.exports = {
    processMessage,
    analyzeIntentWithLLM,
    getContext,
    updateContext,
    clearContext,
    getProductInfo: getProductInfoResponse,
    generateProductInfoResponse: getProductInfoResponse
};