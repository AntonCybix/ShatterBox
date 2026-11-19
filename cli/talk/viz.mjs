// Ljudstaplarna i samtalsläget: ett speglat spektrum som rör sig med rösten, en reflektion
// under, toppmarkörer som faller och skärvor som flyger när boten avbryts.

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SHARDS = ['◆', '◇', '▪', '·', '✦', '*'];
const ASCII_SHARDS = ['*', '+', '.', 'x', 'o'];
const BAR = 2; // stapelns bredd i tecken
const GAP = 1;

const PALETTES = {
  idle: { low: [15, 118, 110], high: [45, 212, 191], peak: [94, 234, 212] },
  listening: { low: [21, 128, 61], high: [74, 222, 128], peak: [187, 247, 208] },
  hearing: { low: [22, 163, 74], high: [250, 204, 21], peak: [254, 240, 138] },
  transcribing: { low: [79, 70, 229], high: [129, 140, 248], peak: [199, 210, 254] },
  thinking: { low: [109, 40, 217], high: [232, 121, 249], peak: [245, 208, 254] },
  searching: { low: [180, 83, 9], high: [251, 191, 36], peak: [254, 243, 199] },
  speaking: { low: [8, 145, 178], high: [232, 121, 249], peak: [255, 255, 255] },
};

export function colorMode() {
  if (process.env.NO_COLOR) return 'none';
  const term = process.env.TERM ?? '';
  if (/truecolor|24bit/i.test(process.env.COLORTERM ?? '') || process.env.WT_SESSION || process.env.TERM_PROGRAM) return 'truecolor';
  if (process.platform === 'win32') return 'truecolor';
  if (term === 'dumb') return 'none';
  return '256';
}

/** Klarar terminalen blocktecknen? Linux-konsolen utan UTF-8 gör det inte. */
export function wantsAscii() {
  if (process.platform === 'win32') return false;
  const locale = `${process.env.LC_ALL ?? ''}${process.env.LC_CTYPE ?? ''}${process.env.LANG ?? ''}`;
  return !/utf-?8/i.test(locale);
}

export function paint(rgb, mode) {
  if (!rgb || mode === 'none') return '';
  const [r, g, b] = rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))));
  if (mode === 'truecolor') return `\x1b[38;2;${r};${g};${b}m`;
  const cube = (value) => Math.round((value / 255) * 5);
  return `\x1b[38;5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}m`;
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (rgb, factor) => [rgb[0] * factor, rgb[1] * factor, rgb[2] * factor];

export class Visualizer {
  constructor({ ascii = wantsAscii(), color = colorMode() } = {}) {
    this.ascii = ascii;
    this.color = color;
    this.state = 'idle';
    this.values = [];
    this.peaks = [];
    this.input = [];
    this.inputAt = 0;
    this.level = 0;
    this.particles = [];
    this.palette = PALETTES.idle;
    this.last = Date.now();
    this.pendingShatter = false;
  }

  setState(state) {
    this.state = PALETTES[state] ? state : 'idle';
  }

  /** Senaste spektrum (0-1 per band, låga först) från uppspelningen eller mikrofonen. */
  feed(bands) {
    this.input = bands;
    this.inputAt = Date.now();
  }

  /** Mikrofonens ljudstyrka (0-1), för den lilla rörelsen medan boten lyssnar. */
  feedLevel(level) {
    this.level = Math.max(level, this.level * 0.8);
  }

  /** Staplarna spricker i skärvor. Används när boten avbryts. */
  shatter() {
    this.pendingShatter = true;
  }

