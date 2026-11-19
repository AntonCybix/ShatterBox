// Läser och skriver .env utan att röra kommentarer eller rader som programmet inte känner till.

import fs from 'node:fs';
import { ENV_EXAMPLE, ENV_FILE } from './paths.mjs';

const readEnvLines = () =>
  fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/) : [];

function parseValue(raw) {
  const value = raw.trim();
  const quoted = (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'));
  return quoted && value.length >= 2 ? value.slice(1, -1) : value;
}

export function readEnv() {
  const env = {};
  for (const line of readEnvLines()) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) env[match[1]] = parseValue(match[2]);
  }
  return env;
}

function formatValue(value) {
  const text = String(value).replace(/[\r\n]+/g, ' ').trim();
  // Tecken som docker compose annars tolkar (kommentar, variabel, citat) kräver enkla citattecken.
  return /[#$"'\\]/.test(text) ? `'${text.replace(/'/g, '’')}'` : text;
}

/** changes: { NYCKEL: värde | null }. null tar bort raden. Övriga rader och kommentarer rörs inte. */
export function updateEnv(changes) {
  const lines = readEnvLines();
  for (const [key, value] of Object.entries(changes)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (value === null || value === undefined) {
      if (index >= 0) lines.splice(index, 1);
    } else if (index >= 0) {
      lines[index] = `${key}=${formatValue(value)}`;
    } else {
      lines.push(`${key}=${formatValue(value)}`);
    }
  }
  if (fs.existsSync(ENV_FILE)) fs.copyFileSync(ENV_FILE, `${ENV_FILE}.bak`);
  const temp = `${ENV_FILE}.tmp`;
  fs.writeFileSync(temp, lines.join('\n').replace(/\n*$/, '\n'), 'utf8');
  fs.renameSync(temp, ENV_FILE);
}

/** Skapar .env från .env.example första gången. Returnerar true om filen skapades nu. */
export function ensureEnvFile() {
  if (fs.existsSync(ENV_FILE)) return false;
  if (fs.existsSync(ENV_EXAMPLE)) fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
  else fs.writeFileSync(ENV_FILE, '', 'utf8');
  return true;
}
