// utils/contactCache.js
// Stores phone numbers for user IDs

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'contact_cache.json');

let cache = new Map();

function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            cache = new Map(Object.entries(data));
            console.log(`[CONTACTS] Loaded ${cache.size} contacts`);
        }
    } catch (err) {
        console.error('[CONTACTS] Failed to load cache:', err.message);
    }
}

function saveCache() {
    try {
        const obj = Object.fromEntries(cache);
        fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.error('[CONTACTS] Failed to save cache:', err.message);
    }
}

function setContact(userId, phoneNumber, name = null) {
    if (!phoneNumber || phoneNumber.length < 7) return;

    cache.set(userId, {
        phoneNumber: phoneNumber.replace(/[^0-9]/g, ''),
        name: name,
        updatedAt: Date.now()
    });
    saveCache();
}

function getContact(userId) {
    return cache.get(userId);
}

function getPhoneNumber(userId) {
    const contact = cache.get(userId);
    return contact ? contact.phoneNumber : null;
}

function hasPhone(userId) {
    return cache.has(userId);
}

loadCache();

module.exports = {
    setContact,
    getContact,
    getPhoneNumber,
    hasPhone
};