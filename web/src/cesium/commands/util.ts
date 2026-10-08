/**
 * 命令执行器公共层
 *
 * 移植自 cesium-mcp 的 utils.ts + LayerManager：
 * - parseColor / parseColorWithAlpha：统一颜色解析（模型常给 "#3B82F6"、red、rgba(...)）
 * - LayerRegistry：layerId → Cesium 对象引用的注册表。
 *   所有「加载类」工具返回 layerId，后续 remove/显隐/改样式全靠它定位真实对象。
 *   这是必须的：Cesium 的 dataSource / tileset / imageryLayer 分属不同容器，
 *   没有统一引用表就只能靠猜，删错或删不掉。
 */

import {
  Color,
  ConstantProperty,
  ColorMaterialProperty,
  ConstantPositionProperty,
  Cartesian3,
} from 'cesium';
import type { DataSource, Entity, ImageryLayer, Cesium3DTileset, Viewer } from 'cesium';

/* ------------------------------ 颜色 ------------------------------ */

export function parseColor(input: unknown, fallback = '#3B82F6'): Color {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw) {
    try {
      return Color.fromCssColorString(raw);
    } catch {
      /* 落到 fallback */
    }
  }
  return Color.fromCssColorString(fallback);
}

export function parseColorWithAlpha(input: unknown, alpha: number, fallback = '#3B82F6'): Color {
  return parseColor(input, fallback).withAlpha(clamp01(alpha));
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

/* --------------------------- 实体属性包装 --------------------------- */

/** Cesium 只认 Property，直接赋原始值不生效 —— 这是最常见的坑 */
export function constProp<T>(value: T) {
  return new ConstantProperty(value);
}

export function colorMaterial(color: Color) {
  return new ColorMaterialProperty(color);
}

export function constPosition(longitude: number, latitude: number, height = 0) {
  return new ConstantPositionProperty(Cartesian3.fromDegrees(longitude, latitude, height));
}

/* --------------------------- 图层注册表 --------------------------- */

export type LayerKind =
  | 'geojson'
  | 'kml'
  | 'czml'
  | '3dtiles'
  | 'imagery'
  | 'entity'
  | 'entities'
  | 'measure';

export interface CesiumRefs {
  dataSource?: DataSource;
  entities?: Entity[];
  tileset?: Cesium3DTileset;
  imageryLayer?: ImageryLayer;
}

export interface LayerInfo {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
}

let seq = 0;
function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${++seq}`;
}

class LayerRegistryImpl {
  private layers = new Map<string, LayerInfo>();
  private refs = new Map<string, CesiumRefs>();

  nextId(prefix: string): string {
    return makeId(prefix);
  }

  add(info: LayerInfo, refs: CesiumRefs): string {
    // 同 id 覆盖：先清掉旧引用，避免泄漏
    if (this.layers.has(info.id)) this.remove(info.id, true);
    this.layers.set(info.id, info);
    this.refs.set(info.id, refs);
    return info.id;
  }

  get(id: string): { info: LayerInfo; refs: CesiumRefs } | undefined {
    const info = this.layers.get(id);
    if (!info) return undefined;
    return { info, refs: this.refs.get(id) ?? {} };
  }

  list(): LayerInfo[] {
    return [...this.layers.values()];
  }

  /** 只看内部 ID 是否存在（不删 Cesium 对象，用于覆盖场景） */
  private drop(id: string): void {
    this.layers.delete(id);
    this.refs.delete(id);
  }

  setVisible(id: string, visible: boolean): boolean {
    const entry = this.get(id);
    if (!entry) return false;
    const r = entry.refs;
    if (r.dataSource) r.dataSource.show = visible;
    if (r.tileset) r.tileset.show = visible;
    if (r.imageryLayer) r.imageryLayer.show = visible;
    if (r.entities) for (const e of r.entities) e.show = visible;
    entry.info.visible = visible;
    return true;
  }

  remove(id: string, soft = false): boolean {
    const entry = this.get(id);
    if (!entry) return false;
    if (!soft) {
      const { viewer } = getActiveViewer();
      const r = entry.refs;
      if (viewer) {
        if (r.dataSource) viewer.dataSources.remove(r.dataSource, true);
        if (r.tileset) viewer.scene.primitives.remove(r.tileset);
        if (r.imageryLayer) viewer.imageryLayers.remove(r.imageryLayer);
        if (r.entities) for (const e of r.entities) viewer.entities.remove(e);
      }
    }
    this.drop(id);
    return true;
  }

  /** 清空所有受管图层 */
  clear(viewer: Viewer): { layers: number; entities: number } {
    const count = this.layers.size;
    for (const id of [...this.layers.keys()]) this.remove(id);
    const entities = viewer.entities.values.length;
    viewer.entities.removeAll();
    viewer.dataSources.removeAll(true);
    return { layers: count, entities };
  }
}

export const LayerRegistry = new LayerRegistryImpl();

/* ------------------------- 当前 Viewer 引用 ------------------------- */

let activeViewer: Viewer | null = null;

export function setActiveViewer(viewer: Viewer): void {
  activeViewer = viewer;
}

export function getActiveViewer(): { viewer: Viewer | null } {
  return { viewer: activeViewer };
}

/* ---------------------------- 坐标工具 ---------------------------- */

export interface LngLat {
  longitude: number;
  latitude: number;
  height?: number;
}

/** 把模型给的 [lon, lat] / [lon, lat, h] 数组解析成坐标点 */
export function parseCoordinateTuple(item: unknown): LngLat | null {
  if (!Array.isArray(item)) return null;
  const lon = Number(item[0]);
  const lat = Number(item[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const h = Number(item[2]);
  return { longitude: lon, latitude: lat, height: Number.isFinite(h) ? h : 0 };
}

export function parseCoordinates(input: unknown): LngLat[] {
  if (!Array.isArray(input)) return [];
  return input.map(parseCoordinateTuple).filter((v): v is LngLat => v !== null);
}

/** 解析 bbox：[west, south, east, north] */
export function parseBbox(input: unknown): [number, number, number, number] | null {
  if (!Array.isArray(input) || input.length < 4) return null;
  const [w, s, e, n] = input.map(Number);
  if (![w, s, e, n].every(Number.isFinite)) return null;
  return [w, s, e, n];
}

/** 简单质心（用于标签落点，球面精度足够） */
export function centroidOf(points: LngLat[]): LngLat | null {
  if (points.length === 0) return null;
  let lon = 0;
  let lat = 0;
  let h = 0;
  for (const p of points) {
    lon += p.longitude;
    lat += p.latitude;
    h += p.height ?? 0;
  }
  return { longitude: lon / points.length, latitude: lat / points.length, height: h / points.length };
}
