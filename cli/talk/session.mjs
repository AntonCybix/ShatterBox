// Ett samtal med en karaktär utan Discord. Återanvänder botens egen logik (services/bot/src):
// samma persona, minne, ordlista, webbsök och röst som i en röstkanal.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEnv } from '../../lib/env.mjs';
import { DATA_DIR, KNOWLEDGE_DIR, LOCAL, PERSONA_DIR, ROOT } from '../../lib/paths.mjs';

/** Adresser i .env gäller inifrån Docker. Här körs vi direkt på datorn och når allt via 127.0.0.1. */
function localUrl(value, fallback, dockerNames = {}) {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (dockerNames[url.hostname]) return dockerNames[url.hostname];
    if (url.hostname === 'host.docker.internal') url.hostname = '127.0.0.1';
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

/** Läser in .env och laddar botens moduler. Måste göras innan något annat i services/bot rörs. */
export async function loadBotModules() {
  for (const [key, value] of Object.entries(readEnv())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  process.env.OLLAMA_URL = localUrl(process.env.OLLAMA_URL, LOCAL.ollama);
  process.env.STT_URL = localUrl(process.env.STT_URL, LOCAL.stt, { stt: LOCAL.stt });
  process.env.TTS_URL = localUrl(process.env.TTS_URL, LOCAL.tts, { tts: LOCAL.ttsCpu });
  process.env.SEARXNG_URL = localUrl(process.env.SEARXNG_URL, LOCAL.search, { searxng: LOCAL.search });
  process.env.PERSONA_DIR = PERSONA_DIR;
  process.env.KNOWLEDGE_DIR = KNOWLEDGE_DIR;
  process.env.MEMORY_DIR = path.join(DATA_DIR, 'memory');

  const load = (file) => import(pathToFileURL(path.join(ROOT, 'services', 'bot', 'src', file)).href);
  const [config, assistant, speech, glossary, text, i18n, persona, llm] = await Promise.all(
    ['config.js', 'assistant.js', 'speech.js', 'glossary.js', 'text.js', 'i18n.js', 'persona.js', 'llm.js'].map(load),
  );
  return { ...config, ...assistant, ...speech, ...glossary, ...text, ...i18n, ...persona, ...llm };
}

function friendly(error) {
  const code = error?.cause?.code ?? '';
  if (code === 'ECONNREFUSED' || /fetch failed/i.test(error?.message ?? '')) {
    return 'Når inte tjänsterna. Är allt igång? Kör "shatterbox start".';
  }
  return error?.message ?? String(error);
}

/**
 * Händelser:
 *   'state' (namn, detalj)   idle | thinking | searching | speaking
 *   'user' (text)            det användaren sa, efter rättning mot ordlistan
 *   'sentence' (text)        en färdig mening i svaret
 *   'done' ({ firstMs, totalMs })
 *   'interrupted'            svaret avbröts
 *   'notice' (text)          något användaren bör få veta
 */
export class Session extends EventEmitter {
  constructor({ bot, modules, player = null, userName = '' }) {
    super();
    this.bot = bot;
    this.m = modules;
    this.player = player;
    this.userName = userName;
    this.conversation = new modules.Conversation(bot);
    // Ladda språkmodellen i grafikminnet direkt, så att första svaret inte får vänta på det.
    this.ready = modules.warmUp().catch(() => {});
    this.turn = null;
    this.state = 'idle';
    this.voiceLabel = '';
    this.player?.on('start', () => {
      if (this.turn) this.#state('speaking');
    });
  }

  get busy() {
    return Boolean(this.turn);
  }

  #state(state, detail = '') {
    this.state = state;
    this.emit('state', state, detail);
  }

  reset() {
    this.interrupt();
    this.conversation.reset();
  }

  /** Avbryter svaret som pågår. Ger true om något faktiskt avbröts. */
  interrupt() {
    const turn = this.turn;
    if (!turn) return false;
    this.turn = null;
    turn.abort.abort();
    this.player?.stop();
    this.#state('idle');
    this.emit('interrupted');
    return true;
  }

  #speak(sentence, turn) {
    if (!this.player) return;
    turn.speech = turn.speech.then(async () => {
      if (turn.abort.signal.aborted || !this.player) return;
      try {
        const audio = await this.m.synthesize(sentence, { bot: this.bot, signal: turn.abort.signal, sampleRate: 24_000 });
        if (turn.abort.signal.aborted) return;
        this.voiceLabel = audio.voice || this.voiceLabel;
        this.player.enqueue(audio.pcm, audio.sampleRate);
      } catch (error) {
        if (turn.abort.signal.aborted) return;
        // Utan talsyntes fortsätter samtalet i text.
        this.player = null;
        this.emit('notice', `Talsyntesen svarar inte, så svaren visas bara som text. (${friendly(error)})`);
      }
    });
  }

  async #run(work) {
    this.interrupt();
    const turn = { abort: new AbortController(), speech: Promise.resolve(), started: Date.now(), first: null };
    this.turn = turn;
    try {
      await work(turn);
      await turn.speech;
      if (!turn.abort.signal.aborted) await this.player?.idle();
      if (this.turn === turn) this.emit('done', { firstMs: turn.first, totalMs: Date.now() - turn.started });
    } catch (error) {
      if (!turn.abort.signal.aborted) this.emit('notice', friendly(error));
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        this.#state('idle');
      }
    }
  }

  /** Säger en text ordagrant, till exempel hälsningsfrasen. */
  say(text) {
    return this.#run(async (turn) => {
      this.#state('thinking');
      this.emit('sentence', text);
      this.#speak(text, turn);
    });
  }

  /** Skickar det användaren sa eller skrev och låter karaktären svara. */
  send(text) {
    const { bot, m } = this;
    const cleaned = m.applyGlossary(m.stripWakeWord(text, bot.wakeWords), m.loadGlossary(bot));
    return this.#run(async (turn) => {
      this.emit('user', cleaned);
      this.#state('thinking');
      await this.ready;
      if (turn.abort.signal.aborted) return;
      turn.started = Date.now();
      const answer = await this.conversation.ask({
        userName: this.userName,
        userId: this.userName ? `local:${this.userName.toLowerCase()}` : null,
        userText: cleaned,
        signal: turn.abort.signal,
        onSentence: (sentence) => {
          turn.first ??= Date.now() - turn.started;
          this.emit('sentence', sentence);
          this.#speak(sentence, turn);
        },
        onSearch: (query) => this.#state('searching', query),
      });
      if (!answer) this.emit('notice', 'Fick inget svar från språkmodellen.');
    });
  }
}
