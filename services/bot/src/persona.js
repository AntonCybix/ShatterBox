import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// En karaktärs persona kan ligga i en textfil: personas/<namn>.txt (namnet med små bokstäver,
// t.ex. personas/kapten-krok.txt för en bot som heter Kapten Krok). Filen läses om när den ändras,
// så karaktären kan justeras utan omstart. Finns ingen fil används PERSONA / BOTn_PERSONA från .env.

const DIR = process.env.PERSONA_DIR || '/personas';
const cache = new Map();

export function personaFile(bot) {
  return path.join(DIR, `${bot.personaName}.txt`);
}

function readCached(file) {
  try {
    const { mtimeMs } = statSync(file);
    const hit = cache.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.text;
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
    cache.set(file, { mtimeMs, text });
    return text;
  } catch {
    return '';
  }
}

export function personaOf(bot) {
  return readCached(personaFile(bot)) || bot.persona;
}

// Bakgrundskunskap som karaktären alltid har med sig: knowledge/<namn>.md. Läses också om
// när filen ändras. Håll den kort - allt här skickas med i varje fråga.
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || '/knowledge';

export function knowledgeOf(bot) {
  return readCached(path.join(KNOWLEDGE_DIR, `${bot.personaName}.md`));
}
