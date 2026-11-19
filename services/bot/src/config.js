const env = process.env;

const bool = (value, fallback) =>
  value === undefined || value.trim() === '' ? fallback : /^(1|true|yes|ja|on)$/i.test(value.trim());
const num = (value, fallback) => {
  const n = Number(value);
  return value === undefined || value.trim() === '' || Number.isNaN(n) ? fallback : n;
};
const str = (value, fallback = '') => (value ?? '').trim() || fallback;
const list = (value, fallback) => {
  const items = (value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return items.length ? [...new Set(items)] : fallback;
};
const slug = (text) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // å -> a, ö -> o
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Gemensamt för alla botar
export const config = {
  bargeIn: bool(env.BARGE_IN, true),
  // En bot som pratar tystnar först när taligenkänningen har uppfattat så här många riktiga ord
  // (skratt, hostningar och "mm" räknas inte). Stoppord som "tyst" och "stopp" räcker ensamma.
  bargeInWords: num(env.BARGE_IN_WORDS, 2),
  // Hur mycket ljud som ska ha kommit in innan första kontrollen görs.
  bargeInMs: num(env.BARGE_IN_MS, 600),
  silenceMs: num(env.SILENCE_MS, 900),
  model: str(env.OLLAMA_MODEL, 'gemma4:e2b'),
  historyTurns: num(env.HISTORY_TURNS, 8),

  ollamaUrl: str(env.OLLAMA_URL, 'http://host.docker.internal:11434'),
  sttUrl: str(env.STT_URL, 'http://stt:8000'),
  ttsUrl: str(env.TTS_URL, 'http://host.docker.internal:8003'),
  searxngUrl: str(env.SEARXNG_URL, 'http://searxng:8080'),
};

/**
 * En bot/karaktär. Den första använder variablerna utan prefix (DISCORD_TOKEN, ASSISTANT_NAME,
 * LANGUAGE ...), nästa BOT2_..., sedan BOT3_... och så vidare.
 */
function profile(index) {
  const first = index === 1;
  const p = first ? '' : `BOT${index}_`;
  const name = str(first ? env.ASSISTANT_NAME : env[`${p}NAME`], first ? 'Assistenten' : `Bot ${index}`);
  const language = str(env[`${p}LANGUAGE`], first ? 'sv' : 'en').toLowerCase();
  return {
    index,
    key: `bot${index}`,
    token: str(env[`${p}DISCORD_TOKEN`]),
    // discord = egen Discord-bot. local = finns bara på datorn och startas med "shatterbox talk".
    mode: str(first ? env.BOT_MODE : env[`${p}MODE`]).toLowerCase() === 'local' ? 'local' : 'discord',
    name,
    language,
    // Karaktärsbeskrivning. Filen personas/<namn>.txt går före om den finns (se persona.js).
    persona: str(env[`${p}PERSONA`]),
    personaName: slug(name),
    // Imitation av en verklig person: håller stilen men säger ärligt att den är en bot om någon
    // frågar på allvar. Påhittade figurer (false) stannar alltid i rollen.
    parody: bool(env[`${p}PARODY`], false),
    // Röstnamn: filen voice/<namn>.wav. Första botens röstprov heter reference.*
    voice: str(env[`${p}VOICE`], first ? '' : slug(name)),
    // Beskrivning av en designad röst, används om inget röstprov finns
    voiceStyle: str(env[`${p}VOICE_STYLE`]),
    greeting: str(env[`${p}GREETING`]),
    ownerId: str(first ? env.DISCORD_OWNER_ID : env[`${p}OWNER_ID`], str(env.DISCORD_OWNER_ID)),
    autoJoin: bool(env[`${p}AUTO_JOIN`], bool(env.AUTO_JOIN, true)),
    listenTo: str(env[`${p}LISTEN_TO`], str(env.LISTEN_TO, 'all')).toLowerCase(), // all | owner

    // Svarar bara när någon säger namnet (wake-word). Passar en bot som sitter med i en kanal
    // där folk pratar med varandra.
    wakeOnly: bool(env[`${p}WAKE_ONLY`], false),
    // Ord som väcker boten. Standard är första ordet i namnet. Används också för att välja bot
    // när flera sitter i samma kanal ("Sigrid, ...").
    wakeWords: list(env[`${p}WAKE_WORDS`], [name.toLowerCase().split(/\s+/)[0]]),
    // Språk boten förstår när någon pratar. Fler än ett -> taligenkänningen känner av språket.
    listenLanguages: list(env[`${p}LISTEN_LANGUAGES`], [language]),
    // Ämnesord som taligenkänningen ofta hör fel (spelnamn m.m.), kommaseparerade.
    hotwords: str(env[`${p}HOTWORDS`]),
    // Sök på ett annat språk än boten pratar, och lägg alltid till ett ämne i sökfrågan.
    searchLanguage: str(env[`${p}SEARCH_LANGUAGE`], language).toLowerCase(),
    searchHint: str(env[`${p}SEARCH_HINT`]),
    // Kommer ihåg vad varje person berättat om sig själv (t.ex. spelkaraktär) mellan samtal.
    memory: bool(env[`${p}MEMORY`], false),
    // Egen språkmodell för den här karaktären (annars OLLAMA_MODEL). En större modell ger bättre
    // svar men tar mer grafikminne, och två olika modeller kan behöva turas om i minnet.
    model: str(env[`${p}MODEL`]),
  };
}

const defined = (index) => index === 1 || Boolean(str(env[`BOT${index}_DISCORD_TOKEN`]) || str(env[`BOT${index}_NAME`]));

/** Alla definierade karaktärer, även lokala och de som saknar token. */
export const bots = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(defined).map(profile);
/** De som ska in på Discord: har en token och är inte satta som lokala. */
export const activeBots = bots.filter((bot) => bot.token && bot.mode === 'discord');
/** Alla språk som någon karaktär lyssnar på. */
export const languages = [...new Set(bots.flatMap((bot) => bot.listenLanguages))];

export function findBot(selector) {
  if (!selector) return bots[0];
  const wanted = String(selector).toLowerCase();
  return bots.find((bot) => String(bot.index) === wanted || bot.key === wanted || bot.name.toLowerCase() === wanted);
}

export function log(...args) {
  const t = new Date().toLocaleTimeString('sv-SE', { hour12: false, timeZone: 'Europe/Stockholm' });
  console.log(`[${t}]`, ...args);
}
