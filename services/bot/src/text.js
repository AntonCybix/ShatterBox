// Hjälpfunktioner för att göra språkmodellens text uppläsningsbar, mening för mening.

const ABBREVIATION =
  /(?:^|[\s(])(?:t\.\s?ex|bl\.\s?a|m\.\s?m|o\.\s?s\.\s?v|osv|dvs|d\.\s?v\.\s?s|ca|kl|nr|st|s\.\s?k|f\.\s?d|m\.\s?fl|etc|e\.\s?kr|f\.\s?kr|dr|prof|resp|inkl|exkl|tel|e\.\s?g|i\.\s?e|mr|mrs|ms|vs|approx|inc|ltd|jr)\.$/i;
const ORDINAL = /(?:^|\s)\d{1,2}\.$/; // "den 3." i ett datum

// Ljud som taligenkänningen skriver ut men som inte är ord: skratt och småljud.
const LAUGHTER = /(?<![\p{L}])(?:a?(?:ha|he|hi|ho|hä|hö){2,}h?|(?:ha|he|hi|ho|hä|hö)(?:[\s,.!?-]+(?:ha|he|hi|ho|hä|hö))+)(?![\p{L}])/giu;
const NOISE_WORD = /^(?:m+|h+m+|m+h+m+|e+h+|ö+h+|ä+h+|å+h+|a+h+|o+h+|u+h+|u+m+|oj|aj|usch|pf+|ts+|sch+|sh+)$/i;
// Ett enda av de här orden räcker för att tysta boten.
const STOP_WORDS = new Set(['stopp', 'stop', 'tyst', 'sluta', 'vänta', 'quiet', 'wait', 'silence', 'enough']);

/** Riktiga ord i det taligenkänningen hörde, utan skratt, "mm", "eh" och liknande. */
export function realWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g, ' ') // (skratt), [musik], *suckar*
    .replace(LAUGHTER, ' ')
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word && !NOISE_WORD.test(word));
}

export const hasStopWord = (text) => realWords(text).some((word) => STOP_WORDS.has(word));

/** Ska det här avbryta en bot som pratar? Minst `minWords` riktiga ord, eller ett stoppord. */
export function isInterruption(text, minWords = 2) {
  return realWords(text).length >= minWords || hasStopWord(text);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
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

/**
 * Sägs något av botens väckningsord? Taligenkänningen stavar inte alltid namn rätt, så ett
 * tecken får skilja ("Nestår", "Nestors"), och namnet får vara delat i två ord ("Nes tor").
 */
// Bokstäver som taligenkänningen blandar ihop i namn: Zara/Sara, Balthazar/Baltasar, Hector/Hektor.
const soundAlike = (word) => word.replace(/th/g, 't').replace(/z/g, 's').replace(/c/g, 'k').replace(/w/g, 'v');

export function hasWakeWord(text, wakeWords) {
  if (!wakeWords?.length) return false;
  const words = String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(soundAlike);
  // Namnet kan ha delats i två ord ("Sol tan"), men då ska det stämma exakt.
  const pairs = words.slice(0, -1).map((word, i) => word + words[i + 1]);
  return wakeWords.some((raw) => {
    const wake = soundAlike(raw);
    const tolerance = wake.length >= 8 ? 2 : wake.length >= 5 ? 1 : 0;
    return (
      pairs.includes(wake) ||
      words.some(
        (word) =>
          word === wake ||
          word.slice(1) === wake || // ett extra ljud i början, som "Usoltan"
          (tolerance && word[0] === wake[0] && editDistance(word, wake) <= tolerance),
      )
    );
  });
}

/** Tar bort tilltalet ur en replik: "Nestor, var ska jag levla?" -> "var ska jag levla?" */
export function stripWakeWord(text, wakeWords) {
  if (!wakeWords?.length) return text;
  const kept = String(text ?? '')
    .split(/\s+/)
    .filter((word) => !hasWakeWord(word, wakeWords));
  const stripped = kept.join(' ').replace(/^[\s,.!?:;-]+/, '').trim();
  return realWords(stripped).length ? stripped : text;
}

/** Tar bort sådant som inte ska läsas upp: markdown, länkar, emojis. */
export function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\|[^|>]*\|>/g, ' ') // specialtecken som modellen ibland läcker
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*(?:[-•*]|\d+[.)])\s+/gm, '')
    .replace(/[*_`#>~|]+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tar emot text i småbitar (strömmad från språkmodellen) och anropar
 * onSentence så fort en hel mening finns, så att talsyntesen kan börja tidigt.
 */
export class SentenceSplitter {
  constructor(onSentence, { minFirst = 12, min = 24 } = {}) {
    this.onSentence = onSentence;
    this.minFirst = minFirst;
    this.min = min;
    this.buffer = '';
    this.emitted = 0;
  }

  push(delta) {
    this.buffer += delta;
    this.#drain();
  }

  flush() {
    this.#drain();
    this.#emit(this.buffer);
    this.buffer = '';
  }

  #emit(raw) {
    const sentence = cleanForSpeech(raw);
    if (!/[\p{L}\p{N}]/u.test(sentence)) return;
    this.emitted += 1;
    this.onSentence(sentence);
  }

  #drain() {
    // En meningsgräns är skiljetecken följt av blanktecken, eller en radbrytning.
    const boundary = /[.!?…]+["”')\]]*\s+|\n+/g;
    let match;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const candidate = this.buffer.slice(0, end).trim();
      const minLength = this.emitted === 0 ? this.minFirst : this.min;
      if (candidate.length < minLength) continue;
      if (ABBREVIATION.test(candidate) || ORDINAL.test(candidate)) continue;
      this.#emit(candidate);
      this.buffer = this.buffer.slice(end);
      boundary.lastIndex = 0;
    }
  }
}
