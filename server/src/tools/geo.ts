import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GazetteerEntry {
  name: string;
  lon: number;
  lat: number;
  type?: string;
  admin?: string;
  aliases?: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));

let cache: GazetteerEntry[] | null = null;

export function loadGazetteer(): GazetteerEntry[] {
  if (cache) return cache;
  const file = path.resolve(here, '../data/gazetteer.json');
  cache = JSON.parse(readFileSync(file, 'utf8')) as GazetteerEntry[];
  return cache;
}

export interface LocateResult {
  found: boolean;
  query: string;
  name?: string;
  longitude?: number;
  latitude?: number;
  type?: string;
  admin?: string;
  /** 多个候选时给出，便于模型消歧 */
  candidates?: { name: string; longitude: number; latitude: number }[];
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/[\s,，。、]/g, '');

/** 地名 → 经纬度。四级匹配：精确 → 别名 → 包含 → 被包含 */
export function geoLocate(query: string): LocateResult {
  const q = normalize(query || '');
  if (!q) return { found: false, query };

  const all = loadGazetteer();
  const hit = (e: GazetteerEntry) =>
    normalize(e.name) === q || (e.aliases ?? []).some((a) => normalize(a) === q);

  const exact = all.filter(hit);
  if (exact.length === 1) {
    return {
      found: true,
      query,
      name: exact[0].name,
      longitude: exact[0].lon,
      latitude: exact[0].lat,
      type: exact[0].type,
      admin: exact[0].admin,
    };
  }
  if (exact.length > 1) {
    return {
      found: true,
      query,
      name: exact[0].name,
      longitude: exact[0].lon,
      latitude: exact[0].lat,
      candidates: exact.map((e) => ({ name: e.name, longitude: e.lon, latitude: e.lat })),
    };
  }

  // 包含匹配：「北京市朝阳区」里含「北京」
  const contains = all.filter((e) => q.includes(normalize(e.name)) || normalize(e.name).includes(q));
  if (contains.length) {
    // 选最长的那个（更具体）
    const best = contains.sort((a, b) => normalize(b.name).length - normalize(a.name).length)[0];
    return {
      found: true,
      query,
      name: best.name,
      longitude: best.lon,
      latitude: best.lat,
      type: best.type,
      admin: best.admin,
    };
  }

  return { found: false, query };
}

/** 从用户消息里抽取已知地名（MOCK 模式与意图兜底用） */
export function extractPlace(text: string): GazetteerEntry | null {
  const all = loadGazetteer();
  const sorted = [...all].sort((a, b) => b.name.length - a.name.length);
  for (const e of sorted) {
    if (text.includes(e.name)) return e;
    for (const a of e.aliases ?? []) {
      if (text.includes(a)) return e;
    }
  }
  return null;
}
