/**
 * AIEarth 工具契约（前后端唯一来源）
 *
 * 设计要点：
 * 1. 工具的「定义」只写一份，后端拿它去调 LLM，前端拿它去实现执行器。
 * 2. target = 'client' 的工具由浏览器里的 Cesium 执行（因为球在前端）；
 *    target = 'server' 的工具由 Node 后端执行（不依赖浏览器能力）。
 * 3. stage = 'planned' 的工具只占位、不发给 LLM，扩充时把 stage 改成 'mvp' 并
 *    在 web/src/cesium/commands 下补一个同名执行器即可，无需改 Agent 主流程。
 * 4. group = 能力分组。工具变多后一次性全给模型会显著降低选择准确率，
 *    因此后端按用户意图只下发命中的分组（见 getToolsForIntent）。
 *
 * 移植来源：工具能力与参数语义参考 cesium-mcp（59 个 Cesium MCP 工具），
 * 命名统一为 snake_case 并对齐 AIEarth 既有风格。
 */

export type ToolTarget = 'client' | 'server';
export type ToolStage = 'mvp' | 'planned';

/** 能力分组：后端按意图做工具路由，避免一次下发几十个工具 */
export type ToolGroup =
  | 'core' // 常驻：飞行、标注、地名解析
  | 'data' // 数据加载
  | 'layer' // 图层与底图管理
  | 'draw' // 图形实体
  | 'camera' // 相机与视角
  | 'scene' // 场景环境
  | 'analysis'; // 量测与输出

