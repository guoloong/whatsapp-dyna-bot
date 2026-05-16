/**
 * Unified Context Manager (LLM-Aware)
 * - Single source of truth for user context
 * - Maintains recent conversation history for LLM
 * - NO interpretation logic - only storage
 * - All interpretation done by LLM
 */

const MAX_HISTORY = 10; // Limit recent messages sent to LLM
const CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 minutes

let userContexts = new Map();

/**
 * Get context for user - just data, no interpretation
 */
function getContext(userId) {
    const ctx = userContexts.get(userId);
    if (!ctx) return createEmptyContext(userId);

    // Check TTL
    if (Date.now() - ctx.lastUpdated > CONTEXT_TTL_MS) {
        userContexts.delete(userId);
        return createEmptyContext(userId);
    }

    return ctx;
}

/**
 * Update context - LLM decides what to update
 */
function updateContext(userId, updates) {
    let ctx = getContext(userId);

    if (updates.entities) {
        ctx.entities = { ...ctx.entities, ...updates.entities };
    }
    if (updates.intent) {
        ctx.intent = updates.intent;
    }
    if (updates.history) {
        ctx.history = ctx.history.concat(updates.history);

        // Trim to MAX_HISTORY
        if (ctx.history.length > MAX_HISTORY) {
            ctx.history = ctx.history.slice(-MAX_HISTORY);
        }
    }

    ctx.lastUpdated = Date.now();
    userContexts.set(userId, ctx);

    return ctx;
}

/**
 * Add a single message to history
 */
function addToHistory(userId, role, content) {
    const ctx = getContext(userId);
    ctx.history.push({
        role,
        content,
        timestamp: Date.now()
    });

    // Trim to MAX_HISTORY
    if (ctx.history.length > MAX_HISTORY) {
        ctx.history = ctx.history.slice(-MAX_HISTORY);
    }

    ctx.lastUpdated = Date.now();
}

/**
 * Get formatted history for LLM (last MAX_HISTORY messages)
 */
function getHistoryForLLM(userId) {
    const ctx = getContext(userId);
    return ctx.history.slice(-MAX_HISTORY).map(m => ({
        role: m.role,
        content: m.content
    }));
}

/**
 * Get current entities (product, location, currency)
 */
function getEntities(userId) {
    const ctx = getContext(userId);
    return { ...ctx.entities };
}

/**
 * Clear context for user
 */
function clearContext(userId) {
    userContexts.delete(userId);
}

/**
 * Create empty context
 */
function createEmptyContext(userId) {
    return {
        userId,
        history: [],
        entities: {
            product: null,
            location: null,
            currency: null
        },
        intent: null,
        lastUpdated: Date.now()
    };
}

module.exports = {
    getContext,
    updateContext,
    getHistoryForLLM,
    addToHistory,
    getEntities,
    clearContext,
    MAX_HISTORY
};