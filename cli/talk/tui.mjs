// Samtalsfönstret i terminalen: ljudstaplar överst, samtalet under, och en inmatningsrad.
// Ritas om cirka 30 gånger per sekund på terminalens alternativa skärm, så att det som stod
// i terminalen innan kommer tillbaka när man avslutar.

import { MIC_RATE } from './audio.mjs';
import { Vad, spectrum } from './dsp.mjs';
import { Visualizer, paint } from './viz.mjs';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_SPINNER = ['|', '/', '-', '\\'];
const BANDS = 28;
const RESET = '\x1b[0m';

const COLORS = {
  brand: [45, 212, 191],
  you: [74, 222, 128],
  bot: [232, 121, 249],
  note: [251, 191, 36],
  dim: [120, 120, 130],
  text: [226, 226, 232],
};

/** Bryter text i rader om högst `width` tecken, vid mellanslag när det går. */
function wrap(text, width) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let rest = word;
      while (rest.length > width) {
        if (line) lines.push(line);
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
        line = '';
      }
      if (!line) line = rest;
      else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
      else {
        lines.push(line);
        line = rest;
      }
    }
    lines.push(line);
  }
  return lines;
}

export class Tui {
  /**
   * session: Session. recorder: Recorder eller null. options: { ascii, color, barge, mic, verbose,
   * languages, greeting, modelName, onMicChange }
   */
  constructor({ session, modules, player, recorder, options }) {
    this.session = session;
    this.m = modules;
    this.player = player;
    this.recorder = recorder;
    this.options = options;
    this.viz = new Visualizer({ ascii: options.ascii, color: options.color });
    this.color = this.viz.color;
    this.ascii = this.viz.ascii;
    this.transcript = [];
    this.input = '';
    this.micOn = false;
    this.micState = 'off'; // off | listening | hearing | transcribing
    this.micTail = Buffer.alloc(0);
    this.muteUntil = 0;
    this.detail = '';
    this.timing = '';
    this.running = false;
    this.vad = new Vad({ sampleRate: MIC_RATE, silenceMs: modules.config.silenceMs });
    this.#wire();
  }

