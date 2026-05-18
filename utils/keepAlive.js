// utils/keepAlive.js
// Heartbeat to keep the bot alive

const https = require('https');
const http = require('http');

/**
 * Simple heartbeat to prevent the bot from sleeping on free hosting platforms
 */
function startHeartbeat(intervalMs = 120000) {
    // Get the current URL from environment or use a placeholder
    const url = process.env.VERCEL_URL || process.env.RAILWAY_STATIC_URL || 'http://localhost';

    // Skip heartbeat in local development
    if (url.includes('localhost')) {
        console.log('[HEARTBEAT] Skipping heartbeat in local development');
        return;
    }

    console.log(`[HEARTBEAT] Starting heartbeat every ${intervalMs / 1000}s`);

    setInterval(() => {
        try {
            const protocol = url.startsWith('https') ? https : http;
            const req = protocol.get(url, { timeout: 5000 }, (res) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`[HEARTBEAT] Ping successful (${res.statusCode})`);
                } else {
                    console.log(`[HEARTBEAT] Ping returned ${res.statusCode}`);
                }
            });

            req.on('error', (err) => {
                console.log(`[HEARTBEAT] Ping error: ${err.message}`);
            });

            req.on('timeout', () => {
                req.destroy();
                console.log(`[HEARTBEAT] Ping timed out`);
            });

        } catch (err) {
            console.log(`[HEARTBEAT] Error: ${err.message}`);
        }
    }, intervalMs);
}

module.exports = { startHeartbeat };