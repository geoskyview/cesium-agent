/**
 * 图形实体：折线 / 多边形 / 模型 / 图标 / 实体增删改查
 *
 * 移植要点（cesium-mcp commands/entity.ts）：
 * - 更新实体属性必须用 ConstantProperty / ColorMaterialProperty 包装，
 *   直接赋原始值 Cesium 不认（唯一例外是 entity.show，直接给布尔）
 * - polygon 的 clampToGround 映射到 heightReference，且与 extrudedHeight 互斥
 * - add_model 用 HeadingPitchRoll.fromDegrees + Transforms.headingPitchRollQuaternion
 */

import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  ConstantPositionProperty,
  HeadingPitchRoll,
  HorizontalOrigin,
  LabelStyle,
  Math as CesiumMath,
  PolygonHierarchy,
  Transforms,
  VerticalOrigin,
  HeightReference,
  JulianDate,
} from 'cesium';
import type { Entity, Viewer } from 'cesium';
import type { CommandResult } from '../../../../shared/protocol';
import { bool, num, resolvePosition, str, type CommandExecutor } from './index';
import {
  LayerRegistry,
  centroidOf,
  constProp,
  colorMaterial,
  parseColor,
  parseColorWithAlpha,
  parseCoordinates,
} from './util';

function labelGraphics(text: string) {
  return {
    text,
    font: '600 13px "Microsoft YaHei", sans-serif',
    fillColor: Color.WHITE,
    outlineColor: Color.BLACK,
    outlineWidth: 3,
    style: LabelStyle.FILL_AND_OUTLINE,
    verticalOrigin: VerticalOrigin.BOTTOM,
    pixelOffset: new Cartesian2(0, -14),
    showBackground: true,
    backgroundColor: new Color(0.06, 0.09, 0.16, 0.72),
    backgroundPadding: new Cartesian2(6, 3),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}

/* ------------------------------ 折线 ------------------------------ */

export const addPolylineCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const points = parseCoordinates(args.coordinates);
  if (points.length < 2) return { ok: false, error: 'add_polyline 至少需要 2 个坐标点' };

  const positions = points.map((p) => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height ?? 0));
  const name = str(args.name);
  const entity = ctx.viewer.entities.add({
    name,
    polyline: {
      positions,
      width: num(args.width) ?? 3,
      material: colorMaterial(parseColor(str(args.color), '#3B82F6')),
      clampToGround: bool(args.clampToGround) ?? true,
    },
    label: name ? labelGraphics(name) : undefined,
    position: name ? positions[Math.floor(positions.length / 2)] : undefined,
  } as never);

  const id = LayerRegistry.add(
    { id: LayerRegistry.nextId('entity'), name: name ?? '折线', kind: 'entity', visible: true },
    { entities: [entity] },
  );
  return { ok: true, data: { action: 'add_polyline', entityId: entity.id, layerId: id, pointCount: points.length } };
};

/* ------------------------------ 多边形 ------------------------------ */

export const addPolygonCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const points = parseCoordinates(args.coordinates);
  if (points.length < 3) return { ok: false, error: 'add_polygon 至少需要 3 个坐标点' };

  const positions = points.map((p) => Cartesian3.fromDegrees(p.longitude, p.latitude, p.height ?? 0));
  const opacity = num(args.opacity) ?? 0.6;
  const fill = parseColorWithAlpha(str(args.color), opacity, '#3B82F6');
  const outline = parseColor(str(args.outlineColor), '#FFFFFF');
  const clampToGround = bool(args.clampToGround) ?? true;
  const extrudedHeight = num(args.extrudedHeight);
  const name = str(args.name);
  const center = centroidOf(points);

  const entity = ctx.viewer.entities.add({
    name,
    position: name && center ? Cartesian3.fromDegrees(center.longitude, center.latitude, center.height ?? 0) : undefined,
    polygon: {
      hierarchy: new PolygonHierarchy(positions),
      material: colorMaterial(fill),
      outline: true,
      outlineColor: outline,
      outlineWidth: 2,
      // 贴地与拉伸互斥：给了拉伸高度就不再贴地
      heightReference: clampToGround && extrudedHeight === undefined ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE,
      extrudedHeight,
    },
    label: name ? labelGraphics(name) : undefined,
  } as never);

  const id = LayerRegistry.add(
    { id: LayerRegistry.nextId('entity'), name: name ?? '多边形', kind: 'entity', visible: true },
    { entities: [entity] },
  );
  return { ok: true, data: { action: 'add_polygon', entityId: entity.id, layerId: id, pointCount: points.length } };
};

