// shatterbox talk: prata med en karaktär direkt i terminalen, utan Discord.
//
//   shatterbox talk                 välj karaktär i en lista
//   shatterbox talk eko             samtalsfönster med ljudstaplar
//   shatterbox talk eko "Hej!"      en enda fråga, svaret skrivs ut och läses upp
//
//   --mic            börja med mikrofonen på (annars slår Tab på den)
//   --mic=<namn|nr>  välj mikrofon (se --list-mics). Valet sparas.
//   --barge          lyssna även medan karaktären pratar (använd hörlurar)
//   --mute           inget ljud, bara text
//   --plain          enkel textdialog utan helskärm (väljs automatiskt utan terminal)
//   --tui            öppna samtalsfönstret även när en fråga ges på kommandoraden
//   --ascii          bara ASCII-tecken i staplarna
//   --user=<namn>    vem som pratar (för karaktärer med minne)
//   --no-greeting    hoppa över hälsningsfrasen
//   --verbose        visa botens loggrader i samtalet

import os from 'node:os';
import { UserError, findBot, listBots } from '../../lib/bots.mjs';
import { IS_WINDOWS } from '../../lib/paths.mjs';
import { serviceState } from '../../lib/services.mjs';
import { ask, c, choose, closePrompts } from '../ui.mjs';
import { Player, Recorder, detectAudio, findFfmpeg, listWindowsMics, loadSettings, saveSettings } from './audio.mjs';
import { Session, loadBotModules } from './session.mjs';
import { Tui } from './tui.mjs';
import { colorMode, wantsAscii } from './viz.mjs';

const RUN = IS_WINDOWS ? 'shatterbox' : './shatterbox';

async function listMics() {
  if (!IS_WINDOWS) {
    console.log('I Linux väljs mikrofonen med ALSA-namnet, till exempel:  --mic=plughw:1,0');
    console.log('Lista enheterna med:  arecord -L');
    return 0;
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    console.log('Hittar inte ffmpeg, som behövs för mikrofonen. Den följer med talsyntesen (shatterbox setup).');
    return 1;
  }
  const mics = await listWindowsMics(ffmpeg);
  const saved = loadSettings().mic;
  if (!mics.length) console.log('Hittade inga mikrofoner.');
  mics.forEach((name, i) => console.log(`  ${i + 1}. ${name}${name === saved || (!saved && i === 0) ? c.dim('  (används)') : ''}`));
  console.log(`\nVälj med:  ${RUN} talk --mic=<nummer>`);
  return 0;
}

async function pickBot(selector) {
  const bots = listBots();
  if (selector) {
    const bot = findBot(selector, bots);
    if (!bot) throw new UserError(`Hittar ingen karaktär som heter "${selector}". Finns: ${bots.map((entry) => entry.name).join(', ')}`);
    return bot;
  }
  if (bots.length === 1 || !process.stdin.isTTY) return bots[0];
  const index = await choose('Vem vill du prata med?', bots.map((bot) => ({
    value: bot.index,
    label: bot.name,
    hint: `${bot.language}${bot.mode === 'local' ? ', lokal' : ', Discord'}`,
  })), (bots.find((bot) => bot.mode === 'local') ?? bots[0]).index);
  return bots.find((bot) => bot.index === index);
}

/** Enkel dialog rad för rad, för terminaler utan helskärm och för skript. */
async function plain(session, bot, { question, greeting, verbose }) {
  const originalLog = console.log;
  const print = (text) => originalLog(text);
  // Botens moduler loggar med tidsstämpel. Det hör inte hemma i ett samtal.
  console.log = (...args) => {
    if (verbose || !/^\[\d\d:\d\d:\d\d\]/.test(String(args[0]))) originalLog(...args);
  };
  let open = false;
  session.on('sentence', (sentence) => {
    print(open ? `   ${' '.repeat(bot.name.length)}${sentence}` : `${c.magenta(`${bot.name}:`)} ${sentence}`);
    open = true;
  });
  session.on('state', (state, detail) => {
    if (state === 'searching') print(c.dim(`   (söker på nätet: ${detail})`));
  });
  session.on('notice', (text) => print(c.yellow(`! ${text}`)));
  session.on('done', ({ firstMs, totalMs }) => {
    open = false;
    if (verbose && firstMs !== null) print(c.dim(`   (första meningen efter ${(firstMs / 1000).toFixed(1)} s, klart efter ${(totalMs / 1000).toFixed(1)} s)`));
  });

  try {
    if (question) {
      print(`${c.green('Du:')} ${question}`);
      await session.send(question);
      return;
    }
    print(c.dim(`Du pratar med ${bot.name}. Skriv och tryck Enter. Tom rad eller /quit avslutar.\n`));
    if (greeting) await session.say(greeting);
    for (;;) {
      open = false;
      const line = await ask(c.green('Du'));
      if (!line || /^\/(quit|exit|q|avsluta)$/i.test(line)) break;
      if (/^\/(reset|glöm)$/i.test(line)) {
        session.reset();
        print(c.dim('Samtalet är nollställt.'));
        continue;
      }
      await session.send(line);
    }
  } finally {
    console.log = originalLog;
    closePrompts();
  }
}

