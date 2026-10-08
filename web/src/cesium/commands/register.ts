/**
 * 命令注册表：shared/tools.ts 里 target='client' 的工具，都要在这里有同名执行器。
 * 新增能力 = 在 shared/tools.ts 加定义(stage:mvp) + 在这里注册执行器 + 后端无需改动。
 */
import { registerCommand } from './index';
import { flyToCommand } from './flyTo';
import { addMarkerCommand, clearMarkersCommand } from './marker';

/* 数据加载 */
import {
  loadGeoJsonCommand,
  loadKmlCommand,
  loadCzmlCommand,
  load3dTilesCommand,
  loadImageryCommand,
  loadTerrainCommand,
} from './layers';

/* 图层与底图 */
import {
  listLayersCommand,
  removeLayerCommand,
  setLayerVisibilityCommand,
  clearSceneCommand,
  setBasemapCommand,
} from './layers';

/* 图形实体 */
import {
  addPolylineCommand,
  addPolygonCommand,
  addModelCommand,
  addBillboardCommand,
  updateEntityCommand,
  removeEntityCommand,
  queryEntitiesCommand,
} from './draw';

/* 相机视角 */
import {
  setViewCommand,
  getViewCommand,
  zoomToExtentCommand,
  lookAtTransformCommand,
  startOrbitCommand,
  stopOrbitCommand,
} from './camera';

/* 场景环境 */
import { setSceneOptionsCommand, setGlobeLightingCommand } from './scene';

/* 量测与输出 */
import { measureCommand, screenshotCommand } from './analysis';

export function registerAllCommands(): void {
  /* core */
  registerCommand('fly_to', flyToCommand);
  registerCommand('add_marker', addMarkerCommand);
  registerCommand('clear_markers', clearMarkersCommand);

  /* data：数据加载 */
  registerCommand('load_geojson', loadGeoJsonCommand);
  registerCommand('load_kml', loadKmlCommand);
  registerCommand('load_czml', loadCzmlCommand);
  registerCommand('load_3dtiles', load3dTilesCommand);
  registerCommand('load_imagery', loadImageryCommand);
  registerCommand('load_terrain', loadTerrainCommand);

  /* layer：图层与底图 */
  registerCommand('list_layers', listLayersCommand);
  registerCommand('remove_layer', removeLayerCommand);
  registerCommand('set_layer_visibility', setLayerVisibilityCommand);
  registerCommand('clear_scene', clearSceneCommand);
  registerCommand('set_basemap', setBasemapCommand);

  /* draw：图形实体 */
  registerCommand('add_polyline', addPolylineCommand);
  registerCommand('add_polygon', addPolygonCommand);
  registerCommand('add_model', addModelCommand);
  registerCommand('add_billboard', addBillboardCommand);
  registerCommand('update_entity', updateEntityCommand);
  registerCommand('remove_entity', removeEntityCommand);
  registerCommand('query_entities', queryEntitiesCommand);

  /* camera：相机视角 */
  registerCommand('set_view', setViewCommand);
  registerCommand('get_view', getViewCommand);
  registerCommand('zoom_to_extent', zoomToExtentCommand);
  registerCommand('look_at_transform', lookAtTransformCommand);
  registerCommand('start_orbit', startOrbitCommand);
  registerCommand('stop_orbit', stopOrbitCommand);

  /* scene：场景环境 */
  registerCommand('set_scene_options', setSceneOptionsCommand);
  registerCommand('set_globe_lighting', setGlobeLightingCommand);

  /* analysis：量测与输出 */
  registerCommand('measure', measureCommand);
  registerCommand('screenshot', screenshotCommand);

  // 第二批（stage: planned，前端实现后再注册）：
  // play_trajectory / control_clock / add_heatmap / save_viewpoint / load_viewpoint / highlight
}
