import {
  ArcGisMapServerImageryProvider,
  ArcGISTiledElevationTerrainProvider,
  Cartographic,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Rectangle,
  SceneMode,
  Viewer,
  Ion,
  Camera,
  TileMapServiceImageryProvider,
  buildModuleUrl,
  sampleTerrainMostDetailed,
  ArcGisBaseMapType
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

/** ArcGIS 影像底图（World_Imagery，全球 0.3m~15m） */
export const ARCGIS_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';

/** ArcGIS 高程地形（WorldElevation3D / Terrain3D） */
export const ARCGIS_TERRAIN_URL =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';

type AnyCtor = Record<string, unknown> & { new (...args: never[]): unknown };

const IMAGERY_TIMEOUT = 10_000;
const TERRAIN_TIMEOUT = 10_000;
const PROBE_TIMEOUT = 6_000;

/**
 * 创建 Viewer：
 * - 底图与地形默认走 ArcGIS，完全不依赖 Cesium ion（不需要 ion token）
 * - ArcGIS 影像拿不到真实瓦片时（网络不通 / 被拦截 / 需要 token）自动回退到
 *   Cesium 自带的离线底图，避免「瓦片解码失败 → 渲染停止 → 交互全废」
 */
export async function createViewer(container: HTMLElement): Promise<Viewer> {
  // 不设置 ion token：底图/地形都自定义后不会再去请求 ion
 // Ion.defaultAccessToken = '';

  //const imagery = await resolveBaseLayer();

  const viewer = new Viewer(container, {
    baseLayer:  ImageryLayer.fromProviderAsync(
    ArcGisMapServerImageryProvider.fromBasemapType(
      ArcGisBaseMapType.SATELLITE
    )
  ),
    //baseLayerPicker: false,
    geocoder: false,
    homeButton: true,
    sceneModePicker: true,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: true,
    selectionIndicator: true,
    sceneMode: SceneMode.SCENE3D,
  });

  // 我们自己处理瓦片/渲染异常并降级；不要弹 Cesium 默认的红色错误面板
  (viewer.cesiumWidget as unknown as { showErrorPanel: (...args: unknown[]) => void }).showErrorPanel =
    () => {};

  viewer.scene.globe.depthTestAgainstTerrain = true;
 // watchRenderErrors(viewer);
  await attachTerrain(viewer);

  // 默认视角：中国范围
  Camera.DEFAULT_VIEW_RECTANGLE = Rectangle.fromDegrees(73, 3, 136, 54);
  Camera.DEFAULT_VIEW_FACTOR = 0.6;
  viewer.camera.setView({
    destination: Rectangle.fromDegrees(73, 3, 136, 54),
  });

  return viewer;
}

/* ------------------------------------------------------------------ */
/* 底图                                                                */
/* ------------------------------------------------------------------ */

async function resolveBaseLayer(): Promise<ImageryLayer> {
  const reachable = await probeArcGisImagery();
  console.warn('[aiearth] ArcGIS 影像探测结果：', reachable ? '可用' : '不可用');
  if (!reachable) {
    console.warn('[aiearth] ArcGIS 影像当前不可达，使用内置离线底图 Natural Earth II');
    return await createOfflineImageryLayer();
  }
  try {
    return await createArcGisImageryLayer();
  } catch (err) {
    console.warn('[aiearth] ArcGIS 影像初始化失败，回退离线底图：', err);
    return await createOfflineImageryLayer();
  }
}

/** 真正取一张瓦片来探测：能连通 ≠ 能出图，代理/WAF 常返回 HTML 拦截页或极小占位图 */
async function probeArcGisImagery(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
    // 取一张中国区域(level 4)的真实瓦片，比 1/0/0 更能反映实际可用性
    const resp = await fetch(`${ARCGIS_IMAGERY_URL}/tile/4/13/6`, {
      signal: ctrl.signal,
      mode: 'cors',
    });
    clearTimeout(timer);

    const type = (resp.headers.get('content-type') ?? '').toLowerCase();
    if (!resp.ok || !type.startsWith('image')) {
      console.warn('[aiearth] ArcGIS 影像探测失败：HTTP', resp.status, 'content-type=', type.slice(0, 40));
      return false;
    }
    const bytes = (await resp.arrayBuffer()).byteLength;
    console.warn(`[aiearth] ArcGIS 瓦片探测：status=${resp.status} type=${type} bytes=${bytes}`);
    if (bytes < 2000) {
      console.warn(`[aiearth] ArcGIS 影像疑似返回占位图（${bytes} bytes），判定不可用`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[aiearth] ArcGIS 影像探测异常：', err instanceof Error ? err.message : err);
    return false;
  }
}

async function createArcGisImageryLayer(): Promise<ImageryLayer> {
  const providerPromise = withTimeout(
    ArcGisMapServerImageryProvider.fromUrl(ARCGIS_IMAGERY_URL, {
      enablePickFeatures: false,
    }) as unknown as Promise<unknown>,
    IMAGERY_TIMEOUT,
    'ArcGIS 影像',
  );
  return await toImageryLayer(providerPromise);
}

/** 离线兜底底图：Cesium 自带的 Natural Earth II 瓦片（无需联网、无需 ion token） */
async function createOfflineImageryLayer(): Promise<ImageryLayer> {
  const url = buildModuleUrl('Assets/Textures/NaturalEarthII');
  const TMS = TileMapServiceImageryProvider as unknown as {
    fromUrl?: (url: string, options?: unknown) => Promise<unknown>;
  };
  if (typeof TMS.fromUrl !== 'function') {
    throw new Error('当前 Cesium 版本不支持 TileMapServiceImageryProvider.fromUrl');
  }
  return await toImageryLayer(TMS.fromUrl(url, {}) as Promise<unknown>);
}

async function toImageryLayer(providerPromise: Promise<unknown>): Promise<ImageryLayer> {
  const IL = ImageryLayer as unknown as {
    fromProviderAsync?: (p: Promise<unknown>, options?: unknown) => Promise<ImageryLayer>;
  };
  if (typeof IL.fromProviderAsync === 'function') {
    return await IL.fromProviderAsync(providerPromise, {});
  }
  return new ImageryLayer((await providerPromise) as never);
}

/* ------------------------------------------------------------------ */
/* 地形                                                                */
/* ------------------------------------------------------------------ */

async function attachTerrain(viewer: Viewer): Promise<void> {
  try {
    const Ctor = ArcGISTiledElevationTerrainProvider as unknown as AnyCtor & {
      fromUrl?: (url: string) => Promise<unknown>;
    };
    if (typeof Ctor.fromUrl !== 'function') {
      throw new Error('当前 Cesium 版本不支持 ArcGISTiledElevationTerrainProvider.fromUrl');
    }
    viewer.terrainProvider = (await withTimeout(
      Ctor.fromUrl(ARCGIS_TERRAIN_URL) as Promise<unknown>,
      TERRAIN_TIMEOUT,
      'ArcGIS 地形',
    )) as never;
    console.info('[aiearth] 已加载 ArcGIS 高程地形');
  } catch (err) {
    console.warn('[aiearth] ArcGIS 地形加载失败，回退到椭球体地形：', err);
    viewer.terrainProvider = new EllipsoidTerrainProvider() as never;
  }
}

/**
 * 渲染异常不静默吞掉：
 * 1) 打印出来
 * 2) 重新拉起渲染循环（Cesium 遇到瓦片解码失败会停渲染，交互就全废了）
 * 3) 若底图还是 ArcGIS，自动换成离线底图，保证「球始终能看能用」
 */
function watchRenderErrors(viewer: Viewer): void {
  let downgraded = false;

  viewer.scene.renderError.addEventListener((_scene, error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn('[aiearth] 场景渲染异常：', msg);

    try {
      viewer.useDefaultRenderLoop = false;
      viewer.useDefaultRenderLoop = true;
    } catch {
      /* ignore */
    }

    if (downgraded) return;
    downgraded = true;
    void (async () => {
      try {
        const offline = await createOfflineImageryLayer();
        const current = viewer.imageryLayers.get(0);
        // 先加后删，避免出现「一瞬间没有底图」导致 Cesium 内部报错
        viewer.imageryLayers.add(offline, 0);
        if (current && current !== offline) viewer.imageryLayers.remove(current);
        console.warn('[aiearth] 已自动切换到离线底图，保证三维球可交互');
      } catch (err) {
        console.warn('[aiearth] 底图自动降级失败：', err instanceof Error ? err.stack || err.message : String(err));
      }
    })();
  });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 网络不可达时不要让 Viewer 初始化卡死：超时即回退 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);
}

/** 查询某点的地形高度（米），后续地形分析会用到 */
export async function sampleTerrainHeight(
  viewer: Viewer,
  longitude: number,
  latitude: number,
): Promise<number> {
  try {
    const [sampled] = await sampleTerrainMostDetailed(viewer.terrainProvider, [
      Cartographic.fromDegrees(longitude, latitude),
    ]);
    return sampled?.height ?? 0;
  } catch {
    return 0;
  }
}