  #target(band, bands, now) {
    const t = now / 1000;
    const fresh = now - this.inputAt < 160;
    switch (this.state) {
      case 'speaking':
      case 'hearing':
        return fresh ? (this.input[Math.min(this.input.length - 1, Math.floor((band / bands) * this.input.length))] ?? 0) : 0;
      case 'thinking':
      case 'transcribing': {
        // En puls som vandrar från mitten och utåt.
        const position = ((t * (this.state === 'thinking' ? 0.9 : 1.6)) % 1) * (bands + 4) - 2;
        return 0.07 + 0.42 * Math.exp(-((band - position) ** 2) / 5) + 0.04 * Math.sin(t * 7 + band);
      }
      case 'searching': {
        // Två pulser som studsar fram och tillbaka, som ett ekolod.
        const swing = (Math.sin(t * 3.2) + 1) / 2;
        const a = swing * (bands - 1);
        const b = (1 - swing) * (bands - 1);
        return 0.06 + 0.4 * Math.exp(-((band - a) ** 2) / 3) + 0.25 * Math.exp(-((band - b) ** 2) / 3);
      }
      case 'listening':
        return 0.05 + 0.03 * Math.sin(t * 2.2 + band * 0.6) + Math.min(0.5, this.level * 6) * (1 - band / bands);
      default:
        return 0.045 + 0.03 * Math.sin(t * 1.4 + band * 0.45);
    }
  }

  /** Ritar en bildruta. Ger `height` rader som alla är exakt `width` tecken breda. */
  render(width, height, now = Date.now()) {
    const dt = Math.min(0.2, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    this.level *= 0.9;

    const usable = Math.min(width, 118);
    const count = Math.max(4, Math.floor((usable + GAP) / (BAR + GAP)));
    const bands = Math.ceil(count / 2);
    const left = Math.floor((width - (count * (BAR + GAP) - GAP)) / 2);
    const top = Math.max(2, Math.ceil(height * 0.68));
    const bottom = height - top;
    if (this.values.length !== bands) {
      this.values = new Array(bands).fill(0);
      this.peaks = new Array(bands).fill(0);
    }

    // Färgerna glider mjukt mellan lägena.
    const wanted = PALETTES[this.state];
    const blend = Math.min(1, dt * 6);
    this.palette = {
      low: mix(this.palette.low, wanted.low, blend),
      high: mix(this.palette.high, wanted.high, blend),
      peak: mix(this.palette.peak, wanted.peak, blend),
    };

    const columnOf = (bar) => left + bar * (BAR + GAP);
    const bandOf = (bar) => Math.min(bands - 1, Math.floor(Math.abs(bar - (count - 1) / 2)));

    if (this.pendingShatter) {
      this.pendingShatter = false;
      for (let bar = 0; bar < count; bar += 1) {
        const value = this.values[bandOf(bar)];
        if (value < 0.08) continue;
        for (let n = 0; n < 1 + Math.floor(value * 3); n += 1) {
          this.particles.push({
            x: columnOf(bar) + Math.random() * BAR,
            y: top - value * top * Math.random(),
            vx: (Math.random() - 0.5) * 16,
            vy: -3 - Math.random() * 9,
            life: 0.5 + Math.random() * 0.8,
          });
        }
      }
      this.values.fill(0);
      this.peaks.fill(0);
    }

    for (let band = 0; band < bands; band += 1) {
      const target = Math.max(0, Math.min(1, this.#target(band, bands, now)));
      const before = this.values[band];
      this.values[band] = target > before ? before + (target - before) * Math.min(1, dt * 24) : Math.max(target, before - dt * 2.2);
      this.peaks[band] = Math.max(this.values[band], this.peaks[band] - dt * 0.55);
      // En gnista ibland när en stapel slår i taket.
      if (this.state === 'speaking' && this.values[band] > 0.82 && before <= 0.82 && Math.random() < 0.5 && this.particles.length < 60) {
        const bar = Math.random() < 0.5 ? Math.floor((count - 1) / 2 - band) : Math.ceil((count - 1) / 2 + band);
        this.particles.push({ x: columnOf(Math.max(0, Math.min(count - 1, bar))) + 0.5, y: top * (1 - this.values[band]), vx: (Math.random() - 0.5) * 6, vy: -4 - Math.random() * 4, life: 0.4 + Math.random() * 0.4 });
      }
    }

    const cells = Array.from({ length: height }, () => new Array(width).fill(null));
    const put = (row, column, ch, rgb) => {
      if (row >= 0 && row < height && column >= 0 && column < width) cells[row][column] = { ch, rgb };
    };

    for (let bar = 0; bar < count; bar += 1) {
      const band = bandOf(bar);
      const value = this.values[band];
      const column = columnOf(bar);
      const units = Math.round(value * top * 8);
      const full = Math.floor(units / 8);
      const rest = units % 8;
      for (let level = 0; level <= full && level < top; level += 1) {
        const partial = level === full;
        if (partial && rest === 0) break;
        const rgb = mix(this.palette.low, this.palette.high, ((level + 1) / top) ** 0.8);
        const ch = partial
          ? this.ascii ? (rest < 3 ? '.' : rest < 6 ? ':' : '|') : BLOCKS[rest]
          : this.ascii ? '#' : '█';
        for (let x = 0; x < BAR; x += 1) put(top - 1 - level, column + x, ch, rgb);
      }
      // Toppmarkören hänger kvar en stund och faller sedan.
      const peakRow = top - 1 - Math.min(top - 1, Math.floor(this.peaks[band] * top));
      if (this.peaks[band] > value + 0.04 && !cells[peakRow][column]) {
        for (let x = 0; x < BAR; x += 1) put(peakRow, column + x, this.ascii ? '-' : '▂', this.palette.peak);
      }
      // Reflektionen under mittlinjen, svagare ju längre ner.
      const depth = Math.round(value * bottom * 2);
      for (let level = 0; level * 2 < depth && level < bottom; level += 1) {
        const half = depth - level * 2 === 1;
        const rgb = scale(this.palette.low, 0.75 - 0.5 * (level / Math.max(1, bottom)));
        const ch = this.ascii ? (half ? '.' : ':') : half ? '▀' : '█';
        for (let x = 0; x < BAR; x += 1) put(top + level, column + x, ch, rgb);
      }
    }

    const shards = this.ascii ? ASCII_SHARDS : SHARDS;
    this.particles = this.particles.filter((particle) => {
      particle.life -= dt;
      particle.vy += 26 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      if (particle.life <= 0 || particle.y >= height) return false;
      const ch = shards[Math.floor(Math.abs(particle.x * 7 + particle.y * 3)) % shards.length];
      put(Math.floor(particle.y), Math.floor(particle.x), ch, mix(this.palette.high, this.palette.peak, Math.min(1, particle.life)));
      return true;
    });

    return cells.map((row) => {
      let line = '';
      let current = '';
      for (const cell of row) {
        const code = cell ? paint(cell.rgb, this.color) : '';
        if (cell && code !== current) {
          line += code;
          current = code;
        }
        line += cell ? cell.ch : ' ';
      }
      return this.color === 'none' ? line : `${line}\x1b[0m`;
    });
  }
}
