// services/contextManager.js
// Tracks conversation context for price and store follow-up queries
// Maintains last product, last currency, and pending store product per user

const CONTEXT_TTL = 5184000000; // 60 days in milliseconds (2 months)

// In-memory context storage (per user)
const userContexts = new Map();

// Context structure per user:
// {
//   lastPriceProduct: string | null,      // Product user last asked about for price
//   lastPriceCurrency: string | null,    // Currency of last price query
//   lastPriceTimestamp: number,          // When last price query occurred
//   pendingStoreProduct: string | null,     // Product for pending store query
//   pendingStoreTimestamp: number,         // When store query was initiated
//   lastMentionedProduct: string | null,   // Any product user mentioned (for general queries)
//   lastMentionedTimestamp: number         // When product was mentioned
// }

/**
 * Get context for a user
 */
function getContext(userId) {
    const now = Date.now();
    const ctx = userContexts.get(userId);

    if (!ctx) return null;

    // Check for expired context
    const hasPriceContext = ctx.lastPriceProduct && (now - ctx.lastPriceTimestamp < CONTEXT_TTL);
    const hasStoreContext = ctx.pendingStoreProduct && (now - ctx.pendingStoreTimestamp < CONTEXT_TTL);
    const hasMentionedContext = ctx.lastMentionedProduct && (now - ctx.lastMentionedTimestamp < CONTEXT_TTL);

    if (!hasPriceContext && !hasStoreContext && !hasMentionedContext) {
        // All context expired, clean up
        userContexts.delete(userId);
        return null;
    }

    return {
        lastPriceProduct: hasPriceContext ? ctx.lastPriceProduct : null,
        lastPriceCurrency: hasPriceContext ? ctx.lastPriceCurrency : null,
        pendingStoreProduct: hasStoreContext ? ctx.pendingStoreProduct : null,
        lastMentionedProduct: hasMentionedContext ? ctx.lastMentionedProduct : null
    };
}

/**
 * Update context after a price query
 */
function updatePriceContext(userId, productName, currency) {
    const now = Date.now();
    let ctx = userContexts.get(userId);

    if (!ctx) {
        ctx = {
            lastPriceProduct: null,
            lastPriceCurrency: null,
            lastPriceTimestamp: 0,
            pendingStoreProduct: null,
            pendingStoreTimestamp: 0,
            lastMentionedProduct: null,
            lastMentionedTimestamp: 0
        };
    }

    ctx.lastPriceProduct = productName;
    ctx.lastPriceCurrency = currency;
    ctx.lastPriceTimestamp = now;

    userContexts.set(userId, ctx);
    console.log(`[CONTEXT] Updated price context for ${userId}: product=${productName}, currency=${currency}`);
}

/**
 * Update context after a store query
 */
function updateStoreContext(userId, productName) {
    const now = Date.now();
    let ctx = userContexts.get(userId);

    if (!ctx) {
        ctx = {
            lastPriceProduct: null,
            lastPriceCurrency: null,
            lastPriceTimestamp: 0,
            pendingStoreProduct: null,
            pendingStoreTimestamp: 0,
            lastMentionedProduct: null,
            lastMentionedTimestamp: 0
        };
    }

    ctx.pendingStoreProduct = productName;
    ctx.pendingStoreTimestamp = now;

    userContexts.set(userId, ctx);
    console.log(`[CONTEXT] Updated store context for ${userId}: pending product=${productName}`);
}

/**
 * Update context when user mentions any product (for general queries)
 * This allows follow-ups like "Price?" after user mentions a product in general conversation
 */
function updateMentionedProduct(userId, productName) {
    const now = Date.now();
    let ctx = userContexts.get(userId);

    if (!ctx) {
        ctx = {
            lastPriceProduct: null,
            lastPriceCurrency: null,
            lastPriceTimestamp: 0,
            pendingStoreProduct: null,
            pendingStoreTimestamp: 0,
            lastMentionedProduct: null,
            lastMentionedTimestamp: 0
        };
    }

    ctx.lastMentionedProduct = productName;
    ctx.lastMentionedTimestamp = now;

    userContexts.set(userId, ctx);
    console.log(`[CONTEXT] Updated mentioned product for ${userId}: product=${productName}`);
}

/**
 * Clear price context (when user asks unrelated question)
 */
function clearPriceContext(userId) {
    const ctx = userContexts.get(userId);
    if (ctx) {
        ctx.lastPriceProduct = null;
        ctx.lastPriceCurrency = null;
        ctx.lastPriceTimestamp = 0;
        console.log(`[CONTEXT] Cleared price context for ${userId}`);
    }
}

/**
 * Clear store context
 */
function clearStoreContext(userId) {
    const ctx = userContexts.get(userId);
    if (ctx) {
        ctx.pendingStoreProduct = null;
        ctx.pendingStoreTimestamp = 0;
        console.log(`[CONTEXT] Cleared store context for ${userId}`);
    }
}

/**
 * Clear all context for a user
 */
function clearContext(userId) {
    userContexts.delete(userId);
    console.log(`[CONTEXT] Cleared all context for ${userId}`);
}

/**
 * Check if user has valid price context
 */
function hasPriceContext(userId) {
    const ctx = getContext(userId);
    return ctx && ctx.lastPriceProduct !== null;
}

/**
 * Check if user has valid store context
 */
function hasStoreContext(userId) {
    const ctx = getContext(userId);
    return ctx && ctx.pendingStoreProduct !== null;
}

/**
 * Check if user has any product mention in context
 */
function hasMentionedProduct(userId) {
    const ctx = getContext(userId);
    return ctx && ctx.lastMentionedProduct !== null;
}

/**
 * Periodic cleanup of expired contexts
 */
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, ctx] of userContexts.entries()) {
        const hasPriceContext = ctx.lastPriceProduct && (now - ctx.lastPriceTimestamp < CONTEXT_TTL);
        const hasStoreContext = ctx.pendingStoreProduct && (now - ctx.pendingStoreTimestamp < CONTEXT_TTL);
        const hasMentionedContext = ctx.lastMentionedProduct && (now - ctx.lastMentionedTimestamp < CONTEXT_TTL);

        if (!hasPriceContext && !hasStoreContext && !hasMentionedContext) {
            userContexts.delete(userId);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`[CONTEXT] Cleaned up ${cleaned} expired contexts`);
    }
}, 3600000); // Run every hour

module.exports = {
    getContext,
    updatePriceContext,
    updateStoreContext,
    updateMentionedProduct,
    clearPriceContext,
    clearStoreContext,
    clearContext,
    hasPriceContext,
    hasStoreContext,
    hasMentionedProduct
};