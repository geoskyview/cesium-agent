/**
 * 验证：发送指令后的「等待状态」气泡
 * 通过 CDP 拦截 /api/chat 并人为延迟，模拟模型思考很久的情况。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9500 + (Date.now() % 200);
const URL = 'http://localhost:5173/';
const SHOT = 'D:/Home/AIEarth/verify-thinking.png';
const DELAY_MS = Number(process.env.DELAY_MS ?? 7500); // 模拟模型思考；0 = 不拦截

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const userDir = mkdtempSync(join(tmpdir(), 'aiearth-thinking-'));
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
let sessionId;
const errors = [];
let msgId = 0;
const pending = new Map();

/** 只有第一轮请求被延迟 */
let delayedCount = 0;
const paused = new Map();

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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
      return;
    }
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params;
      // 只延迟第一轮（后面还有「执行完工具回传结果」的那一轮，不该再拖）
      if (/api\/chat/.test(request.url) && delayedCount++ === 0) {
        log(`  ⏸ 拦截第 1 轮 /api/chat，延迟 ${DELAY_MS}ms 后放行`);
        setTimeout(() => {
          sendRaw('Fetch.continueRequest', { requestId }, m.session);
        }, DELAY_MS);
      } else {
        sendRaw('Fetch.continueRequest', { requestId }, m.session);
      }
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (m.params?.exceptionDetails?.exception?.description ?? '?'));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('CONSOLE.ERROR: ' + (m.params.args ?? []).map((a) => a.description ?? a.value).join(' ').slice(0, 200));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));

  const sendRaw = (method, params = {}, sid) => {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params, sessionId: sid }));
    return id;
  };
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
  if (DELAY_MS > 0) {
    await send('Fetch.enable', { patterns: [{ urlPattern: '*api/chat*' }] }, sessionId);
    log(`  (已启用请求拦截，延迟 ${DELAY_MS}ms)`);
  }

  const evalJs = async (expr) => {
    const r = await send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result?.value;
  };

  const probe = () =>
    evalJs(
      `(()=>{
        const n = document.querySelector('.msg-thinking');
        if (!n) return null;
        return {
          text: n.querySelector('.thinking-text')?.textContent ?? '',
          timer: n.querySelector('.thinking-timer')?.textContent ?? '',
          dots: n.querySelectorAll('.dots i').length,
        };
      })()`,
    );

  log('▶ 打开页面');
  await send('Page.navigate', { url: URL }, sessionId);
  await sleep(4000);
  for (let i = 0; i < 60; i++) {
    const ok = await evalJs(`!!(window.__aiearth && window.__aiearth.viewer)`).catch(() => false);
    if (ok) break;
    await sleep(800);
  }
  await sleep(3000);

  log('▶ 发送指令');
  await evalJs(`
    (()=>{
      const ta = document.querySelector('.chat-textarea');
      ta.value = '定位到北京，添加一个标注';
      document.querySelector('.chat-send').click();
      return true;
    })()
  `);

  log('▶ 观察等待状态');
  await sleep(600);
  const s1 = await probe();
  log('  t=0.6s  ' + JSON.stringify(s1));

  await sleep(2600);
  const s2 = await probe();
  log('  t=3.2s  ' + JSON.stringify(s2));

  await sleep(4200);
  const s3 = await probe();
  log('  t=7.4s  ' + JSON.stringify(s3));

  // 轮询等整个会话结束（思考气泡消失 + 按钮恢复），最多 45s
  let waited = 0;
  let cleared = false;
  while (waited < 45000) {
    const st = await evalJs(
      `(()=>({thinking: !!document.querySelector('.msg-thinking'), disabled: document.querySelector('.chat-send').disabled}))()`,
    );
    if (!st.thinking && !st.disabled) {
      cleared = true;
      break;
    }
    await sleep(1000);
    waited += 1000;
  }
  log(`  等待结束耗时 ${waited}ms`);
  const s4 = await probe();
  log('  完成后  ' + JSON.stringify(s4));

  const finalState = await evalJs(
    `(()=>({
      thinking: !!document.querySelector('.msg-thinking'),
      msgs: document.querySelectorAll('.chat-messages > *').length,
      lastTexts: [...document.querySelectorAll('.chat-messages > *')].slice(-3).map(n=>n.textContent.slice(0,60)),
      sendBtn: document.querySelector('.chat-send').textContent,
      sendDisabled: document.querySelector('.chat-send').disabled,
    }))()`,
  );
  log('  最终状态 ' + JSON.stringify(finalState, null, 1));

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  log('  截图: ' + SHOT);

  const checks = [
    ['发送后立即出现思考气泡', !!s1 && s1.text.includes('正在理解')],
    ['三点动画元素存在', !!s1 && s1.dots === 3],
    ['计时器在走', !!s1 && !!s2 && s1.timer !== s2.timer],
    ['超时后文案变为「还在思考」', !!s3 && s3.text.includes('还在思考')],
    ['会话结束后气泡被移除', cleared && s4 === null],
    ['按钮恢复可用', finalState.sendDisabled === false],
    ['无控制台报错', errors.length === 0],
  ];
  log('\n==== 结果 ====');
  let pass = 0;
  for (const [name, ok] of checks) {
    log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (ok) pass++;
  }
  log(`  ${pass}/${checks.length} 通过`);
  if (errors.length) log('  错误：' + errors.slice(0, 3).join('\n      '));
  log(pass === checks.length ? '\n✅ PASS' : '\n❌ FAIL');
}

main()
  .catch((e) => {
    console.error('运行失败:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      chrome.kill();
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
