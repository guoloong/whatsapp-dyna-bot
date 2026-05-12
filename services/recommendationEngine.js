// services/recommendationEngine.js
// LLM-Driven Smart Recommendation System
// Reads products directly from config/products/*.json

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Path to products directory
const PRODUCTS_DIR = path.join(__dirname, '..', 'config', 'products');

// Intent detection prompt
const INTENT_DETECTION_PROMPT = `You are DynaBot, a health supplement expert for Dyna-Nutrition.

Analyze the user's message and determine if they need a product recommendation.

User message: "{userMessage}"

These signals indicate recommendation needs:
- Explicit: "recommend", "suggest", "which is best", "what should I take"
- Health conditions: joint pain, hair loss, weak immunity, skin issues, etc.
- Desired outcomes: "I want better skin", "need something for anti-aging"
- Ingredient interests: collagen, vitamin c, zinc, probiotics, etc.
- Product function: describing what they want a product to do

Return ONLY valid JSON:
{
    "needsRecommendation": true/false,
    "confidence": 0.0-1.0,
    "extractedNeeds": ["list of needs/conditions mentioned"],
    "reasoning": "brief explanation"
}`;

// Product matching prompt
const PRODUCT_MATCHING_PROMPT = `You are DynaBot, a health supplement expert for Dyna-Nutrition.

Match the user's needs to products from the catalog.

USER NEEDS: {userNeeds}

PRODUCT CATALOG:
{productCatalog}

Return ONLY valid JSON with top 1-2 best matches:
{
    "recommendations": [
        {
            "productName": "exact product name",
            "matchScore": 0.0-1.0,
            "whyItFits": "1-2 sentences why this product matches",
            "keyHighlights": ["2-3 most relevant benefits/ingredients"]
        }
    ]
}`;

// Response generation prompt - CONCISE VERSION
const RESPONSE_GENERATION_PROMPT = `You are DynaBot, a friendly health supplement advisor.

Generate a brief, friendly recommendation response.

USER'S MESSAGE: "{userMessage}"

RECOMMENDED PRODUCT: {recommendation}

Guidelines:
- Keep it conversational and warm
- Max 2-3 short paragraphs
- Include: brief acknowledgment + product name + why it fits + 2 key highlights
- End with simple question like "Want to know more?" or "Interested?"
- Don't overwhelm with details - just the essentials
- Don't use bullet points - write naturally

Return ONLY the response text.`;

// Load products directly from config/products/*.json
function loadProductsFromFiles() {
    try {
        const files = fs.readdirSync(PRODUCTS_DIR).filter(f => f.endsWith('.json'));
        const products = {};

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(PRODUCTS_DIR, file), 'utf8');
                const product = JSON.parse(content);
                // Use the 'name' field from the JSON
                const name = product.name || file.replace('.json', '');
                products[name] = product;
            } catch (err) {
                console.warn(`⚠️ [RECOMMENDATION] Failed to parse ${file}: ${err.message}`);
            }
        }

        console.log(`📦 [RECOMMENDATION] Loaded ${Object.keys(products).length} products from files`);
        return products;
    } catch (err) {
        console.error(`❌ [RECOMMENDATION] Failed to load products: ${err.message}`);
        return {};
    }
}

// Format product catalog for LLM (concise)
function formatProductCatalog(products) {
    let catalog = '';

    for (const [name, product] of Object.entries(products)) {
        const benefits = Array.isArray(product.benefits)
            ? product.benefits.slice(0, 5).join('; ')  // Limit to 5 benefits
            : 'N/A';
        const ingredients = Array.isArray(product.ingredients)
            ? product.ingredients.slice(0, 5).join(', ')  // Limit to 5 ingredients
            : 'N/A';
        const suitable = product.who_can_consume || 'N/A';

        catalog += `\n${name}\n`;
        catalog += `Benefits: ${benefits}\n`;
        catalog += `Ingredients: ${ingredients}\n`;
        catalog += `For: ${suitable}\n`;
    }

    return catalog;
}

// Detect recommendation intent using LLM
async function detectRecommendationIntent(userMessage, apiKey) {
    if (!apiKey) {
        return detectIntentFallback(userMessage);
    }

    const prompt = INTENT_DETECTION_PROMPT.replace('{userMessage}', userMessage);

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are an intent analyzer. Return ONLY valid JSON.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                max_tokens: 250
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
            console.log(`🎯 [RECOMMENDATION] Intent: needsRecommendation=${result.needsRecommendation}, confidence=${result.confidence}`);
            return result;
        }
    } catch (err) {
        console.error(`❌ [RECOMMENDATION] Intent detection failed: ${err.message}`);
    }

    return detectIntentFallback(userMessage);
}

