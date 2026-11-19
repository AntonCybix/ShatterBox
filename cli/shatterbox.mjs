#!/usr/bin/env node
// ShatterBox på kommandoraden: samma saker som kontrollpanelen, plus samtal direkt i terminalen.
// Körs via ./shatterbox (Linux) eller shatterbox.cmd (Windows). Inga npm-paket behövs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UserError, deleteBot, findBot, listBots, removeVoice, saveVoice } from '../lib/bots.mjs';
import { IS_WINDOWS, LOCAL, LOG_DIR, ROOT } from '../lib/paths.mjs';
import { RESTART_BOTS, SERVICES, probe, runInherit, scriptCommand, serviceState, ttsLog } from '../lib/services.mjs';
import { editBotWizard } from './botwizard.mjs';
import { LOGO, c, choose, closePrompts, confirm, heading, interactive, table } from './ui.mjs';

const RUN = IS_WINDOWS ? 'shatterbox' : './shatterbox';

const HELP = `
${c.bold('ShatterBox')}  lokala röstkaraktärer, på Discord eller direkt i terminalen

${c.bold('Användning:')}  ${RUN} <kommando> [val]

${c.bold('Kom igång')}
  setup                 installationsguiden: kontrollerar och installerar allt som behövs
  doctor                visar vad som finns, vad som saknas och vad som är igång

${c.bold('Prata')}
  talk [karaktär]       samtal i terminalen med ljudstaplar (Tab slår på mikrofonen)
  talk <karaktär> "fråga"   en enda fråga
                        val: --mic  --mic=<nr>  --list-mics  --barge  --mute  --plain  --ascii  --user=<namn>

${c.bold('Karaktärer')}
  bots                  lista karaktärerna (--invite visar inbjudningslänkarna till Discord)
  new                   skapa en karaktär (guide). Välj Discord eller bara lokalt
  edit <karaktär>       ändra en karaktär
  remove <karaktär>     ta bort en karaktär
  voice <karaktär> <ljudfil>   byt röstprov (--remove tar bort det)
                        val för new/edit: --name= --language=sv|en --local | --discord --token=
                        --persona-file= --voice= --voice-style= --greeting= --parody --wake-only --yes

${c.bold('Tjänsterna')}
  start                 startar allt: språkmodell, talsyntes, tal-till-text, webbsök, Discord-botar
  stop                  stoppar allt
  restart               startar om Discord-botarna (behövs efter ändrat namn, språk, läge eller token)
  status                läget för tjänsterna och varje karaktär
  logs [bot|tts]        visar loggen (--follow följer botens logg)
  ui                    öppnar kontrollpanelen i webbläsaren

En karaktär anges med namn, början av namnet eller nummer:  ${RUN} talk zol
`;

function parse(argv) {
  const flags = {};
  const args = [];
  for (const item of argv) {
    if (item.startsWith('--')) {
      const [key, ...rest] = item.slice(2).split('=');
      flags[key] = rest.length ? rest.join('=') : true;
    } else {
      args.push(item);
    }
  }
  return { flags, args };
}

function requireBot(selector) {
  const bots = listBots();
  if (!selector) throw new UserError(`Ange vilken karaktär. Finns: ${bots.map((bot) => bot.name).join(', ')}`);
  const bot = findBot(selector, bots);
  if (!bot) throw new UserError(`Hittar ingen karaktär som heter "${selector}". Finns: ${bots.map((entry) => entry.name).join(', ')}`);
  return bot;
}

function liveText(bot, live, botUp) {
  if (bot.mode === 'local') return `${RUN} talk ${bot.key}`;
  if (!botUp) return 'inte igång';
  if (!bot.hasToken) return c.yellow('token saknas');
  if (!live || !live.hasToken) return 'sparad, gäller efter omstart';
  if (live.error) return c.red(live.error);
  if (live.voice) return c.green(`i röstkanalen #${live.voice.channel} (${live.voice.guild})`);
  if (live.loggedIn) return live.guilds?.length ? `inloggad som ${live.tag}` : c.yellow(`inloggad som ${live.tag}, men inte inbjuden till någon server`);
  return 'loggar in …';
}

async function status() {
  const { services, live } = await serviceState();
  heading('Tjänster');
  table(SERVICES.map(([key, label]) => [services[key] ? c.green('●') : c.red('○'), label, services[key] ? 'igång' : c.dim('inte igång')]));
  heading('Karaktärer');
  const bots = listBots();
  table(bots.map((bot) => [
    c.dim(String(bot.index)),
    c.bold(bot.name),
    bot.language,
    bot.mode === 'local' ? c.cyan('lokal') : 'Discord',
    liveText(bot, live.find((entry) => entry.index === bot.index), services.bot),
  ]));
  console.log('');
  return 0;
}

