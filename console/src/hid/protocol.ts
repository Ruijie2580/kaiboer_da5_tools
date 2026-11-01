// 开博尔 DA5 机身 DSP。WebHID 载荷不含报告号 0x4B。
// 已在这块声卡上核对过的字段：载荷[4] 段号，[27..28] 频率，
// [29..30] Q×256，[31..32] 增益×256，[33] 滤波器类型。
// 播放采样率、DSD、快/慢滚降、3.5/4.4 切换和固件刷写都不在这套报告里。

export const VENDOR_ID = 0x3302;
export const PRODUCT_ID = 0x4351;
export const REPORT_ID = 0x4b;
export const BANDS = 10;
export const SAMPLE_RATE = 96000;

export const READ = 0x80;
export const WRITE = 0x01;
export const CMD_FLASH = 0x01;
export const CMD_GAIN = 0x03;
export const CMD_PEQ = 0x09;
export const CMD_TEMP = 0x0a;
export const CMD_VERSION = 0x0c;

export const FILTERS = ["PK", "LSQ", "HSQ", "LP", "HP"] as const;
export type FilterType = (typeof FILTERS)[number];

export const TYPE_TO_BYTE: Record<FilterType, number> = {
  LSQ: 1,
  PK: 2,
  HSQ: 3,
  LP: 4,
  HP: 5,
};
export const BYTE_TO_TYPE: Record<number, FilterType> = {
  1: "LSQ",
  2: "PK",
  3: "HSQ",
  4: "LP",
  5: "HP",
};
export const TYPE_LABEL: Record<FilterType, string> = {
  PK: "峰值",
  LSQ: "低架",
  HSQ: "高架",
  LP: "低通",
  HP: "高通",
};

export const DEFAULT_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const DEFAULT_Q = 0.707;

export const PRESETS: Record<string, number[]> = {
  直通: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  低音增强: [5, 4, 3, 1.5, 0, 0, 0, 0, 0, 0],
  人声: [-1, -0.5, 0, 1.5, 2.5, 3, 2, 1, 0, -1],
  明亮: [0, 0, 0, 0, 0, 0.5, 1.5, 2.5, 2, 1],
  夜间: [1, 0.5, 0, 0, -0.5, -1, -2, -3.5, -5, -6],
};

export interface Band {
  type: FilterType;
  freq: number;
  gain: number;
  q: number;
}

export function clampBand(band: Band): Band {
  const type = TYPE_TO_BYTE[band.type] ? band.type : "PK";
  return {
    type,
    freq: Math.min(20000, Math.max(20, Math.round(Number(band.freq) || 1000))),
    gain: Math.min(12, Math.max(-12, Math.round(Number(band.gain) * 10) / 10 || 0)),
    q: Math.min(10, Math.max(0.1, Number(band.q) || DEFAULT_Q)),
  };
}

export function flatBands(): Band[] {
  return DEFAULT_FREQS.map((freq) => ({ type: "PK", freq, gain: 0, q: DEFAULT_Q }));
}

export function clampPreamp(value: number): number {
  return Math.max(-12, Math.min(0, Math.round(value)));
}

export function snapshot(preamp: number, bands: Band[]): string {
  return JSON.stringify({ preamp, bands: bands.map(clampBand) });
}

export function design(kind: FilterType, freq: number, gainDb: number, q: number) {
  const amp = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * freq) / SAMPLE_RATE;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  let alpha: number;
  if (kind === "LSQ" || kind === "HSQ") {
    const shelf = Math.max(0, (amp + 1 / amp) * (1 / q - 1) + 2);
    alpha = (sinW / 2) * Math.sqrt(shelf);
  } else {
    alpha = sinW / (2 * q);
  }
  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  if (kind === "PK") {
    b0 = 1 + alpha * amp;
    b1 = -2 * cosW;
    b2 = 1 - alpha * amp;
    a0 = 1 + alpha / amp;
    a1 = -2 * cosW;
    a2 = 1 - alpha / amp;
  } else if (kind === "LSQ") {
    const sqrtA = Math.sqrt(amp);
    b0 = amp * ((amp + 1) - (amp - 1) * cosW + 2 * sqrtA * alpha);
    b1 = 2 * amp * ((amp - 1) - (amp + 1) * cosW);
    b2 = amp * ((amp + 1) - (amp - 1) * cosW - 2 * sqrtA * alpha);
    a0 = (amp + 1) + (amp - 1) * cosW + 2 * sqrtA * alpha;
    a1 = -2 * ((amp - 1) + (amp + 1) * cosW);
    a2 = (amp + 1) + (amp - 1) * cosW - 2 * sqrtA * alpha;
  } else if (kind === "HSQ") {
    const sqrtA = Math.sqrt(amp);
    b0 = amp * ((amp + 1) + (amp - 1) * cosW + 2 * sqrtA * alpha);
    b1 = -2 * amp * ((amp - 1) + (amp + 1) * cosW);
    b2 = amp * ((amp + 1) + (amp - 1) * cosW - 2 * sqrtA * alpha);
    a0 = (amp + 1) - (amp - 1) * cosW + 2 * sqrtA * alpha;
    a1 = 2 * ((amp - 1) - (amp + 1) * cosW);
    a2 = (amp + 1) - (amp - 1) * cosW - 2 * sqrtA * alpha;
  } else if (kind === "LP") {
    b0 = (1 - cosW) / 2;
    b1 = 1 - cosW;
    b2 = (1 - cosW) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW;
    a2 = 1 - alpha;
  } else {
    b0 = (1 + cosW) / 2;
    b1 = -(1 + cosW);
    b2 = (1 + cosW) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW;
    a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function responseAt(freq: number, band: Band): number {
  const [b0, b1, b2, a1, a2] = design(band.type, band.freq, band.gain, band.q);
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  const z1 = { re: Math.cos(w), im: -Math.sin(w) };
  const z2 = { re: z1.re * z1.re - z1.im * z1.im, im: 2 * z1.re * z1.im };
  const num = { re: b0 + b1 * z1.re + b2 * z2.re, im: b1 * z1.im + b2 * z2.im };
  const den = { re: 1 + a1 * z1.re + a2 * z2.re, im: a1 * z1.im + a2 * z2.im };
  const denMag = den.re * den.re + den.im * den.im || 1e-12;
  const re = (num.re * den.re + num.im * den.im) / denMag;
  const im = (num.im * den.re - num.re * den.im) / denMag;
  const mag = Math.hypot(re, im);
  return mag > 1e-9 ? 20 * Math.log10(mag) : -80;
}

export function curveOf(bands: Band[], preamp: number, points = 180): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points; i += 1) {
    const freq = 20 * (20000 / 20) ** (i / (points - 1));
    let total = preamp;
    for (const band of bands) {
      if ((band.type === "PK" || band.type === "LSQ" || band.type === "HSQ") && Math.abs(band.gain) < 0.05) {
        continue;
      }
      total += responseAt(freq, band);
    }
    out.push([freq, total]);
  }
  return out;
}

