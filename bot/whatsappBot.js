// bot/whatsappBot.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { generateResponse } = require('../services/deepseek');
const { getHistory, addMessage, hasProductBeenShown, markProductAsShown } = require('../utils/memory');
const { setContact, getPhoneNumber } = require('../utils/contactCache');

// Helper function to decode WhatsApp LID to actual phone number
function decodeLIDtoPhone(lid) {
    if (!lid) return null;
    const cleanLid = lid.replace(/[^0-9]/g, '');
    if (cleanLid.length < 7) return cleanLid;
    const last10 = cleanLid.slice(-10);
    const last9 = cleanLid.slice(-9);
    const last8 = cleanLid.slice(-8);
    const singaporePattern = /^[89]/;
    if (singaporePattern.test(last10)) return last10;
    if (singaporePattern.test(last9)) return last9;
    if (singaporePattern.test(last8)) return last8;
    return last10;
}

// Get fresh handoff module instance (clears cache to ensure fresh data)
function getHandoff() {
    delete require.cache[require.resolve('../utils/humanHandoff')];
    return require('../utils/humanHandoff');
}

// Split long messages into chunks (WhatsApp limit ~4096 chars)
async function sendLongMessage(msg, text, delayMs = 800) {
    const MAX_LENGTH = 500;
    const chatId = msg.id.remote;

    if (!text || text.length === 0) return;

    if (text.length <= MAX_LENGTH) {
        await msg.reply(text);
        return;
    }

    const chunks = [];
    const lines = text.split('\n');
    let currentChunk = '';

    for (const line of lines) {
        if (currentChunk.length + line.length + 1 > MAX_LENGTH) {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            if (line.length > MAX_LENGTH) {
                for (let i = 0; i < line.length; i += MAX_LENGTH - 50) {
                    chunks.push(line.substring(i, i + MAX_LENGTH - 50));
                }
            } else {
                currentChunk = line;
            }
        } else {
            currentChunk += (currentChunk.length > 0 ? '\n' : '') + line;
        }
    }

    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    console.log(`📤 Splitting long message into ${chunks.length} parts (limit: ${MAX_LENGTH} chars)`);
    for (let i = 0; i < chunks.length; i++) {
        try {
            await client.sendMessage(chatId, chunks[i]);
        } catch (sendErr) {
            console.error(`Failed to send chunk ${i + 1}:`, sendErr.message);
            await msg.reply(chunks[i]);
        }
        if (i < chunks.length - 1) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

let client = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const userCooldowns = new Map();
const COOLDOWN_MS = 2000;

// ==================== Human Handoff Functions ====================

async function sendAsHuman(userId, message) {
    if (!client) {
        console.error('Client not initialized');
        return false;
    }
    try {
        await client.sendMessage(userId, message);
        console.log(`👤 Human sent to ${userId}: "${message}"`);
        return true;
    } catch (err) {
        console.error('Failed to send human message:', err.message);
        return false;
    }
}

function enableHumanMode(userId, agentId = 'default') {
    const { setHumanMode } = getHandoff();
    setHumanMode(userId, agentId);
}

function disableHumanMode(userId) {
    const { setBotMode } = getHandoff();
    setBotMode(userId, 'human_complete');
}

function getBotStatus(userId) {
    const handoff = getHandoff();
    const session = handoff.getSession(userId);
    return {
        mode: session ? session.mode : 'bot',
        agentId: session?.agentId || null,
        sessionActive: !!session
    };
}

// Cleanup expired cooldown entries every 60 seconds
setInterval(() => {
    const now = Date.now();
    const EXPIRY_MS = 300000;
    for (const [userId, lastTime] of userCooldowns.entries()) {
        if (now - lastTime > EXPIRY_MS) {
            userCooldowns.delete(userId);
        }
    }
}, 60000);

function initWhatsAppBot() {
    if (client) { client.destroy().catch(() => {}); }

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './session-data' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        },
        qrMaxRetries: 3
    });

    client.on('qr', qr => {
        console.log('Scan QR:');
        qrcode.generate(qr, { small: true });
        reconnectAttempts = 0;
    });

    client.on('ready', () => {
        console.log('✅ Bot ready');
        reconnectAttempts = 0;
    });

    client.on('auth_failure', msg => console.error('Auth failed:', msg));

    client.on('disconnected', async (reason) => {
        console.log(`Disconnected: ${reason}`);
        if (reconnectAttempts < MAX_RECONNECT) {
            reconnectAttempts++;
            const delay = 5000 * reconnectAttempts;
            console.log(`Reconnecting in ${delay / 1000}s...`);
            setTimeout(() => initWhatsAppBot(), delay);
        }
    });

    client.on('message', async (msg) => {
        const msgBody = msg.body.trim();
        const userId = msg.from;

        console.log(`\n📩 Incoming message from ${userId}: "${msgBody}"`);
        console.log(`   msg.fromMe=${msg.fromMe}, msg.type=${msg.type}`);

        // Cache contact info for all messages
        try {
            const contact = await msg.getContact();
            if (contact) {
                const storedPhone = contact.id?.user || contact.number;
                console.log(`📞 [CONTACT CACHE] Caching contact: userId=${userId}, storedPhone=${storedPhone}, pushname=${contact.pushname}`);
                setContact(userId, storedPhone, contact.pushname || null);
                
                // Debug: Verify cache was written
                const verifyPhone = getPhoneNumber(userId);
                console.log(`📞 [CONTACT CACHE] Verified cache write: ${verifyPhone}`);
            } else {
                console.log(`⚠️ [CONTACT CACHE] Contact object is null/undefined for userId=${userId}`);
            }
        } catch (e) {
            console.error(`❌ [CONTACT CACHE] Error caching contact: ${e.message}`);
        }

        const lowerMsg = msgBody.toLowerCase();

        // ========================================
        // SPECIAL COMMANDS
        // ========================================

        if (lowerMsg === '!bot') {
            console.log(`🔓 !bot command detected`);
            const handoff = getHandoff();
            handoff.setBotMode(userId, 'user_request');
            await msg.reply('✅ Bot is now active. How can I help you?');
            return;
        }

        if (lowerMsg === '!status') {
            console.log(`🔓 !status command detected`);
            const handoff = getHandoff();
            const sessions = handoff.getActiveSessions();
            const count = Object.keys(sessions).length;
            console.log(`📋 Status check: ${count} sessions found`);

            if (count === 0) {
                await msg.reply('ℹ️ No active human sessions.');
            } else {
                let reply = `📋 Active human sessions (${count}):\n\n`;
                let index = 1;

                for (const [uid, session] of Object.entries(sessions)) {
                    let phoneDisplay = session.phoneNumber || uid;
                    if (!session.phoneNumber) {
                        phoneDisplay = uid.replace(/@.*$/, '').replace(/[^0-9]/g, '');
                    }
                    const minsAgo = Math.round((Date.now() - session.lastHumanMessage) / 60000);
                    const cmdPhone = phoneDisplay.replace(/[^0-9]/g, '');
                    reply += `📱 [${index}] ${phoneDisplay}\n   Agent: ${session.agentId}\n   Last: ${minsAgo} min ago\n   Command: !close ${cmdPhone}\n\n`;
                    index++;
                }
                reply += `Copy the command above to close a session.`;
                await msg.reply(reply);
            }
            return;
        }

        // !closeall MUST come before !close
        if (lowerMsg === '!closeall') {
            console.log(`🔓 !closeall command detected`);
            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();
            const sessionIds = Object.keys(allSessions);
            console.log(`📋 Found ${sessionIds.length} sessions:`, sessionIds);
            const count = sessionIds.length;

            if (count === 0) {
                await msg.reply('ℹ️ No active sessions.');
            } else {
                for (const uid of sessionIds) {
                    console.log(`🔒 Closing session: ${uid}`);
                    console.log(`   Session data:`, allSessions[uid]);
                    handoff.setBotMode(uid, 'agent_closed');
                }
                await msg.reply(`✅ Closed ${count} session(s).`);
            }
            return;
        }

        if (lowerMsg.startsWith('!close ') || lowerMsg === '!close') {
            console.log(`🔓 !close command detected`);
            const parts = msgBody.trim().split(/\s+/);
            let searchPhone = parts.length > 1 ? parts.slice(1).join(' ').replace(/^[\s@]+/, '') : null;

            const handoff = getHandoff();
            const allSessions = handoff.getActiveSessions();
            const sessionIds = Object.keys(allSessions);

            if (!searchPhone) {
                await msg.reply('Usage: !close <phone_number>\nExample: !close 60123456789\n\nUse !status to see active sessions.');
                return;
            }

            const cleanSearch = searchPhone.replace(/[^0-9]/g, '');
            let targetUserId = null;

            for (const [uid, session] of Object.entries(allSessions)) {
                if (session.phoneNumber) {
                    const sessionPhone = session.phoneNumber.replace(/[^0-9]/g, '');
                    if (sessionPhone === cleanSearch ||
                        sessionPhone.includes(cleanSearch) ||
                        cleanSearch.includes(sessionPhone)) {
                        targetUserId = uid;
                        console.log(`🔍 Matched by session.phoneNumber: ${sessionPhone}`);
                        break;
                    }
                }

                if (!targetUserId) {
                    const cleanUid = uid.replace(/[^0-9]/g, '');
                    if (cleanUid.includes(cleanSearch) || cleanSearch.includes(cleanUid.slice(-8))) {
                        targetUserId = uid;
                        break;
                    }
                }
            }

            if (!targetUserId) {
                await msg.reply(`❌ No session found for: ${searchPhone}\nUse !status to see active sessions.`);
                return;
            }

            console.log(`🔍 Target: ${targetUserId}`);

            if (handoff.isHumanMode(targetUserId)) {
                handoff.setBotMode(targetUserId, 'agent_closed');
                await msg.reply(`✅ Session closed for ${searchPhone}. Bot active.`);
            } else {
                await msg.reply('ℹ️ No active human session for that user.');
            }
            return;
        }

        // ========================================
        // REGULAR MESSAGES
        // ========================================

        if (msg.fromMe) {
            console.log(`🚫 Filtered: own message`);
            return;
        }

        if (msg.type === 'notification') {
            console.log(`🚫 Filtered: notification`);
            return;
        }

        if (msgBody.startsWith('!')) {
            console.log(`🚫 Filtered: other command`);
            return;
        }

        const handoff = getHandoff();
        console.log(`🔍 Mode check: ${handoff.isHumanMode(userId) ? 'HUMAN' : 'BOT'}`);

        if (handoff.isHumanMode(userId)) {
            console.log(`🤫 User ${userId} in HUMAN mode - ignoring`);
            return;
        }

        if (handoff.shouldEscalate(msgBody)) {
            console.log(`📞 Escalation triggered: "${msgBody}"`);

            // Check if within working hours
            if (!handoff.isWithinWorkingHours()) {
                console.log(`📞 Outside working hours - informing user`);
                const hoursMessage = handoff.getWorkingHoursMessage();
                await msg.reply(hoursMessage);
                return;
            }

            let phoneNumber = null;

            try {
                const contact = await msg.getContact();
                if (contact) {
                    console.log(`📞 Contact: number=${contact.number}, pushname=${contact.pushname}, id.user=${contact.id?.user}`);

                    const storedPhone = contact.id?.user || contact.number;
                    setContact(userId, storedPhone, contact.pushname || null);

                    if (contact.id?.user) {
                        const userPart = contact.id.user.replace(/[^0-9]/g, '');
                        if (userPart.length >= 7 && userPart.length <= 15) {
                            phoneNumber = userPart;
                            console.log(`📞 Phone from id.user: ${phoneNumber}`);
                        }
                    }

                    if (!phoneNumber && contact.number) {
                        const cleaned = contact.number.replace(/[^0-9]/g, '');
                        if (cleaned.length >= 7 && cleaned.length <= 15 && /^[89]/.test(cleaned)) {
                            phoneNumber = cleaned;
                            console.log(`📞 Phone from contact.number: ${phoneNumber}`);
                        }
                    }
                }
            } catch (e) {
                console.log(`📞 Could not get contact: ${e.message}`);
            }

            if (!phoneNumber) {
                const cachedPhone = getPhoneNumber(userId);
                if (cachedPhone) {
                    phoneNumber = cachedPhone;
                    console.log(`📞 Phone from cache: ${phoneNumber}`);
                }
            }

            if (!phoneNumber) {
                phoneNumber = decodeLIDtoPhone(userId);
                console.log(`📞 Phone decoded from userId: ${phoneNumber}`);
            }

            if (!phoneNumber) {
                phoneNumber = userId.replace(/@.*$/, '').replace(/[^0-9]/g, '');
                console.log(`📞 Phone fallback: ${phoneNumber}`);
            }

            handoff.setHumanMode(userId, 'escalation', phoneNumber);
            await msg.reply('👋 Connecting to human agent...');
            return;
        }

        const now = Date.now();

        const lastMsgTime = userCooldowns.get(userId) || 0;
        if (now - lastMsgTime < COOLDOWN_MS) return;
        userCooldowns.set(userId, now);

        try {
            if (msgBody.length < 2) return;

            // ========== PHONE NUMBER EXTRACTION (for price API) ==========
            // Extract phone number before calling generateResponse so it can be used for price lookups
            let phoneNumberForPrice = null;

            try {
                const contact = await msg.getContact();
                if (contact) {
                    console.log(`📞 [PRICE] Contact: number=${contact.number}, pushname=${contact.pushname}, id.user=${contact.id?.user}`);

                    const storedPhone = contact.id?.user || contact.number;
                    setContact(userId, storedPhone, contact.pushname || null);

                    if (contact.id?.user) {
                        const userPart = contact.id.user.replace(/[^0-9]/g, '');
                        if (userPart.length >= 7 && userPart.length <= 15) {
                            phoneNumberForPrice = userPart;
                            console.log(`📞 [PRICE] Phone from id.user: ${phoneNumberForPrice}`);
                        }
                    }

                    if (!phoneNumberForPrice && contact.number) {
                        const cleaned = contact.number.replace(/[^0-9]/g, '');
                        if (cleaned.length >= 7 && cleaned.length <= 15 && /^[89]/.test(cleaned)) {
                            phoneNumberForPrice = cleaned;
                            console.log(`📞 [PRICE] Phone from contact.number: ${phoneNumberForPrice}`);
                        }
                    }
                }
            } catch (e) {
                console.log(`📞 [PRICE] Could not get contact: ${e.message}`);
            }

            if (!phoneNumberForPrice) {
                const cachedPhone = getPhoneNumber(userId);
                if (cachedPhone) {
                    phoneNumberForPrice = cachedPhone;
                    console.log(`📞 [PRICE] Phone from cache: ${phoneNumberForPrice}`);
                }
            }

            if (!phoneNumberForPrice) {
                phoneNumberForPrice = decodeLIDtoPhone(userId);
                console.log(`📞 [PRICE] Phone decoded from userId: ${phoneNumberForPrice}`);
            }

            if (!phoneNumberForPrice) {
                phoneNumberForPrice = userId.replace(/@.*$/, '').replace(/[^0-9]/g, '');
                console.log(`📞 [PRICE] Phone fallback: ${phoneNumberForPrice}`);
            }

            console.log(`📞 [PRICE] Final phone number for price lookup: ${phoneNumberForPrice}`);
            // ========== END PHONE NUMBER EXTRACTION ==========

            try {
                const chat = await msg.getChat();
                await chat.sendStateTyping();
            } catch (e) {
                console.warn('Could not send typing indicator:', e.message);
            }

            const history = getHistory(userId);
            const response = await generateResponse(
                msgBody,
                '',
                process.env.DEEPSEEK_API_KEY,
                history,
                userId,
                phoneNumberForPrice
            );

            const finalReply = response.text || '⚠️ I\'m having trouble responding. Please try again or contact support.';
            const imageUrl = response.imageUrl;
            const productName = response.productName;

            try {
                const chat = await msg.getChat();
                await chat.clearState();
            } catch (e) {
                console.warn('Could not clear typing indicator:', e.message);
            }

            await sendLongMessage(msg, finalReply);

            const imageKeywords = ['image', 'photo', 'picture', 'show', 'send image', 'send photo'];
            const isImageRequest = imageKeywords.some(k => msgBody.toLowerCase().includes(k));
            const shouldSendImage = imageUrl && (isImageRequest || !hasProductBeenShown(userId, productName));

            if (shouldSendImage) {
                console.log(`📷 Sending product image for "${productName}"`);
                try {
                    const media = await MessageMedia.fromUrl(imageUrl, { unsafeMimeType: true });
                    await msg.reply(media, msg.chatId, { caption: `Here's the image of ${productName}` });
                    markProductAsShown(userId, productName);
                } catch (err) {
                    console.error('Failed to send product image:', err.message);
                }
            }

            addMessage(userId, "user", msgBody);
            addMessage(userId, "assistant", finalReply);
        } catch (err) {
            console.error('Message handling error:', err);
            try {
                const chat = await msg.getChat();
                await chat.clearState();
            } catch (e) {
                // ignore
            }
            await msg.reply('⚠️ Something went wrong. Please try again later.');
        }
    });

    client.initialize().catch(err => console.error('Init error:', err));
}

module.exports = {
    initWhatsAppBot,
    sendAsHuman,
    enableHumanMode,
    disableHumanMode,
    getBotStatus
};
