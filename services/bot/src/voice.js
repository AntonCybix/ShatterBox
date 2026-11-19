import { once } from 'node:events';
import { Readable, pipeline } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import { config, log } from './config.js';
import { applyGlossary, loadGlossary } from './glossary.js';
import { strings } from './i18n.js';
import { monoToStereo, synthesize, transcribe, ttsReady } from './speech.js';
import { hasStopWord, hasWakeWord, isInterruption, realWords, stripWakeWord } from './text.js';

const STT_RATE = 16_000; // Opus kan avkodas direkt till 16 kHz mono, det Whisper vill ha
const PLAY_RATE = 48_000; // Discord spelar 48 kHz stereo
const MIN_UTTERANCE_S = 0.5;
const MAX_UTTERANCE_S = 30;
const FOLLOW_UP_MS = 30_000; // så länge väntar en bot på svar på sin motfråga
const BARGE_IN_STEP_S = 0.5; // hur ofta ljudet kontrolleras medan någon pratar över boten
const BARGE_IN_MAX_CHECKS = 8; // ... och hur många gånger per replik, för att inte dra processorkraft i onödan

// Färdigsyntetiserade standardfraser per karaktär, så att de kan spelas upp direkt.
const phraseCache = new Map(); // `${bot.key}:${fras}` -> ljud
const prewarming = new Map(); // bot.key -> pågående förberedelse
const currentVoice = new Map(); // bot.key -> rösten som användes senast

/**
 * Förbereder karaktärens standardfraser ("Jag kollar upp det" m.m.). Väntar på talsyntesen
 * om den inte hunnit starta. Körs om vid varje anslutning, så att en ny röst slår igenom.
 */
export function prewarmPhrases(bot) {
  if (!prewarming.has(bot.key)) {
    const job = (async () => {
      for (let attempt = 0; !(await ttsReady()); attempt += 1) {
        if (attempt === 0) log(`[${bot.name}] väntar på talsyntesen ...`);
        if (attempt >= 60) {
          log(`[${bot.name}] talsyntesen svarar inte - boten kan lyssna och svara i text men inte prata`);
          return;
        }
        await sleep(5_000);
      }
      const t = strings(bot.language);
      let voice = '';
      for (const phrase of [t.filler, t.apology]) {
        try {
          const audio = await synthesize(phrase, { bot, sampleRate: PLAY_RATE });
          phraseCache.set(`${bot.key}:${phrase}`, audio);
          currentVoice.set(bot.key, audio.voice);
          voice = audio.voice;
        } catch (error) {
          log(`[${bot.name}] kunde inte förbereda frasen "${phrase}": ${error.message}`);
        }
      }
      if (voice) log(`[${bot.name}] talsyntesen är klar, röst: ${voice}`);
    })().finally(() => prewarming.delete(bot.key));
    prewarming.set(bot.key, job);
  }
  return prewarming.get(bot.key);
}

// ---------------------------------------------------------------------------------------
// Ett "rum" är en röstkanal. Flera karaktärer kan sitta i samma kanal: då lyssnar bara en
// av dem (öronen), talet transkriberas en gång, och den karaktär vars språk talades svarar.
// ---------------------------------------------------------------------------------------
const rooms = new Map();

class Room {
  constructor(key) {
    this.key = key;
    this.sessions = new Set();
    this.capturing = new Set(); // användare vi spelar in just nu
  }

  static for(channel) {
    const key = `${channel.guild.id}:${channel.id}`;
    if (!rooms.has(key)) rooms.set(key, new Room(key));
    return rooms.get(key);
  }

  get ready() {
    return [...this.sessions].filter((session) => session.ready && !session.destroyed);
  }

  /** Den session som tar emot ljudet. */
  get ears() {
    return this.ready[0] ?? null;
  }

  add(session) {
    this.sessions.add(session);
  }

  remove(session) {
    this.sessions.delete(session);
    if (!this.sessions.size) rooms.delete(this.key);
  }

  anySpeaking() {
    return this.ready.some((session) => session.isSpeaking());
  }

