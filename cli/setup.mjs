// Installationsguiden (shatterbox setup) och kontrollen (shatterbox doctor).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listBots } from '../lib/bots.mjs';
import { ensureEnvFile, readEnv, updateEnv } from '../lib/env.mjs';
import { IS_WINDOWS, LOCAL, ROOT, VENV_DIR } from '../lib/paths.mjs';
import { SERVICES, capture, probe, runInherit, serviceState, which } from '../lib/services.mjs';
import { editBotWizard } from './botwizard.mjs';
import { detectAudio } from './talk/audio.mjs';
import { LOGO, bad, c, choose, confirm, heading, note, ok, warn } from './ui.mjs';

export const venvPython = () => path.join(VENV_DIR, IS_WINDOWS ? 'Scripts' : 'bin', IS_WINDOWS ? 'python.exe' : 'python');
const model = () => (readEnv().OLLAMA_MODEL ?? '').trim() || 'gemma4:e2b';

async function ollamaProgram() {
  const inPath = await which('ollama');
  if (inPath) return inPath;
  if (IS_WINDOWS && process.env.LOCALAPPDATA) {
    const bundled = path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  return null;
}

/** Vilket grafikkort finns? Avgör vilken PyTorch som installeras för talsyntesen. */
export async function detectGpu() {
  let names = [];
  if (IS_WINDOWS) {
    const result = await capture('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name']);
    names = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } else {
    const result = await capture('sh', ['-c', "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | sed 's/^[^:]*:[^:]*: //'"]);
    names = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!names.length && (await which('nvidia-smi'))) names = ['NVIDIA'];
  }
  const all = names.join(' ').toLowerCase();
  const vendor = /nvidia|geforce|rtx|gtx/.test(all) ? 'nvidia' : /radeon|amd|advanced micro/.test(all) ? 'amd' : 'none';
  return { vendor, names };
}

/** Alla kontroller. Varje rad: { ok, label, detail, fix, required } */
export async function runChecks() {
  const checks = [];
  const add = (okay, label, detail = '', fix = '', required = true) => checks.push({ ok: okay, label, detail, fix, required });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18, 'Node.js 18 eller nyare', `v${process.versions.node}`, 'Installera en nyare Node.js från https://nodejs.org');

  const docker = await capture('docker', ['--version']);
  add(docker.code === 0, 'Docker', docker.stdout.trim(),
    IS_WINDOWS ? 'Installera Docker Desktop:  winget install Docker.DockerDesktop' : 'Installera Docker Engine: https://docs.docker.com/engine/install/');
  if (docker.code === 0) {
    const compose = await capture('docker', ['compose', 'version']);
    add(compose.code === 0, 'Docker Compose', compose.stdout.trim(), 'Installera tillägget docker-compose-plugin.');
    const info = await capture('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
    add(info.code === 0, 'Docker är igång', info.code === 0 ? `server ${info.stdout.trim()}` : '',
      IS_WINDOWS ? 'Starta Docker Desktop.' : 'Starta Docker:  sudo systemctl start docker   (och lägg dig i gruppen docker)');
  }

  const program = await ollamaProgram();
  const api = await probe(`${LOCAL.ollama}/api/version`);
  add(Boolean(program) || api !== null, 'Ollama', program ?? (api ? 'svarar på port 11434' : ''),
    IS_WINDOWS ? 'Installera Ollama:  winget install Ollama.Ollama' : 'Installera Ollama:  curl -fsSL https://ollama.com/install.sh | sh');
  if (api !== null) {
    const tags = await probe(`${LOCAL.ollama}/api/tags`, 5000);
    let names = [];
    try {
      names = (JSON.parse(tags ?? '{}').models ?? []).map((entry) => entry.name);
    } catch {
      names = [];
    }
    add(names.includes(model()), `Språkmodellen ${model()}`, names.includes(model()) ? 'nedladdad' : '', `Hämta den:  ollama pull ${model()}`);
  } else if (program) {
    add(false, 'Ollama är igång', '', IS_WINDOWS ? 'Starta Ollama (finns i Start-menyn).' : 'Starta Ollama:  sudo systemctl start ollama   eller   ollama serve', false);
  }

  add(fs.existsSync(path.join(ROOT, '.env')), 'Inställningsfilen .env', '', 'Skapas av:  shatterbox setup');
  add(fs.existsSync(venvPython()), 'Talsyntesen (Python-miljön .venv-omnivoice)', '',
    IS_WINDOWS ? 'Installera den:  shatterbox setup   (eller scripts\\install-tts.ps1)' : 'Installera den:  ./shatterbox setup   (eller scripts/install-tts.sh)');

  const audio = await detectAudio();
  add(Boolean(audio.player), 'Uppspelning av ljud i terminalen', audio.player?.label ?? '',
    IS_WINDOWS ? '' : 'Installera t.ex. alsa-utils:  sudo apt install alsa-utils', false);
  add(Boolean(audio.recorder), 'Mikrofon i terminalen', audio.recorder?.label ?? '',
    IS_WINDOWS ? 'Kräver ffmpeg. Den följer med talsyntesen, eller:  winget install Gyan.FFmpeg' : 'Installera t.ex. alsa-utils:  sudo apt install alsa-utils', false);
  return checks;
}

