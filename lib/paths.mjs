// Var allt ligger. Projektmappen är mappen ovanför lib/, oavsett varifrån programmet startas.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IS_WINDOWS = process.platform === 'win32';

export const ENV_FILE = path.join(ROOT, '.env');
export const ENV_EXAMPLE = path.join(ROOT, '.env.example');
export const PERSONA_DIR = path.join(ROOT, 'personas');
export const VOICE_DIR = path.join(ROOT, 'voice');
export const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');
export const DATA_DIR = path.join(ROOT, 'data');
export const LOG_DIR = path.join(ROOT, 'logs');
export const VENV_DIR = path.join(ROOT, '.venv-omnivoice');

/** Adresserna som tjänsterna har sedda från den här datorn (inte inifrån Docker). */
export const LOCAL = {
  ollama: 'http://127.0.0.1:11434',
  stt: 'http://127.0.0.1:8001',
  ttsCpu: 'http://127.0.0.1:8002',
  tts: 'http://127.0.0.1:8003',
  botStatus: 'http://127.0.0.1:8004',
  search: 'http://127.0.0.1:8888',
  panel: 'http://127.0.0.1:8090',
};
