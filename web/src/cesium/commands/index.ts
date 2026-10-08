import type { Viewer } from 'cesium';
import type { CommandResult } from '../../../../shared/protocol';

export interface GeocodeHit {
  name: string;
  longitude: number;
  latitude: number;
}

export interface CommandContext {
  viewer: Viewer;
  /** 地名 → 坐标（后端词典）。模型只给了 place 没给坐标时兜底用 */
  geocode: (query: string) => Promise<GeocodeHit | null>;
}

export type CommandExecutor = (
  args: Record<string, unknown>,
  ctx: CommandContext,
) => Promise<CommandResult>;

const registry = new Map<string, CommandExecutor>();

export function registerCommand(name: string, exec: CommandExecutor): void {
  registry.set(name, exec);
}

export function implementedCommands(): string[] {
  return [...registry.keys()];
}

export async function runCommand(
  name: string,
  args: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandResult> {
  const exec = registry.get(name);
  if (!exec) {
    return { ok: false, error: `前端尚未实现该命令：${name}` };
  }
  try {
    return await exec(args ?? {}, ctx);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------- 参数取值helper：模型给的参数可能是字符串/数字/null ---------- */

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

export function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** 统一的坐标解析：优先经纬度，其次地名（走后端词典） */
export async function resolvePosition(
  args: Record<string, unknown>,
  ctx: CommandContext,
): Promise<{ longitude: number; latitude: number; place?: string } | { error: string }> {
  const lon = num(args.longitude);
  const lat = num(args.latitude);
  if (lon !== undefined && lat !== undefined) {
    return { longitude: lon, latitude: lat, place: str(args.place) };
  }
  const place = str(args.place);
  if (place) {
    const hit = await ctx.geocode(place);
    if (hit) return { longitude: hit.longitude, latitude: hit.latitude, place: hit.name };
    return { error: `无法解析地名「${place}」的坐标，请让模型改用 geo_locate 或直接给出经纬度` };
  }
  return { error: '缺少位置信息：需要 place 或 longitude/latitude' };
}
