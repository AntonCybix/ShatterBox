// Ljud in och ut för samtal i terminalen, utan extra Node-paket: uppspelning och mikrofon
// sköts av program som redan finns på datorn.
//
//   Windows  uppspelning: PowerShell (System.Media.SoundPlayer)   mikrofon: ffmpeg (DirectShow)
//   Linux    uppspelning: aplay / paplay / ffplay                 mikrofon: arecord / parec / ffmpeg
//   macOS    uppspelning: afplay                                  mikrofon: ffmpeg (avfoundation)

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, IS_WINDOWS, VENV_DIR } from '../../lib/paths.mjs';
import { capture, which } from '../../lib/services.mjs';

export const MIC_RATE = 16_000;
const SETTINGS = path.join(DATA_DIR, 'talk.json');

export function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, `${JSON.stringify({ ...loadSettings(), ...patch }, null, 2)}\n`, 'utf8');
}

/** ffmpeg från PATH, annars den som följer med talsyntesens Python-miljö (imageio-ffmpeg). */
export async function findFfmpeg() {
  const inPath = await which('ffmpeg');
  if (inPath) return inPath;
  const sitePackages = IS_WINDOWS
    ? [path.join(VENV_DIR, 'Lib', 'site-packages')]
    : fs.existsSync(path.join(VENV_DIR, 'lib'))
      ? fs.readdirSync(path.join(VENV_DIR, 'lib')).map((dir) => path.join(VENV_DIR, 'lib', dir, 'site-packages'))
      : [];
  for (const dir of sitePackages) {
    const binaries = path.join(dir, 'imageio_ffmpeg', 'binaries');
    if (!fs.existsSync(binaries)) continue;
    const file = fs.readdirSync(binaries).find((name) => name.startsWith('ffmpeg'));
    if (file) return path.join(binaries, file);
  }
  return null;
}

/** Mikrofonerna som DirectShow känner till (Windows). */
export async function listWindowsMics(ffmpeg) {
  const result = await capture(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  const mics = [];
  let section = '';
  for (const line of result.stderr.split(/\r?\n/)) {
    if (/DirectShow video devices/i.test(line)) section = 'video';
    else if (/DirectShow audio devices/i.test(line)) section = 'audio';
    const match = /"([^"]+)"(?:\s+\((audio|video|none)\))?\s*$/.exec(line);
    if (!match || /Alternative name/i.test(line)) continue;
    if (match[2] === 'audio' || (!match[2] && section === 'audio')) mics.push(match[1]);
  }
  return mics;
}

/**
 * Vad som finns att spela upp och spela in med på den här datorn.
 * player/recorder är null om inget hittades.
 */
export async function detectAudio({ mic } = {}) {
  const ffmpeg = await findFfmpeg();
  let player = null;
  let recorder = null;

  if (IS_WINDOWS) {
    player = { kind: 'winhelper', label: 'Windows ljudutgång' };
    if (ffmpeg) {
      const mics = await listWindowsMics(ffmpeg);
      const wanted = mic ?? loadSettings().mic;
      const picked = /^\d+$/.test(String(wanted ?? '')) ? mics[Number(wanted) - 1] : mics.find((name) => name === wanted) ?? mics[0];
      if (picked) {
        recorder = {
          label: picked,
          mics,
          command: ffmpeg,
          args: ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '40', '-i', `audio=${picked}`,
            '-ac', '1', '-ar', String(MIC_RATE), '-f', 's16le', 'pipe:1'],
        };
      }
    }
    return { player, recorder, ffmpeg };
  }

  const has = async (program) => Boolean(await which(program));
  if (process.platform === 'darwin') {
    if (await has('afplay')) player = { kind: 'file', label: 'afplay', command: 'afplay', args: (file) => [file] };
    if (ffmpeg) {
      recorder = {
        label: 'ffmpeg (avfoundation)',
        command: ffmpeg,
        args: ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', `:${mic ?? 'default'}`, '-ac', '1', '-ar', String(MIC_RATE), '-f', 's16le', 'pipe:1'],
      };
    }
    return { player, recorder, ffmpeg };
  }

  // Linux
  if (await has('aplay')) {
    player = { kind: 'stream', label: 'aplay (ALSA)', command: 'aplay', args: (rate) => ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(rate), '-c', '1', '-'] };
  } else if (await has('paplay')) {
    player = { kind: 'stream', label: 'paplay (PulseAudio/PipeWire)', command: 'paplay', args: (rate) => ['--raw', '--format=s16le', `--rate=${rate}`, '--channels=1'] };
  } else if (await has('ffplay')) {
    player = { kind: 'stream', label: 'ffplay', command: 'ffplay', args: (rate) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-f', 's16le', '-ar', String(rate), '-ch_layout', 'mono', '-i', 'pipe:0'] };
  }
  const device = mic ? ['-D', String(mic)] : [];
  if (await has('arecord')) {
    recorder = { label: `arecord (ALSA${mic ? `, ${mic}` : ''})`, command: 'arecord', args: ['-q', ...device, '-t', 'raw', '-f', 'S16_LE', '-r', String(MIC_RATE), '-c', '1', '-'] };
  } else if (await has('parec')) {
    recorder = { label: 'parec (PulseAudio/PipeWire)', command: 'parec', args: ['--raw', '--format=s16le', `--rate=${MIC_RATE}`, '--channels=1', ...(mic ? [`--device=${mic}`] : [])] };
  } else if (ffmpeg) {
    recorder = { label: 'ffmpeg (ALSA)', command: ffmpeg, args: ['-hide_banner', '-loglevel', 'error', '-f', 'alsa', '-i', String(mic ?? 'default'), '-ac', '1', '-ar', String(MIC_RATE), '-f', 's16le', 'pipe:1'] };
  }
  return { player, recorder, ffmpeg };
}

