import type { LlmMessage, ToolCall } from '../../../shared/protocol';
import type { LlmResult } from './llm';
import { extractPlace } from '../tools/geo';

/**
 * 离线规则引擎：没配 DEEPSEEK_API_KEY 时用它顶替模型，
 * 目的只有一个 —— 让「前端 → 后端 → 工具 → 地球」这条链路能先跑通。
 * 真接入模型后这个文件不会再被用到（config.mock = false）。
 */

let seq = 0;
const nextId = (name: string) => `call_${name}_${Date.now().toString(36)}_${++seq}`;

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content ?? '';
  }
  return '';
}

function tailToolMessages(messages: LlmMessage[], max = 6): { name: string; payload: Record<string, unknown> }[] {
  const out: { name: string; payload: Record<string, unknown> }[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < max; i--) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    try {
      out.unshift({ name: m.name ?? '', payload: JSON.parse(m.content ?? '{}') });
    } catch {
      out.unshift({ name: m.name ?? '', payload: {} });
    }
  }
  return out;
}

/** 工具结果里的数组字段（类型不确定时安全取用） */
function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function describeToolResult(entry: { name: string; payload: Record<string, unknown> }): string {
  const p = entry.payload;
  switch (entry.name) {
    case 'fly_to': {
      const lon = Number(p.longitude ?? 0);
      const lat = Number(p.latitude ?? 0);
      const h = Number(p.cameraHeight ?? p.height ?? 0);
      const place = p.place ? `${p.place} ` : '';
      return `已飞行定位到 ${place}（${lon.toFixed(4)}, ${lat.toFixed(4)}），相机高度 ${Math.round(h)} 米，俯仰角 ${Math.round(Number(p.pitch ?? -45))}°`;
    }
    case 'add_marker': {
      const lon = Number(p.longitude ?? 0);
      const lat = Number(p.latitude ?? 0);
      return `已添加标注「${p.name ?? '未命名'}」（${lon.toFixed(4)}, ${lat.toFixed(4)}）`;
    }
    case 'clear_markers':
      return `已清除 ${p.removed ?? 0} 个标注`;
    case 'geo_locate':
      return p.found ? `查询到「${p.name}」的坐标` : `没查到「${p.query}」的坐标`;
    case 'load_geojson':
    case 'load_kml':
    case 'load_czml':
    case 'load_3dtiles':
    case 'load_imagery':
      return `已加载图层「${p.name ?? '未命名'}」（${p.layerId ?? '-'}）${p.featureCount !== undefined ? `，共 ${p.featureCount} 个要素` : ''}`;
    case 'load_terrain':
      return `地形已切换为 ${p.kind}`;
    case 'list_layers':
      return `当前共 ${p.count ?? 0} 个图层`;
    case 'set_basemap':
      return `底图已切换为 ${p.basemap}`;
    case 'get_view':
      return `当前视角：经度 ${p.longitude}，纬度 ${p.latitude}，高度 ${Math.round(Number(p.height ?? 0))} 米，俯仰角 ${p.pitch}°`;
    case 'measure':
      return `量算结果（${p.mode === 'area' ? '面积' : '距离'}）：${p.display ?? p.value}`;
    case 'screenshot':
      return `已截图并下载：${p.filename}`;
    case 'clear_scene':
      return `场景已清空（图层 ${p.removedLayers ?? 0} 个，实体 ${p.removedEntities ?? 0} 个）`;
    case 'set_scene_options':
      return `场景参数已更新：${asList(p.applied).join('、')}`;
    case 'set_globe_lighting':
      return `地球光照已更新：${asList(p.applied).join('、')}`;
    case 'start_orbit':
      return '相机已开始环绕';
    case 'stop_orbit':
      return '相机已停止环绕';
    default:
      return `已执行 ${entry.name}`;
  }
}

/**
 * 离线模式下能直接响应的「单动作」指令。
 * 只覆盖不需要外部数据、不依赖上下文 ID 的工具 —— 这样即使没配 Key 也能演示新能力。
 */
function matchSimpleCommand(text: string): ToolCall | null {
  const call = (name: string, args: Record<string, unknown>) => ({
    id: nextId(name),
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });

  if (/截图|截个图|保存图片|导出图片|拍个照/.test(text)) return call('screenshot', { filename: `aiearth-${Date.now()}` });
  if (/当前视角|现在看的是|相机在哪|视角是多少/.test(text)) return call('get_view', {});
  if (/图层列表|有哪些图层|列出图层|有什么图层/.test(text)) return call('list_layers', {});
  if (/停止环绕|别转了|停下旋转|停止旋转/.test(text)) return call('stop_orbit', {});
  if (/环绕|转起来|自动旋转|巡航/.test(text)) return call('start_orbit', { speed: 0.5 });

  if (/暗色底图|深色底图/.test(text)) return call('set_basemap', { basemap: 'dark' });
  if (/浅色底图|白色底图/.test(text)) return call('set_basemap', { basemap: 'light' });
  if (/影像底图|卫星底图/.test(text)) return call('set_basemap', { basemap: 'satellite' });
  if (/天地图/.test(text)) return call('set_basemap', { basemap: 'tianditu_vec' });
  if (/高德/.test(text)) return call('set_basemap', { basemap: 'amap' });
  if (/osm|开放街道|街道图/.test(text)) return call('set_basemap', { basemap: 'osm' });

  if (/开雾|起雾|雾效/.test(text)) return call('set_scene_options', { fogEnabled: true, fogDensity: 0.0002 });
  if (/关雾|去掉雾/.test(text)) return call('set_scene_options', { fogEnabled: false });
  if (/开阴影|阴影/.test(text)) return call('set_scene_options', { shadows: true });
  if (/关阴影/.test(text)) return call('set_scene_options', { shadows: false });
  if (/开光照|打开光照|地球光照/.test(text)) return call('set_globe_lighting', { enableLighting: true });
  if (/关光照|关闭光照/.test(text)) return call('set_globe_lighting', { enableLighting: false });

  if (/扁平地形|去掉地形|关掉地形|无地形/.test(text)) return call('load_terrain', { kind: 'flat' });
  if (/加载地形|开启地形|高程地形|arcgis地形/.test(text)) return call('load_terrain', { kind: 'arcgis' });

  return null;
}

