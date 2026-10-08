/** 临时脚本：验证移植后的 27 个前端命令在真实 Cesium 里能跑（用完删除） */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9500 + (Date.now() % 300);
const URL = 'http://localhost:5173/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const userDir = mkdtempSync(join(tmpdir(), 'aiearth-e2e2-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
const errors = [];
let sessionId;

async function main() {
  let wsUrl;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!wsUrl) throw new Error('Chrome 调试端口未就绪');

  ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? '?'));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('CONSOLE.ERROR: ' + (m.params.args ?? []).map((a) => a.description ?? a.value).join(' ').slice(0, 300));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));

  const send = (method, params = {}, sid) =>
    new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, (m) => (m.error ? rej(new Error(method + ' -> ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params, sessionId: sid }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  const evalJs = async (expr) => {
    const r = await send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result?.value;
  };

  log('▶ 打开 ' + URL);
  await send('Page.navigate', { url: URL }, sessionId);
  await sleep(3000);
  for (let i = 0; i < 60; i++) {
    if (await evalJs(`!!(window.__aiearth && window.__aiearth.viewer)`)) break;
    await sleep(800);
  }
  const ready = await evalJs(`!!(window.__aiearth && window.__aiearth.viewer)`);
  log('  Viewer 就绪: ' + ready);
  if (!ready) throw new Error('Viewer 未初始化');
  await sleep(3000);

  const run = async (name, args) => {
    const expr = `window.__aiearth.runCommand(${JSON.stringify(name)}, ${JSON.stringify(args)})`;
    const out = await evalJs(expr);
    return out ?? { ok: false, error: '(undefined)' };
  };

  const results = [];
  const test = async (name, args, label) => {
    let r;
    try {
      r = await run(name, args);
    } catch (e) {
      r = { ok: false, error: 'THROWN: ' + e.message };
    }
    results.push({ name, label, ok: !!r.ok, error: r.error, data: r.data });
    const brief = r.ok ? JSON.stringify(r.data).slice(0, 160) : 'ERROR: ' + r.error;
    log(`  ${r.ok ? '✓' : '✖'} ${label || name}: ${brief}`);
    return r;
  };

  log('\n=== 数据加载 ===');
  const geojson = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: '北京' }, geometry: { type: 'Point', coordinates: [116.4074, 39.9042] } },
      { type: 'Feature', properties: { name: '上海' }, geometry: { type: 'Point', coordinates: [121.4737, 31.2304] } },
      {
        type: 'Feature',
        properties: { name: '区域' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[116.0, 39.5], [116.8, 39.5], [116.8, 40.0], [116.0, 40.0], [116.0, 39.5]]],
        },
      },
    ],
  };
  const g = await test('load_geojson', { data: geojson, name: '测试点位', labelField: 'name', flyTo: false }, 'load_geojson(内联数据)');

  await test('load_kml', { data: '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>KML点</name><Point><coordinates>120,30,0</coordinates></Point></Placemark></kml>', flyTo: false }, 'load_kml(内联文本)');
  await test('load_czml', { data: [{ id: 'document', version: '1.0' }, { id: 'p1', name: 'CZML点', position: { cartographicDegrees: [114.0, 22.5, 0] }, point: { pixelSize: 10, color: { rgba: [255, 0, 0, 255] } } }], flyTo: false }, 'load_czml(内联)');
  await test('load_imagery', { url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer', serviceType: 'arcgis_mapserver', name: '测试影像', opacity: 0.5 }, 'load_imagery(arcgis)');
  await test('load_terrain', { kind: 'flat' }, 'load_terrain(flat)');
  await test('load_terrain', { kind: 'arcgis' }, 'load_terrain(arcgis)');

  log('\n=== 图层管理 ===');
  await test('list_layers', {}, 'list_layers');
  const layerId = g?.data?.layerId;
  if (layerId) {
    await test('set_layer_visibility', { layerId, visible: false }, 'set_layer_visibility(hide)');
    await test('set_layer_visibility', { layerId, visible: true }, 'set_layer_visibility(show)');
    await test('remove_layer', { layerId }, 'remove_layer');
  }
  await test('set_basemap', { basemap: 'dark' }, 'set_basemap(dark)');
  await test('set_basemap', { basemap: 'satellite' }, 'set_basemap(satellite)');

  log('\n=== 图形实体 ===');
  const line = await test('add_polyline', { coordinates: [[116.4, 39.9], [121.47, 31.23]], name: '京沪线', color: '#ff4d4f' }, 'add_polyline');
  const poly = await test('add_polygon', { coordinates: [[116.2, 39.8], [116.9, 39.8], [116.9, 40.1], [116.2, 40.1]], name: '北京框', opacity: 0.4 }, 'add_polygon');
  await test('add_billboard', { image: 'https://cesium.com/downloads/cesiumjs/releases/1.146/Build/Cesium/Assets/Images/ion-credit.png', longitude: 116.4, latitude: 39.9, name: '测试图标' }, 'add_billboard');
  await test('add_model', { url: 'https://raw.githubusercontent.com/CesiumGS/cesium/main/Apps/SampleData/models/CesiumAir/Cesium_Air.glb', longitude: 116.4, latitude: 39.9, scale: 100, name: '测试飞机' }, 'add_model');

  if (poly?.data?.entityId) {
    await test('update_entity', { entityId: poly.data.entityId, color: '#00ff00' }, 'update_entity(改色)');
  }
  await test('query_entities', { name: '北京' }, 'query_entities(按名)');
  await test('query_entities', {}, 'query_entities(全部,截断200)');

  log('\n=== 相机 ===');
  await test('get_view', {}, 'get_view');
  await test('zoom_to_extent', { bbox: [73, 18, 135, 54], duration: 1 }, 'zoom_to_extent(中国)');
  await test('set_view', { longitude: 116.4, latitude: 39.9, height: 100000, pitch: -45 }, 'set_view');
  await test('look_at_transform', { longitude: 116.4, latitude: 39.9, range: 5000 }, 'look_at_transform');
  await test('start_orbit', { speed: 0.5 }, 'start_orbit');
  await sleep(1500);
  await test('stop_orbit', {}, 'stop_orbit');

  log('\n=== 场景 ===');
  await test('set_scene_options', { fogEnabled: true, fogDensity: 0.0002, skyAtmosphere: true }, 'set_scene_options(雾+大气)');
  await test('set_globe_lighting', { enableLighting: true }, 'set_globe_lighting');

  log('\n=== 量测与输出 ===');
  await test('measure', { mode: 'distance', coordinates: [[116.4, 39.9], [121.47, 31.23]] }, 'measure(京沪距离)');
  await test('measure', { mode: 'area', coordinates: [[116.2, 39.8], [116.9, 39.8], [116.9, 40.1], [116.2, 40.1]] }, 'measure(面积)');
  await test('screenshot', { filename: 'e2e-shot' }, 'screenshot');

  log('\n=== 清理 ===');
  await test('clear_scene', { confirm: true }, 'clear_scene');

  const fatal = errors.filter((e) => /TypeError|ReferenceError|SyntaxError/.test(e) && !/Request cancelled/i.test(e));
  log('\n▶ 致命错误：' + (fatal.length ? '\n   ' + fatal.join('\n   ') : '无'));
  log('▶ console 报错（' + errors.length + '）：');
  for (const e of errors.slice(0, 12)) log('   ' + e.slice(0, 220));

  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  log(`\n★ 结果：${pass}/${results.length} 通过`);
  if (fail.length) {
    log('✖ 失败项：');
    for (const f of fail) log(`   - ${f.name} (${f.label}): ${f.error}`);
  }
  log('★ 结论：' + (fail.length === 0 && fatal.length === 0 ? 'PASS —— 移植命令全部可运行' : 'FAIL —— 见上面明细'));
}

main()
  .catch((e) => {
    console.error('✖ 脚本异常：', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { ws?.close(); } catch {}
    try { spawn('taskkill', ['/F', '/PID', String(chrome.pid), '/T'], { stdio: 'ignore' }); } catch {}
    try { rmSync(userDir, { recursive: true, force: true }); } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
