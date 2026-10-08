/**
 * 量算与输出：距离 / 面积量算、截图
 *
 * 移植要点（cesium-mcp commands/interaction.ts）：
 * - 距离用 EllipsoidGeodesic 复用同一实例逐段累加（测地距离，不是直线距离）
 * - 面积用球面积分公式，输入必须是弧度
 * - 截图必须在 postRender 回调里同步取 canvas，否则 WebGL 缓冲区已被清空，拿到黑图；
 *   监听器在 settle 时一定要移除
 */

import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidGeodesic,
  LabelStyle,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  VerticalOrigin,
} from 'cesium';
import type { CommandResult } from '../../../../shared/protocol';
import { bool, str, type CommandExecutor } from './index';
import { LayerRegistry, colorMaterial, parseCoordinates } from './util';

const EARTH_RADIUS = 6371008.8;

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(3)} km` : `${meters.toFixed(1)} m`;
}

function formatArea(sqMeters: number): string {
  return sqMeters >= 1e6 ? `${(sqMeters / 1e6).toFixed(3)} km²` : `${sqMeters.toFixed(1)} m²`;
}

/** 球面多边形面积（球面 excess 公式，输入需为弧度） */
function sphericalArea(cartographics: Cartographic[]): number {
  let sum = 0;
  for (let i = 0; i < cartographics.length; i++) {
    const a = cartographics[i];
    const b = cartographics[(i + 1) % cartographics.length];
    sum += (b.longitude - a.longitude) * (2 + Math.sin(a.latitude) + Math.sin(b.latitude));
  }
  return Math.abs((sum * EARTH_RADIUS * EARTH_RADIUS) / 2);
}

export const measureCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const mode = str(args.mode) === 'area' ? 'area' : 'distance';
  const points = parseCoordinates(args.coordinates);
  const min = mode === 'area' ? 3 : 2;
  if (points.length < min) {
    return { ok: false, error: `measure(${mode}) 至少需要 ${min} 个坐标点，实际 ${points.length} 个` };
  }

  const cartographics = points.map((p) => Cartographic.fromDegrees(p.longitude, p.latitude, p.height ?? 0));
  const cartesians = cartographics.map((c) => Cartographic.toCartesian(c));

  let meters = 0;
  let area = 0;
  if (mode === 'distance') {
    const geodesic = new EllipsoidGeodesic();
    for (let i = 0; i < cartographics.length - 1; i++) {
      geodesic.setEndPoints(cartographics[i], cartographics[i + 1]);
      meters += geodesic.surfaceDistance;
    }
  } else {
    area = sphericalArea(cartographics);
  }

  const showOnMap = bool(args.showOnMap) ?? true;
  let entityId: string | undefined;

  if (showOnMap) {
    const labelPos =
      mode === 'distance' ? cartesians[Math.floor(cartesians.length / 2)] : BoundingSphere.fromPoints(cartesians).center;
    const labelCarto = Cartographic.fromCartesian(labelPos);
    const text = mode === 'distance' ? formatDistance(meters) : formatArea(area);

    const entity = ctx.viewer.entities.add({
      name: `量算：${text}`,
      position: labelCarto
        ? Cartesian3.fromRadians(labelCarto.longitude, labelCarto.latitude, (labelCarto.height ?? 0) + 50)
        : undefined,
      label: {
        text,
        font: '600 14px "Microsoft YaHei", sans-serif',
        fillColor: Color.YELLOW,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -20),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      ...(mode === 'distance'
        ? {
            polyline: {
              positions: cartesians,
              width: 3,
              material: new PolylineDashMaterialProperty({ color: Color.YELLOW, dashLength: 16 }),
              clampToGround: true,
            },
          }
        : {
            polygon: {
              hierarchy: new PolygonHierarchy(cartesians),
              material: colorMaterial(Color.YELLOW.withAlpha(0.3)),
              outline: true,
              outlineColor: Color.YELLOW,
              outlineWidth: 2,
            },
          }),
    } as never);
    entityId = entity.id;
    LayerRegistry.add(
      { id: LayerRegistry.nextId('measure'), name: `量算 ${text}`, kind: 'measure', visible: true },
      { entities: [entity] },
    );
  }

  return {
    ok: true,
    data: {
      action: 'measure',
      mode,
      value: mode === 'distance' ? Number(meters.toFixed(2)) : Number(area.toFixed(2)),
      unit: mode === 'distance' ? 'm' : 'm²',
      display: mode === 'distance' ? formatDistance(meters) : formatArea(area),
      entityId,
      pointCount: points.length,
    },
  };
};

/** 触发浏览器下载 */
function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export const screenshotCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const viewer = ctx.viewer;
  const filename = `${str(args.filename) ?? `aiearth-${Date.now()}`}.png`;

  const dataUrl: string = await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      removeListener();
    };
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    // 必须监听 postRender：渲染结束后立刻取，晚一步缓冲区就被清了
    const listener = () => finish(viewer.scene.canvas.toDataURL('image/png'));
    const removeListener = () => viewer.scene.postRender.removeEventListener(listener);
    viewer.scene.postRender.addEventListener(listener);
    const timer = setTimeout(() => {
      if (settled) return;
      // 兜底：极端情况下直接取当前 canvas
      try {
        finish(viewer.scene.canvas.toDataURL('image/png'));
      } catch (err) {
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, 5000);
    viewer.scene.requestRender();
  });

  downloadDataUrl(dataUrl, filename);
  return {
    ok: true,
    data: {
      action: 'screenshot',
      filename,
      width: viewer.scene.canvas.width,
      height: viewer.scene.canvas.height,
      downloaded: true,
    },
  };
};

