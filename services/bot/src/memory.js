import fs from 'node:fs';
import path from 'node:path';
import { log } from './config.js';
import { extractProfile } from './llm.js';

// Minne per person för karaktärer med MEMORY=true: vad var och en har berättat om sin
// spelkaraktär. Sparas i data/memory/<botnamn>.json och överlever omstarter. Filen går att
// redigera för hand.
//
//   { "users": [ { "id": "1234...", "names": ["Spelarnamn"], "race": "Undead", "class": "Rogue",
//                  "level": 21, "faction": "Horde", "professions": "", "notes": ["..."] } ] }

const DIR = process.env.MEMORY_DIR || '/data/memory';
const CLASSES = ['Warrior', 'Paladin', 'Hunter', 'Rogue', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid'];
const RACES = ['Human', 'Dwarf', 'Gnome', 'Night Elf', 'Orc', 'Troll', 'Tauren', 'Undead', 'Skyborne'];
const FACTIONS = ['Horde', 'Alliance'];
// Billig förhandskoll, så att språkmodellen bara körs när personen troligen berättar något om sig själv.
const WORTH_CHECKING =
  /\b(level|lvl|nivå|spelar|plays?|playing|i'?m\s+an?|i\s+am|jag\s+är|jag\s+har|min\s+(?:karaktär|gubbe|char|main|alt)|my\s+(?:character|char|main|alt)|warrior|paladin|hunter|rogue|priest|shaman|mage|warlock|druid|human|dwarf|gnome|night\s?elf|orc|troll|tauren|undead|forsaken|skyborne|horde|alliance|mining|herbalism|skinning|alchemy|blacksmithing|engineering|leatherworking|tailoring|enchanting)\b/i;

const fileFor = (bot) => path.join(DIR, `${bot.personaName}.json`);

function load(bot) {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(bot), 'utf8').replace(/^﻿/, ''));
    return Array.isArray(data.users) ? data : { users: [] };
  } catch {
    return { users: [] };
  }
}

function save(bot, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileFor(bot);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function find(data, user) {
  const name = (user.name ?? '').toLowerCase();
  return (
    data.users.find((entry) => user.id && entry.id === user.id) ??
    data.users.find((entry) => name && (entry.names ?? []).some((n) => n.toLowerCase() === name))
  );
}

const pick = (value, allowed) => allowed.find((item) => item.toLowerCase() === String(value ?? '').trim().toLowerCase()) ?? '';

/** Det boten vet om personen, som en rad till prompten. Tom sträng om inget är känt. */
export function recall(bot, user) {
  if (!bot.memory || !user?.name) return '';
  const entry = find(load(bot), user);
  if (!entry) return '';
  const sv = bot.language === 'sv';
  const parts = [];
  if (entry.race || entry.class) parts.push(`${sv ? 'spelar' : 'plays'} ${[entry.race, entry.class].filter(Boolean).join(' ')}`);
  if (entry.level) parts.push(`level ${entry.level}${sv ? ' (senast känt)' : ' (last known)'}`);
  if (entry.faction) parts.push(entry.faction);
  if (entry.professions) parts.push(`${sv ? 'yrken' : 'professions'}: ${entry.professions}`);
  for (const note of entry.notes ?? []) parts.push(note);
  if (!parts.length) return '';
  return sv ? `Det här vet du om ${user.name}: ${parts.join(', ')}.` : `What you know about ${user.name}: ${parts.join(', ')}.`;
}

/** Plockar upp nya uppgifter ur det personen sa. Körs i bakgrunden efter svaret. */
export async function learn(bot, user, userText) {
  if (!bot.memory || !user?.name || !WORTH_CHECKING.test(userText)) return;
  try {
    const found = await extractProfile(userText);
    const update = {
      race: pick(found.race, RACES),
      class: pick(found.class, CLASSES),
      faction: pick(found.faction, FACTIONS),
      level: Number.isInteger(found.level) && found.level >= 1 && found.level <= 60 ? found.level : 0,
      professions: String(found.professions ?? '').trim().slice(0, 80),
    };
    if (!Object.values(update).some(Boolean)) return;

    const data = load(bot);
    let entry = find(data, user);
    if (!entry) {
      entry = { id: user.id ?? null, names: [user.name], notes: [] };
      data.users.push(entry);
    }
    if (user.id && !entry.id) entry.id = user.id;
    if (!(entry.names ?? []).some((n) => n.toLowerCase() === user.name.toLowerCase())) entry.names = [...(entry.names ?? []), user.name];
    const changed = [];
    for (const [key, value] of Object.entries(update)) {
      if (value && entry[key] !== value) {
        entry[key] = value;
        changed.push(`${key}=${value}`);
      }
    }
    if (!changed.length) return;
    entry.updated = new Date().toISOString().slice(0, 10);
    save(bot, data);
    log(`[${bot.name}]   minns om ${user.name}: ${changed.join(', ')}`);
  } catch (error) {
    log(`[${bot.name}] kunde inte uppdatera minnet: ${error.message}`);
  }
}
