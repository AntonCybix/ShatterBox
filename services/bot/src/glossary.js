import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Ordlista per karaktär: knowledge/<namn>.terms.txt. Taligenkänningen förvanskar ofta egennamn
// ("Hylsbrad fothills", "roge"), och då rättas de mot listan innan frågan går till språkmodellen.
//
//   Hillsbrad Foothills
//   Rogue = roge, roag, rogg        <- uttalade felhörningar som ska bytas rakt av
//
// Långa termer matchas ungefärligt (några bokstäver får skilja, och orden får vara ihop- eller
// isärskrivna). Korta termer matchas bara exakt eller via sina felhörningar, annars skulle
// vanliga ord bytas ut av misstag.

const DIR = process.env.KNOWLEDGE_DIR || '/knowledge';
const cache = new Map();

const fold = (text) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/th/g, 't')
    .replace(/[zc]/g, (c) => (c === 'z' ? 's' : 'k'))
    .replace(/w/g, 'v')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1'); // dubbla bokstäver hörs inte

function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

const tolerance = (length) => (length < 7 ? 0 : length < 10 ? 1 : length < 14 ? 2 : 3);

export function loadGlossary(bot) {
  const file = path.join(DIR, `${bot.personaName}.terms.txt`);
  try {
    const { mtimeMs } = statSync(file);
    const hit = cache.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.terms;
    const terms = [];
    for (const raw of readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [term, aliasList = ''] = line.split('=').map((part) => part.trim());
      if (!term) continue;
      terms.push({
        term,
        folded: fold(term),
        aliases: aliasList.split(',').map((alias) => fold(alias)).filter(Boolean),
      });
    }
    cache.set(file, { mtimeMs, terms });
    return terms;
  } catch {
    return [];
  }
}

/** Rättar förvanskade termer i en replik mot ordlistan. */
export function applyGlossary(text, terms) {
  if (!terms.length) return text;
  // Dela upp i ord och det som står mellan dem, så att skiljetecken behålls.
  const parts = String(text).split(/([\p{L}\p{N}'’&]+)/u);
  const wordIndexes = parts.map((part, i) => (i % 2 === 1 ? i : -1)).filter((i) => i >= 0);

  // Alla tänkbara träffar: ett till fyra ord i följd som liknar en term.
  const matches = [];
  for (let start = 0; start < wordIndexes.length; start += 1) {
    for (let size = 1; size <= Math.min(4, wordIndexes.length - start); size += 1) {
      const joined = fold(wordIndexes.slice(start, start + size).map((i) => parts[i]).join(''));
      if (joined.length < 3) continue;
      for (const entry of terms) {
        let score = null;
        if (entry.aliases.includes(joined) || joined === entry.folded) score = 0;
        else {
          const limit = tolerance(entry.folded.length);
          if (limit) {
            const d = distance(joined, entry.folded, limit);
            if (d <= limit) score = d;
          }
        }
        if (score !== null) matches.push({ score, start, size, entry });
      }
    }
  }
  // Bäst träff först. Då vinner "under City" över "i under City", som också liknar Undercity.
  matches.sort((a, b) => a.score - b.score || a.size - b.size);
  const taken = new Set();
  for (const match of matches) {
    const span = Array.from({ length: match.size }, (_, k) => match.start + k);
    if (span.some((position) => taken.has(position))) continue;
    span.forEach((position) => taken.add(position));
    const first = wordIndexes[match.start];
    const last = wordIndexes[match.start + match.size - 1];
    parts[first] = match.entry.term;
    for (let i = first + 1; i <= last; i += 1) parts[i] = '';
  }
  return parts.join('').replace(/\s{2,}/g, ' ').trim();
}
