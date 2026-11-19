import { config, log } from './config.js';
import { clock, strings } from './i18n.js';
import { knowledgeOf, personaOf } from './persona.js';
import { webSearch } from './search.js';
import { SentenceSplitter } from './text.js';

// Svaret tas fram i två steg, eftersom små modeller är opålitliga på fria verktygsanrop:
//   1. decideSearch(): ett snabbt beslut med strukturerat JSON-svar - ska vi söka, och på vad?
//   2. respond():      själva svaret, strömmat mening för mening (med sökträffarna om vi sökte).
// Promptarna finns i i18n.js, en uppsättning per språk.

const NUM_CTX = 8192;

const SEARCH_SCHEMA = {
  type: 'object',
  properties: { search: { type: 'boolean' }, query: { type: 'string' } },
  required: ['search', 'query'],
};
const UNCLEAR_REFERENCE =
  /(?<![\p{L}])(?:dit|där|därifrån|dom|dem|honom|henne|han|hon|den\s+där|det\s+där|de\s+där|sådan\s+där|there|that\s+one|those|them|him|her)(?![\p{L}])/iu;
// En guide-bot får också säga att frågan är för oklar och föreslå en motfråga.
const GUIDE_SCHEMA = {
  type: 'object',
  properties: { clarify: { type: 'string' }, search: { type: 'boolean' }, query: { type: 'string' } },
  required: ['clarify', 'search', 'query'],
};

