// Kontrollpanelen för ShatterBox: en liten lokal webbsida där man startar och stoppar allt
// och skapar karaktärer.
//
// Körs direkt på datorn, inte i Docker, eftersom den startar och stoppar allt annat:
//   node app/server.mjs        (startas normalt av skrivbordsgenvägen eller "shatterbox ui")
//
// Lyssnar bara på 127.0.0.1. Varje API-anrop kräver en slumpad nyckel som bara den egna
// sidan känner till, så att andra webbsidor i din webbläsare inte kan styra panelen.
// Discord-tokens skrivs till .env men skickas aldrig tillbaka till webbläsaren.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { UserError, deleteBot, listBots, removeVoice, saveBot, saveVoice } from '../lib/bots.mjs';
import { readEnv } from '../lib/env.mjs';
import { IS_WINDOWS, LOCAL, LOG_DIR, PERSONA_DIR, ROOT, VOICE_DIR } from '../lib/paths.mjs';
import { RESTART_BOTS, botLogs, probe, scriptCommand, serviceState, tail, ttsLog, which } from '../lib/services.mjs';

const PORT = Number(process.env.APP_PORT || 8090);
const INDEX_HTML = path.join(ROOT, 'app', 'index.html');
const CLI = path.join(ROOT, 'cli', 'shatterbox.mjs');
const SESSION = crypto.randomBytes(24).toString('hex');

for (const dir of [PERSONA_DIR, VOICE_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------------------------------
// Starta / stoppa
// ---------------------------------------------------------------------------------------
let action = null; // { name, startedAt, done, exitCode }
let dirty = false; // sparade ändringar som Discord-botarna ännu inte har läst in
const ACTION_LOG = path.join(LOG_DIR, 'app-action.log');

function runAction(name, command, args) {
  if (action && !action.done) throw new UserError('Vänta tills det som pågår är klart.');
  const fd = fs.openSync(ACTION_LOG, 'w');
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true });
  const current = { name, startedAt: Date.now(), done: false, exitCode: null };
  action = current;
  const finish = (code) => {
    if (current.done) return;
    current.done = true;
    current.exitCode = code;
    try {
      fs.closeSync(fd);
    } catch {
      // redan stängd
    }
  };
  child.on('exit', finish);
  child.on('error', () => finish(-1));
}

async function getState() {
  const { services, live } = await serviceState();
  const env = readEnv();
  const bots = listBots(env).map((bot) => ({ ...bot, live: live.find((entry) => entry.index === bot.index) ?? null }));
  // Skiljer sig det som kör från det som är sparat?
  const mismatch = services.bot && (
    bots.some((bot) => !bot.live || bot.live.name !== bot.name || bot.live.language !== bot.language ||
      bot.live.hasToken !== bot.hasToken || (bot.live.mode ?? 'discord') !== bot.mode) ||
    live.some((entry) => !bots.some((bot) => bot.index === entry.index))
  );
  if (!services.bot) dirty = false;
  return {
    services,
    model: (env.OLLAMA_MODEL ?? '').trim() || 'gemma4:e2b',
    bots,
    pendingRestart: services.bot && (dirty || mismatch),
    talkCommand: `${IS_WINDOWS ? 'shatterbox' : './shatterbox'} talk`,
    action: action
      ? { name: action.name, running: !action.done, exitCode: action.exitCode, log: tail(ACTION_LOG, 14) }
      : null,
  };
}