export function mockLlm(messages: LlmMessage[]): LlmResult {
  const last = messages[messages.length - 1];

  // 工具已执行完 → 收尾，给出自然语言总结
  if (last?.role === 'tool') {
    const tools = tailToolMessages(messages);
    const lines = tools.map((t) => describeToolResult(t)).filter(Boolean);
    const content = lines.length
      ? `${lines.join('；')}。（当前为离线规则模式，未接入 DeepSeek）`
      : '操作已完成。（当前为离线规则模式，未接入 DeepSeek）';
    return { message: { role: 'assistant', content } };
  }

  const text = lastUserText(messages) || (last?.content ?? '');
  const lower = text.toLowerCase();

  // 先把「不需要外部数据」的单动作指令处理掉，避免被下面的飞行/标注规则抢走
  const simple = matchSimpleCommand(text);
  if (simple) return { message: { role: 'assistant', content: '好的，我来操作地球。', tool_calls: [simple] } };

  const wantClear = /清空|清除|清掉|删掉所有|删除所有/.test(text);
  const wantMarker = /标注|标记|打点|加个点|图钉|地标|标记点|pin/.test(text);
  const wantFly = /定位|飞到|飞往|飞行|去|看看|看一下|视角|放大|缩小|俯视|跳转|到/.test(text);
  const is3d = /三维|立体|倾斜|斜着|斜视/.test(text);
  const isTop = /正上方|垂直俯视|正射|顶视|俯视/.test(text);

  const place = extractPlace(text);
  const toolCalls: ToolCall[] = [];

  // 「清空标注」里也含「标注」，所以要让清空独占，避免又清又加
  const exclusiveClear = wantClear && !wantFly;

  if (wantClear) {
    toolCalls.push({
      id: nextId('clear_markers'),
      type: 'function',
      function: { name: 'clear_markers', arguments: JSON.stringify({ confirm: true }) },
    });
  }

  if (!exclusiveClear && (wantFly || (wantMarker && place))) {
    let height = 10000;
    let pitch = -45;
    if (place?.type === 'province') height = 300000;
    else if (place?.type === 'landmark') height = 1500;
    else if (place?.type === 'city') height = 10000;
    if (isTop) pitch = -90;
    if (is3d) pitch = -45;
    if (/省|自治区|全国|中国/.test(text) && place?.type !== 'landmark') height = Math.max(height, 300000);
    if (/建筑|楼|街区|近一点|看清楚/.test(text)) height = Math.min(height, 600);

    toolCalls.push({
      id: nextId('fly_to'),
      type: 'function',
      function: {
        name: 'fly_to',
        arguments: JSON.stringify({
          place: place?.name,
          longitude: place?.lon,
          latitude: place?.lat,
          height,
          pitch,
          duration: 3,
        }),
      },
    });
  }

  if (!exclusiveClear && wantMarker) {
    toolCalls.push({
      id: nextId('add_marker'),
      type: 'function',
      function: {
        name: 'add_marker',
        arguments: JSON.stringify({
          name: place?.name ?? '标注点',
          place: place?.name,
          longitude: place?.lon,
          latitude: place?.lat,
          flyTo: false,
        }),
      },
    });
  }

  if (toolCalls.length) {
    return {
      message: {
        role: 'assistant',
        content: '好的，我来操作地球。',
        tool_calls: toolCalls,
      },
    };
  }

  if (/你好|hi|hello|你是谁|能做什么/.test(lower)) {
    return {
      message: {
        role: 'assistant',
        content:
          '我是 AIEarth 助手（离线规则模式）。可以试着说：定位到北京 / 三维视角飞到深圳并加个标注 / 清空标注。在 server/.env 里配好 LLM_PROVIDER 与对应的 API Key 后，我会接入真实大模型来理解你的指令。',
      },
    };
  }

  return {
    message: {
      role: 'assistant',
      content:
        '离线规则模式没看懂这句话。在 server/.env 里配好 LLM_PROVIDER 与对应的 API Key 后，会由真实大模型来解析；现在可以先试：定位到北京、三维视角飞到深圳并加个标注、清空标注。',
    },
  };
}
