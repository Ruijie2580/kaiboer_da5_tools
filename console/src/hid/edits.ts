import { type Band, clampBand, clampPreamp, flatBands } from "./protocol";

export const PRESET_STORAGE_KEY = "da5-user-presets";
export const MAX_USER_PRESETS = 16;

export interface StoredPreset {
  name: string;
  preamp: number;
  bands: Band[];
}

export function presetName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 16);
}

export function qFromDrag(startQ: number, deltaY: number): number {
  const next = startQ * 2 ** (deltaY / 72);
  const rounded = Math.round(next * 100) / 100;
  return Math.min(10, Math.max(0.1, rounded));
}

export function shouldAsk(dirty: boolean, pageSnap: string, deviceSnap: string): boolean {
  return dirty && pageSnap !== deviceSnap;
}

function asBand(value: unknown, fallback: Band): Band {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Partial<Band>;
  return clampBand({
    type: record.type ?? fallback.type,
    freq: Number(record.freq),
    gain: Number(record.gain),
    q: Number(record.q),
  });
}

export function readPresets(raw: string | null): StoredPreset[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const fallback = flatBands();
  const presets: StoredPreset[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; preamp?: unknown; bands?: unknown };
    const name = presetName(typeof record.name === "string" ? record.name : "");
    const storedBands = record.bands;
    if (!name || !Array.isArray(storedBands)) continue;
    const bands = fallback.map((band, index) => asBand(storedBands[index], band));
    presets.push({
      name,
      preamp: clampPreamp(Number(record.preamp) || 0),
      bands,
    });
    if (presets.length >= MAX_USER_PRESETS) break;
  }
  return presets;
}

export function upsertPreset(list: StoredPreset[], preset: StoredPreset): StoredPreset[] | "full" {
  const name = presetName(preset.name);
  if (!name) return list;
  const next = { ...preset, name, preamp: clampPreamp(preset.preamp), bands: preset.bands.map(clampBand) };
  const index = list.findIndex((item) => item.name === name);
  if (index >= 0) {
    const copy = list.slice();
    copy[index] = next;
    return copy;
  }
  if (list.length >= MAX_USER_PRESETS) return "full";
  return [...list, next];
}

export function removePreset(list: StoredPreset[], name: string): StoredPreset[] {
  return list.filter((item) => item.name !== name);
}
