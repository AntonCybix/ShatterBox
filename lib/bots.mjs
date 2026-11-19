// Karaktärerna: läsa, skapa, ändra och ta bort. Används av både kontrollpanelen (app/) och
// kommandoraden (cli/). Reglerna för namn och nycklar är desamma som i services/bot/src/config.js.

import fs from 'node:fs';
import path from 'node:path';
import { readEnv, updateEnv } from './env.mjs';
import { PERSONA_DIR, VOICE_DIR } from './paths.mjs';

export const AUDIO_EXT = ['wav', 'm4a', 'mp3', 'flac', 'ogg', 'opus', 'aac', 'wma', 'webm', 'mp4'];
export const MAX_BOTS = 9;
const FIRST_VOICE_NAMES = ['reference', 'referens', 'voice', 'min_rost'];

/** Fel som beror på vad användaren skrev in, och som ska visas som de är. */
export class UserError extends Error {}

export const slug = (text) =>
  String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // å -> a, ö -> o
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function keysFor(index) {
  const p = index === 1 ? '' : `BOT${index}_`;
  return {
    token: `${p}DISCORD_TOKEN`,
    name: index === 1 ? 'ASSISTANT_NAME' : `${p}NAME`,
    // discord = egen Discord-bot, local = bara på den här datorn (shatterbox talk)
    mode: index === 1 ? 'BOT_MODE' : `${p}MODE`,
    language: `${p}LANGUAGE`,
    voiceStyle: `${p}VOICE_STYLE`,
    greeting: `${p}GREETING`,
    parody: `${p}PARODY`,
    wakeOnly: `${p}WAKE_ONLY`,
    persona: `${p}PERSONA`,
    voice: `${p}VOICE`,
  };
}

const truthy = (value) => /^(1|true|yes|ja|on)$/i.test(String(value ?? '').trim());

function botIndices(env) {
  const indices = [1];
  for (let i = 2; i <= MAX_BOTS; i += 1) {
    if ((env[`BOT${i}_DISCORD_TOKEN`] ?? '').trim() || (env[`BOT${i}_NAME`] ?? '').trim()) indices.push(i);
  }
  return indices;
}

function voiceFileFor(index, voiceName) {
  const wanted = index === 1 ? FIRST_VOICE_NAMES : [voiceName];
  if (!fs.existsSync(VOICE_DIR)) return null;
  return (
    fs
      .readdirSync(VOICE_DIR)
      .sort()
      .find((file) => {
        const parts = file.toLowerCase().split('.');
        return AUDIO_EXT.includes(parts.at(-1)) && wanted.includes(parts[0]);
      }) ?? null
  );
}

