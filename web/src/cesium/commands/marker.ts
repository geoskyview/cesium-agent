import {
  Cartesian2,
  Cartesian3,
  Color,
  CustomDataSource,
  LabelStyle,
  VerticalOrigin,
} from 'cesium';
import type { Viewer } from 'cesium';
import type { CommandResult } from '../../../../shared/protocol';
import {
  bool,
  num,
  resolvePosition,
  str,
  type CommandContext,
  type CommandExecutor,
} from './index';
import { flyToPromise } from './flyTo';

const DS_NAME = 'aiearth-markers';

function ensureDataSource(viewer: Viewer): CustomDataSource {
  const exist = viewer.dataSources.getByName(DS_NAME)[0];
  if (exist) return exist as CustomDataSource;
  const ds = new CustomDataSource(DS_NAME);
  viewer.dataSources.add(ds);
  return ds;
}

function toColor(input: string | undefined): Color {
  if (!input) return Color.fromCssColorString('#ff4d4f');
  try {
    return Color.fromCssColorString(input);
  } catch {
    return Color.fromCssColorString('#ff4d4f');
  }
}

export const addMarkerCommand: CommandExecutor = async (
  args: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandResult> => {
  const pos = await resolvePosition(args, ctx);
  if ('error' in pos) return { ok: false, error: pos.error };

  const ds = ensureDataSource(ctx.viewer);
  const index = ds.entities.values.length + 1;
  const name = str(args.name) ?? str(args.place) ?? `标注 ${index}`;
  const height = num(args.height) ?? 0;
  const color = toColor(str(args.color));

  const entity = ds.entities.add({
    name,
    position: Cartesian3.fromDegrees(pos.longitude, pos.latitude, height),
    point: {
      pixelSize: 14,
      color,
      outlineColor: Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: name,
      font: '600 14px "Microsoft YaHei", sans-serif',
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -16),
      showBackground: true,
      backgroundColor: new Color(0.06, 0.09, 0.16, 0.72),
      backgroundPadding: new Cartesian2(6, 3),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    description: str(args.description) ?? '',
  } as never);

  let flew = false;
  if (bool(args.flyTo) === true) {
    flew = true;
    await flyToPromise(ctx.viewer, {
      longitude: pos.longitude,
      latitude: pos.latitude,
      height: num(args.flyHeight) ?? 2000,
      heading: 0,
      pitch: -45,
      roll: 0,
      duration: num(args.duration) ?? 3,
    });
  }

  return {
    ok: true,
    data: {
      action: 'add_marker',
      id: entity.id,
      name,
      longitude: Number(pos.longitude.toFixed(6)),
      latitude: Number(pos.latitude.toFixed(6)),
      height,
      flewTo: flew,
      totalMarkers: ds.entities.values.length,
    },
  };
};

export const clearMarkersCommand: CommandExecutor = async (
  _args: Record<string, unknown>,
  ctx: CommandContext,
): Promise<CommandResult> => {
  const ds = ensureDataSource(ctx.viewer);
  const removed = ds.entities.values.length;
  ds.entities.removeAll();
  return { ok: true, data: { action: 'clear_markers', removed } };
};

export function markerCount(viewer: Viewer): number {
  const ds = viewer.dataSources.getByName(DS_NAME)[0] as CustomDataSource | undefined;
  return ds?.entities.values.length ?? 0;
}