/** Öppnar ett terminalfönster där man pratar med karaktären (shatterbox talk). */
async function openTalk(index) {
  const bot = listBots().find((entry) => entry.index === index);
  if (!bot) throw new UserError('Karaktären finns inte längre.');
  const detached = { cwd: ROOT, detached: true, stdio: 'ignore' };
  if (IS_WINDOWS) {
    // start "titel" cmd /k ""node" "skript" talk N"  - yttre citattecknen krävs av cmd /k
    const line = `start "ShatterBox" cmd /k ""${process.execPath}" "${CLI}" talk ${index}"`;
    spawn('cmd.exe', ['/d', '/c', line], { ...detached, windowsVerbatimArguments: true }).unref();
    return;
  }
  const manual = `Kör det här i en terminal:  ./shatterbox talk ${bot.key}`;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new UserError(`Den här datorn har inget skrivbord att öppna ett fönster på. ${manual}`);
  const terminals = [
    ['x-terminal-emulator', ['-e']],
    ['gnome-terminal', ['--']],
    ['konsole', ['-e']],
    ['xfce4-terminal', ['-x']],
    ['xterm', ['-e']],
  ];
  for (const [program, flag] of terminals) {
    if (await which(program)) {
      spawn(program, [...flag, process.execPath, CLI, 'talk', String(index)], detached).unref();
      return;
    }
  }
  throw new UserError(`Hittade inget terminalprogram att öppna. ${manual}`);
}

// ---------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new UserError('Filen är för stor.'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host ?? '');
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'Fel värdnamn.' });
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(INDEX_HTML, 'utf8').replace('__SESSION__', SESSION);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/icon.png') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'icon.png')), 'image/png');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Finns inte.' });

    // Bara den egna sidan får använda API:t.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'Fel ursprung.' });
    if (req.headers['x-panel-token'] !== SESSION) return send(res, 403, { error: 'Sidan är för gammal - ladda om den.' });

    lastSeen = Date.now();
    const route = `${req.method} ${url.pathname}`;
    const botMatch = /^\/api\/bots\/(\d)(\/voice|\/talk)?$/.exec(url.pathname);
    const json = async () => JSON.parse((await readBody(req, 1_000_000)).toString('utf8') || '{}');

    if (route === 'GET /api/state') return send(res, 200, await getState());
    if (route === 'GET /api/logs') {
      const source = url.searchParams.get('source');
      if (source === 'tts') return send(res, 200, { text: ttsLog() });
      if (source === 'action') return send(res, 200, { text: tail(ACTION_LOG, 150) });
      return send(res, 200, { text: await botLogs() });
    }
    if (route === 'POST /api/start') {
      runAction('start', ...scriptCommand('start'));
      dirty = false;
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/stop') {
      runAction('stop', ...scriptCommand('stop'));
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/restart-bots') {
      runAction('restart', ...RESTART_BOTS);
      dirty = false;
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/quit') {
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return undefined;
    }
    if (route === 'POST /api/bots') {
      const result = await saveBot(null, await json());
      dirty = true;
      return send(res, 200, result);
    }
    if (botMatch) {
      const index = Number(botMatch[1]);
      const sub = botMatch[2];
      if (!sub && req.method === 'PUT') {
        const result = await saveBot(index, await json());
        dirty = true;
        return send(res, 200, result);
      }
      if (!sub && req.method === 'DELETE') {
        deleteBot(index);
        dirty = true;
        return send(res, 200, { ok: true });
      }
      if (sub === '/voice' && req.method === 'PUT') {
        saveVoice(index, url.searchParams.get('name') ?? '', await readBody(req, 60_000_000));
        return send(res, 200, { ok: true });
      }
      if (sub === '/voice' && req.method === 'DELETE') {
        removeVoice(index);
        return send(res, 200, { ok: true });
      }
      if (sub === '/talk' && req.method === 'POST') {
        await openTalk(index);
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { error: 'Finns inte.' });
  } catch (error) {
    if (error instanceof UserError) return send(res, 400, { error: error.message });
    console.error(error);
    return send(res, 500, { error: `Internt fel: ${error.message}` });
  }
});

// Stäng av panelen själv när den inte behövs: fönstret är stängt sedan en stund och inget kör.
let lastSeen = Date.now();
setInterval(async () => {
  if (Date.now() - lastSeen < 10 * 60_000 || (action && !action.done)) return;
  const [bot, tts] = await Promise.all([probe(`${LOCAL.botStatus}/status`), probe(`${LOCAL.tts}/health`)]);
  if (bot === null && tts === null) process.exit(0);
}, 60_000).unref();

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} används redan - panelen är troligen redan igång.` : error);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Kontrollpanelen lyssnar på http://127.0.0.1:${PORT}`));