/* ------------------------------- 模型 ------------------------------- */

export const addModelCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const url = str(args.url);
  if (!url) return { ok: false, error: 'add_model 需要 url' };

  const pos = await resolvePosition(args, ctx);
  if ('error' in pos) return { ok: false, error: pos.error };

  const height = num(args.height) ?? 0;
  const position = Cartesian3.fromDegrees(pos.longitude, pos.latitude, height);
  const hpr = HeadingPitchRoll.fromDegrees(num(args.heading) ?? 0, num(args.pitch) ?? 0, num(args.roll) ?? 0);
  const orientation = Transforms.headingPitchRollQuaternion(position, hpr);

  const entity = ctx.viewer.entities.add({
    name: str(args.name),
    position,
    orientation: orientation as never,
    model: { uri: url, scale: num(args.scale) ?? 1 },
  } as never);

  const id = LayerRegistry.add(
    { id: LayerRegistry.nextId('entity'), name: str(args.name) ?? '模型', kind: 'entity', visible: true },
    { entities: [entity] },
  );
  return {
    ok: true,
    data: { action: 'add_model', entityId: entity.id, layerId: id, longitude: pos.longitude, latitude: pos.latitude },
  };
};

/* ------------------------------ 图标 ------------------------------ */

export const addBillboardCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const image = str(args.image);
  if (!image) return { ok: false, error: 'add_billboard 需要 image' };

  const pos = await resolvePosition(args, ctx);
  if ('error' in pos) return { ok: false, error: pos.error };

  const entity = ctx.viewer.entities.add({
    name: str(args.name),
    position: Cartesian3.fromDegrees(pos.longitude, pos.latitude, num(args.height) ?? 0),
    billboard: {
      image,
      scale: num(args.scale) ?? 1,
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  } as never);

  const id = LayerRegistry.add(
    { id: LayerRegistry.nextId('entity'), name: str(args.name) ?? '图标', kind: 'entity', visible: true },
    { entities: [entity] },
  );
  return { ok: true, data: { action: 'add_billboard', entityId: entity.id, layerId: id } };
};

/* ---------------------------- 更新 / 删除 ---------------------------- */

export const updateEntityCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const entityId = str(args.entityId);
  if (!entityId) return { ok: false, error: 'update_entity 需要 entityId' };

  const entity = findEntity(ctx.viewer, entityId);
  if (!entity) return { ok: false, error: `找不到实体 ${entityId}` };

  const lon = num(args.longitude);
  const lat = num(args.latitude);
  if (lon !== undefined && lat !== undefined) {
    entity.position = new ConstantPositionProperty(Cartesian3.fromDegrees(lon, lat, num(args.height) ?? 0)) as never;
  }

  const name = str(args.name);
  if (name) {
    entity.name = name;
    if (entity.label) entity.label.text = constProp(name) as never;
  }

  const color = str(args.color);
  if (color) {
    const c = parseColor(color, '#3B82F6');
    const anyEntity = entity as unknown as Record<string, { color?: unknown; material?: unknown }>;
    if (anyEntity.point) anyEntity.point.color = constProp(c);
    if (anyEntity.polyline) anyEntity.polyline.material = new ColorMaterialProperty(c);
    if (anyEntity.polygon) (anyEntity.polygon as { material?: unknown }).material = new ColorMaterialProperty(c);
  }

  const scale = num(args.scale);
  if (scale !== undefined) {
    const anyEntity = entity as unknown as Record<string, { scale?: unknown }>;
    if (anyEntity.model) anyEntity.model.scale = constProp(scale);
    if (anyEntity.billboard) anyEntity.billboard.scale = constProp(scale);
  }

  const show = bool(args.show);
  if (show !== undefined) entity.show = show; // 唯一不需要 Property 包装的字段

  return { ok: true, data: { action: 'update_entity', entityId } };
};