function showBots(flags = {}) {
  const bots = listBots();
  heading('Karaktärer');
  table(bots.map((bot) => [
    c.dim(String(bot.index)),
    c.bold(bot.name),
    bot.language,
    bot.mode === 'local' ? c.cyan('lokal') : bot.hasToken ? 'Discord' : c.yellow('Discord, token saknas'),
    bot.voiceFile ? `röstprov ${bot.voiceFile}` : bot.voiceStyle ? `designad röst (${bot.voiceStyle})` : 'standardröst',
    bot.persona ? `persona ${bot.persona.length} tecken` : c.dim('ingen persona'),
    [bot.parody ? 'imitation' : '', bot.wakeOnly ? 'svarar på namn' : ''].filter(Boolean).join(', '),
  ]));
  const invitable = bots.filter((bot) => bot.inviteUrl);
  if (flags.invite) {
    console.log('');
    for (const bot of invitable) console.log(`  Bjud in ${c.bold(bot.name)} till en server:\n  ${c.cyan(bot.inviteUrl)}\n`);
    if (!invitable.length) console.log('  Ingen karaktär har en Discord-token ännu.\n');
    return 0;
  }
  console.log(`\n  Prata med en av dem:  ${c.cyan(`${RUN} talk <namn>`)}`);
  if (invitable.length) console.log(`  Inbjudningslänkar till Discord:  ${c.cyan(`${RUN} bots --invite`)}`);
  console.log('');
  return 0;
}

async function inVoice() {
  const { live } = await serviceState();
  return live.filter((entry) => entry.voice).map((entry) => entry.name);
}

async function stop(flags) {
  const names = await inVoice();
  if (names.length && !flags.yes && !(await confirm(`${names.join(', ')} sitter i en röstkanal och kopplas ner. Stoppa ändå?`, false))) return 0;
  return runInherit(...scriptCommand('stop'));
}

async function restart(flags) {
  const names = await inVoice();
  if (names.length && !flags.yes && !(await confirm(`${names.join(', ')} sitter i en röstkanal och kopplas ner. Starta om ändå?`, false))) return 0;
  return runInherit(...RESTART_BOTS);
}

async function logs(args, flags) {
  if (args[0] === 'tts') {
    console.log(ttsLog(100) || '(tomt)');
    return 0;
  }
  return runInherit('docker', ['compose', 'logs', '--tail', '100', ...(flags.follow || flags.f ? ['-f'] : []), 'bot']);
}

/** Värden som getts som flaggor. Med --yes eller utan terminal fylls resten i utan frågor. */
function presetFrom(flags, bot) {
  const preset = {};
  if (typeof flags.name === 'string') preset.name = flags.name;
  if (typeof flags.language === 'string') preset.language = flags.language.toLowerCase();
  if (flags.local) preset.mode = 'local';
  if (flags.discord) preset.mode = 'discord';
  if (typeof flags.mode === 'string') preset.mode = flags.mode.toLowerCase();
  if (typeof flags.token === 'string') preset.token = flags.token;
  if (typeof flags['persona-file'] === 'string') {
    const file = path.resolve(flags['persona-file']);
    if (!fs.existsSync(file)) throw new UserError(`Hittar inte ${file}.`);
    preset.persona = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  }
  if (typeof flags['voice-style'] === 'string') preset.voiceStyle = flags['voice-style'];
  if (typeof flags.voice === 'string') {
    preset.voiceFile = path.resolve(flags.voice);
    if (!fs.existsSync(preset.voiceFile)) throw new UserError(`Hittar inte ${preset.voiceFile}.`);
  }
  if (typeof flags.greeting === 'string') preset.greeting = flags.greeting;
  if (flags.parody) preset.parody = true;
  if (flags['wake-only']) preset.wakeOnly = true;

  if (flags.yes || !interactive()) {
    const defaults = bot
      ? { name: bot.name, language: bot.language, mode: bot.mode, token: '', persona: bot.persona, parody: bot.parody, wakeOnly: bot.wakeOnly, voiceStyle: bot.voiceStyle, greeting: bot.greeting }
      : { language: 'sv', mode: 'discord', token: '', persona: '', parody: false, wakeOnly: false, voiceStyle: '', greeting: '' };
    if (!bot && preset.name === undefined) throw new UserError('Ange ett namn:  --name=<namn>');
    return { ...defaults, ...preset };
  }
  return preset;
}