export async function talk(args, flags) {
  if (flags['list-mics']) return listMics();

  const picked = await pickBot(args[0]);
  const question = args.slice(1).join(' ').trim();
  const modules = await loadBotModules();
  const bot = modules.bots.find((entry) => entry.index === picked.index);
  if (!bot) throw new UserError(`${picked.name} finns i .env men kunde inte läsas in.`);

  const { services } = await serviceState();
  if (!services.ollama) throw new UserError(`Språkmodellen (Ollama) är inte igång. Starta allt med:  ${RUN} start`);

  const micChoice = typeof flags.mic === 'string' ? flags.mic : undefined;
  const audio = await detectAudio({ mic: micChoice });
  if (micChoice && IS_WINDOWS && audio.recorder) saveSettings({ mic: audio.recorder.label });

  let player = null;
  const warnings = [];
  if (flags.mute) {
    // tyst på begäran
  } else if (!services.tts) warnings.push(`Talsyntesen är inte igång, så svaren visas bara som text. Starta med:  ${RUN} start`);
  else if (!audio.player) warnings.push('Hittade inget program som kan spela upp ljud, så svaren visas bara som text.');
  else player = new Player(audio.player);

  let noMicReason = null;
  if (!audio.recorder) noMicReason = IS_WINDOWS
    ? 'Hittade ingen mikrofon. Mikrofonen kräver ffmpeg, som följer med talsyntesen.'
    : 'Hittade inget program för mikrofonen. Installera till exempel alsa-utils.';
  else if (!services.stt) noMicReason = `Tal-till-text är inte igång, så mikrofonen går inte att använda. Starta med:  ${RUN} start`;

  const userName = flags.user || process.env.TALK_USER || os.userInfo().username;
  const session = new Session({ bot, modules, player, userName });
  const greeting = flags['no-greeting'] ? '' : bot.greeting || modules.strings(bot.language).greeting;
  const modelName = bot.model || modules.config.model;

  try {
    const fullScreen = process.stdout.isTTY && process.stdin.isTTY && !flags.plain && (!question || flags.tui);
    if (!fullScreen) {
      for (const warning of warnings) console.log(c.yellow(`! ${warning}`));
      await plain(session, bot, { question, greeting, verbose: Boolean(flags.verbose) });
      return 0;
    }
    closePrompts();
    const tui = new Tui({
      session,
      modules,
      player,
      recorder: noMicReason ? null : new Recorder(audio.recorder),
      options: {
        ascii: flags.ascii ? true : wantsAscii(),
        color: colorMode(),
        barge: Boolean(flags.barge),
        mic: Boolean(flags.mic),
        verbose: Boolean(flags.verbose),
        languages: bot.listenLanguages,
        greeting: question ? '' : greeting,
        question,
        modelName,
        noMicReason,
        micNames: audio.recorder?.mics ?? [],
        // Byte av mikrofon under samtalet. Bara Windows har en numrerad lista att välja ur.
        selectMic: IS_WINDOWS && !noMicReason ? async (number) => {
          const next = await detectAudio({ mic: String(number) });
          if (!next.recorder || !(number >= 1 && number <= (next.recorder.mics?.length ?? 0))) throw new Error(`Det finns ingen mikrofon nummer ${number}. Skriv /mics.`);
          saveSettings({ mic: next.recorder.label });
          return new Recorder(next.recorder);
        } : null,
      },
    });
    for (const warning of warnings) tui.note(warning);
    const error = await tui.start();
    if (error) throw error;
    console.log(c.dim(`Samtalet med ${bot.name} är avslutat.`));
    return 0;
  } finally {
    player?.close();
  }
}