function printChecks(checks) {
  for (const check of checks) {
    const text = `${check.label}${check.detail ? c.dim(`  ${check.detail}`) : ''}`;
    if (check.ok) ok(text);
    else if (check.required) bad(text);
    else warn(text);
    if (!check.ok && check.fix) note(check.fix);
  }
}

export async function doctor() {
  heading('Det som behöver finnas');
  const checks = await runChecks();
  printChecks(checks);

  heading('Det som är igång just nu');
  const { services } = await serviceState();
  for (const [key, label] of SERVICES) (services[key] ? ok : warn)(`${label}${services[key] ? '' : c.dim('  inte igång')}`);

  const missing = checks.filter((check) => !check.ok && check.required);
  console.log('');
  const run = IS_WINDOWS ? 'shatterbox' : './shatterbox';
  if (missing.length) console.log(c.yellow(`${missing.length} saker saknas. Kör "${run} setup" för att åtgärda dem.`));
  else if (Object.values(services).every(Boolean)) console.log(c.green('Allt finns och är igång.'));
  else console.log(`Allt finns. Starta det som inte är igång med ${c.cyan(`${run} start`)}.`);
  return missing.length ? 1 : 0;
}

const script = (name, args = []) =>
  IS_WINDOWS
    ? runInherit('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', `${name}.ps1`), ...args])
    : runInherit('bash', [path.join(ROOT, 'scripts', `${name}.sh`), ...args]);

async function stepModel() {
  heading('3. Språkmodellen');
  const wanted = model();
  let tags = await probe(`${LOCAL.ollama}/api/tags`, 5000);
  if (tags === null) {
    warn('Ollama svarar inte.');
    note(IS_WINDOWS ? 'Starta Ollama från Start-menyn.' : 'Starta med:  sudo systemctl start ollama   eller   ollama serve');
    if (!(await confirm('Försök igen nu?'))) return;
    tags = await probe(`${LOCAL.ollama}/api/tags`, 5000);
    if (tags === null) return warn(`Hoppar över. Hämta modellen senare med:  ollama pull ${wanted}`);
  }
  const names = (JSON.parse(tags).models ?? []).map((entry) => entry.name);
  if (names.includes(wanted)) return ok(`${wanted} är redan nedladdad.`);
  console.log(`  Modellen ${c.bold(wanted)} behöver laddas ner (några GB).`);
  if (IS_WINDOWS) note('Ollama sparar modeller i din användarmapp. Flytta dem med miljövariabeln OLLAMA_MODELS om du vill ha dem på en annan disk.');
  if (!(await confirm('Hämta den nu?'))) return note(`Senare:  ollama pull ${wanted}`);
  const code = await runInherit((await ollamaProgram()) ?? 'ollama', ['pull', wanted]);
  if (code === 0) ok(`${wanted} är nedladdad.`);
  else bad('Nedladdningen misslyckades. Försök igen senare med:  ollama pull ' + wanted);
}

async function stepTts() {
  heading('4. Talsyntesen');
  if (fs.existsSync(venvPython())) return ok('Python-miljön finns redan (.venv-omnivoice).');
  const gpu = await detectGpu();
  console.log(`  Grafikkort: ${gpu.names.join(', ') || 'hittade inget'}`);
  console.log('  Talsyntesen (OmniVoice) körs helst på grafikkortet. Installationen laddar ner flera GB.');
  const backend = await choose('  Vilken variant ska installeras?', [
    { value: 'auto', label: 'Välj åt mig', hint: gpu.vendor === 'amd' ? 'AMD Radeon (ROCm)' : gpu.vendor === 'nvidia' ? 'NVIDIA (CUDA)' : 'processorn, eftersom inget grafikkort hittades' },
    { value: 'rocm', label: 'AMD Radeon (ROCm)' },
    { value: 'cuda', label: 'NVIDIA (CUDA)' },
    { value: 'cpu', label: 'Bara processorn', hint: 'fungerar överallt men är långsamt' },
    { value: 'skip', label: 'Hoppa över', hint: 'då kan karaktärerna inte prata' },
  ]);
  if (backend === 'skip') return note(IS_WINDOWS ? 'Senare:  scripts\\install-tts.ps1' : 'Senare:  scripts/install-tts.sh');
  const picked = backend === 'auto' ? (gpu.vendor === 'amd' ? 'rocm' : gpu.vendor === 'nvidia' ? 'cuda' : 'cpu') : backend;
  const code = await script('install-tts', IS_WINDOWS ? ['-Backend', picked] : [picked]);
  if (code === 0) ok('Talsyntesen är installerad.');
  else bad('Installationen misslyckades. Se utskriften ovan och kör om steget med "shatterbox setup".');
}

