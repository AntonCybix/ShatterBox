// Små hjälpmedel för kommandoraden: färger, frågor och tabeller. Inga beroenden.

import readline from 'node:readline';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
};

export const ok = (text) => console.log(`  ${c.green('✓')} ${text}`);
export const bad = (text) => console.log(`  ${c.red('✗')} ${text}`);
export const warn = (text) => console.log(`  ${c.yellow('!')} ${text}`);
export const note = (text) => console.log(`    ${c.dim(text)}`);
export const heading = (text) => console.log(`\n${c.bold(c.cyan(text))}`);

export const LOGO = [
  '  ____  _           _   _            ____            ',
  ' / ___|| |__   __ _| |_| |_ ___ _ __| __ )  _____  __',
  " \\___ \\| '_ \\ / _` | __| __/ _ \\ '__|  _ \\ / _ \\ \\/ /",
  '  ___) | | | | (_| | |_| ||  __/ |  | |_) | (_) >  < ',
  ' |____/|_| |_|\\__,_|\\__|\\__\\___|_|  |____/ \\___/_/\\_\\',
];

// ---------------------------------------------------------------------------------------
// Frågor. Rader läses via en kö så att det också fungerar när svaren matas in via en pipe.
// ---------------------------------------------------------------------------------------
let rl = null;
let closed = false;
const lines = [];
const waiters = [];

function open() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  rl.on('SIGINT', () => {
    console.log('');
    process.exit(130);
  });
}

function nextLine() {
  open();
  if (lines.length) return Promise.resolve(lines.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

/** Stänger inläsningen så att programmet kan avslutas. */
export function closePrompts() {
  if (rl) rl.close();
  rl = null;
}

export const interactive = () => Boolean(process.stdin.isTTY);

/** Ställer en fråga. fallback visas inom hakparentes och används vid tomt svar. */
export async function ask(question, { fallback = '', secret = false } = {}) {
  open();
  const hint = fallback && !secret ? c.dim(` [${fallback}]`) : '';
  process.stdout.write(`${question}${hint}: `);
  const original = rl._writeToOutput;
  // Dölj det som skrivs (token). Radslutet släpps igenom så att markören hamnar rätt.
  if (secret && process.stdin.isTTY) rl._writeToOutput = (text) => { if (/[\r\n]/.test(text)) process.stdout.write('\n'); };
  const line = await nextLine();
  rl._writeToOutput = original;
  if (line === null) {
    console.log('');
    return fallback;
  }
  return line.trim() || fallback;
}

export async function confirm(question, fallback = true) {
  const answer = (await ask(`${question} ${c.dim(fallback ? '(J/n)' : '(j/N)')}`)).toLowerCase();
  if (!answer) return fallback;
  return /^(j|ja|y|yes)$/.test(answer);
}

/** options: [{ value, label, hint }]. Returnerar value för det valda alternativet. */
export async function choose(question, options, fallbackValue = options[0].value) {
  console.log(question);
  options.forEach((option, i) => {
    console.log(`  ${c.cyan(String(i + 1))}. ${option.label}${option.hint ? c.dim(`  ${option.hint}`) : ''}`);
  });
  const fallbackIndex = Math.max(0, options.findIndex((option) => option.value === fallbackValue));
  for (;;) {
    const answer = await ask('Välj', { fallback: String(fallbackIndex + 1) });
    const picked = options[Number(answer) - 1] ?? options.find((option) => String(option.value).toLowerCase() === answer.toLowerCase());
    if (picked) return picked.value;
    console.log(c.yellow(`Skriv en siffra mellan 1 och ${options.length}.`));
  }
}

/** Läser flera rader tills en rad med bara en punkt. Tom text om man avslutar direkt. */
export async function askMultiline(question) {
  console.log(`${question}\n${c.dim('Skriv eller klistra in. Avsluta med en rad som bara innehåller en punkt (.)')}`);
  const collected = [];
  for (;;) {
    const line = await nextLine();
    if (line === null || line.trim() === '.') break;
    collected.push(line);
  }
  return collected.join('\n').trim();
}

/** Skriver rader i kolumner. rows: [[cell, cell, ...]] */
export function table(rows, indent = '  ') {
  // eslint-disable-next-line no-control-regex
  const visible = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, '').length;
  const widths = [];
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, visible(cell)); });
  for (const row of rows) {
    const cells = row.map((cell, i) => (i === row.length - 1 ? cell : `${cell}${' '.repeat(widths[i] - visible(cell))}`));
    console.log(indent + cells.join('  ').trimEnd());
  }
}