function wavFile(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Spelar upp klipp (mono, 16-bit PCM) i den ordning de köas.
 * Händelser: 'start' (klipp), 'drain' (kön är tom), 'error' (text)
 * Varje klipp: { pcm, sampleRate, duration (s), startedAt (ms eller null) }
 */
export class Player extends EventEmitter {
  constructor(backend) {
    super();
    this.backend = backend;
    this.clips = [];
    this.nextId = 1;
    this.child = null;
    this.rate = 0;
    this.queueEnd = 0;
    this.drainTimer = null;
    this.idleTimer = null;
    this.tempDir = null;
    this.closed = false;
    if (backend.kind === 'winhelper') this.#startHelper();
  }

  get playing() {
    return this.clips.length > 0;
  }

  /** Klippet som hörs just nu och hur långt in i det vi är, för visualiseringen. */
  current(now = Date.now()) {
    for (const clip of this.clips) {
      if (clip.startedAt === null) continue;
      const offset = (now - clip.startedAt) / 1000;
      if (offset >= 0 && offset < clip.duration) return { clip, offset };
    }
    return null;
  }

  /** Löser ut när allt som köats har spelats klart (eller avbrutits). */
  idle() {
    if (!this.playing) return Promise.resolve();
    return new Promise((resolve) => this.once('drain', resolve));
  }

  enqueue(pcm, sampleRate) {
    if (this.closed) return null;
    const clip = { id: this.nextId++, pcm, sampleRate, duration: pcm.length / 2 / sampleRate, startedAt: null, file: null };
    this.clips.push(clip);
    if (this.backend.kind === 'stream') this.#enqueueStream(clip);
    else this.#enqueueFile(clip);
    return clip;
  }

  /** Tystnar direkt och tömmer kön. */
  stop() {
    const had = this.playing;
    clearTimeout(this.drainTimer);
    clearTimeout(this.idleTimer);
    this.#removeFiles(this.clips);
    this.clips = [];
    this.queueEnd = 0;
    this.#killChild();
    if (this.backend.kind === 'winhelper' && !this.closed) this.#startHelper();
    if (had) this.emit('drain');
  }

  close() {
    this.closed = true;
    this.stop();
    if (this.tempDir) fs.rmSync(this.tempDir, { recursive: true, force: true });
  }

  #killChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeAllListeners();
    child.stdout?.removeAllListeners();
    child.stdin?.on('error', () => {});
    child.on('error', () => {});
    try {
      child.kill();
    } catch {
      // redan avslutad
    }
  }

  #finish(clip) {
    this.#removeFiles([clip]);
    this.clips = this.clips.filter((entry) => entry !== clip);
    if (!this.clips.length) this.emit('drain');
  }

  #removeFiles(clips) {
    for (const clip of clips) if (clip.file) fs.rm(clip.file, { force: true }, () => {});
  }

  // --- rå PCM till ett program som spelar upp från stdin (Linux) -------------------------
  #enqueueStream(clip) {
    clearTimeout(this.idleTimer);
    if (this.child && this.rate !== clip.sampleRate) this.#killChild();
    let latency = 30;
    if (!this.child) {
      latency = 150; // programmet ska hinna starta och öppna ljudkortet
      this.rate = clip.sampleRate;
      const child = spawn(this.backend.command, this.backend.args(clip.sampleRate), { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.on('error', () => {});
      child.on('error', (error) => this.emit('error', `Kunde inte spela upp ljud med ${this.backend.command}: ${error.message}`));
      child.on('exit', () => {
        if (this.child === child) this.child = null;
      });
      this.child = child;
    }
    const now = Date.now();
    clip.startedAt = Math.max(now + latency, this.queueEnd);
    this.queueEnd = clip.startedAt + clip.duration * 1000;
    this.child.stdin.write(clip.pcm);
    setTimeout(() => {
      if (this.clips.includes(clip)) this.emit('start', clip);
    }, clip.startedAt - now);
    setTimeout(() => {
      if (!this.clips.includes(clip)) return;
      this.#finish(clip);
      // Släpp ljudkortet om inget mer kommer på en stund.
      if (!this.clips.length) {
        this.idleTimer = setTimeout(() => {
          this.child?.stdin.end();
          this.child = null;
        }, 2500);
      }
    }, this.queueEnd - now + 80);
  }

  // --- en WAV-fil per klipp (Windows-hjälparen och afplay) -------------------------------
  #enqueueFile(clip) {
    if (!this.tempDir) this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shatterbox-'));
    clip.file = path.join(this.tempDir, `${clip.id}.wav`);
    fs.writeFileSync(clip.file, wavFile(clip.pcm, clip.sampleRate));
    if (this.backend.kind === 'winhelper') {
      this.child?.stdin.write(`play ${clip.id} ${Buffer.from(clip.file, 'utf8').toString('base64')}\n`);
    } else if (this.clips.length === 1) {
      this.#playNextFile();
    }
  }

  #playNextFile() {
    const clip = this.clips[0];
    if (!clip) return;
    const child = spawn(this.backend.command, this.backend.args(clip.file), { stdio: 'ignore' });
    this.child = child;
    clip.startedAt = Date.now() + 60;
    this.emit('start', clip);
    child.on('error', (error) => this.emit('error', `Kunde inte spela upp ljud med ${this.backend.command}: ${error.message}`));
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      this.#finish(clip);
      this.#playNextFile();
    });
  }

  #startHelper() {
    const script = fileURLToPath(new URL('./win-player.ps1', import.meta.url));
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.child = child;
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.emit('error', `Kunde inte starta ljuduppspelningen: ${error.message}`));
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const [event, id, ...rest] = buffered.slice(0, newline).trim().split(' ');
        buffered = buffered.slice(newline + 1);
        const clip = this.clips.find((entry) => String(entry.id) === id);
        if (event === 'start' && clip) {
          clip.startedAt = Date.now() + 40;
          this.emit('start', clip);
        } else if (event === 'error') {
          this.emit('error', `Kunde inte spela upp ljudet: ${rest.join(' ')}`);
        } else if (event === 'end' && clip) {
          this.#finish(clip);
        }
      }
    });
  }
}

/** Mikrofonen som en ström av 16 kHz mono PCM. Händelser: 'data' (Buffer), 'error' (text) */
export class Recorder extends EventEmitter {
  constructor(backend) {
    super();
    this.backend = backend;
    this.child = null;
  }

  get running() {
    return Boolean(this.child);
  }

  start() {
    if (this.child) return;
    const child = spawn(this.backend.command, this.backend.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let carry = null; // ett udda byte som väntar på sin andra halva
    let errors = '';
    child.stdout.on('data', (chunk) => {
      let data = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = data.length % 2 ? data.subarray(data.length - 1) : null;
      if (carry) data = data.subarray(0, data.length - 1);
      if (data.length) this.emit('data', data);
    });
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-400);
    });
    child.on('error', (error) => {
      if (this.child === child) this.child = null;
      this.emit('error', `Kunde inte starta mikrofonen (${this.backend.command}): ${error.message}`);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.emit('error', `Mikrofonen stängdes oväntat${code ? ` (kod ${code})` : ''}. ${errors.trim().split(/\r?\n/).at(-1) ?? ''}`.trim());
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.removeAllListeners('exit');
    try {
      child.kill();
    } catch {
      // redan avslutad
    }
  }
}
