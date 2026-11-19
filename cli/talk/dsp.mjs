// Signalbehandling för samtalsläget: spektrum till staplarna och röstdetektering för mikrofonen.

import { EventEmitter } from 'node:events';

const FFT_SIZE = 1024;
const hann = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
const reversed = new Uint16Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i += 1) {
  let r = 0;
  for (let bit = 0; bit < 10; bit += 1) r |= ((i >> bit) & 1) << (9 - bit);
  reversed[i] = r;
}
const re = new Float32Array(FFT_SIZE);
const im = new Float32Array(FFT_SIZE);

/** Tar FFT_SIZE sampel ur 16-bit PCM från sampel nummer `start` och fyller re/im med spektrum. */
function fft(pcm, start) {
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const index = start + i;
    const value = index >= 0 && index < samples ? pcm.readInt16LE(index * 2) / 32768 : 0;
    re[reversed[i]] = value * hann[i];
    im[reversed[i]] = 0;
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const step = (-2 * Math.PI) / size;
    for (let block = 0; block < FFT_SIZE; block += size) {
      for (let k = 0; k < half; k += 1) {
        const cos = Math.cos(step * k);
        const sin = Math.sin(step * k);
        const a = block + k;
        const b = a + half;
        const tr = re[b] * cos - im[b] * sin;
        const ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * Ljudstyrkan i `bands` frekvensband (låga först) kring tidpunkten `seconds` i ett klipp.
 * Varje värde ligger mellan 0 och 1.
 */
export function spectrum(pcm, sampleRate, seconds, bands) {
  fft(pcm, Math.floor(seconds * sampleRate) - FFT_SIZE / 2);
  const low = 90;
  const high = Math.min(7000, sampleRate / 2 - 200);
  const out = new Array(bands);
  for (let band = 0; band < bands; band += 1) {
    const from = low * (high / low) ** (band / bands);
    const to = low * (high / low) ** ((band + 1) / bands);
    const first = Math.max(1, Math.floor((from / sampleRate) * FFT_SIZE));
    const last = Math.max(first + 1, Math.ceil((to / sampleRate) * FFT_SIZE));
    let peak = 0;
    for (let bin = first; bin < last && bin < FFT_SIZE / 2; bin += 1) {
      const magnitude = Math.hypot(re[bin], im[bin]);
      if (magnitude > peak) peak = magnitude;
    }
    // Decibel relativt full utstyrning, med lite lyft i diskanten där tal är svagare.
    const db = 20 * Math.log10(peak / (FFT_SIZE / 4) + 1e-6) + (band / bands) * 12;
    out[band] = Math.min(1, Math.max(0, (db + 52) / 44));
  }
  return out;
}

/** Ljudstyrka (RMS, 0-1) för en bit 16-bit PCM. */
export function rms(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Röstdetektering: delar upp mikrofonljudet i yttranden.
 * Händelser: 'level' (0-1), 'start', 'speech' (Buffer med hela yttrandet), 'cancel' (för kort)
 */
export class Vad extends EventEmitter {
  constructor({ sampleRate = 16_000, silenceMs = 900, minSpeechMs = 240, preRollMs = 300, maxMs = 30_000 } = {}) {
    super();
    this.frameBytes = Math.round(sampleRate * 0.02) * 2; // 20 ms
    this.silenceFrames = Math.round(silenceMs / 20);
    this.minFrames = Math.round(minSpeechMs / 20);
    this.preRoll = Math.round(preRollMs / 20);
    this.maxFrames = Math.round(maxMs / 20);
    this.floor = 0.004;
    this.reset();
  }

  reset() {
    this.pending = Buffer.alloc(0);
    this.history = []; // de senaste tysta bitarna, så att början av första ordet kommer med
    this.frames = [];
    this.speaking = false;
    this.voiced = 0;
    this.run = 0;
    this.quiet = 0;
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= this.frameBytes) {
      this.#frame(this.pending.subarray(0, this.frameBytes));
      this.pending = this.pending.subarray(this.frameBytes);
    }
  }

  #frame(frame) {
    const level = rms(frame);
    this.emit('level', level);
    const loud = level > Math.max(this.floor * (this.speaking ? 2.2 : 3.2), this.speaking ? 0.008 : 0.012);

    if (!this.speaking) {
      // Bakgrundsnivån följer med snabbt nedåt och långsamt uppåt.
      this.floor = level < this.floor ? this.floor * 0.9 + level * 0.1 : this.floor * 0.995 + level * 0.005;
      this.history.push(frame);
      if (this.history.length > this.preRoll + 4) this.history.shift();
      this.run = loud ? this.run + 1 : 0;
      if (this.run >= 4) {
        this.speaking = true;
        this.frames = this.history.splice(0);
        this.voiced = this.run;
        this.quiet = 0;
        this.emit('start');
      }
      return;
    }

    this.frames.push(frame);
    if (loud) {
      this.voiced += 1;
      this.quiet = 0;
    } else {
      this.quiet += 1;
    }
    if (this.quiet >= this.silenceFrames || this.frames.length >= this.maxFrames) {
      const audio = Buffer.concat(this.frames);
      const enough = this.voiced >= this.minFrames;
      this.speaking = false;
      this.frames = [];
      this.run = 0;
      this.quiet = 0;
      this.voiced = 0;
      this.emit(enough ? 'speech' : 'cancel', audio);
    }
  }
}
