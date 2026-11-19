import { config } from './config.js';
import { strings } from './i18n.js';

const clip = (text, max) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * Söker via den lokala SearXNG-instansen och returnerar en kompakt text
 * som språkmodellen kan läsa.
 */
export async function webSearch(query, { signal, maxResults = 5, language = 'sv' } = {}) {
  const t = strings(language);
  const url = new URL('/search', config.searxngUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', t.searchLocale);

  const signals = [AbortSignal.timeout(12_000)];
  if (signal) signals.push(signal);
  const res = await fetch(url, { signal: AbortSignal.any(signals) });
  if (!res.ok) throw new Error(`SearXNG svarade ${res.status}`);
  const data = await res.json();

  const lines = [];
  for (const answer of data.answers ?? []) {
    const text = typeof answer === 'string' ? answer : answer?.answer;
    if (text) lines.push(`${t.search.direct}: ${clip(text, 400)}`);
  }
  for (const box of (data.infoboxes ?? []).slice(0, 1)) {
    if (box?.content) lines.push(`${t.search.infobox} ${box.infobox ?? query}: ${clip(box.content, 500)}`);
  }
  (data.results ?? []).slice(0, maxResults).forEach((r, i) => {
    const date = r.publishedDate ? ` [${String(r.publishedDate).slice(0, 10)}]` : '';
    lines.push(`${i + 1}. ${clip(r.title, 120)}${date} (${host(r.url)}): ${clip(r.content, 320)}`);
  });

  return lines.length ? lines.join('\n') : t.search.none;
}
