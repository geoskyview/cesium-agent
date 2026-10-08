import { Cartesian3, Math as CesiumMath } from 'cesium';
import type { Viewer } from 'cesium';
import type { CommandResult } from '../../../../shared/protocol';
import { num, resolvePosition, str, type CommandContext, type CommandExecutor } from './index';

interface FlyOptions {
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  duration: number;
}

/** 包装成 Promise，飞行结束/被打断/超时都继续往下走，避免卡住整条链路 */
export function flyToPromise(viewer: Viewer, o: FlyOptions): Promise<void> {
  const destination = Cartesian3.fromDegrees(o.longitude, o.latitude, o.height);
  const orientation = {
    heading: CesiumMath.toRadians(o.heading),
    pitch: CesiumMath.toRadians(o.pitch),
    roll: CesiumMath.toRadians(o.roll),
  };

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    // 兜底：飞行若没在预期时间内完成（渲染被暂停、瓦片错误导致渲染中断等），
    // 直接把相机落到目标位姿，保证「指令执行结果」与「地球状态」一致。
    const timer = setTimeout(() => {
      if (settled) return;
      console.warn('[aiearth] 飞行未在预期时间内完成，直接落位到目标视角');
      try {
        viewer.camera.setView({ destination, orientation });
      } catch (err) {
        console.error('[aiearth] 落位失败', err);
      }
      finish();
    }, Math.max(1500, (o.duration + 2) * 1000));

    try {
      viewer.camera.flyTo({
        destination,
        orientation,
        duration: o.duration,
        complete: finish,
        cancel: finish,
      });
    } catch (err) {
      console.error('[aiearth] flyTo 调用失败，改用 setView', err);
      try {
        viewer.camera.setView({ destination, orientation });
      } catch {
        /* ignore */
      }
      finish();
    }
  });
}

export const flyToCommand: CommandExecutor = async (
  args: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandResult> => {
  const pos = await resolvePosition(args, ctx);
  if ('error' in pos) return { ok: false, error: pos.error };

  const height = num(args.height) ?? 10000;
  const heading = num(args.heading) ?? 0;
  const pitch = num(args.pitch) ?? -45;
  const roll = num(args.roll) ?? 0;
  const duration = num(args.duration) ?? 3;

  await flyToPromise(ctx.viewer, {
    longitude: pos.longitude,
    latitude: pos.latitude,
    height,
    heading,
    pitch,
    roll,
    duration,
  });

  return {
    ok: true,
    data: {
      action: 'fly_to',
      place: str(args.place) ?? pos.place ?? null,
      longitude: Number(pos.longitude.toFixed(6)),
      latitude: Number(pos.latitude.toFixed(6)),
      cameraHeight: height,
      heading,
      pitch,
      duration,
    },
  };
};
