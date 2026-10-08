/**
 * 相机与视角控制
 *
 * 移植要点（cesium-mcp commands/view.ts、camera.ts）：
 * - set_view 之后必须 lookAtTransform(Matrix4.IDENTITY)，否则相机被锁死、用户拖不动地图
 * - look_at_transform 恰恰相反：故意保持锁定，让相机绕中心转
 * - flyTo 的 complete 与 cancel 都要触发 resolve，否则「相机已在目标位置」时
 *   Cesium 不回调，Promise 永远挂住；再加一个超时兜底
 * - start_orbit 重复调用要先停旧的，否则监听器叠加导致越转越快
 */

import {
  Cartesian3,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  Rectangle,
  Transforms,
} from 'cesium';
import type { Viewer } from 'cesium';
import type { CommandResult } from '../../../../shared/protocol';
import { bool, num, resolvePosition, type CommandExecutor } from './index';
import { orbitHandlers } from './layers';
import { parseBbox } from './util';

/**
 * 统一的飞行动画 Promise。
 * complete 和 cancel 都要触发 resolve —— 相机已在目标位置时 Cesium 不会回调，
 * 只挂 complete 会让 Promise 永远悬着；再叠一个超时兜底防极端情况。
 */
export function flightDone(viewer: Viewer, duration: number, start: (finish: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, (duration + 2) * 1000);
    start(finish);
  });
}

/** 相机高度 → 距离（用于 lookAt 语义下把「高度」换算成 range） */
function heightToRange(height: number, pitchDeg: number): number {
  const absSin = Math.abs(Math.sin(CesiumMath.toRadians(pitchDeg)));
  return absSin > 0.05 ? height / absSin : height * 10;
}

export const setViewCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const pos = await resolvePosition(args, ctx);
  if ('error' in pos) return { ok: false, error: pos.error };

  const height = num(args.height) ?? 50000;
  const pitch = num(args.pitch) ?? -45;
  const range = heightToRange(height, pitch);

  ctx.viewer.camera.lookAt(
    Cartesian3.fromDegrees(pos.longitude, pos.latitude, 0),
    new HeadingPitchRange(CesiumMath.toRadians(num(args.heading) ?? 0), CesiumMath.toRadians(pitch), range),
  );
  // 解锁：否则相机被锁定，用户无法拖动
  ctx.viewer.camera.lookAtTransform(Matrix4.IDENTITY);

  const roll = num(args.roll);
  if (roll !== undefined) {
    ctx.viewer.camera.setView({
      orientation: {
        heading: ctx.viewer.camera.heading,
        pitch: ctx.viewer.camera.pitch,
        roll: CesiumMath.toRadians(roll),
      },
    } as never);
  }

  return {
    ok: true,
    data: { action: 'set_view', longitude: pos.longitude, latitude: pos.latitude, height, pitch },
  };
};

export const getViewCommand: CommandExecutor = async (_args, ctx): Promise<CommandResult> => {
  const cam = ctx.viewer.camera;
  const carto = cam.positionCartographic;
  return {
    ok: true,
    data: {
      action: 'get_view',
      longitude: Number(CesiumMath.toDegrees(carto.longitude).toFixed(6)),
      latitude: Number(CesiumMath.toDegrees(carto.latitude).toFixed(6)),
      height: Number(carto.height.toFixed(1)),
      heading: Number(CesiumMath.toDegrees(cam.heading).toFixed(2)),
      pitch: Number(CesiumMath.toDegrees(cam.pitch).toFixed(2)),
      roll: Number(CesiumMath.toDegrees(cam.roll).toFixed(2)),
    },
  };
};

export const zoomToExtentCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const bbox = parseBbox(args.bbox);
  if (!bbox) return { ok: false, error: 'zoom_to_extent 需要 bbox = [西, 南, 东, 北]' };

  const duration = num(args.duration) ?? 1.5;
  await flightDone(ctx.viewer, duration, (finish) => {
    ctx.viewer.camera.flyTo({
      destination: Rectangle.fromDegrees(bbox[0], bbox[1], bbox[2], bbox[3]),
      duration,
      complete: finish,
      cancel: finish,
    });
  });
  return { ok: true, data: { action: 'zoom_to_extent', bbox } };
};

export const lookAtTransformCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const pos = await resolvePosition(args, ctx);
  if ('error' in pos) return { ok: false, error: pos.error };

  const center = Cartesian3.fromDegrees(pos.longitude, pos.latitude, num(args.height) ?? 0);
  const transform = Transforms.eastNorthUpToFixedFrame(center);
  // 这里故意保持锁定状态：相机绕中心点转
  ctx.viewer.camera.lookAtTransform(
    transform,
    new HeadingPitchRange(
      CesiumMath.toRadians(num(args.heading) ?? 0),
      CesiumMath.toRadians(num(args.pitch) ?? -45),
      num(args.range) ?? 1000,
    ),
  );

  return {
    ok: true,
    data: { action: 'look_at_transform', longitude: pos.longitude, latitude: pos.latitude },
  };
};

export const startOrbitCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const viewer = ctx.viewer;
  // 防叠加：新的环绕开始前先停掉旧的
  const existing = orbitHandlers.get(viewer);
  if (existing) {
    existing();
    orbitHandlers.delete(viewer);
  }

  const speed = num(args.speed) ?? 0.005;
  const direction = (bool(args.clockwise) ?? true) ? -1 : 1;
  const handler = viewer.clock.onTick.addEventListener(() => {
    viewer.camera.rotateRight(CesiumMath.toRadians(speed) * direction);
  });
  const cancel = () => handler();
  orbitHandlers.set(viewer, cancel);

  return { ok: true, data: { action: 'start_orbit', speed, clockwise: direction === -1 } };
};

export const stopOrbitCommand: CommandExecutor = async (_args, ctx): Promise<CommandResult> => {
  const viewer = ctx.viewer;
  const handler = orbitHandlers.get(viewer);
  if (handler) {
    handler();
    orbitHandlers.delete(viewer);
  }
  // 解锁可能存在的 lookAt 锁定
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  return { ok: true, data: { action: 'stop_orbit', stopped: Boolean(handler) } };
};