  /**
   * Tystar de botar som pratar, om det som sades räcker för det. En vanlig bot tystnar av
   * minst två riktiga ord. En bot som bara svarar på sitt namn sitter ofta i en kanal där folk
   * pratar med varandra, så den tystnar bara av sitt namn eller ett stoppord.
   */
  static mayInterrupt(session, text) {
    return session.bot.wakeOnly
      ? hasWakeWord(text, session.bot.wakeWords) || hasStopWord(text)
      : isInterruption(text, config.bargeInWords);
  }

  interruptBy(text) {
    let interrupted = false;
    for (const session of this.ready) {
      if (session.isSpeaking() && Room.mayInterrupt(session, text)) {
        session.interrupt();
        interrupted = true;
      }
    }
    return interrupted;
  }

  /**
   * Språken som karaktärerna i kanalen lyssnar på just nu. Bara om de är fler än ett
   * behöver tal-till-text känna av språket (och ha en extra modell igång).
   */
  languages() {
    return [...new Set(this.ready.flatMap((session) => session.bot.listenLanguages))];
  }

  /** Ämnesord från karaktärerna i kanalen, som hjälp till taligenkänningen. */
  hotwords() {
    return this.ready.map((session) => session.bot.hotwords).filter(Boolean).join(', ');
  }

  /** Vem ska svara? */
  route(language, text, userId) {
    const ready = this.ready;
    // 1. Den som tilltalas med namn.
    const named = ready.find((session) => hasWakeWord(text, session.bot.wakeWords));
    if (named) return named;
    // 2. En bot som nyss ställde en motfråga till just den här personen.
    const waiting = ready.find((session) => session.awaitsReplyFrom(userId));
    if (waiting) return waiting;
    // 3. Annars en bot som svarar på allt, i första hand den som pratar samma språk.
    const open = ready.filter((session) => !session.bot.wakeOnly);
    return open.find((session) => session.bot.language === language) ?? open[0] ?? null;
  }

  async handleUtterance(userId, member, pcm) {
    const seconds = pcm.length / 2 / STT_RATE;
    if (seconds < MIN_UTTERANCE_S) return;

    const started = Date.now();
    const languages = this.languages();
    if (!languages.length) return;
    const result = await transcribe(pcm, { languages, hotwords: this.hotwords() });
    const heard = (result.text ?? '').trim();
    if (!realWords(heard).length) return; // bara skratt, hostningar eller "mm"

    const target = this.route(result.language, heard, userId);
    if (!target) return; // ingen bot tilltalades
    const { bot } = target;
    if (bot.listenTo === 'owner' && bot.ownerId && userId !== bot.ownerId) return;
    // Pratar boten själv fortfarande, och det här inte räcker för att avbryta den, ska det inte besvaras heller.
    if (config.bargeIn && target.isSpeaking() && !Room.mayInterrupt(target, heard)) return;

    const name = member?.displayName ?? strings(bot.language).someone;
    const stt = ((Date.now() - started) / 1000).toFixed(1);
    log(`[${bot.name}] ${name} (${seconds.toFixed(1)} s, ${result.language}, STT ${stt} s): ${heard}`);

    for (const session of this.ready) if (session !== target) session.interrupt();
    await target.respondTo(name, heard, userId);
  }
}

export class VoiceSession {
  constructor(channel, bot, conversation) {
    this.channel = channel;
    this.guild = channel.guild;
    this.bot = bot;
    this.conversation = conversation;
    this.room = Room.for(channel);
    this.turn = null;
    this.followUp = null; // { userId, until } efter en motfråga
    this.ready = false;
    this.destroyed = false;
    this.onClosed = null;

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on('error', (error) => log(`[${bot.name}] uppspelningsfel: ${error.message}`));
  }

  get channelId() {
    return this.channel.id;
  }

