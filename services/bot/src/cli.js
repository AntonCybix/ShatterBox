// Testverktyg utan Discord.
//
//   docker compose run --rm bot node src/cli.js --check
//   docker compose run --rm bot node src/cli.js "Vad är det för väder i Stockholm?"
//   docker compose run --rm bot node src/cli.js --speak "Berätta kort om Vasaskeppet"
//   docker compose run --rm bot node src/cli.js --bot=2 --speak "What do you think about fish?"
//   docker compose run --rm bot node src/cli.js --bot=2 --say "Read exactly this text"
//   docker compose run --rm bot node src/cli.js --transcribe /out/svar.wav
//
// --bot=N      vilken karaktär (nummer eller namn), standard är den första
// --user=Namn  vem som pratar (för karaktärer som minns saker om var och en)
// --speak      syntetiserar svaret och sparar det som /out/svar.wav (mappen out i projektet)
// --roundtrip  låter dessutom tal-till-text lyssna på det syntetiserade svaret
// --say        läser upp texten ordagrant istället för att fråga språkmodellen

import { readFile, writeFile } from 'node:fs/promises';
import { generateDependencyReport } from '@discordjs/voice';
import { Conversation } from './assistant.js';
import { bots, config, findBot, languages } from './config.js';
import { applyGlossary, loadGlossary } from './glossary.js';
import { personaFile, personaOf } from './persona.js';
import { health, synthesize, transcribe, writeWav } from './speech.js';
import { stripWakeWord } from './text.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
const option = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const rest = args.filter((a) => !a.startsWith('--'));
const seconds = (since) => ((Date.now() - since) / 1000).toFixed(1);

const bot = findBot(option('--bot'));
if (!bot) {
  console.error(`Hittar ingen karaktär "${option('--bot')}". Finns: ${bots.map((b) => `${b.index}=${b.name}`).join(', ')}`);
  process.exit(2);
}

async function check() {
  const checks = await Promise.all([
    health('Ollama', `${config.ollamaUrl}/api/version`),
    health('SearXNG', `${config.searxngUrl}/healthz`),
    health('STT', `${config.sttUrl}/health`),
    health('TTS', `${config.ttsUrl}/health`),
  ]);
  for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FEL '} ${c.name.padEnd(8)} ${c.detail}`);

  try {
    const tags = await (await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) })).json();
    const names = (tags.models ?? []).map((m) => m.name);
    const found = names.includes(config.model);
    console.log(`${found ? 'OK  ' : 'FEL '} modell   ${config.model} ${found ? 'finns' : `saknas (finns: ${names.join(', ') || 'inga'})`}`);
  } catch (error) {
    console.log(`FEL  modell   kunde inte lista Ollama-modeller: ${error.message}`);
  }

  console.log(`\nKaraktärer (språk i samtalet: ${languages.join(', ')}):`);
  for (const b of bots) {
    const persona = personaOf(b);
    console.log(
      `  ${b.index}. ${b.name.padEnd(14)} ${b.language}  token: ${b.token ? 'ifylld' : 'SAKNAS'}  ` +
        `röst: ${b.voice || 'reference'}${b.voiceStyle ? ` / design "${b.voiceStyle}"` : ''}  ` +
        `persona: ${persona ? `${persona.length} tecken` : `ingen (${personaFile(b)})`}`,
    );
  }
  console.log('\n@discordjs/voice:\n' + generateDependencyReport());
  return checks.every((c) => c.ok);
}

async function speakToFile(sentences, path) {
  const parts = [];
  let sampleRate = 24_000;
  let gen = 0;
  let audio = 0;
  let voice = '';
  for (const sentence of sentences) {
    const result = await synthesize(sentence, { bot, sampleRate });
    parts.push(result.pcm);
    gen += result.genSeconds;
    audio += result.audioSeconds;
    sampleRate = result.sampleRate;
    voice = result.voice;
    console.log(`  tal: ${result.audioSeconds.toFixed(1)} s ljud på ${result.genSeconds.toFixed(1)} s`);
  }
  await writeFile(path, writeWav(Buffer.concat(parts), sampleRate));
  console.log(`Sparat: ${path} (${audio.toFixed(1)} s ljud, syntes ${gen.toFixed(1)} s, röst: ${voice})`);
}

async function main() {
  if (flags.has('--check')) {
    process.exit((await check()) ? 0 : 1);
  }

  if (flags.has('--transcribe')) {
    const file = rest[0];
    if (!file) throw new Error('ange en ljudfil, t.ex. /out/svar.wav');
    const started = Date.now();
    const result = await transcribe(await readFile(file), { contentType: 'audio/wav', languages });
    console.log(`Hörde (${seconds(started)} s, språk: ${result.language}): ${result.text}`);
    return;
  }

  const text = rest.join(' ').trim();
  if (!text) {
    console.log('Användning: node src/cli.js [--bot=N] [--check | --transcribe fil | --speak | --roundtrip | --say] "text"');
    process.exit(2);
  }

  const out = '/out/svar.wav';
  let sentences = [];

  if (flags.has('--say')) {
    sentences = [text];
  } else {
    const started = Date.now();
    let first = null;
    console.log(`Du: ${text}`);
    const answer = await new Conversation(bot).ask({
      userName: option('--user') ?? '',
      userText: applyGlossary(stripWakeWord(text, bot.wakeWords), loadGlossary(bot)),
      onSentence: (sentence) => {
        if (first === null) first = seconds(started);
        sentences.push(sentence);
        console.log(`  [${seconds(started)} s] ${sentence}`);
      },
      onSearch: (query) => console.log(`  [${seconds(started)} s] söker: ${query}`),
    });
    console.log(`${bot.name} (första meningen efter ${first ?? '-'} s, klart efter ${seconds(started)} s):\n${answer}`);
  }

  if (flags.has('--speak') || flags.has('--say') || flags.has('--roundtrip')) {
    await speakToFile(sentences, out);
  }
  if (flags.has('--roundtrip')) {
    const started = Date.now();
    const result = await transcribe(await readFile(out), { contentType: 'audio/wav', languages: [bot.language] });
    console.log(`Tal-till-text hörde (${seconds(started)} s, språk: ${result.language}): ${result.text}`);
  }
}

main().catch((error) => {
  console.error(`Fel: ${error.message}`);
  process.exit(1);
});
