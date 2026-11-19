// Gör om siffror, klockslag, datum och vanliga tecken till svenska ord,
// så att talsyntesen läser dem rätt. Språkmodellen får skriva vanliga siffror.

const ONES = [
  'noll', 'ett', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta', 'nio', 'tio',
  'elva', 'tolv', 'tretton', 'fjorton', 'femton', 'sexton', 'sjutton', 'arton', 'nitton',
];
const TENS = ['', '', 'tjugo', 'trettio', 'fyrtio', 'femtio', 'sextio', 'sjuttio', 'åttio', 'nittio'];
const ORDINALS = [
  '', 'första', 'andra', 'tredje', 'fjärde', 'femte', 'sjätte', 'sjunde', 'åttonde', 'nionde', 'tionde',
  'elfte', 'tolfte', 'trettonde', 'fjortonde', 'femtonde', 'sextonde', 'sjuttonde', 'artonde', 'nittonde',
  'tjugonde', 'tjugoförsta', 'tjugoandra', 'tjugotredje', 'tjugofjärde', 'tjugofemte', 'tjugosjätte',
  'tjugosjunde', 'tjugoåttonde', 'tjugonionde', 'trettionde', 'trettioförsta',
];
const MONTHS = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
];
// Efter ett fyrsiffrigt tal: då är det en mängd, inte ett årtal.
const UNIT_AFTER =
  /^\s*(?:kr\b|kronor|sek\b|euro|dollar|pund|meter|m\b|km\b|kilometer|mil\b|kg\b|kilo|gram|g\b|ton\b|liter|st\b|stycken|grader|procent|personer|människor|invånare|år\b|dagar|timmar|minuter|sekunder|gånger|poäng|röster|watt|w\b|kwh|mb\b|gb\b)/i;

function below100(n) {
  if (n < 20) return ONES[n];
  const ones = n % 10;
  return TENS[(n - ones) / 10] + (ones ? ONES[ones] : '');
}

function below1000(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundreds) parts.push(`${ONES[hundreds]}hundra`);
  if (rest) parts.push(below100(rest));
  return parts.join(' ');
}

export function numberToSwedish(n) {
  if (!Number.isFinite(n) || n >= 1e15) return String(n);
  if (n < 0) return `minus ${numberToSwedish(-n)}`;
  if (n === 0) return 'noll';
  const groups = [
    [1e12, 'biljon', 'biljoner'],
    [1e9, 'miljard', 'miljarder'],
    [1e6, 'miljon', 'miljoner'],
  ];
  const parts = [];
  let rest = n;
  for (const [value, one, many] of groups) {
    const count = Math.floor(rest / value);
    rest %= value;
    if (count) parts.push(count === 1 ? `en ${one}` : `${below1000(count)} ${many}`);
  }
  const thousands = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousands) parts.push(thousands === 1 ? 'tusen' : `${below1000(thousands)} tusen`);
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}

function yearToSwedish(year) {
  if (year >= 2000 && year <= 2009) return numberToSwedish(year); // två tusen fem
  const century = Math.floor(year / 100);
  const rest = year % 100;
  return `${below100(century)}hundra${rest ? ` ${below100(rest)}` : ''}`; // nittonhundra åttiofyra, tjugohundra tjugosex
}

function ordinalToSwedish(n) {
  if (n <= 31) return ORDINALS[n];
  if (n >= 100) return null;
  const ones = n % 10;
  const tens = TENS[(n - ones) / 10];
  return ones ? tens + ORDINALS[ones] : `${tens}nde`; // sextiosjunde, fyrtionde
}

const digitsOneByOne = (digits) => [...digits].map((d) => ONES[Number(d)]).join(' ');

function decimalsToSwedish(digits) {
  return digits.length <= 2 && digits[0] !== '0' ? below100(Number(digits)) : digitsOneByOne(digits);
}

// ----------------------------------------------------------------------------------------
// Engelska
// ----------------------------------------------------------------------------------------
const EN_ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_IRREGULAR_ORDINALS = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
};
const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const EN_UNIT_AFTER =
  /^\s*(?:dollars?|euros?|pounds?|kronor|sek\b|usd\b|meters?|metres?|m\b|km\b|kilometers?|kilometres?|miles?|kg\b|kilos?|grams?|g\b|tons?|liters?|litres?|pieces?|degrees|percent|people|inhabitants|years?\b|days|hours|minutes|seconds|times|points|votes|watts?|w\b|kwh|mb\b|gb\b|gold|hp\b)/i;

function enBelow100(n) {
  if (n < 20) return EN_ONES[n];
  const ones = n % 10;
  return EN_TENS[(n - ones) / 10] + (ones ? `-${EN_ONES[ones]}` : '');
}