  async connect() {
    this.connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      group: this.bot.key, // håller isär anslutningarna när flera botar är på samma server
      selfDeaf: false, // måste vara av för att boten ska höra något
      selfMute: false,
    });
    this.connection.on('error', (error) => log(`[${this.bot.name}] röstanslutningsfel: ${error.message}`));
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Flyttad till annan kanal eller tillfälligt nätverksfel: ge den en chans att återansluta.
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });
    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.#close();
      this.onClosed?.();
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.connection.subscribe(this.player);
    this.connection.receiver.speaking.on('start', (userId) => this.#onSpeakingStart(userId));
    this.room.add(this);
    this.ready = true;
  }

  #close() {
    this.destroyed = true;
    this.ready = false;
    this.room.remove(this);
  }

  destroy() {
    this.interrupt();
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.#close();
  }

  isSpeaking() {
    const status = this.player.state.status;
    return status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering;
  }

  /** Tystar boten och avbryter pågående svar. */
  interrupt() {
    if (this.turn && !this.turn.done) this.turn.abort.abort();
    this.player.stop(true);
  }

  /** Startar en ny replik; en pågående replik avbryts. */
  startTurn(userText = '') {
    const previous = this.turn;
    let text = userText;
    if (previous && !previous.done) {
      previous.abort.abort();
      this.player.stop(true);
      // Personen pausade mitt i en mening: slå ihop med det som ännu inte besvarats.
      if (!previous.spoke && previous.userText && userText) text = `${previous.userText} ${userText}`;
    }
    const turn = {
      abort: new AbortController(),
      startedAt: Date.now(),
      userText: text,
      spoke: false,
      done: false,
      synthChain: Promise.resolve(),
      playChain: Promise.resolve(),
    };
    this.turn = turn;
    return turn;
  }

  /** Väntar tills allt som köats i repliken har spelats upp. */
  async endTurn(turn) {
    try {
      await turn.playChain;
    } finally {
      turn.done = true;
    }
  }

  /** Köar en mening: syntes sker i ordning, uppspelning i ordning. */
  say(text, turn) {
    const { signal } = turn.abort;
    const audio = (turn.synthChain = turn.synthChain.then(() => (signal.aborted ? null : this.#synth(text, signal))));
    turn.playChain = turn.playChain.then(async () => {
      const result = await audio;
      if (!result || signal.aborted || this.destroyed) return;
      await this.#play(result, turn);
    });
  }

  /** Säger en fristående fras, t.ex. hälsningen. */
  async announce(text) {
    if (!text) return;
    const turn = this.startTurn();
    this.say(text, turn);
    await this.endTurn(turn);
  }

  /** Har boten nyss ställt en motfråga till den här personen? Då behövs inget väckningsord för svaret. */
  awaitsReplyFrom(userId) {
    return Boolean(this.followUp && this.followUp.userId === userId && Date.now() < this.followUp.until);
  }

  /** Svarar på något som sagts i kanalen. */
  async respondTo(userName, heard, userId) {
    const t = strings(this.bot.language);
    // Ta bort tilltalet och rätta förvanskade egennamn mot karaktärens ordlista.
    const said = applyGlossary(stripWakeWord(heard, this.bot.wakeWords), loadGlossary(this.bot));
    if (said !== heard) log(`[${this.bot.name}]   tolkat som: ${said}`);
    const turn = this.startTurn(said);
    this.followUp = null;
    let answer = '';
    try {
      answer = await this.conversation.ask({
        userName,
        userId,
        userText: turn.userText,
        signal: turn.abort.signal,
        onSentence: (sentence) => this.say(sentence, turn),
        onSearch: (query) => {
          log(`[${this.bot.name}]   söker: ${query}`);
          this.say(t.filler, turn); // förinspelad fras, så att det inte blir tyst under sökningen
        },
      });
      log(`[${this.bot.name}] ${this.bot.name}: ${answer}`);
    } catch (error) {
      if (!turn.abort.signal.aborted) {
        log(`[${this.bot.name}] fel: ${error.message}`);
        this.say(t.apology, turn);
      }
    } finally {
      await this.endTurn(turn);
    }
    // Slutade svaret med en fråga får personen svara utan att säga namnet igen.
    if (userId && !turn.abort.signal.aborted && /\?\s*$/.test(answer)) {
      this.followUp = { userId, until: Date.now() + FOLLOW_UP_MS };
    }
  }

  async #synth(text, signal) {
    const key = `${this.bot.key}:${text}`;
    const cached = phraseCache.get(key);
    // En förinspelad fras duger bara om den har samma röst som boten pratar med just nu
    // (röstprovet kan ha bytts sedan frasen spelades in).
    const current = currentVoice.get(this.bot.key);
    if (cached && (!current || cached.voice === current)) return cached;
    try {
      const audio = await synthesize(text, { bot: this.bot, signal, sampleRate: PLAY_RATE });
      currentVoice.set(this.bot.key, audio.voice);
      if (cached) phraseCache.set(key, audio);
      log(`[${this.bot.name}]   tal: ${audio.audioSeconds.toFixed(1)} s ljud på ${audio.genSeconds.toFixed(1)} s`);
      return audio;
    } catch (error) {
      if (!signal.aborted) log(`[${this.bot.name}] talsyntesfel: ${error.message}`);
      return null;
    }
  }

  async #play(audio, turn) {
    if (audio.sampleRate !== PLAY_RATE) {
      log(`[${this.bot.name}] fel samplingsfrekvens från talsyntesen: ${audio.sampleRate}`);
      return;
    }
    const stream = new Readable({ read() {} });
    stream.push(monoToStereo(audio.pcm));
    stream.push(null);
    this.player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
    if (!turn.spoke && turn.userText) {
      const waited = ((Date.now() - turn.startedAt) / 1000).toFixed(1);
      log(`[${this.bot.name}]   börjar prata ${waited} s efter att frågan uppfattats`);
    }
    turn.spoke = true;
    try {
      await once(this.player, AudioPlayerStatus.Idle, { signal: turn.abort.signal });
    } catch {
      // avbruten
    }
  }

  #onSpeakingStart(userId) {
    const room = this.room;
    // Bara en session per kanal lyssnar, annars skulle varje replik behandlas flera gånger.
    if (this.destroyed || room.ears !== this || room.capturing.has(userId)) return;
    const member = this.guild.members.cache.get(userId);
    if (member?.user.bot) return; // lyssna inte på andra botar (eller oss själva)
    // Lyssnar alla botar i kanalen bara på sin ägare behöver andras tal inte ens transkriberas.
    const owners = room.ready.map((session) => (session.bot.listenTo === 'owner' ? session.bot.ownerId : null));
    if (owners.length && owners.every(Boolean) && !owners.includes(userId)) return;

    room.capturing.add(userId);
    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs },
    });
    const decoder = new prism.opus.Decoder({ rate: STT_RATE, channels: 1, frameSize: STT_RATE / 50 });
    const chunks = [];
    let bytes = 0;
    let interrupted = false;
    let checking = false;
    let checks = 0;
    let nextCheck = (config.bargeInMs / 1000) * STT_RATE * 2;

    // Avbryt en bot som pratar först när det som sägs faktiskt är ord. Medan någon låter
    // samtidigt som boten talar skickas ljudet hittills till taligenkänningen då och då;
    // skratt, hostningar och enstaka ord släpps förbi.
    const maybeInterrupt = () => {
      if (!config.bargeIn || interrupted || checking || checks >= BARGE_IN_MAX_CHECKS) return;
      if (bytes < nextCheck || !room.anySpeaking()) return;
      checking = true;
      checks += 1;
      nextCheck = bytes + BARGE_IN_STEP_S * STT_RATE * 2;
      transcribe(Buffer.concat(chunks), { languages: room.languages(), hotwords: room.hotwords() })
        .then((result) => {
          if (interrupted || !room.anySpeaking()) return;
          if (room.interruptBy(result.text)) {
            interrupted = true;
            log(`  (avbruten: "${(result.text ?? '').trim()}")`);
          }
        })
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    };

    decoder.on('data', (chunk) => {
      chunks.push(chunk);
      bytes += chunk.length;
      maybeInterrupt();
      if (bytes >= MAX_UTTERANCE_S * STT_RATE * 2) opus.destroy();
    });

    pipeline(opus, decoder, (error) => {
      room.capturing.delete(userId);
      if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') log(`mottagningsfel: ${error.message}`);
      room.handleUtterance(userId, member, Buffer.concat(chunks)).catch((err) => log(`fel i svaret: ${err.message}`));
    });
  }
}
