// utils/humanHandoff.js
// Manages human agent handoff state

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', 'human_sessions.json');
const AUTO_RETURN_HOURS = 24;

let sessions = new Map();
let saveTimer = null;

function loadSessions() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            sessions = new Map(Object.entries(data));
            console.log(`[HANDOFF] Loaded ${sessions.size} human sessions`);
            cleanupExpiredSessions();
        }
    } catch (err) {
        console.error('[HANDOFF] Failed to load sessions:', err.message);
    }
}

function saveSessions() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const obj = Object.fromEntries(sessions);
            fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
        } catch (err) {
            console.error('[HANDOFF] Failed to save sessions:', err.message);
        }
    }, 500);
}

function cleanupExpiredSessions() {
    const now = Date.now();
    let changed = false;

    for (const [userId, session] of sessions.entries()) {
        if (session.mode === 'human') {
            const silentMs = now - (session.lastHumanMessage || session.startedAt);
            if (silentMs > AUTO_RETURN_HOURS * 60 * 60 * 1000) {
                console.log(`[HANDOFF] Auto-returning user ${userId} to bot`);
                sessions.delete(userId);
                changed = true;
            }
        }
    }

    if (changed) saveSessions();
}

setInterval(cleanupExpiredSessions, 30 * 60 * 1000);

function getSession(userId) {
    return sessions.get(userId);
}

function isHumanMode(userId) {
    const session = sessions.get(userId);
    return session && session.mode === 'human';
}

function setHumanMode(userId, agentId = 'human', phoneNumber = null) {
    sessions.set(userId, {
        mode: 'human',
        agentId: agentId,
        startedAt: Date.now(),
        lastHumanMessage: Date.now(),
        status: 'active',
        phoneNumber: phoneNumber
    });
    console.log(`[HANDOFF] User ${userId} switched to HUMAN mode`);
    saveSessions();
}

function setBotMode(userId, reason = 'manual') {
    sessions.delete(userId);
    console.log(`[HANDOFF] User ${userId} returned to BOT mode (reason: ${reason})`);
    saveSessions();
}

function updateHumanActivity(userId) {
    const session = sessions.get(userId);
    if (session && session.mode === 'human') {
        session.lastHumanMessage = Date.now();
        saveSessions();
    }
}

function closeSession(userId) {
    sessions.delete(userId);
    saveSessions();
}

function getActiveSessions() {
    return Object.fromEntries(sessions);
}

function isWithinWorkingHours() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;

    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeMinutes = hours * 60 + minutes;
    const startTimeMinutes = 9 * 60;
    const endTimeMinutes = 17 * 60;

    return currentTimeMinutes >= startTimeMinutes && currentTimeMinutes < endTimeMinutes;
}

function getWorkingHoursMessage() {
    return "Our human agents are only available Monday to Friday, 9:00 AM to 5:00 PM. " +
           "For immediate assistance, please leave a message and we'll get back to you during business hours.";
}

function shouldEscalate(message) {
    const keywords = [
        'talk to human', 'speak to human', 'real person', 'live agent',
        'customer service', 'representative', 'help from person',
        'person', 'agent', 'real person', 'not bot', 'not a bot'
    ];
    const lowerMsg = message.toLowerCase();
    return keywords.some(k => lowerMsg.includes(k));
}

loadSessions();

module.exports = {
    isHumanMode,
    setHumanMode,
    setBotMode,
    updateHumanActivity,
    closeSession,
    getSession,
    getActiveSessions,
    shouldEscalate,
    isWithinWorkingHours,
    getWorkingHoursMessage
};