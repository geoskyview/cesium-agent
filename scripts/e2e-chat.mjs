import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9411 + (Date.now() % 200);
const URL = 'http://localhost:5173/';
const SHOT = 'D:/Home/AIEarth/verify-mvp.png';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const userDir = mkdtempSync(join(tmpdir(), 'aiearth-e2e-'));
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
  // 1) 连接 CDP
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
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? []).map((a) => a.description ?? a.value).join(' ').slice(0, 400);
      if (m.params.type === 'error') errors.push('CONSOLE.ERROR: ' + text);
      else if (m.params.type === 'warning' && /aiearth|ArcGIS|离线|降级|探测/.test(text)) log('  [warn] ' + text);
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

  const waitFor = async (expr, label, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = await evalJs(`(()=>{try{return !!(${expr})}catch(e){return false}})()`);
        if (v) {
          log(`  ✓ ${label}`);
          return true;
        }
      } catch {
        /* ignore */
      }
      await sleep(800);
    }
    throw new Error('等待超时：' + label);
  };

  // 2) 打开页面
  log('▶ 打开 ' + URL);
  await send('Page.navigate', { url: URL }, sessionId);
  await sleep(3000);
  await waitFor('document.querySelector("#cesium-container canvas")', 'Cesium canvas 已创建');
  await waitFor('window.__aiearth && window.__aiearth.viewer', 'Viewer 实例就绪');
  await waitFor('!document.getElementById("loading-mask")', '初始化完成（loading 消失）');
  await sleep(4000);

  const webgl = await evalJs(
    `(()=>{const c=document.querySelector('#cesium-container canvas'); const gl=c.getContext('webgl2')||c.getContext('webgl'); return gl? (gl.getParameter(gl.VERSION)||'ok') : 'NO-GL'})()`,
  );
  log('  WebGL: ' + webgl);

  const baseImagery = await evalJs(
    `(()=>{
      const v=window.__aiearth.viewer;
      const layers=[];
      for(let i=0;i<v.imageryLayers.length;i++){
        const l=v.imageryLayers.get(i);
        const p=l&&l.imageryProvider;
        layers.push({
          i,
          ctor: p? p.constructor.name : 'no-provider',
          url: p? (p.url||'(no url)') : 'no-provider',
          ready: p? !!p.ready : false,
        });
      }
      return {count: v.imageryLayers.length, layers};
    })()`,
  );
  log('  底图: ' + JSON.stringify(baseImagery));
  const terrain = await evalJs(`window.__aiearth.viewer.terrainProvider.constructor.name`);
  log('  地形: ' + terrain);

  // 3) 发一条自然语言指令
  log('▶ 发送指令：定位到北京，添加一个标注');
  await evalJs(
    `(()=>{const t=document.querySelector('.chat-textarea'); t.value='定位到北京，添加一个标注'; t.dispatchEvent(new Event('input',{bubbles:true})); return true})()`,
  );
  await evalJs(`(()=>{document.querySelector('.chat-send').click(); return true})()`);

  await waitFor('document.querySelectorAll(".tool-card").length >= 2', '产出 2 个工具调用', 30000);
  await waitFor(
    'document.querySelectorAll(".tool-card.done, .tool-card.failed").length >= 2',
    '工具执行完成',
    45000,
  );
  await sleep(2500);

  const cards = await evalJs(
    `Array.from(document.querySelectorAll('.tool-card')).map(c=>c.className+' | '+c.querySelector('.tool-name').textContent+' | '+c.querySelector('.tool-status').textContent)`,
  );
  log('▶ 工具卡片：');
  for (const c of cards) log('   - ' + c);

  const reply = await evalJs(
    `(()=>{const b=document.querySelectorAll('.msg-assistant .bubble'); return b.length? b[b.length-1].textContent : '(无回复)'})()`,
  );
  log('▶ 助手回复：' + reply);

  const camera = await evalJs(
    `(()=>{const v=window.__aiearth.viewer; const car=v.scene.globe.ellipsoid.cartesianToCartographic(v.camera.positionWC); return {lon:+(car.longitude*180/Math.PI).toFixed(4), lat:+(car.latitude*180/Math.PI).toFixed(4), h:Math.round(car.height)}})()`,
  );
  log('▶ 相机位置：' + JSON.stringify(camera));

  const markers = await evalJs(
    `(()=>{const ds=window.__aiearth.viewer.dataSources.getByName('aiearth-markers')[0]; return ds? ds.entities.values.map(e=>e.name) : []})()`,
  );
  log('▶ 已添加标注：' + JSON.stringify(markers));

  // 4) 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  log('▶ 截图已保存：' + SHOT);

  // 5) 结论
  const fatal = errors.filter(
    (e) => /TypeError|ReferenceError|SyntaxError/.test(e) && !/Request cancelled/i.test(e),
  );
  log('▶ 致命错误：' + (fatal.length ? '\n   ' + fatal.join('\n   ') : '无'));
  log('▶ 其它 console 报错（' + errors.length + '）：');
  for (const e of errors.slice(0, 10)) log('   ' + e.slice(0, 200));

  const ok =
    cards.length >= 2 &&
    cards.every((c) => c.includes('done')) &&
    Math.abs(camera.lon - 116.4074) < 0.5 &&
    Math.abs(camera.lat - 39.9042) < 0.5 &&
    markers.length >= 1 &&
    fatal.length === 0;
  log('\n★ 结论：' + (ok ? 'PASS —— MVP 链路跑通' : 'FAIL —— 见上面明细'));
}

main()
  .catch((e) => {
    console.error('✖ 脚本异常：', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {}
    try {
      spawn('taskkill', ['/F', '/PID', String(chrome.pid), '/T'], { stdio: 'ignore' });
    } catch {}
    try {
      rmSync(userDir, { recursive: true, force: true });
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