  #paint(name, text) {
    const code = paint(COLORS[name], this.color);
    return code ? `${code}${text}${RESET}` : text;
  }

  note(text) {
    this.transcript.push({ who: 'note', text });
  }

  #wire() {
    const { session } = this;
    session.on('user', (text) => this.transcript.push({ who: 'you', text }));
    session.on('sentence', (sentence) => {
      const last = this.transcript.at(-1);
      if (last?.who === 'bot' && last.open) last.text += ` ${sentence}`;
      else this.transcript.push({ who: 'bot', text: sentence, open: true });
    });
    const close = () => {
      const last = this.transcript.at(-1);
      if (last?.who === 'bot') last.open = false;
      this.muteUntil = Date.now() + 350; // låt ekot av sista ordet klinga ut innan mikrofonen lyssnar
    };
    session.on('done', ({ firstMs, totalMs }) => {
      close();
      this.timing = firstMs === null ? '' : `svarade efter ${(firstMs / 1000).toFixed(1)} s · klar efter ${(totalMs / 1000).toFixed(1)} s`;
    });
    session.on('interrupted', () => {
      const last = this.transcript.at(-1);
      if (last?.who === 'bot' && last.open) last.text += ' …';
      close();
      this.viz.shatter();
    });
    session.on('state', (state, detail) => {
      this.detail = detail;
    });
    session.on('notice', (text) => this.note(text));
    this.player?.on('error', (text) => this.note(text));

    this.vad.on('level', (level) => this.viz.feedLevel(level));
    this.vad.on('start', () => {
      this.micState = 'hearing';
    });
    this.vad.on('cancel', () => {
      this.micState = 'listening';
    });
    this.vad.on('speech', (audio) => this.#heard(audio));
    this.vad.on('level', (level) => {
      this.micPeak = Math.max(this.micPeak ?? 0, level);
    });
    this.#attach(this.recorder);
  }

  #attach(recorder) {
    recorder?.on('data', (chunk) => this.#micData(chunk));
    recorder?.on('error', (text) => {
      this.note(text);
      this.micOn = false;
      this.micState = 'off';
    });
  }

  /** Byter mikrofon medan samtalet pågår (/mic 2). */
  async #switchMic(number) {
    if (!this.options.selectMic) return this.note('Här väljs mikrofonen när programmet startas:  --mic=<enhet>');
    try {
      const next = await this.options.selectMic(number);
      this.recorder?.stop();
      this.recorder?.removeAllListeners();
      this.recorder = next;
      this.#attach(next);
      this.#setMic(true);
    } catch (error) {
      this.note(error.message);
    }
    return undefined;
  }

  #micData(chunk) {
    if (!this.micOn) return;
    // Utan hörlurar hör mikrofonen botens egen röst, så den stängs medan boten pratar.
    const blocked = (this.session.busy || Date.now() < this.muteUntil) && !this.options.barge;
    if (blocked) {
      if (this.vad.speaking) this.vad.reset();
      return;
    }
    this.micTail = Buffer.concat([this.micTail, chunk]).subarray(-MIC_RATE * 2 * 0.2);
    this.vad.push(chunk);
  }

  async #heard(audio) {
    this.micState = 'transcribing';
    try {
      const result = await this.m.transcribe(audio, { languages: this.options.languages });
      const text = (result.text ?? '').trim();
      if (!this.m.realWords(text).length) return;
      if (this.session.busy && !this.m.isInterruption(text, this.m.config.bargeInWords)) return;
      this.session.send(text);
    } catch (error) {
      this.note(`Taligenkänningen svarar inte (${error.message}). Skriv i stället, eller kör "shatterbox start".`);
      this.#setMic(false);
    } finally {
      if (this.micOn && this.micState === 'transcribing') this.micState = 'listening';
    }
  }

  #setMic(on) {
    if (on && !this.recorder) {
      this.note(this.options.noMicReason ?? 'Hittade ingen mikrofon. Kör "shatterbox doctor" för att se vad som saknas.');
      return;
    }
    this.micOn = on;
    this.micState = on ? 'listening' : 'off';
    this.vad.reset();
    this.micPeak = 0;
    this.micOnAt = Date.now();
    this.silenceWarned = false;
    if (on) {
      this.recorder.start();
      const others = (this.options.micNames ?? []).length > 1;
      this.note(`Mikrofon: ${this.recorder.backend.label}${others ? '. Byt med /mic <nummer>, lista med /mics.' : ''}`);
    } else {
      this.recorder?.stop();
    }
  }

  /** En mikrofon som inte ger ett enda ljud är oftast fel enhet (en virtuell eller avstängd). */
  #checkSilence(now) {
    if (!this.micOn || this.silenceWarned || now - this.micOnAt < 4000 || this.micPeak > 0) return;
    if (this.session.busy && !this.options.barge) {
      this.micOnAt = now; // mikrofonen är avstängd medan boten pratar, räkna om efteråt
      return;
    }
    this.silenceWarned = true;
    this.note('Mikrofonen ger inget ljud alls. Det är troligen fel enhet. Skriv /mics för att se de som finns.');
  }

  // --- tangentbordet -------------------------------------------------------------------
  #key(chunk) {
    // Styrsekvenser (piltangenter m.m.) börjar med Esc följt av fler tecken.
    if (chunk.length > 1 && chunk.startsWith('\x1b')) return;
    for (const ch of chunk) {
      if (ch === '\x03' || ch === '\x04') return this.quit();
      if (ch === '\x1b') {
        if (!this.session.interrupt()) this.input = '';
      } else if (ch === '\r' || ch === '\n') {
        this.#submit();
      } else if (ch === '\x7f' || ch === '\b') {
        this.input = [...this.input].slice(0, -1).join('');
      } else if (ch === '\x15') {
        this.input = '';
      } else if (ch === '\t') {
        this.#setMic(!this.micOn);
      } else if (ch >= ' ') {
        this.input += ch;
      }
    }
    return undefined;
  }

  #submit() {
    const text = this.input.trim();
    this.input = '';
    if (!text) return;
    if (!text.startsWith('/')) {
      this.session.send(text);
      return;
    }
    const command = text.slice(1).toLowerCase();
    if (['quit', 'exit', 'q', 'avsluta'].includes(command)) this.quit();
    else if (['reset', 'glöm', 'nytt'].includes(command)) {
      this.session.reset();
      this.transcript = [];
      this.note('Samtalet är nollställt.');
    } else if (['mic', 'mik', 'mikrofon'].includes(command)) this.#setMic(!this.micOn);
    else if (/^(mic|mik|mikrofon) \d+$/.test(command)) this.#switchMic(Number(command.split(' ')[1]));
    else if (['mics', 'mikrofoner'].includes(command)) {
      const names = this.options.micNames ?? [];
      this.note(names.length
        ? `Mikrofoner: ${names.map((name, i) => `${i + 1}. ${name}`).join('   ')}`
        : 'Här väljs mikrofonen när programmet startas:  --mic=<enhet>');
    } else if (['help', 'hjälp', '?'].includes(command)) {
      this.note('Enter skickar det du skrivit. Tab slår av och på mikrofonen. Esc avbryter svaret. /mics visar mikrofonerna och /mic <nummer> byter. /reset glömmer samtalet. /quit avslutar.');
    } else this.note(`Okänt kommando: ${text}. Skriv /hjälp.`);
  }

  // --- ritning -------------------------------------------------------------------------
  #vizState() {
    if (this.session.state !== 'idle') return this.session.state;
    if (this.micState === 'off') return 'idle';
    return this.micState;
  }

  #status(state, now) {
    const spinner = this.ascii ? ASCII_SPINNER : SPINNER;
    const spin = spinner[Math.floor(now / 90) % spinner.length];
    const dot = this.ascii ? '*' : '●';
    switch (state) {
      case 'speaking': return [`${this.ascii ? '>' : '▶'} ${this.session.bot.name} pratar`, 'bot'];
      case 'thinking': return [`${spin} Tänker …`, 'bot'];
      case 'searching': return [`${spin} Söker på nätet${this.detail ? `: ${this.detail}` : ' …'}`, 'note'];
      case 'transcribing': return [`${spin} Tolkar vad du sa …`, 'you'];
      case 'hearing': return [`${dot} Hör dig …`, 'you'];
      case 'listening': return [`${dot} Lyssnar. Säg något`, 'you'];
      default: return ['Skriv något och tryck Enter, eller Tab för mikrofon', 'dim'];
    }
  }

  #frame() {
    const now = Date.now();
    const cols = Math.max(40, process.stdout.columns || 80);
    const rows = Math.max(16, process.stdout.rows || 24);
    const vizRows = Math.max(4, Math.min(16, rows < 22 ? rows - 12 : Math.floor(rows * 0.4)));
    const state = this.#vizState();
    this.#checkSilence(now);

    this.viz.setState(state);
    if (state === 'speaking') {
      const playing = this.player?.current(now);
      if (playing) this.viz.feed(spectrum(playing.clip.pcm, playing.clip.sampleRate, playing.offset, BANDS));
    } else if (state === 'hearing' && this.micTail.length > 2048) {
      this.viz.feed(spectrum(this.micTail, MIC_RATE, this.micTail.length / 2 / MIC_RATE - 0.032, BANDS));
    }

    const lines = [];
    const center = (plain, colorName) => {
      const text = plain.length > cols - 2 ? `${plain.slice(0, cols - 3)}…` : plain;
      return ' '.repeat(Math.max(0, Math.floor((cols - text.length) / 2))) + this.#paint(colorName, text);
    };

    // Rubrikrad
    const { bot } = this.session;
    const left = ` ${this.ascii ? '<>' : '◆'} SHATTERBOX ${this.ascii ? '|' : '│'} ${bot.name}`;
    const right = [bot.language, this.options.modelName, this.session.voiceLabel ? `röst: ${this.session.voiceLabel}` : ''].filter(Boolean).join(' · ');
    const room = cols - left.length - 2;
    const rightText = right.length > room ? '' : right;
    lines.push('');
    lines.push(this.#paint('brand', left) + ' '.repeat(Math.max(1, cols - left.length - rightText.length - 1)) + this.#paint('dim', rightText));
    lines.push('');

    lines.push(...this.viz.render(cols, vizRows, now));
    const [statusText, statusColor] = this.#status(state, now);
    lines.push(center(statusText, statusColor));
    lines.push('');

    // Samtalet: de senaste raderna som får plats
    const room2 = rows - lines.length - 3;
    const width = Math.min(cols - 4, 100);
    const body = [];
    for (const entry of this.transcript) {
      const label = entry.who === 'you' ? 'Du' : entry.who === 'bot' ? bot.name : '';
      const colorName = entry.who === 'note' ? 'note' : entry.who;
      const wrapped = wrap(entry.text, width - (label ? label.length + 2 : 2));
      wrapped.forEach((line, i) => {
        if (label) body.push(i === 0 ? `  ${this.#paint(colorName, `${label}:`)} ${this.#paint('text', line)}` : `  ${' '.repeat(label.length + 2)}${this.#paint('text', line)}`);
        else body.push(`  ${this.#paint('note', `${i === 0 ? '! ' : '  '}${line}`)}`);
      });
      body.push('');
    }
    const visible = body.slice(-Math.max(1, room2));
    lines.push(...visible);
    while (lines.length < rows - 3) lines.push('');

    // Inmatning och hjälprad
    lines.push(this.#paint('dim', (this.ascii ? '-' : '─').repeat(cols)));
    const cursor = Math.floor(now / 500) % 2 ? (this.ascii ? '_' : '▏') : ' ';
    const shown = [...this.input].slice(-(cols - 6)).join('');
    lines.push(` ${this.#paint('brand', this.ascii ? '>' : '›')} ${this.#paint('text', shown)}${cursor}`);
    const mic = this.recorder ? `Tab mikrofon ${this.micOn ? 'av' : 'på'}` : 'ingen mikrofon';
    const hints = ` Enter skicka · ${mic} · Esc avbryt · /hjälp · Ctrl+C avsluta`;
    const hintLine = this.timing && hints.length + this.timing.length + 4 < cols
      ? hints + ' '.repeat(cols - hints.length - this.timing.length - 1) + this.timing
      : hints.slice(0, cols - 1);
    lines.push(this.#paint('dim', hintLine));

    let out = '';
    for (let row = 0; row < rows; row += 1) out += `\x1b[${row + 1};1H${lines[row] ?? ''}\x1b[K`;
    process.stdout.write(out);
  }

  // --- start och stopp -----------------------------------------------------------------
  start() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.running = true;
      this.originalLog = console.log;
      this.originalError = console.error;
      // Botens moduler loggar med console.log, vilket skulle rita sönder skärmen.
      const quiet = (...args) => {
        if (this.options.verbose) this.note(args.join(' '));
      };
      console.log = quiet;
      console.error = quiet;

      process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
      process.stdin.setRawMode(true);
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      this.onKey = (chunk) => this.#key(chunk);
      this.onResize = () => process.stdout.write('\x1b[2J');
      this.onExit = () => this.#restore();
      this.onSignal = () => this.quit();
      process.stdin.on('data', this.onKey);
      process.stdout.on('resize', this.onResize);
      process.on('exit', this.onExit);
      process.on('SIGINT', this.onSignal);
      process.on('SIGTERM', this.onSignal);
      this.timer = setInterval(() => {
        try {
          this.#frame();
        } catch (error) {
          this.quit(error);
        }
      }, 33);

      if (this.options.mic) this.#setMic(true);
      if (this.options.question) this.session.send(this.options.question);
      else if (this.options.greeting) this.session.say(this.options.greeting);
    });
  }

  #restore() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    console.log = this.originalLog;
    console.error = this.originalError;
    process.stdin.off('data', this.onKey);
    process.stdout.off('resize', this.onResize);
    process.off('exit', this.onExit);
    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);
    try {
      process.stdin.setRawMode(false);
    } catch {
      // terminalen är redan stängd
    }
    process.stdin.pause();
    process.stdout.write(`${RESET}\x1b[?25h\x1b[?1049l`);
  }

  quit(error) {
    if (!this.running) return;
    this.session.interrupt();
    this.recorder?.stop();
    this.#restore();
    this.resolve?.(error ?? null);
  }
}
