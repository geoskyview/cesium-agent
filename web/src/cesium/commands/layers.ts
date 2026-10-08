/**
 * 数据加载 + 图层管理 + 底图切换
 *
 * 实现要点移植自 cesium-mcp（commands/layer.ts、basemap-presets.ts），
 * 保留了几个关键坑的处理：
 * - GeoJsonDataSource 的 fill 透明度要乘系数，否则面要素会盖住底图
 * - KmlDataSource 必须传 camera + canvas，否则 KML 内的相机/屏幕叠加不生效
 * - CZML 没有原生 clampToGround，只能加载后逐个实体补 heightReference
 * - 3D Tiles 的 heightOffset 用 fromRadians（boundingSphere 中心是弧度制笛卡尔）
 * - 影像图层透明度在 ImageryLayer.alpha 上，不在 Provider 上
 */

import {
  ArcGisMapServerImageryProvider,
  ArcGISTiledElevationTerrainProvider,
  Cesium3DTileset,
  CzmlDataSource,
  EllipsoidTerrainProvider,
  GeoJsonDataSource,
  HeightReference,
  KmlDataSource,
  CesiumTerrainProvider,
  UrlTemplateImageryProvider,
  WebMapServiceImageryProvider,
  WebMapTileServiceImageryProvider,
  Cartesian3,
  Cartographic,
  Matrix4,
  Color,
} from 'cesium';
import type { ImageryLayer, Viewer } from 'cesium';
import type { CommandResult } from '../../../../shared/protocol';
import { bool, num, str, type CommandContext, type CommandExecutor } from './index';
import {
  LayerRegistry,
  parseColorWithAlpha,
  parseColor,
  type CesiumRefs,
} from './util';

const FILL_ALPHA_RATIO = 0.4; // 面填充相对描边透明度的折减，避免盖住底图

/* ============================ 数据加载 ============================ */

export const loadGeoJsonCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const url = str(args.url);
  const data = args.data;
  if (!url && !data) return { ok: false, error: 'load_geojson 需要 url 或 data 之一' };

  const color = parseColorWithAlpha(str(args.color), 1, '#3B82F6');
  const opacity = num(args.opacity) ?? 0.6;
  const strokeWidth = num(args.strokeWidth) ?? 3;
  const clampToGround = bool(args.clampToGround) ?? true;
  const name = str(args.name) ?? 'GeoJSON 图层';

  try {
    const ds = await GeoJsonDataSource.load((url ?? data) as never, {
      stroke: color,
      fill: color.withAlpha(opacity * FILL_ALPHA_RATIO),
      strokeWidth,
      markerSize: 1,
      markerColor: color,
      clampToGround,
    } as never);

    const entities = ds.entities.values;
    const labelField = str(args.labelField);
    if (labelField) {
      for (const e of entities) {
        const props = (e as unknown as { properties?: { getValue?: (t: unknown) => Record<string, unknown> } }).properties;
        const bag = props?.getValue?.(undefined as never) as Record<string, unknown> | undefined;
        const text = bag?.[labelField];
        if (text !== undefined && text !== null) {
          (e as unknown as { label: unknown }).label = {
            text: String(text),
            font: '600 13px "Microsoft YaHei", sans-serif',
            fillColor: Color.WHITE,
            outlineColor: Color.BLACK,
            outlineWidth: 3,
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          };
        }
      }
    }

    ds.name = name;
    ctx.viewer.dataSources.add(ds);
    const id = LayerRegistry.add(
      { id: LayerRegistry.nextId('geojson'), name, kind: 'geojson', visible: true },
      { dataSource: ds },
    );

    if (bool(args.flyTo) !== false) {
      await ctx.viewer.flyTo(ds, { duration: 1.5 }).catch(() => undefined);
    }

    return {
      ok: true,
      data: { action: 'load_geojson', layerId: id, name, featureCount: entities.length },
    };
  } catch (err) {
    return { ok: false, error: `GeoJSON 加载失败：${err instanceof Error ? err.message : String(err)}` };
  }
};

