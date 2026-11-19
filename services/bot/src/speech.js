import { activeBots, bots, config } from './config.js';
import { spellOutEnglish, spellOutSwedish } from './numbers.js';

/** Texten som faktiskt skickas till talsyntesen: siffror, klockslag och datum utskrivna som ord. */
export function speakable(text, language) {
  if (language === 'sv') return spellOutSwedish(text);
  if (language === 'en') return spellOutEnglish(text);
  return text;
}

/**
 * Tal -> text. Tar rå PCM (16 kHz, mono, 16-bit) eller en WAV-fil.
 * Med flera möjliga språk avgör tjänsten vilket som talas (kostar ~0,4 s extra per replik);
 * svaret innehåller { text, language }.
 */
export async function transcribe(audio, { signal, contentType = 'audio/pcm', languages = [bots[0].language], hotwords = '' } = {}) {
  const url = new URL('/transcribe', config.sttUrl);
  if (languages.length === 1) url.searchParams.set('language', languages[0]);
  else url.searchParams.set('languages', languages.join(','));
  if (hotwords) url.searchParams.set('hotwords', hotwords.slice(0, 1500));
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body: audio, signal });
  if (!res.ok) throw new Error(`STT svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Ber tal-till-text ladda modellerna för de karaktärer som faktiskt startas. En modell som
 * bara ligger laddad drar ingen processorkraft; den används först när någon pratar det språket.
 */
export async function preloadStt() {
  const wanted = [...new Set(activeBots.flatMap((bot) => bot.listenLanguages))];
  if (!wanted.length) return;
  const url = new URL('/preload', config.sttUrl);
  url.searchParams.set('languages', wanted.join(','));
  await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

/** Text -> tal med karaktärens röst. Returnerar mono 16-bit PCM i önskad samplingsfrekvens. */
export async function synthesize(text, { bot, signal, sampleRate = 48_000 }) {
  const res = await fetch(`${config.ttsUrl}/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: speakable(text, bot.language),
      language: bot.language,
      voice: bot.voice || null,
      voice_style: bot.voiceStyle || null,
      sr: sampleRate,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`TTS svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const wav = parseWav(Buffer.from(await res.arrayBuffer()));
  return {
    ...wav,
    voice: decodeURIComponent(res.headers.get('x-voice') ?? ''),
    genSeconds: Number(res.headers.get('x-gen-seconds') ?? 0),
    audioSeconds: wav.pcm.length / 2 / wav.sampleRate,
  };
}

export function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('inte en WAV-fil');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') {
      if (bits !== 16 || channels !== 1) throw new Error(`oväntat WAV-format: ${bits} bitar, ${channels} kanaler`);
      const end = Math.min(start + size, buffer.length);
      return { pcm: buffer.subarray(start, end - ((end - start) % 2)), sampleRate };
    }
    offset = start + size + (size % 2);
  }
  throw new Error('WAV-filen saknar ljuddata');
}

export function writeWav(pcm, sampleRate, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Discord vill ha stereo: duplicera varje mono-sampel. */
export function monoToStereo(mono) {
  const samples = Math.floor(mono.length / 2);
  const stereo = Buffer.allocUnsafe(samples * 4);
  for (let i = 0; i < samples; i += 1) {
    const value = mono.readInt16LE(i * 2);
    stereo.writeInt16LE(value, i * 4);
    stereo.writeInt16LE(value, i * 4 + 2);
  }
  return stereo;
}

/** Är talsyntesen igång? */
export async function ttsReady() {
  try {
    const res = await fetch(`${config.ttsUrl}/health`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function health(name, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { name, ok: false, detail: `HTTP ${res.status}` };
    const text = await res.text();
    return { name, ok: true, detail: text.slice(0, 200) };
  } catch (error) {
    return { name, ok: false, detail: error.cause?.code ?? error.message };
  }
}
