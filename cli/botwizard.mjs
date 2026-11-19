// Guiden som skapar eller ändrar en karaktär från kommandoraden. Samma val som i kontrollpanelen.

import fs from 'node:fs';
import path from 'node:path';
import { UserError, removeVoice, saveBot, saveVoice } from '../lib/bots.mjs';
import { IS_WINDOWS } from '../lib/paths.mjs';
import { serviceState } from '../lib/services.mjs';
import { ask, askMultiline, c, choose, confirm, heading, note, ok, warn } from './ui.mjs';

const RUN = IS_WINDOWS ? 'shatterbox' : './shatterbox';

const DISCORD_STEPS = `
  Så skaffar du en token (en gång per karaktär):
    1. Gå till https://discord.com/developers/applications och välj New Application.
    2. Installation: sätt installationslänken till Ingen. Bot: stäng av Publik bot.
    3. Bot: Återställ token, kopiera den och klistra in den här.`;

/** Tar bort citattecken som följer med när man drar en fil till terminalen. */
const cleanPath = (text) => path.resolve(text.trim().replace(/^["']|["']$/g, ''));

async function askPersona(bot) {
  const options = [
    ...(bot?.persona ? [{ value: 'keep', label: 'Behåll den som finns', hint: `${bot.persona.length} tecken` }] : []),
    { value: 'type', label: 'Skriv eller klistra in nu' },
    { value: 'file', label: 'Läs in från en textfil' },
    { value: 'none', label: 'Ingen persona', hint: 'en vanlig hjälpsam assistent' },
  ];
  const how = await choose('\nPersona: vem karaktären är och hur den pratar.', options, bot?.persona ? 'keep' : 'none');
  if (how === 'keep') return bot.persona;
  if (how === 'none') return '';
  if (how === 'file') {
    const file = cleanPath(await ask('Sökväg till textfilen'));
    if (!fs.existsSync(file)) {
      warn(`Hittar inte ${file}. Personan lämnas som den var.`);
      return bot?.persona ?? '';
    }
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  }
  note('Skriv på karaktärens språk och var konkret: typiska ord, ton, vad den gillar och ogillar.');
  return askMultiline('Persona');
}

/**
 * Frågar igenom alla val och sparar. bot = null skapar en ny karaktär.
 * preset: värden som redan getts som flaggor på kommandoraden (då ställs inte den frågan).
 */
export async function editBotWizard(bot, { first = false, preset = {} } = {}) {
  heading(bot && !first ? `Redigera ${bot.name}` : first ? 'Din första karaktär' : 'Ny karaktär');
  const has = (key) => preset[key] !== undefined;

  const name = has('name') ? preset.name : await ask('Namn', { fallback: bot?.name ?? '' });
  if (!name) throw new UserError('Karaktären behöver ett namn.');

  const language = has('language') ? preset.language : await choose('\nVilket språk pratar den?', [
    { value: 'sv', label: 'Svenska' },
    { value: 'en', label: 'English' },
  ], bot?.language ?? 'sv');

  const mode = has('mode') ? preset.mode : await choose('\nVar ska karaktären finnas?', [
    { value: 'discord', label: 'Discord', hint: 'en egen Discord-bot som går med i röstkanaler' },
    { value: 'local', label: 'Bara på den här datorn', hint: `utan Discord, du pratar med den via "${RUN} talk"` },
  ], bot?.mode ?? 'discord');

  let token = preset.token ?? '';
  if (mode === 'discord' && !has('token')) {
    if (!bot?.hasToken) console.log(c.dim(DISCORD_STEPS));
    token = await ask(bot?.hasToken ? '\nNy Discord-token (Enter behåller den sparade)' : '\nDiscord-token (Enter hoppar över tills vidare)', { secret: true });
  }

  const persona = has('persona') ? preset.persona : await askPersona(first ? null : bot);
  const parody = has('parody') ? preset.parody : await confirm('\nÄr det en imitation av en verklig person? (Då säger den ärligt att den är en bot om någon frågar på allvar.)', bot?.parody ?? false);
  const wakeOnly = has('wakeOnly') ? preset.wakeOnly
    : mode === 'discord' ? await confirm('Ska den bara svara när någon säger dess namn?', bot?.wakeOnly ?? false) : false;

  let voiceStyle = has('voiceStyle') ? preset.voiceStyle : bot?.voiceStyle ?? '';
  let voiceFile = preset.voiceFile ?? null;
  let dropVoice = false;
  if (!has('voiceStyle') && !has('voiceFile')) {
    const current = bot?.voiceFile ? `röstprov (${bot.voiceFile})` : bot?.voiceStyle ? `designad (${bot.voiceStyle})` : 'standardrösten';
    const voice = await choose('\nRöst', [
      { value: 'keep', label: 'Behåll som nu', hint: current },
      { value: 'sample', label: 'Klona från ett röstprov', hint: '10-15 sekunder tal i en ljudfil' },
      { value: 'design', label: 'Designa med ord', hint: 't.ex. male, elderly, low pitch' },
      { value: 'default', label: 'Standardrösten för språket' },
    ], 'keep');
    if (voice === 'sample') {
      const file = cleanPath(await ask('Sökväg till ljudfilen (wav, m4a, mp3 ...)'));
      if (fs.existsSync(file)) voiceFile = file;
      else warn(`Hittar inte ${file}. Rösten lämnas som den var.`);
    } else if (voice === 'design') {
      note('Kombinera: male / female · child / teenager / young adult / middle-aged / elderly ·');
      note('very low pitch ... very high pitch · whisper · british / american accent (bara engelska)');
      voiceStyle = await ask('Beskrivning', { fallback: bot?.voiceStyle ?? '' });
      dropVoice = Boolean(bot?.voiceFile);
    } else if (voice === 'default') {
      voiceStyle = '';
      dropVoice = Boolean(bot?.voiceFile);
    }
  }

  const greeting = has('greeting') ? preset.greeting : await ask('\nHälsningsfras (Enter = standardfrasen)', { fallback: bot?.greeting ?? '' });

  const result = await saveBot(bot ? bot.index : null, { name, language, mode, token, persona, parody, wakeOnly, voiceStyle, greeting });
  const saved = result.bot;
  if (voiceFile) saveVoice(saved.index, voiceFile, fs.readFileSync(voiceFile));
  else if (dropVoice) removeVoice(saved.index);

  console.log('');
  ok(`${saved.name} är sparad.`);
  if (result.token?.ok) ok(`Discord godkände token: ${result.token.tag}`);
  else if (result.token) warn(`Token kunde inte kontrolleras just nu (${result.token.reason}).`);

  if (saved.mode === 'local') {
    console.log(`\n  Prata med den:  ${c.cyan(`${RUN} talk ${saved.key}`)}`);
  } else if (!saved.hasToken) {
    console.log(`\n  Den saknar token och loggar inte in på Discord förrän du lagt in en:  ${c.cyan(`${RUN} edit ${saved.key}`)}`);
    console.log(`  Under tiden går den att prata med här:  ${c.cyan(`${RUN} talk ${saved.key}`)}`);
  } else {
    if (saved.inviteUrl) console.log(`\n  Bjud in den till din server:\n  ${c.cyan(saved.inviteUrl)}`);
    const { services } = await serviceState();
    console.log(services.bot
      ? `\n  Discord-botarna är igång. Ändringen gäller efter:  ${c.cyan(`${RUN} restart`)}`
      : `\n  Starta allt med:  ${c.cyan(`${RUN} start`)}`);
  }
  return saved;
}
