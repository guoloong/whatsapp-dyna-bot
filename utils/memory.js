// utils/memory.js
// Conversation history management per user

const fs = require('fs');
const path = require('path');
const MEMORY_FILE = path.join(__dirname, '..', 'conversations.json');
const MAX_HISTORY = 10;
const MAX_USERS = 1000;
const EXPIRE_MS = 180 * 24 * 60 * 60 * 1000;

let userHistories = new Map();
let saveTimer = null;

function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const obj = Object.fromEntries(userHistories);
            fs.writeFileSync(MEMORY_FILE, JSON.stringify(obj, null, 2));
        } catch (err) {
            console.error('[MEMORY] Save error:', err);
        }
    }, 500);
}

function load() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
            userHistories = new Map(Object.entries(data));
            const now = Date.now();
            for (const [id, entry] of userHistories.entries()) {
                if (now - entry.lastActive > EXPIRE_MS) userHistories.delete(id);
            }
            if (userHistories.size > MAX_USERS) {
                const sorted = [...userHistories.entries()].sort((a, b) => b[1].lastActive - a[1].lastActive);
                userHistories = new Map(sorted.slice(0, MAX_USERS));
            }
            save();
        }
    } catch (err) {
        console.error('[MEMORY] Load error:', err);
    }
}

function getHistory(userId) {
    const entry = userHistories.get(userId);
    if (entry && Date.now() - entry.lastActive < EXPIRE_MS) return entry.messages || [];
    return [];
}

function addMessage(userId, role, content) {
    let entry = userHistories.get(userId);
    const now = Date.now();
    if (!entry || now - entry.lastActive >= EXPIRE_MS) {
        entry = { messages: [], lastActive: now };
        userHistories.set(userId, entry);
    }
    entry.messages.push({ role, content });
    if (entry.messages.length > MAX_HISTORY) entry.messages = entry.messages.slice(-MAX_HISTORY);
    entry.lastActive = now;
    if (userHistories.size > MAX_USERS) {
        const sorted = [...userHistories.entries()].sort((a, b) => b[1].lastActive - a[1].lastActive);
        userHistories = new Map(sorted.slice(0, MAX_USERS));
    }
    save();
}

function clearHistory(userId) {
    userHistories.delete(userId);
    save();
}

function hasProductBeenShown(userId, productName) {
    if (!productName) return true;
    const entry = userHistories.get(userId);
    if (!entry) return false;
    if (!entry.shownProducts) return false;
    return entry.shownProducts.includes(productName);
}

function markProductAsShown(userId, productName) {
    if (!productName) return;
    let entry = userHistories.get(userId);
    if (!entry) {
        entry = { messages: [], lastActive: Date.now(), shownProducts: [] };
        userHistories.set(userId, entry);
    }
    if (!entry.shownProducts) entry.shownProducts = [];
    if (!entry.shownProducts.includes(productName)) {
        entry.shownProducts.push(productName);
        save();
    }
}

// Periodic cleanup
setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of userHistories.entries()) {
        if (now - entry.lastActive > EXPIRE_MS) {
            userHistories.delete(id);
            changed = true;
        }
    }
    if (userHistories.size > MAX_USERS) {
        const sorted = [...userHistories.entries()].sort((a, b) => b[1].lastActive - a[1].lastActive);
        userHistories = new Map(sorted.slice(0, MAX_USERS));
        changed = true;
    }
    if (changed) save();
}, 24 * 3600 * 1000);

// Graceful shutdown
process.on('exit', () => {
    try {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(Object.fromEntries(userHistories), null, 2));
    } catch (err) { /* ignore */ }
});

load();

module.exports = { getHistory, addMessage, clearHistory, hasProductBeenShown, markProductAsShown };