function enBelow1000(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundreds) parts.push(`${EN_ONES[hundreds]} hundred`);
  if (rest) parts.push(enBelow100(rest));
  return parts.join(' and ');
}

export function numberToEnglish(n) {
  if (!Number.isFinite(n) || n >= 1e15) return String(n);
  if (n < 0) return `minus ${numberToEnglish(-n)}`;
  if (n === 0) return 'zero';
  const parts = [];
  let rest = n;
  for (const [value, word] of [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    const count = Math.floor(rest / value);
    rest %= value;
    if (count) parts.push(`${enBelow1000(count)} ${word}`);
  }
  if (rest) parts.push(parts.length && rest < 100 ? `and ${enBelow100(rest)}` : enBelow1000(rest));
  return parts.join(' ');
}

function yearToEnglish(year) {
  if (year >= 2000 && year <= 2009) return numberToEnglish(year).replace(' and ', ' '); // two thousand five
  const century = Math.floor(year / 100);
  const rest = year % 100;
  if (rest === 0) return `${enBelow100(century)} hundred`;
  return `${enBelow100(century)} ${rest < 10 ? `oh ${EN_ONES[rest]}` : enBelow100(rest)}`; // nineteen eighty-four
}

function ordinalToEnglish(n) {
  const words = numberToEnglish(n);
  const match = /^(.*?)([a-z]+)$/.exec(words);
  if (!match) return words;
  const [, head, last] = match;
  if (EN_IRREGULAR_ORDINALS[last]) return head + EN_IRREGULAR_ORDINALS[last];
  if (last.endsWith('y')) return `${head}${last.slice(0, -1)}ieth`;
  return `${head}${last}th`;
}

const enDigits = (digits) => [...digits].map((d) => EN_ONES[Number(d)]).join(' ');

/** Skriver ut tal m.m. i en text som engelska ord. */
export function spellOutEnglish(input) {
  let text = input;
  const months = EN_MONTHS.join('|');

  // ISO-datum: 2026-11-13 -> the thirteenth of November twenty twenty-six
  text = text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, y, m, d) => {
    const month = EN_MONTHS[Number(m) - 1];
    const day = Number(d);
    return month && day >= 1 && day <= 31 ? `the ${ordinalToEnglish(day)} of ${month} ${yearToEnglish(Number(y))}` : match;
  });

  // Klockslag: 14:30 -> fourteen thirty, 9:05 -> nine oh five, 16:00 -> sixteen hundred
  text = text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(\s*[ap]\.?m\.?)?/gi, (_, h, m, suffix = '') => {
    const hour = enBelow100(Number(h));
    const minute = Number(m);
    const ampm = suffix.replace(/[\s.]/g, '').toLowerCase();
    const tail = ampm ? ` ${ampm[0]} m` : '';
    if (minute === 0) return ampm ? `${hour}${tail}` : `${hour} o'clock`;
    return `${hour} ${minute < 10 ? `oh ${EN_ONES[minute]}` : enBelow100(minute)}${tail}`;
  });

  // Tecken och enheter
  text = text
    .replace(/\s*°\s*C\b/g, ' degrees Celsius')
    .replace(/\s*°\s*F\b/g, ' degrees Fahrenheit')
    .replace(/\s*°/g, ' degrees')
    .replace(/\s*%/g, ' percent')
    .replace(/\bkm\/h\b/gi, 'kilometres per hour')
    .replace(/\bm\/s\b/gi, 'metres per second')
    .replace(/\$\s*(\d[\d,.]*\d|\d)/g, '$1 dollars')
    .replace(/£\s*(\d[\d,.]*\d|\d)/g, '$1 pounds')
    .replace(/€\s*(\d[\d,.]*\d|\d)/g, '$1 euros')
    .replace(/(\d)\s*€/g, '$1 euros')
    .replace(/\s*&\s*/g, ' and ');

  // Datum och ordningstal: 13 November, November 13, 3rd
  text = text.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${months})\\b`, 'gi'), (match, d, month) => {
    const day = Number(d);
    return day >= 1 && day <= 31 ? `the ${ordinalToEnglish(day)} of ${month}` : match;
  });
  text = text.replace(new RegExp(`\\b(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*[:.,]?\\d)`, 'gi'), (match, month, d) => {
    const day = Number(d);
    return day >= 1 && day <= 31 ? `${month} ${ordinalToEnglish(day)}` : match;
  });
  text = text.replace(/\b(\d{1,4})(?:st|nd|rd|th)\b/g, (_, n) => ordinalToEnglish(Number(n)));

  // Intervall och minustecken
  text = text
    .replace(/(\d)\s*[–—-]\s*(?=\d)/g, '$1 to ')
    .replace(/(^|[\s(])[-−](?=\d)/g, '$1minus ');

  // Själva talen: 1,250.5 / 716 230 / 3.14 / 2026
  const number = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:[   ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  text = text.replace(number, (match, offset, whole) => {
    const [rawInteger, decimals = ''] = match.split('.');
    const integer = rawInteger.replace(/[,   ]/g, '');
    if (!decimals && integer.length > 1 && integer.startsWith('0')) return enDigits(integer);
    if (integer.length > 15) return enDigits(integer);

    const value = Number(integer);
    const plainFourDigits = /^\d{4}$/.test(match);
    if (plainFourDigits && value >= 1100 && value <= 2099 && !EN_UNIT_AFTER.test(whole.slice(offset + match.length))) {
      return yearToEnglish(value);
    }
    const words = numberToEnglish(value);
    return decimals ? `${words} point ${enDigits(decimals)}` : words;
  });

  return text.replace(/\s+/g, ' ').trim();
}

/** Skriver ut tal m.m. i en text som svenska ord. */
export function spellOutSwedish(input) {
  let text = input;

  // ISO-datum: 2026-11-12 -> den tolfte november tjugohundra tjugosex
  text = text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, y, m, d) => {
    const month = MONTHS[Number(m) - 1];
    const day = ORDINALS[Number(d)];
    return month && day ? `den ${day} ${month} ${yearToSwedish(Number(y))}` : match;
  });

  // Klockslag: 14:30 -> fjorton och trettio
  text = text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, h, m) => {
    const hour = below100(Number(h));
    const minute = Number(m);
    if (minute === 0) return hour;
    return minute < 10 ? `${hour} noll ${ONES[minute]}` : `${hour} och ${below100(minute)}`;
  });

  // Tecken och enheter
  text = text
    .replace(/\s*°\s*C\b/g, ' grader')
    .replace(/\s*°/g, ' grader')
    .replace(/\s*%/g, ' procent')
    .replace(/\bkm\/h\b/gi, 'kilometer i timmen')
    .replace(/\bm\/s\b/gi, 'meter per sekund')
    .replace(/\s*€/g, ' euro')
    .replace(/\$\s*(\d[\d\s.,]*\d|\d)/g, '$1 dollar')
    .replace(/\s*&\s*/g, ' och ');

  // Datum: 12 november -> tolfte november
  text = text.replace(new RegExp(`\\b(\\d{1,2})(?::?e)?\\s+(${MONTHS.join('|')})\\b`, 'gi'), (match, d, month) => {
    const day = ORDINALS[Number(d)];
    return day ? `${day} ${month}` : match;
  });

  // Ordningstal: 67:e -> sextiosjunde, 2:a -> andra
  text = text.replace(/\b(\d{1,2}):(?:e|a)\b/g, (match, n) => ordinalToSwedish(Number(n)) || match);

  // Intervall och minustecken: 5-6 -> 5 till 6, -3 -> minus 3
  text = text
    .replace(/(\d)\s*[–—-]\s*(?=\d)/g, '$1 till ')
    .replace(/(^|[\s(])[-−](?=\d)/g, '$1minus ');

  // Själva talen
  const number = /\d{1,3}(?:[   ]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g;
  text = text.replace(number, (match, offset, whole) => {
    let integer = match;
    let decimals = '';

    if (/[   ]/.test(match)) {
      // 723 000 eller 1 234,5
      [integer, decimals = ''] = match.split(',');
      integer = integer.replace(/[   ]/g, '');
    } else if (/^\d{1,3}(?:\.\d{3})+$/.test(match)) {
      integer = match.replace(/\./g, ''); // 723.000 som tusentalsavgränsare
    } else if (/[.,]/.test(match)) {
      [integer, decimals] = match.split(/[.,]/);
    }

    if (!decimals && integer.length > 1 && integer.startsWith('0')) return digitsOneByOne(integer); // 0701...
    if (integer.length > 15) return digitsOneByOne(integer);

    const value = Number(integer);
    const plainFourDigits = match.length === 4 && /^\d{4}$/.test(match);
    if (plainFourDigits && value >= 1100 && value <= 2099 && !UNIT_AFTER.test(whole.slice(offset + match.length))) {
      return yearToSwedish(value);
    }
    const words = numberToSwedish(value);
    return decimals ? `${words} komma ${decimalsToSwedish(decimals)}` : words;
  });

  return text.replace(/\s+/g, ' ').trim();
}
