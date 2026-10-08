/**
 * 场景环境：雾 / 大气 / 阴影 / 日月 / 背景色 / 地球光照
 *
 * 移植要点（cesium-mcp commands/scene.ts、animation.ts）：
 * - 部分更新：字段为 undefined 时绝不写入，否则会把用户没提到的效果重置掉
 * - shadows 在 viewer 上，shadowMap 在 scene 上，两者不是同一个层级
 * - skyAtmosphere / sun / moon 在部分配置下可能为 undefined，写入前要判空
 */

import { Color } from 'cesium';
import type { CommandResult } from '../../../../shared/protocol';
import { bool, num, str, type CommandExecutor } from './index';
import { parseColor } from './util';

export const setSceneOptionsCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const scene = ctx.viewer.scene;
  const applied: string[] = [];

  const fogEnabled = bool(args.fogEnabled);
  if (fogEnabled !== undefined) {
    scene.fog.enabled = fogEnabled;
    applied.push('fogEnabled');
  }
  const fogDensity = num(args.fogDensity);
  if (fogDensity !== undefined) {
    scene.fog.density = fogDensity;
    applied.push('fogDensity');
  }

  const sky = bool(args.skyAtmosphere);
  if (sky !== undefined && scene.skyAtmosphere) {
    scene.skyAtmosphere.show = sky;
    applied.push('skyAtmosphere');
  }

  const ground = bool(args.groundAtmosphere);
  if (ground !== undefined) {
    scene.globe.showGroundAtmosphere = ground;
    applied.push('groundAtmosphere');
  }

  const shadows = bool(args.shadows);
  if (shadows !== undefined) {
    ctx.viewer.shadows = shadows; // 注意：shadows 在 viewer 上
    applied.push('shadows');
  }
  const softShadows = bool(args.softShadows);
  if (softShadows !== undefined) {
    scene.shadowMap.softShadows = softShadows;
    applied.push('softShadows');
  }
  const darkness = num(args.shadowDarkness);
  if (darkness !== undefined) {
    scene.shadowMap.darkness = darkness;
    applied.push('shadowDarkness');
  }

  const sun = bool(args.sun);
  if (sun !== undefined && scene.sun) {
    scene.sun.show = sun;
    applied.push('sun');
  }
  const moon = bool(args.moon);
  if (moon !== undefined && scene.moon) {
    scene.moon.show = moon;
    applied.push('moon');
  }

  const depth = bool(args.depthTestAgainstTerrain);
  if (depth !== undefined) {
    scene.globe.depthTestAgainstTerrain = depth;
    applied.push('depthTestAgainstTerrain');
  }

  const bg = str(args.backgroundColor);
  if (bg) {
    scene.backgroundColor = parseColor(bg, '#0B1120') as Color;
    applied.push('backgroundColor');
  }

  return { ok: true, data: { action: 'set_scene_options', applied } };
};

export const setGlobeLightingCommand: CommandExecutor = async (args, ctx): Promise<CommandResult> => {
  const globe = ctx.viewer.scene.globe;
  const applied: string[] = [];

  const enable = bool(args.enableLighting);
  if (enable !== undefined) {
    globe.enableLighting = enable;
    applied.push('enableLighting');
  }
  const dyn = bool(args.dynamicAtmosphereLighting);
  if (dyn !== undefined) {
    globe.dynamicAtmosphereLighting = dyn;
    applied.push('dynamicAtmosphereLighting');
  }
  const fromSun = bool(args.dynamicAtmosphereLightingFromSun);
  if (fromSun !== undefined) {
    globe.dynamicAtmosphereLightingFromSun = fromSun;
    applied.push('dynamicAtmosphereLightingFromSun');
  }

  return { ok: true, data: { action: 'set_globe_lighting', applied } };
};