export interface ToolDefinition {
  /** 工具名，前后端执行器以此对齐 */
  name: string;
  /** 给 LLM 看的描述，写清楚「什么时候用 / 参数语义 / 例子」，直接影响调用准确率 */
  description: string;
  /** 执行位置 */
  target: ToolTarget;
  /** mvp 才会下发给模型 */
  stage: ToolStage;
  /** 能力分组，用于按意图路由 */
  group: ToolGroup;
  /** JSON Schema（OpenAI tools 规范） */
  parameters: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 复用的 Schema 片段                                                   */
/* ------------------------------------------------------------------ */

const lon = { type: 'number', minimum: -180, maximum: 180, description: '经度（十进制度，东经为正）' };
const lat = { type: 'number', minimum: -90, maximum: 90, description: '纬度（十进制度，北纬为正）' };
const height = { type: 'number', description: '高度（米），默认 0' };
const color = { type: 'string', description: 'CSS 颜色，如 "#3B82F6"、"red"、"rgba(59,130,246,0.8)"' };
const layerId = { type: 'string', description: '图层 ID（加载类工具会返回 layerId，后续操作靠它）' };
const coords = {
  type: 'array',
  description: '坐标数组，每项 [经度, 纬度] 或 [经度, 纬度, 高度]',
  items: { type: 'array', items: { type: 'number' } },
  minItems: 2,
};

export const TOOLS: ToolDefinition[] = [
  /* ============================ core ============================ */
  {
    name: 'fly_to',
    target: 'client',
    stage: 'mvp',
    group: 'core',
    description:
      '将 Cesium 相机飞行定位到指定位置（带动画）。当用户说「定位到/飞到/去/看一下/放大到」某个地点或坐标时使用。' +
      '可以用 place 传地名（中文地名优先，如「北京」「珠穆朗玛峰」），也可以直接用 longitude/latitude 传经纬度（十进制度，WGS84）。' +
      'height 是相机相对地面的高度（米）：看城市轮廓 3000~20000，看单个建筑 300~1000，看全省 100000~400000。' +
      '想做三维倾斜视角时把 pitch 设为 -30 ~ -60（默认 -45）；正俯视用 -90。' +
      '用户说「三维视角」「斜着看」「倾斜视角」时务必给出 pitch。' +
      '示例：「三维视角飞到北京」→ { place: "北京", height: 8000, pitch: -45, duration: 3 }。',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '地名或地址。与经纬度二选一，同时给出时以经纬度为准' },
        longitude: lon,
        latitude: lat,
        height,
        heading: { type: 'number', description: '方位角（度），0=正北，90=正东。默认 0' },
        pitch: { type: 'number', description: '俯仰角（度），-90=垂直俯视，-45=倾斜三维视角。默认 -45' },
        roll: { type: 'number', description: '翻滚角（度），默认 0' },
        duration: { type: 'number', description: '飞行时长（秒），默认 3' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'add_marker',
    target: 'client',
    stage: 'mvp',
    group: 'core',
    description:
      '在地球上添加一个标注点（Cesium Entity：点 + 文字标签）。当用户说「加个标注/打个点/标记这里/标个位置」时使用。' +
      '位置可用 place 或 longitude/latitude。若用户说「标注并飞过去」，把 flyTo 设为 true（不要再额外调 fly_to）。' +
      '示例：「定位到北京，添加一个标注」→ 先 fly_to(place="北京")，再 add_marker(name="北京", place="北京")。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '标注名称，显示在标签上' },
        place: { type: 'string', description: '地名，与经纬度二选一' },
        longitude: lon,
        latitude: lat,
        height,
        color,
        description: { type: 'string', description: '描述，点击后显示在信息框' },
        flyTo: { type: 'boolean', description: '添加后是否立刻飞过去，默认 false' },
        flyHeight: { type: 'number', description: 'flyTo 时的相机高度（米），默认 2000' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_markers',
    target: 'client',
    stage: 'mvp',
    group: 'core',
    description: '清除地球上已添加的全部标注点。用户说「清空标注/删掉所有点/清理标记」时使用。',
    parameters: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: '通常为 true' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'geo_locate',
    target: 'server',
    stage: 'mvp',
    group: 'core',
    description:
      '地名转经纬度（内置离线地名词典：中国省级行政区、主要城市及世界主要城市）。' +
      '拿不准某地准确经纬度时先调用本工具；查到就用返回值，不要凭记忆填。返回 not_found 时再结合地理知识给近似值并说明。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要查询的地名，如「北京」「深圳」「东京」' } },
      required: ['query'],
      additionalProperties: false,
    },
  },

  /* ============================ data ============================ */
  {
    name: 'load_geojson',
    target: 'client',
    stage: 'mvp',
    group: 'data',
    description:
      '加载 GeoJSON 数据到地球（支持 Point/LineString/Polygon）。用户说「加载/叠加/打开 geojson」或给出 geojson 地址/数据时使用。' +
      'data 与 url 二选一。加载后自动飞行到数据范围（flyTo=false 可关闭）。返回的 layerId 用于后续移除/显隐/改样式。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'GeoJSON 文件地址（需可跨域访问）。与 data 二选一' },
        data: { type: 'object', description: 'GeoJSON FeatureCollection 对象。与 url 二选一' },
        name: { type: 'string', description: '图层显示名' },
        color: { ...color, description: '要素颜色，默认 "#3B82F6"' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: '填充透明度，默认 0.6' },
        strokeWidth: { type: 'number', description: '线宽，默认 3' },
        clampToGround: { type: 'boolean', description: '是否贴地，默认 true' },
        labelField: { type: 'string', description: '用哪个属性字段作为文字标注显示' },
        flyTo: { type: 'boolean', description: '加载后是否飞到数据范围，默认 true' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'load_kml',
    target: 'client',
    stage: 'mvp',
    group: 'data',
    description:
      '加载 KML/KMZ 数据。用户说「加载 kml/kmz」时使用。注意：KMZ 只能走 url（内联文本不支持压缩包）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'KML/KMZ 文件地址。与 data 二选一' },
        data: { type: 'string', description: 'KML 文本内容。与 url 二选一' },
        name: { type: 'string', description: '图层显示名' },
        clampToGround: { type: 'boolean', description: '是否贴地' },
        flyTo: { type: 'boolean', description: '加载后是否飞到数据范围，默认 true' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'load_czml',
    target: 'client',
    stage: 'mvp',
    group: 'data',
    description: '加载 CZML 时序数据（Cesium 原生格式，支持时变位置与动画）。用户说「加载 czml」时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'CZML 地址。与 data 二选一' },
        data: { type: 'array', description: 'CZML packet 数组。与 url 二选一', items: { type: 'object' } },
        name: { type: 'string', description: '图层显示名' },
        clampToGround: { type: 'boolean', description: '是否贴地' },
        flyTo: { type: 'boolean', description: '加载后是否飞到数据范围，默认 true' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'load_3dtiles',
    target: 'client',
    stage: 'mvp',
    group: 'data',
    description:
      '加载 3D Tiles 三维模型数据集（城市白模、BIM、点云等）。用户说「加载 3dtiles/三维模型/白模/倾斜摄影」时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'tileset.json 地址' },
        ionAssetId: { type: 'number', description: 'Cesium Ion 资产 ID（需已配置 ion token）' },
        name: { type: 'string', description: '图层显示名' },
        maximumScreenSpaceError: { type: 'number', description: '渲染精度，越小越精细，默认 16' },
        heightOffset: { type: 'number', description: '整体抬高/降低（米），用于纠偏，默认 0' },
        flyTo: { type: 'boolean', description: '加载后是否飞到数据范围，默认 true' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'load_imagery',
    target: 'client',
    stage: 'mvp',
    group: 'data',
    description:
      '叠加影像服务图层（WMS/WMTS/XYZ/ArcGIS MapServer）。用户说「叠加影像/加载 wms/wmts/xyz 服务/加个图层服务」时使用。' +
      '这是叠加到现有底图之上，不是替换底图（替换底图用 set_basemap）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '服务地址' },
        serviceType: {
          type: 'string',
          enum: ['wms', 'wmts', 'xyz', 'arcgis_mapserver'],
          description: '服务类型，默认 xyz',
        },
        layerName: { type: 'string', description: '图层名（WMS 的 layers / WMTS 的 layer）' },
        name: { type: 'string', description: '图层显示名' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: '透明度，默认 1' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'load_terrain',
    target: 'client',
    stage: 'mvp',
    group: 'data',
    description: '切换地形（高程）数据源。用户说「加载地形/换成扁平地形/切换高程」时使用。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['flat', 'arcgis', 'url'], description: 'flat=无地形，arcgis=ArcGIS 全球高程，url=自定义' },
        url: { type: 'string', description: 'kind=url 时的地形服务地址' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },

  /* ============================ layer ============================ */
  {
    name: 'list_layers',
    target: 'client',
    stage: 'mvp',
    group: 'layer',
    description: '列出当前所有已加载图层（ID、名称、类型、可见性）。用户问「现在有哪些图层」或需要找 layerId 时使用。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'remove_layer',
    target: 'client',
    stage: 'mvp',
    group: 'layer',
    description: '按 layerId 移除指定图层。用户说「移除/删掉某个图层」时使用；不知道 ID 就先调 list_layers。',
    parameters: {
      type: 'object',
      properties: { layerId },
      required: ['layerId'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_layer_visibility',
    target: 'client',
    stage: 'mvp',
    group: 'layer',
    description: '显示或隐藏指定图层。用户说「隐藏/显示某某图层」时使用。',
    parameters: {
      type: 'object',
      properties: { layerId, visible: { type: 'boolean', description: 'true=显示，false=隐藏' } },
      required: ['layerId', 'visible'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_scene',
    target: 'client',
    stage: 'mvp',
    group: 'layer',
    description: '清空场景：移除所有图层、实体、动画与轨迹（一键重置）。用户说「清空/重置场景/全部清除」时使用。',
    parameters: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: '通常为 true' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'set_basemap',
    target: 'client',
    stage: 'mvp',
    group: 'layer',
    description:
      '切换底图风格。用户说「换成暗色底图/影像底图/天地图/高德/OSM/街道图」时使用。' +
      '注意会清掉所有已叠加的影像服务图层。天地图/高德需要 token。',
    parameters: {
      type: 'object',
      properties: {
        basemap: {
          type: 'string',
          enum: ['dark', 'satellite', 'standard', 'osm', 'arcgis_imagery', 'light', 'tianditu_vec', 'tianditu_img', 'amap', 'amap_satellite'],
          description: '底图预设，默认 satellite',
        },
        token: { type: 'string', description: '天地图/高德等需要的 key' },
        url: { type: 'string', description: '自定义 XYZ 模板（含 {z}/{x}/{y}），给定时忽略 basemap' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  /* ============================ draw ============================ */
  {
    name: 'add_polyline',
    target: 'client',
    stage: 'mvp',
    group: 'draw',
    description: '绘制折线（路径、边界线、航线）。用户说「画条线/连一条路径/画条航线」时使用。',
    parameters: {
      type: 'object',
      properties: {
        coordinates: coords,
        name: { type: 'string', description: '名称' },
        color,
        width: { type: 'number', description: '线宽，默认 3' },
        clampToGround: { type: 'boolean', description: '是否贴地，默认 true' },
      },
      required: ['coordinates'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_polygon',
    target: 'client',
    stage: 'mvp',
    group: 'draw',
    description: '绘制多边形（区域面）。用户说「画个面/圈一块区域/画个多边形」时使用。extrudedHeight 可拉伸成体块。',
    parameters: {
      type: 'object',
      properties: {
        coordinates: coords,
        name: { type: 'string', description: '名称' },
        color,
        opacity: { type: 'number', minimum: 0, maximum: 1, description: '填充透明度，默认 0.6' },
        outlineColor: color,
        extrudedHeight: { type: 'number', description: '拉伸高度（米），不给则不拉伸' },
        clampToGround: { type: 'boolean', description: '是否贴地，默认 true；与 extrudedHeight 不可同时用' },
      },
      required: ['coordinates'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_model',
    target: 'client',
    stage: 'mvp',
    group: 'draw',
    description: '在指定位置放置 3D 模型（glTF/GLB）。用户说「放个模型/加载 glb/放辆车」时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'glTF/GLB 模型地址' },
        longitude: lon,
        latitude: lat,
        height,
        scale: { type: 'number', description: '缩放，默认 1' },
        heading: { type: 'number', description: '朝向（度），默认 0' },
        pitch: { type: 'number', description: '俯仰（度），默认 0' },
        roll: { type: 'number', description: '翻滚（度），默认 0' },
        name: { type: 'string', description: '名称' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_billboard',
    target: 'client',
    stage: 'mvp',
    group: 'draw',
    description: '在指定位置添加图片图标（billboard）。用户说「加个图标/放张图片标记」时使用。',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '图片地址或 data URL' },
        longitude: lon,
        latitude: lat,
        height,
        scale: { type: 'number', description: '缩放，默认 1' },
        name: { type: 'string', description: '名称' },
      },
      required: ['image'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_entity',
    target: 'client',
    stage: 'mvp',
    group: 'draw',
    description: '修改已有实体的属性（位置、颜色、标签、缩放、显隐）。用户说「把那个点改一下/换个颜色/挪个位置」时使用。',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: '实体 ID（添加类工具会返回）' },
        longitude: lon,
        latitude: lat,
        height,
        name: { type: 'string', description: '新名称/标签文字' },
        color,
        scale: { type: 'number', description: '缩放' },
        show: { type: 'boolean', description: '显隐' },
      },
      required: ['entityId'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_entity',
    target: 'client',
    stage: 'mvp',
    group: 'draw',
    description: '按 entityId 删除单个实体。用户说「删掉这个点/移除那个面」时使用。',
    parameters: {
      type: 'object',
      properties: { entityId: { type: 'string', description: '实体 ID' } },
      required: ['entityId'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_entities',
    target: 'client',
    stage: 'mvp',
    group: 'draw',
    description: '查询已有实体：按名称、类型、空间范围过滤，返回 entityId/名称/类型/位置。不知道实体 ID 时先调它。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '名称子串（大小写不敏感）' },
        type: { type: 'string', description: '类型：marker/polyline/polygon/model/billboard/label 等' },
        bbox: { type: 'array', items: { type: 'number' }, description: '[西, 南, 东, 北] 空间范围' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  /* ============================ camera ============================ */
  {
    name: 'set_view',
    target: 'client',
    stage: 'mvp',
    group: 'camera',
    description: '瞬间切换到指定视角（无动画）。用户说「直接切到/立刻定位到」某坐标视角时使用；要动画就用 fly_to。',
    parameters: {
      type: 'object',
      properties: {
        longitude: lon,
        latitude: lat,
        height: { type: 'number', description: '相机高度（米），默认 50000' },
        heading: { type: 'number', description: '方位角（度），默认 0' },
        pitch: { type: 'number', description: '俯仰角（度），默认 -45' },
        roll: { type: 'number', description: '翻滚角（度），默认 0' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_view',
    target: 'client',
    stage: 'mvp',
    group: 'camera',
    description: '获取当前相机视角（经纬度、高度、朝向角）。用户问「现在看的是哪里/当前视角是多少」时使用。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'zoom_to_extent',
    target: 'client',
    stage: 'mvp',
    group: 'camera',
    description: '缩放到指定地理范围（bbox）。用户给出矩形范围或说「缩放到这个区域」时使用。',
    parameters: {
      type: 'object',
      properties: {
        bbox: { type: 'array', items: { type: 'number' }, description: '[西, 南, 东, 北]' },
        duration: { type: 'number', description: '飞行时长（秒），默认 1.5' },
      },
      required: ['bbox'],
      additionalProperties: false,
    },
  },
  {
    name: 'look_at_transform',
    target: 'client',
    stage: 'mvp',
    group: 'camera',
    description: '让相机锁定并环绕注视某点（ENU 变换）。用户说「绕着这个点看/锁定这个位置」时使用；停止环绕用 stop_orbit。',
    parameters: {
      type: 'object',
      properties: {
        longitude: lon,
        latitude: lat,
        height,
        heading: { type: 'number', description: '方位角（度），默认 0' },
        pitch: { type: 'number', description: '俯仰角（度），默认 -45' },
        range: { type: 'number', description: '距目标距离（米），默认 1000' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'start_orbit',
    target: 'client',
    stage: 'mvp',
    group: 'camera',
    description: '开始相机环绕当前中心旋转（自动巡航）。用户说「转起来/自动旋转/环绕看看」时使用。',
    parameters: {
      type: 'object',
      properties: {
        speed: { type: 'number', description: '角速度（度/帧），默认 0.005' },
        clockwise: { type: 'boolean', description: '是否顺时针，默认 true' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_orbit',
    target: 'client',
    stage: 'mvp',
    group: 'camera',
    description: '停止相机环绕。用户说「停下/别转了」时使用。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },

  /* ============================ scene ============================ */
  {
    name: 'set_scene_options',
    target: 'client',
    stage: 'mvp',
    group: 'scene',
    description:
      '配置场景环境：雾、天空大气、阴影、太阳/月亮、背景色、深度测试。' +
      '用户说「开雾/关大气/加阴影/调背景色/显示太阳」时使用。只传要改的字段。',
    parameters: {
      type: 'object',
      properties: {
        fogEnabled: { type: 'boolean' },
        fogDensity: { type: 'number' },
        skyAtmosphere: { type: 'boolean', description: '是否显示天空大气' },
        groundAtmosphere: { type: 'boolean' },
        shadows: { type: 'boolean' },
        softShadows: { type: 'boolean' },
        shadowDarkness: { type: 'number' },
        sun: { type: 'boolean' },
        moon: { type: 'boolean' },
        depthTestAgainstTerrain: { type: 'boolean' },
        backgroundColor: color,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'set_globe_lighting',
    target: 'client',
    stage: 'mvp',
    group: 'scene',
    description: '开启/关闭地球光照与大气光照（昼夜效果）。用户说「打开光照/关掉太阳光照」时使用。',
    parameters: {
      type: 'object',
      properties: {
        enableLighting: { type: 'boolean' },
        dynamicAtmosphereLighting: { type: 'boolean' },
        dynamicAtmosphereLightingFromSun: { type: 'boolean' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  /* ============================ analysis ============================ */
  {
    name: 'measure',
    target: 'client',
    stage: 'mvp',
    group: 'analysis',
    description:
      '量算距离或面积。用户说「量一下距离/算面积/这条路多长/这个区域多大」时使用。' +
      'distance 至少 2 个点，area 至少 3 个点。默认会把量算图形画在地图上。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['distance', 'area'], description: '量算模式' },
        coordinates: coords,
        showOnMap: { type: 'boolean', description: '是否在地图上显示量算图形，默认 true' },
      },
      required: ['mode', 'coordinates'],
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    target: 'client',
    stage: 'mvp',
    group: 'analysis',
    description: '截取当前三维球画面并下载 PNG。用户说「截图/保存当前视图/导出图片」时使用。',
    parameters: {
      type: 'object',
      properties: { filename: { type: 'string', description: '文件名（不含扩展名）' } },
      required: [],
      additionalProperties: false,
    },
  },

  /* ------------------------------------------------------------------
   * 后续扩充位（第二批）：动画轨迹、热力图、视角书签、批量实体、高级图元
   * 把 stage 改成 'mvp' + 前端补执行器即可生效
   * ------------------------------------------------------------------ */
  {
    name: 'play_trajectory',
    target: 'client',
    stage: 'planned',
    group: 'draw',
    description: '播放移动轨迹动画（对象沿路径运动并带尾迹）。',
    parameters: {
      type: 'object',
      properties: {
        coordinates: coords,
        durationSeconds: { type: 'number' },
        trailSeconds: { type: 'number' },
        name: { type: 'string' },
      },
      required: ['coordinates'],
      additionalProperties: false,
    },
  },
  {
    name: 'control_clock',
    target: 'client',
    stage: 'planned',
    group: 'draw',
    description: '控制 Cesium 时钟（时间范围、倍速、播放/暂停）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'setTime', 'setMultiplier', 'configure'] },
        time: { type: 'string', description: 'ISO8601 时间' },
        multiplier: { type: 'number' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_heatmap',
    target: 'client',
    stage: 'planned',
    group: 'data',
    description: '基于 GeoJSON 点数据生成热力图。',
    parameters: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'GeoJSON FeatureCollection（Point）' },
        url: { type: 'string' },
        radius: { type: 'number' },
        name: { type: 'string' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'save_viewpoint',
    target: 'client',
    stage: 'planned',
    group: 'camera',
    description: '保存当前视角为书签，可用 load_viewpoint 恢复。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'load_viewpoint',
    target: 'client',
    stage: 'planned',
    group: 'camera',
    description: '恢复已保存的视角书签。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, duration: { type: 'number' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'highlight',
    target: 'client',
    stage: 'planned',
    group: 'analysis',
    description: '高亮指定图层或要素。',
    parameters: {
      type: 'object',
      properties: { layerId, featureIndex: { type: 'number' }, color, clear: { type: 'boolean' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'terrain_analysis',
    target: 'client',
    stage: 'planned',
    group: 'analysis',
    description: '地形分析：单点高程、通视分析、剖面分析、坡度坡向、淹没分析、挖填方。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['elevation', 'viewshed', 'profile', 'slope', 'flood', 'cutfill'] },
        coordinates: coords,
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_extract',
    target: 'client',
    stage: 'planned',
    group: 'analysis',
    description: '地物提取：基于影像/矢量提取建筑物、水体、道路、植被。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['building', 'water', 'road', 'vegetation'] },
        bbox: { type: 'array', items: { type: 'number' } },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'stat_query',
    target: 'client',
    stage: 'planned',
    group: 'analysis',
    description: '统计查询：按行政区或范围统计要素数量、面积、长度。',
    parameters: {
      type: 'object',
      properties: { layerId, region: { type: 'string' }, metrics: { type: 'array', items: { type: 'string' } } },
      required: [],
      additionalProperties: false,
    },
  },
];

/** 下发给 LLM 的工具（仅 mvp 阶段） */
export function getEnabledTools(): ToolDefinition[] {
  return TOOLS.filter((t) => t.stage === 'mvp');
}

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);

/**
 * 意图 → 工具分组的关键词路由。
 * 工具变多后一次性全量下发会明显拉低模型的选择准确率，这里按用户输入命中分组，
 * 只下发「常驻 core + 命中的分组」；全部没命中时退回全量，保证能力不丢失。
 */
const GROUP_KEYWORDS: Record<Exclude<ToolGroup, 'core'>, string[]> = {
  data: [
    '加载', '叠加', '打开', '导入', '载入', '数据', '图层数据',
    'geojson', 'json', 'kml', 'kmz', 'czml', 'shp', 'shapefile', '矢量',
    '3dtiles', '3d tiles', '三维模型', '白模', '倾斜摄影', '点云', 'tileset',
    'wms', 'wmts', 'wfs', 'xyz', 'arcgis', 'ogc', '服务',
    '地形', '高程', 'terrain', 'dem',
  ],
  layer: [
    '图层', '移除图层', '删除图层', '隐藏', '显示', '可见', '底图', '切换底图',
    '影像底图', '暗色', '卫星图', '街道图', '天地图', '高德', 'osm', 'basemap',
    '清空', '重置', '清除全部', '清理场景',
  ],
  draw: [
    '画', '绘制', '添加', '加个', '放个', '标注', '打点', '标记', '图标',
    '折线', '路径', '连线', '航线', '多边形', '区域', '圈', '线', '面',
    '模型', 'glb', 'gltf', '实体', 'entity', 'billboard',
    '修改', '更新', '改一下', '换个颜色', '删掉这个', '查询实体', '找实体',
  ],
  camera: [
    '相机', '视角', '镜头', '俯视', '仰视', '环绕', '旋转', '转起来', '巡航',
    '当前位置', '当前视角', '缩放到', '范围', 'bbox', '锁定', '注视',
    'orbit', '别转', '停下',
  ],
  scene: [
    '雾', '大气', '天空', '阴影', '光照', '太阳', '月亮', '背景色', '场景',
    '昼夜', '后处理', '泛光', 'bloom', '环境', 'fog', 'atmosphere', 'shadow',
  ],
  analysis: [
    '测量', '量算', '量一下', '量一量', '距离', '面积', '多长', '多大', '周长',
    '截图', '截个图', '截张图', '存图', '保存图片', '导出图片', '拍照', '快照',
    'measure', 'screenshot', '高亮', '统计', '分析',
  ],
};

interface GroupScore {
  group: Exclude<ToolGroup, 'core'>;
  score: number;
}

/** 按用户输入给各分组打分（含权重排序） */
export function scoreGroups(query: string): GroupScore[] {
  const q = query.toLowerCase();
  const hits: GroupScore[] = [];
  for (const [group, keywords] of Object.entries(GROUP_KEYWORDS) as Array<[Exclude<ToolGroup, 'core'>, string[]]>) {
    let score = 0;
    for (const kw of keywords) {
      if (q.includes(kw.toLowerCase())) score += kw.length >= 3 ? 2 : 1;
    }
    if (score > 0) hits.push({ group, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** 命中了哪些分组（按得分降序，不含 core） */
export function detectGroups(query: string): ToolGroup[] {
  return scoreGroups(query).map((h) => h.group);
}

/**
 * 按用户意图下发工具：
 * - 命中分组 → core + 命中分组（最多 3 个）
 * - 无命中 → 全量 mvp 工具（保证能力不丢，宁可多给也别漏）
 *
 * 阈值说明：口语里「打开」既可能是「打开雾效」也可能是「打开数据」，
 * 所以只保留得分不低于最高分 60% 的分组，避免弱相关分组被顺带下发。
 */
export function getToolsForIntent(query: string): ToolDefinition[] {
  const enabled = getEnabledTools();
  const scored = scoreGroups(query);
  const top = scored[0]?.score ?? 0;
  const groups = scored.filter((s) => s.score >= Math.max(2, top * 0.6)).slice(0, 3).map((s) => s.group);
  if (groups.length === 0) return enabled;
  const picked = new Set<ToolGroup>(['core', ...groups]);
  return enabled.filter((t) => picked.has(t.group));
}
