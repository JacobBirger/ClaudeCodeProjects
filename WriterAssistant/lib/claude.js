'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { buildSystemPrompt, buildCharacterExtractionPrompt, buildStyleInferencePrompt } = require('./phases');

const provider = (process.env.PROVIDER || 'anthropic').toLowerCase();

// ── Clients (lazy init) ────────────────────────────────────────────────

let anthropicClient;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

let ollamaClient;
function getOllamaClient() {
  if (!ollamaClient) {
    ollamaClient = new OpenAI({
      baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
      apiKey: 'ollama' // required by SDK, ignored by Ollama
    });
  }
  return ollamaClient;
}

const ollamaModel = () => process.env.OLLAMA_MODEL || 'llama3.2';

// ── Shared signal-tag stream processor ────────────────────────────────

const SIGNAL_OPEN = '<signal>';
const SIGNAL_CLOSE = '</signal>';

/**
 * Processes a stream of text chunks, strips hidden <signal> tags,
 * calls onChunk() for visible text, and returns signal data if found.
 *
 * @param {AsyncIterable<string>} chunks - raw text chunks
 * @param {Function} onChunk - called with each visible text segment
 * @returns {{ fullText, signalDetected, signalData }}
 */
async function processStream(chunks, onChunk) {
  let fullText = '';
  let signalBuffer = '';
  let inSignal = false;
  let signalDetected = false;
  let signalData = null;

  for await (const delta of chunks) {
    if (!delta) continue;

    for (const ch of delta) {
      if (inSignal) {
        signalBuffer += ch;
        if (signalBuffer.endsWith(SIGNAL_CLOSE)) {
          const inner = signalBuffer.slice(0, -SIGNAL_CLOSE.length);
          try {
            signalData = JSON.parse(inner);
            signalDetected = true;
          } catch (_) {}
          inSignal = false;
          signalBuffer = '';
        }
      } else {
        const candidate = signalBuffer + ch;
        if (SIGNAL_OPEN.startsWith(candidate)) {
          signalBuffer = candidate;
          if (signalBuffer === SIGNAL_OPEN) {
            inSignal = true;
            signalBuffer = '';
          }
        } else {
          if (signalBuffer) {
            onChunk(signalBuffer);
            fullText += signalBuffer;
            signalBuffer = '';
          }
          onChunk(ch);
          fullText += ch;
        }
      }
    }
  }

  if (signalBuffer && !inSignal) {
    onChunk(signalBuffer);
    fullText += signalBuffer;
  }

  return { fullText, signalDetected, signalData };
}

// ── Anthropic implementations ──────────────────────────────────────────

async function streamChatAnthropic(session, userMessage, onChunk) {
  const systemPrompt = buildSystemPrompt(session);
  const messages = [...session.messages, { role: 'user', content: userMessage }];

  const stream = await getAnthropicClient().messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    messages
  });

  async function* anthropicChunks() {
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        yield event.delta?.text ?? '';
      }
    }
  }

  return processStream(anthropicChunks(), onChunk);
}

async function extractCharactersAnthropic(overview) {
  const response = await getAnthropicClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: buildCharacterExtractionPrompt(overview) }]
  });
  return response.content[0]?.text ?? '{"characters":[]}';
}

async function inferWritingStyleAnthropic(userMessages) {
  const response = await getAnthropicClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: buildStyleInferencePrompt(userMessages) }]
  });
  return response.content[0]?.text?.trim() ?? null;
}

// ── Ollama implementations ─────────────────────────────────────────────

async function streamChatOllama(session, userMessage, onChunk) {
  const systemPrompt = buildSystemPrompt(session);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.messages,
    { role: 'user', content: userMessage }
  ];

  const stream = await getOllamaClient().chat.completions.create({
    model: ollamaModel(),
    max_tokens: 2048,
    messages,
    stream: true
  });

  async function* ollamaChunks() {
    for await (const chunk of stream) {
      yield chunk.choices[0]?.delta?.content ?? '';
    }
  }

  return processStream(ollamaChunks(), onChunk);
}

async function extractCharactersOllama(overview) {
  const response = await getOllamaClient().chat.completions.create({
    model: ollamaModel(),
    max_tokens: 256,
    messages: [{ role: 'user', content: buildCharacterExtractionPrompt(overview) }]
  });
  return response.choices[0]?.message?.content ?? '{"characters":[]}';
}

async function inferWritingStyleOllama(userMessages) {
  const response = await getOllamaClient().chat.completions.create({
    model: ollamaModel(),
    max_tokens: 256,
    messages: [{ role: 'user', content: buildStyleInferencePrompt(userMessages) }]
  });
  return response.choices[0]?.message?.content?.trim() ?? null;
}

// ── JSON parse helper shared by both extract paths ─────────────────────

function parseCharacterJSON(text) {
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(cleaned);
  } catch (_) {
    return { characters: [] };
  }
}

// ── Public API ─────────────────────────────────────────────────────────

async function streamChat(session, userMessage, onChunk) {
  const impl = provider === 'ollama' ? streamChatOllama : streamChatAnthropic;
  const { fullText, signalDetected, signalData } = await impl(session, userMessage, onChunk);

  session.messages.push({ role: 'user', content: userMessage });
  session.messages.push({ role: 'assistant', content: fullText.trim() });

  return { signalDetected, signalData, fullText: fullText.trim() };
}

async function extractCharacters(overview) {
  const text = provider === 'ollama'
    ? await extractCharactersOllama(overview)
    : await extractCharactersAnthropic(overview);
  return parseCharacterJSON(text);
}

async function inferWritingStyle(userMessages) {
  if (userMessages.length < 3) return null;
  try {
    return provider === 'ollama'
      ? await inferWritingStyleOllama(userMessages)
      : await inferWritingStyleAnthropic(userMessages);
  } catch (_) {
    return null;
  }
}

module.exports = { streamChat, extractCharacters, inferWritingStyle };
