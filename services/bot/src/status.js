import http from 'node:http';
import { bots, log } from './config.js';

// Läget för varje karaktär, så att kontrollpanelen (appen) kan visa det.
// GET /status -> { bots: [{ index, name, language, mode, hasToken, loggedIn, tag, inviteUrl, guilds, voice, error }] }

const state = new Map();
for (const bot of bots) {
  state.set(bot.key, {
    index: bot.index,
    name: bot.name,
    language: bot.language,
    mode: bot.mode,
    hasToken: Boolean(bot.token),
    loggedIn: false,
    tag: null,
    inviteUrl: null,
    guilds: [],
    voice: null, // { guild, channel } när karaktären sitter i en röstkanal
    error: null,
  });
}

export function setStatus(bot, patch) {
  const entry = state.get(bot.key);
  if (entry) Object.assign(entry, patch);
}

export function startStatusServer(port = Number(process.env.STATUS_PORT || 8080)) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ bots: [...state.values()] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('error', (error) => log(`statusservern kunde inte starta: ${error.message}`));
  // I Docker nås porten bara via 127.0.0.1 på värddatorn (se docker-compose.yml). Med värdens
  // nätverk (Linux) sätts STATUS_HOST=127.0.0.1 så att den inte syns utåt.
  server.listen(port, process.env.STATUS_HOST || '0.0.0.0');
}