export const loadKmlCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const url = str(args.url);
  const data = str(args.data);
  if (!url && !data) return { ok: false, error: 'load_kml 需要 url 或 data 之一（KMZ 只支持 url）' };

  const name = str(args.name) ?? 'KML 图层';
  try {
    // KmlDataSource 需要 camera/canvas，否则 KML 内的视角与屏幕叠加元素失效
    const options: Record<string, unknown> = {
      camera: ctx.viewer.scene.camera,
      canvas: ctx.viewer.scene.canvas,
    };
    if (bool(args.clampToGround)) options.clampToGround = true;

    const source = url ?? new Blob([data as string], { type: 'application/xml' });
    const ds = await KmlDataSource.load(source as never, options as never);
    ds.name = name;
    ctx.viewer.dataSources.add(ds);
    const id = LayerRegistry.add(
      { id: LayerRegistry.nextId('kml'), name, kind: 'kml', visible: true },
      { dataSource: ds },
    );
    if (bool(args.flyTo) !== false) {
      await ctx.viewer.flyTo(ds, { duration: 1.5 }).catch(() => undefined);
    }
    return { ok: true, data: { action: 'load_kml', layerId: id, name, featureCount: ds.entities.values.length } };
  } catch (err) {
    return { ok: false, error: `KML 加载失败：${err instanceof Error ? err.message : String(err)}` };
  }
};

export const loadCzmlCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const url = str(args.url);
  const data = args.data;
  if (!url && !data) return { ok: false, error: 'load_czml 需要 url 或 data 之一' };

  const name = str(args.name) ?? 'CZML 图层';
  try {
    const ds = await CzmlDataSource.load((url ?? data) as never);
    // CZML 没有原生贴地选项，只能加载后逐个补
    if (bool(args.clampToGround)) {
      for (const e of ds.entities.values) {
        const anyEntity = e as unknown as Record<string, { heightReference?: unknown }>;
        for (const key of ['billboard', 'point', 'label', 'model'] as const) {
          const g = anyEntity[key];
          if (g) g.heightReference = HeightReference.CLAMP_TO_GROUND;
        }
      }
    }
    // CzmlDataSource.name 是只读 getter（名字来自 document packet），赋值会抛错
    try {
      ds.name = name;
    } catch {
      /* 保留 CZML 自带名称 */
    }
    ctx.viewer.dataSources.add(ds);
    const id = LayerRegistry.add(
      { id: LayerRegistry.nextId('czml'), name, kind: 'czml', visible: true },
      { dataSource: ds },
    );
    if (bool(args.flyTo) !== false) {
      await ctx.viewer.flyTo(ds, { duration: 1.5 }).catch(() => undefined);
    }
    return { ok: true, data: { action: 'load_czml', layerId: id, name, featureCount: ds.entities.values.length } };
  } catch (err) {
    return { ok: false, error: `CZML 加载失败：${err instanceof Error ? err.message : String(err)}` };
  }
};

export const load3dTilesCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const url = str(args.url);
  const ionAssetId = num(args.ionAssetId);
  if (!url && !ionAssetId) return { ok: false, error: 'load_3dtiles 需要 url 或 ionAssetId' };

  const name = str(args.name) ?? '3D Tiles';
  const msse = num(args.maximumScreenSpaceError) ?? 16;
  try {
    const tileset = ionAssetId
      ? await Cesium3DTileset.fromIonAssetId(ionAssetId, { maximumScreenSpaceError: msse } as never)
      : await Cesium3DTileset.fromUrl(url as string, { maximumScreenSpaceError: msse } as never);

    const heightOffset = num(args.heightOffset) ?? 0;
    if (heightOffset !== 0) {
      const carto = Cartographic.fromCartesian(tileset.boundingSphere.center);
      const surface = Cartesian3.fromRadians(carto.longitude, carto.latitude, 0);
      const lifted = Cartesian3.fromRadians(carto.longitude, carto.latitude, heightOffset);
      const delta = Cartesian3.subtract(lifted, surface, new Cartesian3());
      tileset.modelMatrix = Matrix4.fromTranslation(delta);
    }

    ctx.viewer.scene.primitives.add(tileset);
    const id = LayerRegistry.add(
      { id: LayerRegistry.nextId('3dtiles'), name, kind: '3dtiles', visible: true },
      { tileset },
    );
    if (bool(args.flyTo) !== false) {
      await ctx.viewer.flyTo(tileset, { duration: 1.5 }).catch(() => undefined);
    }
    return { ok: true, data: { action: 'load_3dtiles', layerId: id, name } };
  } catch (err) {
    return { ok: false, error: `3D Tiles 加载失败：${err instanceof Error ? err.message : String(err)}` };
  }
};