async function stepImages() {
  heading('5. Docker-avbilderna');
  console.log('  Tal-till-text, webbsök och Discord-botarna körs i Docker. Avbilderna behöver byggas en gång (några minuter).');
  const info = await capture('docker', ['info'], { timeout: 20_000 });
  if (info.code !== 0) return warn('Docker är inte igång, så det här steget hoppas över. Avbilderna byggs i stället vid första starten.');
  if (!(await confirm('Bygga dem nu?'))) return note('De byggs annars automatiskt vid första starten.');
  const pull = await runInherit('docker', ['compose', 'pull', 'searxng']);
  const build = await runInherit('docker', ['compose', 'build', 'stt', 'bot']);
  if (pull === 0 && build === 0) ok('Avbilderna är klara.');
  else bad('Något gick fel. Kör om senare med:  docker compose build');
}

/** Hela guiden. Går att köra flera gånger: det som redan finns hoppas över. */
export async function setup() {
  console.log(c.cyan(LOGO.join('\n')));
  console.log('\nInstallationsguiden går igenom allt som behövs. Det som redan finns hoppas över,');
  console.log('så det går bra att köra den igen om något avbryts.');

  heading('1. Program som måste finnas');
  let checks = await runChecks();
  const basics = checks.filter((check) => /^(Node|Docker|Ollama$)/.test(check.label) || check.label === 'Docker är igång');
  printChecks(basics);
  if (basics.some((check) => !check.ok)) {
    console.log('\n  Installera det som saknas enligt raderna ovan. Du kan göra det i ett annat fönster nu.');
    if (!(await confirm('  Fortsätta med resten ändå?'))) return 1;
  }

  heading('2. Inställningar');
  if (ensureEnvFile()) ok('Skapade .env från .env.example.');
  else ok('.env finns redan.');
  if (!IS_WINDOWS && process.platform === 'linux') {
    // I Linux når containrar inte tjänster som bara lyssnar på 127.0.0.1 på värddatorn, så
    // Discord-boten får dela värdens nätverk. Docker Compose läser COMPOSE_FILE från .env.
    const wanted = 'docker-compose.yml:docker-compose.linux.yml';
    if ((readEnv().COMPOSE_FILE ?? '') !== wanted) {
      updateEnv({ COMPOSE_FILE: wanted });
      ok('Lade till Linux-tillägget för Docker (COMPOSE_FILE i .env).');
    }
  }

  await stepModel();
  await stepTts();
  await stepImages();

  heading('6. Din första karaktär');
  const bots = listBots();
  const untouched = bots.length === 1 && !bots[0].hasToken && bots[0].mode === 'discord' && !bots[0].persona;
  if (!untouched) {
    ok(`Det finns redan ${bots.length === 1 ? 'en karaktär' : `${bots.length} karaktärer`}: ${bots.map((bot) => bot.name).join(', ')}.`);
  } else if (await confirm('  Vill du ställa in den nu?')) {
    await editBotWizard(bots[0], { first: true });
  } else {
    note('Senare:  shatterbox new');
  }

  if (IS_WINDOWS) {
    heading('7. Genväg på skrivbordet');
    const desktop = path.join(os.homedir(), 'Desktop', 'ShatterBox.lnk');
    if (fs.existsSync(desktop)) ok('Genvägen ShatterBox finns redan.');
    else if (await confirm('  Skapa genvägen ShatterBox, som öppnar kontrollpanelen?')) await script('install-app');
  }

  heading('Klart');
  checks = await runChecks();
  const missing = checks.filter((check) => !check.ok && check.required);
  if (missing.length) {
    console.log(c.yellow('  Det här saknas fortfarande:'));
    printChecks(missing);
  }
  const run = IS_WINDOWS ? 'shatterbox' : './shatterbox';
  console.log(`
  Så här går du vidare:
    ${c.cyan(`${run} start`)}        startar allt
    ${c.cyan(`${run} talk`)}         pratar med en karaktär här i terminalen
    ${c.cyan(`${run} new`)}          skapar en karaktär till
    ${c.cyan(`${run} ui`)}           öppnar kontrollpanelen i webbläsaren
    ${c.cyan(`${run} help`)}         visar alla kommandon
`);
  return missing.length ? 1 : 0;
}