async function ollamaChat(body, signal) {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({ model: config.model, think: false, keep_alive: '60m', ...body }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama svarade ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res;
}

async function* ndjson(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

/** Steg 1: behöver vi söka? Returnerar { search, query }. */
export async function decideSearch({ bot, history = [], userText, memory = '', signal }) {
  try {
    const signals = [AbortSignal.timeout(15_000)];
    if (signal) signals.push(signal);
    const system = [strings(bot.language).router({ ...clock(bot.language), guide: bot.searchHint }), memory]
      .filter(Boolean)
      .join('\n');
    const res = await ollamaChat(
      {
        ...(bot.model ? { model: bot.model } : {}),
        stream: false,
        format: bot.searchHint ? GUIDE_SCHEMA : SEARCH_SCHEMA,
        options: { temperature: 0, num_ctx: NUM_CTX, num_predict: 120 },
        messages: [
          { role: 'system', content: system },
          ...history.slice(-4),
          { role: 'user', content: userText },
        ],
      },
      AbortSignal.any(signals),
    );
    const data = await res.json();
    const parsed = JSON.parse(data.message?.content ?? '{}');
    const query = String(parsed.query ?? '').trim();
    const clarify = String(parsed.clarify ?? '').trim();
    // Små modeller ställer gärna motfrågor i onödan. Godta den bara när frågan faktiskt pekar på
    // något osagt ("dit", "den där", "them") och det inte finns något tidigare i samtalet att syfta på.
    if (clarify.length > 5 && clarify.includes('?') && !history.length && UNCLEAR_REFERENCE.test(userText)) {
      return { search: false, query: '', clarify };
    }
    return { search: parsed.search === true && query.length > 1, query, clarify: '' };
  } catch (error) {
    if (signal?.aborted) throw error;
    log(`sökbeslutet misslyckades (${error.message}) - svarar utan sökning`);
    return { search: false, query: '', clarify: '' };
  }
}

/**
 * Besvarar en fråga som karaktären `bot` och levererar svaret mening för mening via onSentence.
 * onSearch anropas om assistenten bestämmer sig för att söka på webben.
 *
 * @returns {Promise<string>} hela svaret
 */
export async function respond({ bot, history = [], userName, userText, memory = '', signal, onSentence, onSearch }) {
  const t = strings(bot.language);
  const decision = await decideSearch({ bot, history, userText, memory, signal });

  let question = userText;
  if (decision.clarify) {
    // Frågan går inte att besvara utan mer information: ställ motfrågan, i karaktärens egen stil.
    question = t.clarify({ userText, clarify: decision.clarify });
  } else if (decision.search) {
    // En guide-bot söker alltid inom sitt ämne, t.ex. spelets namn.
    let query = decision.query;
    if (bot.searchHint && !query.toLowerCase().includes(bot.searchHint.toLowerCase())) query = `${bot.searchHint} ${query}`;
    onSearch?.(query);
    let results;
    try {
      results = await webSearch(query, { signal, language: bot.searchLanguage, maxResults: bot.searchHint ? 6 : 5 });
    } catch (error) {
      if (signal?.aborted) throw error;
      log(`sökningen misslyckades: ${error.message}`);
      results = t.searchFailed(error.message);
    }
    question = t.withResults({ userText, query, results });
  }

  const system = t.answer({
    name: bot.name,
    persona: personaOf(bot),
    parody: bot.parody,
    knowledge: knowledgeOf(bot),
    memory,
    clock: decision.search || t.needsClock.test(userText) ? clock(bot.language) : null,
    userName,
  });
  const res = await ollamaChat(
    {
      ...(bot.model ? { model: bot.model } : {}),
      stream: true,
      options: { temperature: 0.6, num_ctx: NUM_CTX },
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: question }],
    },
    signal,
  );

  // Modellen börjar ibland svaret med sitt eget namn som i ett manus ("Sigrid: ..."). Det ska
  // inte läsas upp, så början av strömmen hålls kvar tills vi vet om den har en sådan etikett.
  const label = new RegExp(`^\\s*(?:${bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|assistant|svar|answer)\\s*:\\s*`, 'i');
  const holdBack = bot.name.length + 12;
  const splitter = new SentenceSplitter((sentence) => onSentence?.(sentence));
  let answer = '';
  let started = false;
  const feed = (final) => {
    if (started || (!final && answer.length < holdBack)) return;
    started = true;
    answer = answer.replace(label, '');
    splitter.push(answer);
  };
  for await (const part of ndjson(res.body)) {
    if (part.error) throw new Error(`Ollama: ${part.error}`);
    const delta = part.message?.content;
    if (!delta) continue;
    answer += delta;
    if (started) splitter.push(delta);
    else feed(false);
  }
  feed(true);
  splitter.flush();
  return answer.replace(/<\|[^|>]*\|>/g, ' ').replace(/\s+/g, ' ').trim();
}

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    race: { type: 'string' },
    class: { type: 'string' },
    level: { type: 'integer' },
    faction: { type: 'string' },
    professions: { type: 'string' },
  },
  required: ['race', 'class', 'level', 'faction', 'professions'],
};

/** Vad säger personen om sin egen spelkaraktär? Används av minnet (memory.js). */
export async function extractProfile(userText) {
  const res = await ollamaChat(
    {
      stream: false,
      format: PROFILE_SCHEMA,
      options: { temperature: 0, num_ctx: NUM_CTX, num_predict: 80 },
      messages: [
        {
          role: 'system',
          content:
            'Extract only what the speaker states about THEIR OWN World of Warcraft character in the message. ' +
            'race and class in English (for example Undead, Rogue). faction is Horde or Alliance. ' +
            'Use an empty string, or 0 for level, for everything that is not clearly stated. Never guess. ' +
            'Questions about other classes, races or levels are not statements about the speaker.',
        },
        { role: 'user', content: userText },
      ],
    },
    AbortSignal.timeout(15_000),
  );
  return JSON.parse((await res.json()).message?.content ?? '{}');
}

/** Laddar modellen i förväg så att första svaret inte dröjer. */
export async function warmUp() {
  const res = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Samma num_ctx som i frågorna, annars laddar Ollama om modellen vid första frågan (~10 s).
    body: JSON.stringify({ model: config.model, keep_alive: '60m', options: { num_ctx: NUM_CTX } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
  await res.arrayBuffer();
}