export const loadImageryCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const url = str(args.url);
  if (!url) return { ok: false, error: 'load_imagery 需要 url' };

  const serviceType = str(args.serviceType) ?? 'xyz';
  const layerName = str(args.layerName) ?? '';
  const name = str(args.name) ?? `${serviceType} 影像`;
  const opacity = num(args.opacity) ?? 1;

  try {
    let provider;
    switch (serviceType) {
      case 'wms':
        provider = new WebMapServiceImageryProvider({ url, layers: layerName });
        break;
      case 'wmts':
        provider = new WebMapTileServiceImageryProvider({
          url,
          layer: layerName,
          style: 'default',
          tileMatrixSetID: 'default028mm',
        } as never);
        break;
      case 'arcgis_mapserver':
        provider = await ArcGisMapServerImageryProvider.fromUrl(url, { enablePickFeatures: false });
        break;
      default:
        provider = new UrlTemplateImageryProvider({ url, maximumLevel: 18 });
    }

    const imageryLayer: ImageryLayer = ctx.viewer.imageryLayers.addImageryProvider(provider as never);
    imageryLayer.alpha = Math.min(1, Math.max(0, opacity)); // 透明度在 Layer 上，不在 Provider 上
    const id = LayerRegistry.add(
      { id: LayerRegistry.nextId('imagery'), name, kind: 'imagery', visible: true },
      { imageryLayer },
    );
    return { ok: true, data: { action: 'load_imagery', layerId: id, name, serviceType } };
  } catch (err) {
    return { ok: false, error: `影像服务加载失败：${err instanceof Error ? err.message : String(err)}` };
  }
};

const ARCGIS_TERRAIN_URL =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';

export const loadTerrainCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const kind = str(args.kind) ?? 'arcgis';
  try {
    let provider;
    if (kind === 'flat') {
      provider = new EllipsoidTerrainProvider();
    } else if (kind === 'url') {
      const url = str(args.url);
      if (!url) return { ok: false, error: 'kind=url 时需要提供 url' };
      provider = await CesiumTerrainProvider.fromUrl(url);
    } else {
      provider = await ArcGISTiledElevationTerrainProvider.fromUrl(ARCGIS_TERRAIN_URL);
    }
    ctx.viewer.terrainProvider = provider as never;
    return { ok: true, data: { action: 'load_terrain', kind } };
  } catch (err) {
    return { ok: false, error: `地形加载失败：${err instanceof Error ? err.message : String(err)}` };
  }
};

/* ============================ 图层管理 ============================ */

export const listLayersCommand: CommandExecutor = async (): Promise<CommandResult> => {
  const layers = LayerRegistry.list();
  return { ok: true, data: { action: 'list_layers', count: layers.length, layers } };
};

export const removeLayerCommand: CommandExecutor = async (args): Promise<CommandResult> => {
  const layerId = str(args.layerId);
  if (!layerId) return { ok: false, error: 'remove_layer 需要 layerId' };
  const ok = LayerRegistry.remove(layerId);
  return ok
    ? { ok: true, data: { action: 'remove_layer', layerId } }
    : { ok: false, error: `找不到图层 ${layerId}` };
};

export const setLayerVisibilityCommand: CommandExecutor = async (args): Promise<CommandResult> => {
  const layerId = str(args.layerId);
  const visible = bool(args.visible);
  if (!layerId || visible === undefined) return { ok: false, error: '需要 layerId 与 visible' };
  const ok = LayerRegistry.setVisible(layerId, visible);
  return ok
    ? { ok: true, data: { action: 'set_layer_visibility', layerId, visible } }
    : { ok: false, error: `找不到图层 ${layerId}` };
};

