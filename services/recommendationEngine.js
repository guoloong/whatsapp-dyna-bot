// services/recommendationEngine.js
// LLM-Driven Smart Recommendation System
// Uses Tier 1.5 approach: knowledgeBase + brochures (same as product_info)

const axios = require('axios');

// Import from deepseek.js (knowledge prompts only)
const { buildKnowledgePrompt } = require('./deepseek');
// Import LLM helpers from utils (avoids circular dependency)
const { callDeepSeekWithRetry } = require('../utils/llmHelpers');

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

// Product matching prompt - uses buildKnowledgePrompt format for consistency
const PRODUCT_MATCHING_PROMPT = `You are DynaBot, a health supplement expert for Dyna-Nutrition.

Match the user's health needs to products from the Dyna-Nutrition catalog.

CRITICAL RULES:
1. You MUST ONLY recommend products listed in the PRODUCT CATALOG below
2. DO NOT invent, hallucinate, or modify product names
3. Each recommended productName must EXACTLY match a product name from the catalog
4. If no product matches the user's needs, return empty recommendations array
5. Consider the supplementary brochure information if provided for any product

USER'S HEALTH NEEDS: {userNeeds}

PRODUCT CATALOG:
{productCatalog}`;

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
- Use bullet points
- Use bold to highlight important details.

Return ONLY the response text.`;

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
            console.log(`     [RECOMMENDATION] Intent: needsRecommendation=${result.needsRecommendation}, confidence=${result.confidence}`);
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

// Find matching products using LLM with knowledge base + brochures (Tier 1.5)
async function findMatchingProducts(userNeeds, apiKey) {
    if (!apiKey) {
        return simpleProductMatch(userNeeds);
    }

    // Use buildKnowledgePrompt which includes ALL products + brochure content
    // Pass null as productName to get ALL products (not just one)
    console.log(`     [TIER 1.5] Building knowledge prompt with brochure content...`);
    const productCatalog = buildKnowledgePrompt(null);

    const prompt = PRODUCT_MATCHING_PROMPT
        .replace('{userNeeds}', userNeeds.join('; '))
        .replace('{productCatalog}', productCatalog);

    try {
        const messages = [
            { role: "system", content: prompt },
            { role: "user", content: `Based on the user's needs: "${userNeeds.join('; ')}". Which products would you recommend and why? Return JSON with recommendations array.` }
        ];

        const reply = await callDeepSeekWithRetry(messages, apiKey);

        if (reply) {
            // Try to extract JSON from response
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const result = JSON.parse(jsonMatch[0]);
                    console.log(`     [RECOMMENDATION] Found ${result.recommendations?.length || 0} matches`);
                    return result;
                } catch (e) {
                    console.log(`     [RECOMMENDATION] Could not parse JSON, using text response`);
                }
            }

            // If no JSON found, try to extract product name from response
            const productMatch = reply.match(/\*\*([^*]+)\*\*/);
            if (productMatch) {
                return {
                    recommendations: [{
                        productName: productMatch[1].trim(),
                        matchScore: 0.8,
                        whyItFits: 'Based on your health needs',
                        keyHighlights: []
                    }]
                };
            }
        }
    } catch (err) {
        console.error(`❌ [RECOMMENDATION] Product matching failed: ${err.message}`);
    }

    // Fallback to simple matching
    return simpleProductMatch(userNeeds);
}

// Simple product matching without LLM (fallback only)
function simpleProductMatch(userNeeds) {
    // Import knowledge loader here to avoid circular dependency
    const { getKnowledge } = require('./knowledgeLoader');
    const kb = getKnowledge();
    const needs = userNeeds.join(' ').toLowerCase();

    const scored = [];

    for (const [name, product] of Object.entries(kb.products || {})) {
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
    console.log(`     [RECOMMENDATION] Processing: "${userMessage.substring(0, 50)}..."`);

    // Step 1: Detect intent
    const intent = await detectRecommendationIntent(userMessage, apiKey);

    if (!intent.needsRecommendation || intent.confidence < 0.5) {
        console.log(`ℹ️ [RECOMMENDATION] No recommendation needed`);
        return null;
    }

    // Step 2: Find matching products (uses Tier 1.5: knowledgeBase + brochures)
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