/** Botens användar-id står i klartext i första delen av en token, så länken kan räknas ut lokalt. */
function inviteUrlFromToken(token) {
  try {
    const id = Buffer.from(token.split('.')[0], 'base64').toString('utf8');
    if (!/^\d{17,20}$/.test(id)) return null;
    return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=36703232`;
  } catch {
    return null;
  }
}

/** Allt om en karaktär utom själva token, som aldrig lämnar .env. */
export function describeBot(index, env = readEnv()) {
  const keys = keysFor(index);
  const name = (env[keys.name] ?? '').trim() || (index === 1 ? 'Assistenten' : `Bot ${index}`);
  const personaName = slug(name);
  const personaFile = path.join(PERSONA_DIR, `${personaName}.txt`);
  const voiceName = index === 1 ? 'reference' : (env[keys.voice] ?? '').trim() || personaName;
  const token = (env[keys.token] ?? '').trim();
  const mode = (env[keys.mode] ?? '').trim().toLowerCase() === 'local' ? 'local' : 'discord';
  let persona = (env[keys.persona] ?? '').trim();
  if (fs.existsSync(personaFile)) persona = fs.readFileSync(personaFile, 'utf8').replace(/^﻿/, '').trim() || persona;
  return {
    index,
    name,
    key: personaName,
    mode,
    language: ((env[keys.language] ?? '').trim() || (index === 1 ? 'sv' : 'en')).toLowerCase(),
    hasToken: Boolean(token),
    inviteUrl: token && mode === 'discord' ? inviteUrlFromToken(token) : null,
    voiceStyle: (env[keys.voiceStyle] ?? '').trim(),
    greeting: (env[keys.greeting] ?? '').trim(),
    parody: truthy(env[keys.parody]),
    wakeOnly: truthy(env[keys.wakeOnly]),
    persona,
    personaFile: path.join('personas', `${personaName}.txt`),
    voiceName,
    voiceFile: voiceFileFor(index, voiceName),
  };
}

export const listBots = (env = readEnv()) => botIndices(env).map((index) => describeBot(index, env));

/** Hittar en karaktär på nummer, namn eller början av namnet ("kap" -> Kapten Krok). */
export function findBot(selector, bots = listBots()) {
  const wanted = String(selector ?? '').trim().toLowerCase();
  if (!wanted) return bots[0] ?? null;
  const exact = bots.find((bot) => String(bot.index) === wanted || bot.name.toLowerCase() === wanted || bot.key === slug(wanted));
  if (exact) return exact;
  const partial = bots.filter((bot) => bot.key.startsWith(slug(wanted)) || bot.name.toLowerCase().startsWith(wanted));
  return partial.length === 1 ? partial[0] : null;
}

export async function verifyToken(token) {
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false };
    if (!res.ok) return { ok: null, reason: `Discord svarade ${res.status}` };
    const user = await res.json();
    const tag = user.discriminator && user.discriminator !== '0' ? `${user.username}#${user.discriminator}` : user.username;
    return { ok: true, tag };
  } catch (error) {
    return { ok: null, reason: error.message };
  }
}

function cleanInput(body) {
  const text = (value, max) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
  return {
    name: text(body.name, 40),
    mode: String(body.mode ?? '').trim().toLowerCase() === 'local' ? 'local' : 'discord',
    language: /^[a-z]{2}$/.test(String(body.language ?? '').trim().toLowerCase()) ? String(body.language).trim().toLowerCase() : 'sv',
    token: String(body.token ?? '').replace(/\s+/g, ''),
    voiceStyle: text(body.voiceStyle, 120).toLowerCase(),
    greeting: text(body.greeting, 160),
    parody: Boolean(body.parody),
    wakeOnly: Boolean(body.wakeOnly),
    persona: String(body.persona ?? '').replace(/\r\n/g, '\n').trim().slice(0, 6000),
  };
}

/**
 * Skapar (index = null) eller ändrar en karaktär.
 * body: { name, mode, language, token, clearToken, persona, parody, wakeOnly, voiceStyle, greeting }
 * Returnerar { bot, token } där token är svaret från Discord om en ny token angavs.
 */