export const removeEntityCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const entityId = str(args.entityId);
  if (!entityId) return { ok: false, error: 'remove_entity 需要 entityId' };
  const entity = findEntity(ctx.viewer, entityId);
  if (!entity) return { ok: false, error: `找不到实体 ${entityId}` };
  ctx.viewer.entities.remove(entity);
  return { ok: true, data: { action: 'remove_entity', entityId } };
};

/* ------------------------------ 查询 ------------------------------ */

function detectType(e: Entity): string {
  const a = e as unknown as Record<string, unknown>;
  if (a.polyline) return 'polyline';
  if (a.polygon) return 'polygon';
  if (a.model) return 'model';
  if (a.billboard) return 'billboard';
  if (a.point) return 'marker';
  if (a.label) return 'label';
  if (a.corridor) return 'corridor';
  if (a.wall) return 'wall';
  if (a.rectangle) return 'rectangle';
  if (a.ellipse) return 'ellipse';
  if (a.box) return 'box';
  return 'unknown';
}

function entityPosition(e: Entity): { longitude: number; latitude: number } | null {
  try {
    const p = e.position?.getValue(JulianDate.now());
    if (!p) return null;
    const carto = Cartographic.fromCartesian(p as Cartesian3);
    if (!carto) return null;
    // Cesium 内部用弧度，对外统一用度
    return {
      longitude: Number(CesiumMath.toDegrees(carto.longitude).toFixed(6)),
      latitude: Number(CesiumMath.toDegrees(carto.latitude).toFixed(6)),
    };
  } catch {
    return null;
  }
}

function findEntity(viewer: Viewer, id: string): Entity | null {
  const direct = viewer.entities.getById(id);
  if (direct) return direct;
  for (let i = 0; i < viewer.dataSources.length; i++) {
    const ds = viewer.dataSources.get(i);
    const hit = ds.entities.getById(id);
    if (hit) return hit;
  }
  return null;
}

function allEntities(viewer: Viewer): Entity[] {
  const out: Entity[] = [...viewer.entities.values];
  for (let i = 0; i < viewer.dataSources.length; i++) {
    out.push(...viewer.dataSources.get(i).entities.values);
  }
  return out;
}

export const queryEntitiesCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const nameFilter = str(args.name)?.toLowerCase();
  const typeFilter = str(args.type)?.toLowerCase();
  const bboxRaw = args.bbox;
  let bbox: number[] | null = null;
  if (Array.isArray(bboxRaw) && bboxRaw.length >= 4) {
    const nums = bboxRaw.map(Number);
    bbox = nums.every(Number.isFinite) ? nums : null;
  }

  const results = allEntities(ctx.viewer)
    .filter((e) => {
      if (nameFilter) {
        const name = (e.name ?? '').toLowerCase();
        if (!name.includes(nameFilter)) return false;
      }
      if (typeFilter && detectType(e) !== typeFilter) return false;
      if (bbox) {
        const p = entityPosition(e);
        if (!p) return false;
        if (p.longitude < bbox[0] || p.longitude > bbox[2] || p.latitude < bbox[1] || p.latitude > bbox[3]) return false;
      }
      return true;
    })
    .slice(0, 200)
    .map((e) => ({ entityId: e.id, name: e.name ?? '', type: detectType(e), position: entityPosition(e) }));

  return { ok: true, data: { action: 'query_entities', count: results.length, entities: results } };
};
