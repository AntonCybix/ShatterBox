// Läget för tjänsterna och kommandona som startar och stoppar dem, lika för Windows och Linux.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IS_WINDOWS, LOCAL, LOG_DIR, ROOT } from './paths.mjs';

export const SERVICES = [
  ['ollama', 'Språkmodell'],
  ['stt', 'Tal-till-text'],
  ['tts', 'Talsyntes'],
  ['search', 'Webbsök'],
  ['bot', 'Discord-botar'],
];

export async function probe(url, timeout = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** { services: { ollama, stt, tts, search, bot }, live: [status per Discord-bot] } */
export async function serviceState() {
  const [ollama, stt, tts, search, botStatus] = await Promise.all([
    probe(`${LOCAL.ollama}/api/version`),
    probe(`${LOCAL.stt}/health`),
    probe(`${LOCAL.tts}/health`),
    probe(`${LOCAL.search}/healthz`),
    probe(`${LOCAL.botStatus}/status`),
  ]);
  let live = [];
  try {
    live = JSON.parse(botStatus ?? '{}').bots ?? [];
  } catch {
    live = [];
  }
  return {
    services: { ollama: ollama !== null, stt: stt !== null, tts: tts !== null, search: search !== null, bot: botStatus !== null },
    live,
  };
}

/** [kommando, argument] för scripts/<namn>.ps1 i Windows och scripts/<namn>.sh annars. */
export function scriptCommand(name) {
  if (IS_WINDOWS) {
    const file = path.join(ROOT, 'scripts', `${name}.ps1`);
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '${file}'`]];
  }
  return ['bash', [path.join(ROOT, 'scripts', `${name}.sh`)]];
}

export const RESTART_BOTS = ['docker', ['compose', 'up', '-d', '--force-recreate', 'bot']];

/** Kör ett kommando i projektmappen med utskriften direkt i terminalen. Ger avslutskoden. */
export function runInherit(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`Kunde inte köra ${command}: ${error.message}`);
      resolve(127);
    });
  });
}

/** Kör ett kommando tyst och ger { code, stdout, stderr }. Kastar aldrig. */
export function capture(command, args, { timeout = 15_000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout, windowsHide: true, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Finns programmet i PATH? Ger sökvägen eller null. */
export async function which(program) {
  const result = await capture(IS_WINDOWS ? 'where.exe' : 'which', [program], { timeout: 5000 });
  return result.code === 0 ? result.stdout.split(/\r?\n/)[0].trim() || null : null;
}

export function tail(file, lines) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export async function botLogs(lines = 150) {
  const result = await capture('docker', ['compose', 'logs', '--no-log-prefix', '--tail', String(lines), 'bot'], { timeout: 8000 });
  return result.code === 0 ? result.stdout : 'Kan inte läsa botens logg (är Docker igång?).';
}

export const ttsLog = (lines = 150) => tail(path.join(LOG_DIR, 'tts-gpu.log'), lines);