export async function saveBot(index, body) {
  const env = readEnv();
  const input = cleanInput(body);
  const creating = index === null;
  if (!input.name) throw new UserError('Karaktären behöver ett namn.');
  if (!slug(input.name)) throw new UserError('Namnet måste innehålla minst en bokstav eller siffra (a-z, 0-9).');

  const existing = listBots(env);
  if (creating) {
    index = [2, 3, 4, 5, 6, 7, 8, 9].find((i) => !existing.some((bot) => bot.index === i));
    if (!index) throw new UserError(`Det går att ha högst ${MAX_BOTS} karaktärer.`);
  } else if (!existing.some((bot) => bot.index === index)) {
    throw new UserError('Karaktären finns inte längre.');
  }
  const others = existing.filter((bot) => bot.index !== index);
  if (others.some((bot) => slug(bot.name) === slug(input.name))) {
    throw new UserError('Det finns redan en karaktär med det namnet.');
  }

  const keys = keysFor(index);
  const previous = creating ? null : existing.find((bot) => bot.index === index);
  const changes = {
    [keys.name]: input.name,
    [keys.mode]: input.mode === 'local' ? 'local' : null, // discord är standard och behöver ingen rad
    [keys.language]: input.language,
    [keys.voiceStyle]: input.voiceStyle || null,
    [keys.greeting]: input.greeting || null,
    [keys.parody]: input.parody ? 'true' : null,
    [keys.wakeOnly]: input.wakeOnly ? 'true' : null,
  };

  let tokenResult = null;
  if (input.token) {
    for (const bot of others) {
      if ((env[keysFor(bot.index).token] ?? '').trim() === input.token) {
        throw new UserError(`Den token används redan av ${bot.name}. Varje karaktär behöver en egen Discord-bot.`);
      }
    }
    tokenResult = await verifyToken(input.token);
    if (tokenResult.ok === false) {
      throw new UserError('Discord godkände inte den token. Kopiera den på nytt från Bot → Återställ token.');
    }
    changes[keys.token] = input.token;
  } else if (body.clearToken) {
    changes[keys.token] = index === 1 ? '' : null;
  } else if (creating) {
    changes[keys.token] = '';
  }

  // Byter karaktären namn följer personafilen och röstprovet med.
  const personaName = slug(input.name);
  if (previous && slug(previous.name) !== personaName) {
    const oldPersona = path.join(PERSONA_DIR, `${slug(previous.name)}.txt`);
    const newPersona = path.join(PERSONA_DIR, `${personaName}.txt`);
    if (fs.existsSync(oldPersona) && !fs.existsSync(newPersona)) fs.renameSync(oldPersona, newPersona);
    if (index !== 1 && previous.voiceFile && !(env[keys.voice] ?? '').trim()) {
      const rest = previous.voiceFile.split('.').slice(1).join('.');
      const target = path.join(VOICE_DIR, `${personaName}.${rest}`);
      if (!fs.existsSync(target)) fs.renameSync(path.join(VOICE_DIR, previous.voiceFile), target);
      const oldText = path.join(VOICE_DIR, `${previous.voiceName}.txt`);
      if (fs.existsSync(oldText)) fs.renameSync(oldText, path.join(VOICE_DIR, `${personaName}.txt`));
    }
  }
  fs.mkdirSync(PERSONA_DIR, { recursive: true });
  const personaFile = path.join(PERSONA_DIR, `${personaName}.txt`);
  if (input.persona) fs.writeFileSync(personaFile, `${input.persona}\n`, 'utf8');
  // En tömd persona tas bort vid redigering. En ny karaktär får behålla en fil som redan ligger där.
  else if (!creating && fs.existsSync(personaFile)) fs.rmSync(personaFile);
  if (input.persona || !creating) changes[keys.persona] = null; // filen gäller, inte en gammal rad i .env

  updateEnv(changes);
  return { bot: describeBot(index, readEnv()), token: tokenResult };
}

export function deleteBot(index) {
  if (index === 1) throw new UserError('Den första karaktären kan inte tas bort, men du kan ändra den.');
  const env = readEnv();
  const changes = {};
  for (const key of Object.keys(env)) if (key.startsWith(`BOT${index}_`)) changes[key] = null;
  if (!Object.keys(changes).length) throw new UserError('Karaktären finns inte längre.');
  updateEnv(changes);
}

/** Sparar ett röstprov. originalName används bara för filändelsen. */
export function saveVoice(index, originalName, data) {
  const bot = listBots().find((entry) => entry.index === index);
  if (!bot) throw new UserError('Karaktären finns inte längre.');
  const ext = String(originalName).toLowerCase().split('.').at(-1);
  if (!AUDIO_EXT.includes(ext)) throw new UserError(`Filtypen stöds inte. Använd ${AUDIO_EXT.slice(0, 5).join(', ')} ...`);
  if (data.length < 20_000) throw new UserError('Ljudfilen är för kort. Spela in 10-15 sekunder tal.');
  removeVoice(index);
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const file = `${bot.voiceName}.${ext}`;
  fs.writeFileSync(path.join(VOICE_DIR, file), data);
  return file;
}

export function removeVoice(index) {
  const bot = listBots().find((entry) => entry.index === index);
  if (!bot) return;
  for (;;) {
    const file = voiceFileFor(index, bot.voiceName);
    if (!file) break;
    fs.rmSync(path.join(VOICE_DIR, file));
  }
  // En gammal avskrift stämmer inte med ett nytt prov.
  for (const name of index === 1 ? FIRST_VOICE_NAMES : [bot.voiceName]) {
    const transcript = path.join(VOICE_DIR, `${name}.txt`);
    if (fs.existsSync(transcript)) fs.rmSync(transcript);
  }
}