async function voice(args, flags) {
  const bot = requireBot(args[0]);
  if (flags.remove) {
    removeVoice(bot.index);
    console.log(`Röstprovet för ${bot.name} är borttaget.`);
    return 0;
  }
  if (!args[1]) throw new UserError(`Ange en ljudfil:  ${RUN} voice ${bot.key} <fil>`);
  const file = path.resolve(args[1]);
  if (!fs.existsSync(file)) throw new UserError(`Hittar inte ${file}.`);
  const saved = saveVoice(bot.index, file, fs.readFileSync(file));
  console.log(`${bot.name} använder nu röstprovet voice${path.sep}${saved}. Det gäller från nästa mening, utan omstart.`);
  return 0;
}

async function ui() {
  if (IS_WINDOWS) return runInherit(...scriptCommand('app'));
  if ((await probe(`${LOCAL.panel}/`)) === null) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const out = fs.openSync(path.join(LOG_DIR, 'app.log'), 'a');
    spawn(process.execPath, [path.join(ROOT, 'app', 'server.mjs')], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] }).unref();
    for (let i = 0; i < 30 && (await probe(`${LOCAL.panel}/`)) === null; i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`Kontrollpanelen finns på ${c.cyan(LOCAL.panel)}`);
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    spawn('xdg-open', [LOCAL.panel], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } else {
    console.log('Den här datorn har inget skrivbord. Nå panelen från en annan dator genom en SSH-tunnel:');
    console.log(c.dim('  ssh -L 8090:127.0.0.1:8090 <användare>@<den här datorn>   och öppna sedan http://127.0.0.1:8090'));
  }
  return 0;
}

async function menu() {
  console.log(c.cyan(LOGO.join('\n')));
  for (;;) {
    console.log('');
    const pick = await choose(c.bold('Vad vill du göra?'), [
      { value: 'talk', label: 'Prata med en karaktär' },
      { value: 'bots', label: 'Visa karaktärerna' },
      { value: 'new', label: 'Skapa en ny karaktär' },
      { value: 'edit', label: 'Ändra en karaktär' },
      { value: 'status', label: 'Visa läget' },
      { value: 'start', label: 'Starta allt' },
      { value: 'stop', label: 'Stoppa allt' },
      { value: 'setup', label: 'Installera eller kontrollera' },
      { value: 'quit', label: 'Avsluta' },
    ]);
    if (pick === 'quit') return 0;
    try {
      if (pick === 'edit') {
        const bots = listBots();
        const index = await choose('Vilken?', bots.map((bot) => ({ value: bot.index, label: bot.name })));
        await editBotWizard(bots.find((bot) => bot.index === index));
      } else {
        await run(pick, [], {});
      }
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      console.log(c.red(error.message));
    }
  }
}

async function run(command, args, flags) {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case 'menu':
      return menu();
    case 'setup':
      return (await import('./setup.mjs')).setup();
    case 'doctor':
    case 'check':
      return (await import('./setup.mjs')).doctor();
    case 'start':
      return runInherit(...scriptCommand('start'));
    case 'stop':
      return stop(flags);
    case 'restart':
      return restart(flags);
    case 'status':
      return status();
    case 'logs':
      return logs(args, flags);
    case 'bots':
    case 'list':
      return showBots(flags);
    case 'new':
    case 'add':
      await editBotWizard(null, { preset: presetFrom(flags, null) });
      return 0;
    case 'edit': {
      const bot = requireBot(args[0]);
      await editBotWizard(bot, { preset: presetFrom(flags, bot) });
      return 0;
    }
    case 'remove':
    case 'delete': {
      const bot = requireBot(args[0]);
      if (!flags.yes && !(await confirm(`Ta bort ${bot.name}? Inställningarna och token tas bort. Persona-filen och röstprovet ligger kvar på disken.`, false))) return 0;
      deleteBot(bot.index);
      console.log(`${bot.name} är borttagen.`);
      return 0;
    }
    case 'voice':
      return voice(args, flags);
    case 'talk':
    case 'chat':
      return (await import('./talk/index.mjs')).talk(args, flags);
    case 'ui':
    case 'panel':
      return ui();
    default:
      console.log(c.red(`Okänt kommando: ${command}`));
      console.log(HELP);
      return 2;
  }
}

const { flags, args } = parse(process.argv.slice(2));
const command = args.shift() ?? (flags.help || flags.h ? 'help' : interactive() ? 'menu' : 'help');
process.chdir(ROOT);
try {
  process.exitCode = (await run(command, args, flags)) ?? 0;
} catch (error) {
  console.error(error instanceof UserError ? c.red(error.message) : error);
  process.exitCode = 1;
}
closePrompts();
// Programmet avslutas av sig självt när inget mer pågår. Ett direkt process.exit() medan
// nätverksanrop städas undan får Node att krascha i Windows. Nödutgång om något hänger kvar:
setTimeout(() => process.exit(), 2500).unref();
