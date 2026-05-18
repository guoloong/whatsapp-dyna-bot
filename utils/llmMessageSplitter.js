// utils/llmMessageSplitter.js
// LLM-based message chunking for WhatsApp - splits by meaningful content blocks

const axios = require('axios');

const MAX_CHUNK_SIZE = 450;
const SOFT_MAX = 420;
const MIN_CHUNK_SIZE = 80;
const LLM_TIMEOUT = 15000;

// System prompt for the LLM chunker
const SYSTEM_PROMPT = `You are a message formatting specialist for a WhatsApp chatbot.

## TASK
Split long messages into short, meaningful chunks for WhatsApp display.
Each chunk must be standalone and easy to understand.

## CRITICAL RULES

1. **CONTENT BLOCK INTEGRITY**
   - Each chunk must be a complete, meaningful unit
   - Never split mid-sentence, mid-phrase, or mid-paragraph
   - Keep bullet points, numbered lists, and structured data INTACT
   - Each bullet item goes in the same chunk as its parent context
   - Never break a bullet point - keep the marker with its content

2. **LENGTH LIMIT**
   - Each chunk must be UNDER 450 characters (strict limit)
   - If a single sentence exceeds 450 chars, split by commas/clauses
   - No chunk should be a single word or tiny fragment

3. **MEANINGFUL CHUNKS**
   - Group related information together
   - Each chunk should convey a complete thought
   - Logical sections get their own chunks
   - Headers (with emoji) stay with their content

4. **STRUCTURE PRESERVATION**
   - Keep emoji headers/bullets with their content
   - Keep table-like data rows together
   - Keep addresses/contact info as single chunks

## OUTPUT FORMAT
Return ONLY a valid JSON array of strings. Nothing else.
Example: ["First chunk content here", "Second chunk content", "Third chunk"]

## PROCESSING STEPS
1. Identify natural content blocks (paragraphs, sections, list items)
2. For each block, check if it fits within 450 chars
3. If too long, split at sentence boundaries first
4. If still too long, split at comma/clause boundaries
5. Ensure each resulting chunk is complete and meaningful
6. Return JSON array with each chunk as a string`;

/**
 * Split message using LLM for intelligent chunking
 * Falls back to regex splitter if LLM fails
 */
async function splitWithLLM(text, apiKey, fallbackSplitter) {
    if (!text || text.length === 0) return [];
    if (text.length <= MAX_CHUNK_SIZE) return [text];

    if (text.length < 300) {
        return fallbackSplitter(text);
    }

    const userPrompt = `Split this message into WhatsApp-friendly chunks (max ${MAX_CHUNK_SIZE} chars each):

---
${text}
---

Rules:
- Keep each chunk as a complete, meaningful unit
- Keep bullet points intact (don't split them)
- Split only at natural boundaries (sentences, paragraphs)
- Return ONLY a valid JSON array of strings`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT);

        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.1,
                max_tokens: 1000
            },
            {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: controller.signal,
                timeout: LLM_TIMEOUT + 5000
            }
        );

        clearTimeout(timeoutId);

        const content = response.data.choices[0].message.content.trim();
        console.log(`[SPLITTER] LLM Response (${content.length} chars)`);

        const chunks = parseLLMResponse(content);

        if (chunks && chunks.length > 0 && validateChunks(chunks)) {
            console.log(`[SPLITTER] Successfully split into ${chunks.length} chunks`);
            return chunks;
        }

        console.log(`[SPLITTER] Invalid response, using fallback`);
        return fallbackSplitter(text);

    } catch (err) {
        console.log(`[SPLITTER] Failed: ${err.message}, using fallback`);
        return fallbackSplitter(text);
    }
}

/**
 * Parse JSON array from LLM response
 */