export const clearSceneCommand: CommandExecutor = async (_args, ctx): Promise<CommandResult> => {
  stopOrbitInternal(ctx.viewer);
  const { layers, entities } = LayerRegistry.clear(ctx.viewer);
  return { ok: true, data: { action: 'clear_scene', removedLayers: layers, removedEntities: entities } };
};

/** 供 clear_scene 调用：避免环绕定时器泄漏 */
function stopOrbitInternal(viewer: Viewer): void {
  const holder = orbitHandlers.get(viewer);
  if (holder) {
    holder();
    orbitHandlers.delete(viewer);
  }
}

/* ============================ 底图切换 ============================ */

type Preset = { layers: (token?: string) => Array<{ url: string; maximumLevel?: number; subdomains?: string[] }>; backgroundColor?: string };

const BASEMAP_PRESETS: Record<string, Preset> = {
  dark: {
    layers: () => [
      { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c', 'd'], maximumLevel: 18 },
    ],
    backgroundColor: '#0B1120',
  },
  light: {
    layers: () => [
      { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c', 'd'], maximumLevel: 18 },
    ],
    backgroundColor: '#F8FAFC',
  },
  satellite: {
    layers: () => [
      { url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maximumLevel: 18 },
    ],
  },
  arcgis_imagery: {
    layers: () => [
      { url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maximumLevel: 18 },
    ],
  },
  standard: {
    layers: () => [
      { url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', maximumLevel: 18 },
    ],
  },
  osm: {
    layers: () => [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maximumLevel: 19 }],
  },
  tianditu_vec: {
    layers: (tk) => [
      { url: `https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk=${tk ?? ''}`, subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maximumLevel: 18 },
      { url: `https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&x={x}&y={y}&l={z}&tk=${tk ?? ''}`, subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maximumLevel: 18 },
    ],
  },
  tianditu_img: {
    layers: (tk) => [
      { url: `https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=${tk ?? ''}`, subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maximumLevel: 18 },
      { url: `https://t{s}.tianditu.gov.cn/DataServer?T=cia_w&x={x}&y={y}&l={z}&tk=${tk ?? ''}`, subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], maximumLevel: 18 },
    ],
  },
  amap: {
    layers: () => [
      { url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=8&x={x}&y={y}&z={z}', subdomains: ['1', '2', '3', '4'], maximumLevel: 18 },
    ],
  },
  amap_satellite: {
    layers: () => [
      { url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', subdomains: ['1', '2', '3', '4'], maximumLevel: 18 },
      { url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}', subdomains: ['1', '2', '3', '4'], maximumLevel: 18 },
    ],
  },
};

export const setBasemapCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const viewer = ctx.viewer;
  // 注意：会清掉所有已叠加的影像服务图层，这是「换底图」的预期语义
  viewer.imageryLayers.removeAll();

  const custom = str(args.url);
  if (custom) {
    viewer.imageryLayers.addImageryProvider(new UrlTemplateImageryProvider({ url: custom, maximumLevel: 18 }) as never);
    return { ok: true, data: { action: 'set_basemap', basemap: 'custom', url: custom } };
  }

  const key = str(args.basemap) ?? 'satellite';
  const preset = BASEMAP_PRESETS[key] ?? BASEMAP_PRESETS.satellite;
  const token = str(args.token);
  try {
    for (const layer of preset.layers(token)) {
      viewer.imageryLayers.addImageryProvider(new UrlTemplateImageryProvider(layer) as never);
    }
    if (preset.backgroundColor) {
      const c = parseColor(preset.backgroundColor, '#0B1120');
      viewer.scene.backgroundColor = c;
      viewer.scene.globe.baseColor = c;
    }
    return { ok: true, data: { action: 'set_basemap', basemap: key } };
  } catch (err) {
    return { ok: false, error: `底图切换失败：${err instanceof Error ? err.message : String(err)}` };
  }
};

/* 供 clear_scene / stop_orbit 共用的环绕句柄表（viewer → 取消函数） */
export const orbitHandlers = new Map<Viewer, () => void>();

/** 导出给 register.ts 之外的模块复用 */
export type { CesiumRefs };