// Fallback intent detection
function detectIntentFallback(userMessage) {
    const lowerMsg = userMessage.toLowerCase();

    const patterns = [
        /\b(recommend|suggest|which.*best|what.*should|take)\b/,
        /\b(joint|hair|skin|immune|blood|energy|digest|sleep|stress)\b.*\b(pain|loss|problem|weak|support|aging)\b/,
        /\b(want|need|looking)\b.*\b(hair|skin|joint|immune|anti)\b/,
        /\b(collagen|vitamin|probiotic|zinc|omega)\b.*\b(good|best|help|supplement)\b/
    ];

    const matched = patterns.some(p => p.test(lowerMsg));

    return {
        needsRecommendation: matched,
        confidence: matched ? 0.7 : 0,
        extractedNeeds: matched ? [userMessage] : [],
        reasoning: matched ? 'Pattern match detected' : 'No recommendation signals'
    };
}

// Find matching products using LLM
async function findMatchingProducts(userNeeds, apiKey) {
    const products = loadProductsFromFiles();

    if (Object.keys(products).length === 0) {
        console.warn(`⚠️ [RECOMMENDATION] No products loaded`);
        return { recommendations: [] };
    }

    if (!apiKey) {
        // Simple matching without LLM
        return simpleProductMatch(userNeeds, products);
    }

    const productCatalog = formatProductCatalog(products);
    const prompt = PRODUCT_MATCHING_PROMPT
        .replace('{userNeeds}', userNeeds.join('; '))
        .replace('{productCatalog}', productCatalog);

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a product matcher. Return ONLY valid JSON.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 500
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 20000
            }
        );

        const content = response.data.choices[0].message.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            console.log(`🏆 [RECOMMENDATION] Found ${result.recommendations?.length || 0} matches`);
            return result;
        }
    } catch (err) {
        console.error(`❌ [RECOMMENDATION] Product matching failed: ${err.message}`);
    }

    return simpleProductMatch(userNeeds, products);
}

// Simple product matching without LLM
function simpleProductMatch(userNeeds, products) {
    const needs = userNeeds.join(' ').toLowerCase();

    const scored = [];

    for (const [name, product] of Object.entries(products)) {
        let score = 0;
        const benefits = (product.benefits || []).join(' ').toLowerCase();
        const ingredients = (product.ingredients || []).join(' ').toLowerCase();
        const desc = (product.description || '').toLowerCase();
        const combined = benefits + ' ' + ingredients + ' ' + desc;

        // Score based on keyword matches
        const keywords = ['joint', 'hair', 'skin', 'immune', 'blood sugar', 'energy', 'collagen', 'vitamin', 'probiotic'];
        for (const kw of keywords) {
            if (needs.includes(kw) && combined.includes(kw)) {
                score += 10;
            }
        }

        if (score > 0) {
            scored.push({ name, product, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, 1); // Only top match

    return {
        recommendations: top.map(s => ({
            productName: s.name,
            matchScore: s.score / 30,
            whyItFits: 'Matches your mentioned needs',
            keyHighlights: s.product.benefits?.slice(0, 2) || []
        }))
    };
}

// Generate concise response
async function generateResponse(userMessage, recommendation, apiKey) {
    if (!recommendation?.recommendations?.length) {
        return null;
    }

    const rec = recommendation.recommendations[0]; // Only top recommendation

    if (!apiKey) {
        const fallbackText = generateFallbackResponse(rec);
        return {
            text: fallbackText,
            productName: rec.productName
        };
    }

    const prompt = RESPONSE_GENERATION_PROMPT
        .replace('{userMessage}', userMessage)
        .replace('{recommendation}', JSON.stringify(rec));

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'You are a friendly advisor. Return ONLY the response text.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 400  // Limit response length
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                timeout: 15000
            }
        );

        const content = response.data.choices[0].message.content.trim();
        console.log(`✅ [RECOMMENDATION] Response generated (${content.length} chars)`);

        // Return both text and product name for context tracking
        return {
            text: content,
            productName: rec.productName
        };
    } catch (err) {
        console.error(`❌ [RECOMMENDATION] Response generation failed: ${err.message}`);
    }

    const fallbackText = generateFallbackResponse(rec);
    return {
        text: fallbackText,
        productName: rec.productName
    };
}

// Fallback response
function generateFallbackResponse(rec) {
    return `Based on what you've mentioned, I think **${rec.productName}** could be a great fit for you!

${rec.whyItFits}

Here are some highlights:
• ${rec.keyHighlights?.join('\n• ') || 'Tailored to your needs'}

Would you like to know more about ${rec.productName}?`;
}

// Main entry point
async function getRecommendation(userMessage, apiKey) {
    console.log(`🎯 [RECOMMENDATION] Processing: "${userMessage.substring(0, 50)}..."`);

    // Step 1: Detect intent
    const intent = await detectRecommendationIntent(userMessage, apiKey);

    if (!intent.needsRecommendation || intent.confidence < 0.5) {
        console.log(`ℹ️ [RECOMMENDATION] No recommendation needed`);
        return null;
    }

    // Step 2: Find matching products
    const matches = await findMatchingProducts(intent.extractedNeeds, apiKey);

    if (!matches.recommendations?.length) {
        console.log(`ℹ️ [RECOMMENDATION] No matching products found`);
        return null;
    }

    // Step 3: Generate concise response
    const response = await generateResponse(userMessage, matches, apiKey);

    return response;
}

module.exports = { getRecommendation };