function parseLLMResponse(content) {
    try {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
                return parsed;
            }
        }

        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return parsed;
        }

        return null;
    } catch (e) {
        const strings = content.match(/"([^"\\]*(\\.[^"\\]*)*)"/g);
        if (strings && strings.length > 0) {
            return strings.map(s => s.slice(1, -1).replace(/\\"/g, '"'));
        }
        return null;
    }
}

/**
 * Validate that chunks meet requirements
 */
function validateChunks(chunks) {
    if (!chunks || chunks.length === 0) return false;
    if (chunks.length > 20) return false;

    for (const chunk of chunks) {
        if (typeof chunk !== 'string') return false;
        if (chunk.length > MAX_CHUNK_SIZE + 50) return false;
        if (chunk.length < 3) return false;
    }

    for (const chunk of chunks) {
        if (/^[\s]*[-•*]\s/.test(chunk) && chunk.length < 10) {
            return false;
        }
    }

    return true;
}

/**
 * Smart regex-based fallback splitter
 */
function smartFallbackSplitter(text) {
    if (!text || typeof text !== 'string') return [];
    if (text.length <= MAX_CHUNK_SIZE) return [text];

    const chunks = [];
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        const trimmedParagraph = paragraph.trim();
        if (!trimmedParagraph) continue;

        const isBulletList = /^[\s]*[-•*]\s/m.test(trimmedParagraph);

        if (isBulletList) {
            if (currentChunk.length + trimmedParagraph.length + 2 <= SOFT_MAX) {
                currentChunk += (currentChunk ? '\n\n' : '') + trimmedParagraph;
            } else {
                if (currentChunk.trim()) chunks.push(currentChunk.trim());
                currentChunk = trimmedParagraph;
            }
        } else if (trimmedParagraph.length > MAX_CHUNK_SIZE) {
            if (currentChunk.trim()) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }

            const sentences = splitBySentences(trimmedParagraph);
            for (const sentence of sentences) {
                if (sentence.length > MAX_CHUNK_SIZE) {
                    const fragments = splitByClauses(sentence);
                    for (const frag of fragments) {
                        currentChunk = addToChunk(currentChunk, frag, chunks);
                    }
                } else {
                    currentChunk = addToChunk(currentChunk, sentence, chunks);
                }
            }
        } else {
            currentChunk = addToChunk(currentChunk, trimmedParagraph, chunks);
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return mergeSmallChunks(chunks);
}

/**
 * Split text by sentence endings
 */
function splitBySentences(text) {
    const rawSentences = text.split(/(?<=[.!?])\s+/);
    return rawSentences.filter(s => s.trim()).map(s => s.trim());
}

/**
 * Split long text by clauses
 */
function splitByClauses(text) {
    if (text.length <= MAX_CHUNK_SIZE) return [text];

    const parts = text.split(/,\s*/);
    if (parts.length > 1) {
        const result = [];
        let buffer = '';

        for (const part of parts) {
            if (buffer.length + part.length + 2 <= SOFT_MAX) {
                buffer += (buffer ? ', ' : '') + part;
            } else {
                if (buffer) result.push(buffer.trim());
                buffer = part;
            }
        }

        if (buffer) result.push(buffer.trim());

        if (result.every(c => c.length <= MAX_CHUNK_SIZE)) {
            return result;
        }
    }

    const words = text.split(/\s+/);
    const chunks = [];
    let current = '';

    for (const word of words) {
        if (current.length + word.length + 1 > SOFT_MAX) {
            if (current.trim()) chunks.push(current.trim());
            current = word;
        } else {
            current += (current ? ' ' : '') + word;
        }
    }

    if (current.trim()) chunks.push(current.trim());
    return chunks.length > 0 ? chunks : [text];
}

/**
 * Add content to chunk, pushing current if needed
 */
function addToChunk(current, content, chunks) {
    const sep = current ? '\n\n' : '';
    const potentialNew = current + sep + content;

    if (potentialNew.length <= SOFT_MAX) {
        return potentialNew;
    }

    if (current) chunks.push(current.trim());

    if (content.length <= MAX_CHUNK_SIZE) {
        return content;
    }

    const sentences = splitBySentences(content);
    let tempChunk = '';

    for (const sentence of sentences) {
        if (tempChunk.length + sentence.length + 1 > SOFT_MAX) {
            if (tempChunk.trim()) chunks.push(tempChunk.trim());
            tempChunk = sentence;
        } else {
            tempChunk += (tempChunk ? '\n' : '') + sentence;
        }
    }

    return tempChunk;
}

/**
 * Merge small chunks with neighbors
 */
function mergeSmallChunks(chunks) {
    if (chunks.length <= 1) return chunks;

    const result = [];
    let buffer = '';

    for (const chunk of chunks) {
        if (chunk.length < MIN_CHUNK_SIZE && result.length > 0) {
            result[result.length - 1] += '\n\n' + chunk;
        } else if (buffer && (buffer.length + chunk.length + 2) <= SOFT_MAX) {
            buffer += '\n\n' + chunk;
        } else {
            if (buffer) result.push(buffer);
            buffer = chunk;
        }
    }

    if (buffer) result.push(buffer);
    return result;
}

/**
 * Main function - LLM-based split with fallback
 */
async function splitIntoChunks(text, apiKey = null) {
    if (!text || text.length === 0) return [];
    if (text.length <= MAX_CHUNK_SIZE) return [text];

    if (!apiKey) {
        console.log(`[SPLITTER] No API key, using smart fallback`);
        return smartFallbackSplitter(text);
    }

    return splitWithLLM(text, apiKey, smartFallbackSplitter);
}

/**
 * Synchronous version - always uses fallback
 */
function splitWithFallback(text) {
    return smartFallbackSplitter(text);
}

module.exports = {
    splitIntoChunks,
    splitWithFallback,
    splitWithLLM,
    smartFallbackSplitter,
    MAX_CHUNK_SIZE,
    MIN_CHUNK_SIZE,
    SOFT_MAX
};