function leBytes(value: number, length: number): number[] {
  const out: number[] = [];
  let rest = value >>> 0;
  for (let i = 0; i < length; i += 1) {
    out.push(rest & 0xff);
    rest >>>= 8;
  }
  return out;
}

export function filterPacket(index: number, band: Band): number[] {
  const item = clampBand(band);
  const [b0, b1, b2, a1, a2] = design(item.type, item.freq, item.gain, item.q);
  const words = [b0, b1, b2, -a1, -a2].map((value) => (Math.round(value * 2 ** 30) >>> 0));
  const gainQ8 = Math.round(item.gain * 256) & 0xffff;
  return [
    WRITE, CMD_PEQ, 0x18, 0x00, index & 0xff, 0x00, 0x00,
    ...words.flatMap((word) => leBytes(word, 4)),
    ...leBytes(item.freq, 2),
    ...leBytes(Math.round(item.q * 256), 2),
    ...leBytes(gainQ8, 2),
    TYPE_TO_BYTE[item.type], 0x00, 0x00, 0x00,
  ];
}

export function parseBand(payload: Uint8Array): Band {
  if (payload.length < 34) throw new Error("声卡回了一段不完整的数据");
  const freq = payload[27] | (payload[28] << 8);
  const q = (payload[29] | (payload[30] << 8)) / 256;
  let gainRaw = payload[31] | (payload[32] << 8);
  if (gainRaw >= 0x8000) gainRaw -= 0x10000;
  return clampBand({
    type: BYTE_TO_TYPE[payload[33]] || "PK",
    freq,
    gain: gainRaw / 256,
    q,
  });
}

export function formatHz(freq: number): string {
  if (freq >= 1000) {
    const kilo = freq / 1000;
    return Number.isInteger(kilo) ? `${kilo}k` : `${kilo.toFixed(1)}k`;
  }
  return String(freq);
}

export function saveProfileText(preamp: number, bands: Band[]): string {
  const lines = [`Preamp: ${preamp.toFixed(1)} dB`];
  bands.forEach((band, index) => {
    const item = clampBand(band);
    lines.push(
      `Filter ${index + 1}: ON ${item.type} Fc ${item.freq} Hz Gain ${item.gain.toFixed(1)} dB Q ${item.q.toFixed(3)}`,
    );
  });
  return `${lines.join("\n")}\n`;
}

export function loadProfileText(text: string): { preamp: number; bands: Band[] } {
  let preamp = 0;
  const bands: Band[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replaceAll(",", ".");
    if (!line || line.startsWith("#")) continue;
    if (line.toLowerCase().startsWith("preamp")) {
      preamp = Number(line.split(/\s+/)[1]) || 0;
      continue;
    }
    if (!line.toLowerCase().startsWith("filter")) continue;
    const parts = line.split(/\s+/);
    let kind = parts[3].toUpperCase();
    if (kind === "LS" || kind === "LSC") kind = "LSQ";
    if (kind === "HS" || kind === "HSC") kind = "HSQ";
    const enabled = parts[2].toUpperCase() === "ON";
    const type = (FILTERS as readonly string[]).includes(kind) ? (kind as FilterType) : "PK";
    bands.push(clampBand({
      type,
      freq: Number(parts[5]),
      gain: enabled ? Number(parts[8]) : 0,
      q: parts.length > 11 ? Number(parts[11]) : DEFAULT_Q,
    }));
  }
  if (!bands.length) throw new Error("这个文件里没有滤波器");
  while (bands.length < BANDS) bands.push({ type: "PK", freq: 1000, gain: 0, q: DEFAULT_Q });
  return { preamp: clampPreamp(preamp), bands: bands.slice(0, BANDS) };
}
