/**
 * Agent 链路自测脚本（模拟「前端执行器」）
 *
 * 用法：
 *   1) 先启动后端：npm run dev:server（或 npm run start）
 *   2) node scripts/smoke-agent.mjs "定位到北京，添加一个标注"
 *
 * 它会完整走一遍：用户消息 → 模型/规则产出 tool_calls → 假装执行 → 回传结果 → 最终回复。
 * 无论 MOCK 模式还是真实 DeepSeek 模式都能跑，用来快速验证链路是否通。
 */

delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const BASE = process.env.AIEARTH_API ?? 'http://127.0.0.1:8787/api';
const MESSAGE = process.argv.slice(2).join(' ') || '定位到北京，添加一个标注';
const SESSION = `smoke_${Date.now()}`;

async function post(path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${resp.status}）：${text.slice(0, 300)}`);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
  return json;
}

/** 假装自己是浏览器里的 Cesium：把调用参数原样回显成执行结果 */
function fakeExecute(call) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    args = {};
  }
  return {
    toolCallId: call.id,
    name: call.function.name,
    ok: true,
    result: { ...args, simulated: true, note: 'smoke 脚本模拟执行' },
    durationMs: 10,
  };
}

(async () => {
  console.log(`\n▶ 用户：${MESSAGE}\n`);
  let payload = { sessionId: SESSION, message: MESSAGE };

  for (let round = 1; round <= 6; round++) {
    const reply = await post('/chat', payload);

    if (reply.type === 'error') {
      console.error('✖ 错误：', reply.error);
      process.exit(1);
    }

    if (reply.type === 'final') {
      console.log(`✔ 最终回复：${reply.content}`);
      if (reply.toolTrace?.length) {
        console.log('  工具痕迹：', reply.toolTrace.map((t) => `${t.name}(${t.target}:${t.ok ? 'ok' : 'fail'})`).join(', '));
      }
      return;
    }

    const calls = reply.toolCalls ?? [];
    console.log(`第 ${round} 轮 · 需要执行的工具：`);
    for (const c of calls) {
      console.log(`   - ${c.function.name}  ${c.function.arguments}`);
    }
    if (reply.content) console.log(`   模型旁白：${reply.content}`);

    payload = { sessionId: SESSION, toolResults: calls.map(fakeExecute) };
  }

  console.error('✖ 超过最大轮次仍未结束');
  process.exit(1);
})().catch((err) => {
  console.error('✖ 冒烟失败：', err.message);
  console.error('  确认后端已启动：npm run dev:server（默认 8787）');
  process.exit(1);
});
