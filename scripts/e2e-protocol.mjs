#!/usr/bin/env node
/**
 * 协议一致性回归（不需要真模型、不开浏览器）
 *
 * 起一个假的 OpenAI 兼容服务，它像 DeepSeek 一样校验 messages 是否满足
 * tool_calls 协议不变式，然后用脚本化的「模型回复」驱动真实 Agent 后端，
 * 覆盖各种异常时序（工具结果没回传、重复回传、跨轮回传、连续多轮等）。
 *
 * 用法：node scripts/e2e-protocol.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const FAKE_PORT = 8901;
const BACKEND_PORT = 8902;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}/v1`;

/* ──────────────── 假模型：脚本化回复 + 协议校验 ──────────────── */

/** 当前脚本队列，由测试驱动方设置 */
let queue = [];
/** 最近一次收到的 messages，出错时用于诊断 */
let lastMessages = [];
/** 校验不通过的记录 */
const violations = [];

/**
 * OpenAI/DeepSeek 的 tool_calls 协议不变式：
 * 1. 每条 role=tool 必须能对应到「它前面最近一条 assistant.tool_calls」里的某个 id
 * 2. 一条 assistant.tool_calls 里每个 id 都必须被后续的 tool 消息回应，
 *    期间不能插入新的 assistant / user 消息
 */
function validateProtocol(messages) {
  let open = null; // { ids: string[] }
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (open && open.ids.length > 0) {
        return `An assistant message with 'tool_calls' must be followed by tool messages responding to each tool_call_id（缺: ${open.ids.join(',')}）`;
      }
      const calls = m.tool_calls ?? [];
      open = calls.length ? { ids: calls.map((c) => c.id) } : null;
    } else if (m.role === 'tool') {
      if (!open) {
        return `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'（孤儿 tool: ${m.tool_call_id}）`;
      }
      if (!open.ids.includes(m.tool_call_id)) {
        return `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'（id 不匹配: ${m.tool_call_id}）`;
      }
      // 顺序也要和 tool_calls 一致：部分厂商按序匹配，错位一样报 400
      if (open.ids[0] !== m.tool_call_id) {
        return `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'（顺序错位: 期望 ${open.ids[0]}，实际 ${m.tool_call_id}）`;
      }
      open.ids.shift();
    } else if (m.role === 'user') {
      if (open && open.ids.length > 0) {
        return `An assistant message with 'tool_calls' must be followed by tool messages responding to each tool_call_id（缺: ${open.ids.join(',')}）`;
      }
      open = null;
    }
  }
  // 末尾还挂着没被回应的 tool_calls，模型一样会拒绝
  if (open && open.ids.length > 0) {
    return `An assistant message with 'tool_calls' must be followed by tool messages responding to each tool_call_id（缺: ${open.ids.join(',')}）`;
  }
  return null;
}

function fakeLlmServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (!req.url.includes('/chat/completions')) return send(200, { data: [] });

      const parsed = JSON.parse(body || '{}');
      lastMessages = parsed.messages ?? [];

      const bad = validateProtocol(lastMessages);
      if (bad) {
        violations.push(bad);
        return send(400, {
          error: { message: bad, type: 'invalid_request_error', code: 'invalid_request_error' },
        });
      }

      const next = queue.shift() ?? { role: 'assistant', content: '（脚本用尽，默认回复）' };
      send(200, {
        id: 'fake',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model ?? 'fake',
        choices: [{ index: 0, message: next, finish_reason: next.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });
  });
}

/* ──────────────── 脚本化的模型回复 ──────────────── */

const tc = (id, name, args = {}) => ({
  type: 'function',
  id,
  function: { name, arguments: JSON.stringify(args) },
});
const asstTc = (calls, content = null) => ({ role: 'assistant', content, tool_calls: calls });
const asstText = (t) => ({ role: 'assistant', content: t });

const okResult = (toolCallId, name) => ({ toolCallId, name, ok: true, result: { done: true } });

/* ──────────────── 场景 ──────────────── */

async function chat(payload) {
  const resp = await fetch(`${BACKEND}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: resp.status, body: await resp.json() };
}

const scenarios = [];

function scenario(name, fn) {
  scenarios.push({ name, fn });
}

scenario('A 基线：单条客户端工具 → 回传结果 → 收尾', async () => {
  queue = [asstTc([tc('c1', 'fly_to', { place: '北京' })]), asstText('已飞到北京')];
  const r1 = await chat({ sessionId: 'sA', message: '定位到北京' });
  if (r1.body.type !== 'tool_calls') return `第一步不是 tool_calls：${JSON.stringify(r1.body).slice(0, 120)}`;
  const r2 = await chat({ sessionId: 'sA', toolResults: [okResult('c1', 'fly_to')] });
  if (r2.body.type !== 'final') return `第二步不是 final：${JSON.stringify(r2.body).slice(0, 120)}`;
  return null;
});

scenario('B 混合：一轮里同时有服务端工具与客户端工具', async () => {
  queue = [
    asstTc([
      tc('g1', 'geo_locate', { query: '北京' }),
      tc('c2', 'fly_to', { longitude: 116.4, latitude: 39.9 }),
      tc('c3', 'add_marker', { longitude: 116.4, latitude: 39.9, name: '北京' }),
    ]),
    asstText('已完成定位与标注'),
  ];
  const r1 = await chat({ sessionId: 'sB', message: '定位到北京并加标注' });
  if (r1.body.type !== 'tool_calls') return `第一步异常：${JSON.stringify(r1.body).slice(0, 160)}`;
  const r2 = await chat({
    sessionId: 'sB',
    toolResults: [okResult('c2', 'fly_to'), okResult('c3', 'add_marker')],
  });
  if (r2.body.type !== 'final') return `第二步异常：${JSON.stringify(r2.body).slice(0, 160)}`;
  return null;
});

scenario('C 连续多轮：客户端工具 → 回传 → 再调客户端工具 → 回传', async () => {
  queue = [
    asstTc([tc('c1', 'fly_to', { place: '上海' })]),
    asstTc([tc('c2', 'add_marker', { place: '上海' })]),
    asstText('好了'),
  ];
  const r1 = await chat({ sessionId: 'sC', message: '飞到上海并标注' });
  const r2 = await chat({ sessionId: 'sC', toolResults: [okResult('c1', 'fly_to')] });
  if (r2.body.type !== 'tool_calls') return `第二轮未继续：${JSON.stringify(r2.body).slice(0, 160)}`;
  const r3 = await chat({ sessionId: 'sC', toolResults: [okResult('c2', 'add_marker')] });
  if (r3.body.type !== 'final') return `第三轮异常：${JSON.stringify(r3.body).slice(0, 160)}`;
  return null;
});

scenario('D 放弃回传：模型要了工具但前端没回结果，用户又发了新指令', async () => {
  queue = [
    asstTc([tc('c1', 'fly_to', { place: '广州' })]),
    asstTc([tc('c2', 'list_layers', {})]),
    asstText('图层列表如下'),
  ];
  await chat({ sessionId: 'sD', message: '飞到广州' }); // 故意不回传结果
  const r2 = await chat({ sessionId: 'sD', message: '图层列表' });
  if (r2.status !== 200) return `第二条指令被协议错误打断：HTTP ${r2.status} ${JSON.stringify(r2.body).slice(0, 160)}`;
  return null;
});

scenario('E 重复回传：同一批结果被前端发了两次', async () => {
  queue = [
    asstTc([tc('c1', 'fly_to', { place: '深圳' })]),
    asstText('已到达深圳'),
    asstText('（多出来的一轮）'),
  ];
  await chat({ sessionId: 'sE', message: '飞到深圳' });
  await chat({ sessionId: 'sE', toolResults: [okResult('c1', 'fly_to')] });
  const r3 = await chat({ sessionId: 'sE', toolResults: [okResult('c1', 'fly_to')] });
  if (r3.status !== 200 && r3.status !== 400) return `意外状态 ${r3.status}`;
  // 再发一条正常指令，确认会话还能用
  queue.push(asstText('还在'));
  const r4 = await chat({ sessionId: 'sE', message: '继续' });
  if (r4.status !== 200) return `会话已损坏：HTTP ${r4.status} ${JSON.stringify(r4.body).slice(0, 160)}`;
  return null;
});

scenario('F 部分回传：一轮要了 2 个客户端工具，前端只回了 1 个', async () => {
  queue = [
    asstTc([tc('c1', 'fly_to', { place: '成都' }), tc('c2', 'add_marker', { place: '成都' })]),
    asstText('完成'),
  ];
  await chat({ sessionId: 'sF', message: '飞到成都并标注' });
  const r2 = await chat({ sessionId: 'sF', toolResults: [okResult('c1', 'fly_to')] }); // 少回一个
  if (r2.status !== 200) return `部分回传导致协议错误：HTTP ${r2.status} ${JSON.stringify(r2.body).slice(0, 160)}`;
  return null;
});

scenario('G 跨轮旧结果：把上一轮的结果又发了一次（模拟竞态）', async () => {
  queue = [
    asstTc([tc('c1', 'fly_to', { place: '武汉' })]),
    asstText('已到武汉'),
    asstTc([tc('c2', 'list_layers', {})]),
    asstText('图层：[]'),
  ];
  await chat({ sessionId: 'sG', message: '飞到武汉' });
  await chat({ sessionId: 'sG', toolResults: [okResult('c1', 'fly_to')] });
  const r3 = await chat({
    sessionId: 'sG',
    message: '图层列表',
    toolResults: [okResult('c1', 'fly_to')], // 旧结果夹带进新请求
  });
  if (r3.status !== 200) return `旧结果夹带导致协议错误：HTTP ${r3.status} ${JSON.stringify(r3.body).slice(0, 160)}`;
  return null;
});

scenario('H 纯服务端工具：模型只调服务端工具，应就地消化后继续', async () => {
  queue = [asstTc([tc('g1', 'geo_locate', { query: '西安' })]), asstText('西安在 108.9, 34.3')];
  const r1 = await chat({ sessionId: 'sH', message: '西安在哪' });
  if (r1.status !== 200) return `HTTP ${r1.status} ${JSON.stringify(r1.body).slice(0, 160)}`;
  if (r1.body.type !== 'final') return `应直接收尾，实际：${r1.body.type}`;
  return null;
});

scenario('I 未知工具：模型调了一个不存在的工具名', async () => {
  queue = [asstTc([tc('x1', 'not_a_tool', {})]), asstText('没有这个能力')];
  const r1 = await chat({ sessionId: 'sI', message: '做个不存在的操作' });
  if (r1.status !== 200) return `HTTP ${r1.status} ${JSON.stringify(r1.body).slice(0, 160)}`;
  return null;
});

scenario('L 混排顺序：模型先给浏览器工具、再给服务端工具', async () => {
  queue = [
    asstTc([
      tc('c1', 'fly_to', { place: '南京' }),
      tc('g1', 'geo_locate', { query: '南京' }),
      tc('c2', 'add_marker', { place: '南京' }),
    ]),
    asstText('已到南京并标注'),
  ];
  const r1 = await chat({ sessionId: 'sL', message: '飞到南京并标注' });
  if (r1.body.type !== 'tool_calls') return `第一步异常：${JSON.stringify(r1.body).slice(0, 160)}`;
  const r2 = await chat({
    sessionId: 'sL',
    toolResults: [okResult('c1', 'fly_to'), okResult('c2', 'add_marker')],
  });
  if (r2.status !== 200) return `回传后失败：HTTP ${r2.status} ${JSON.stringify(r2.body).slice(0, 160)}`;
  if (r2.body.type !== 'final') return `第二步不是 final：${JSON.stringify(r2.body).slice(0, 160)}`;
  return null;
});

scenario('K 并发：同一会话被两个请求同时驱动（多标签页 / 重复提交）', async () => {
  queue = [
    asstTc([tc('c1', 'fly_to', { place: '杭州' })]),
    asstTc([tc('c2', 'list_layers', {})]),
    asstText('完成'),
  ];
  const [r1, r2] = await Promise.all([
    chat({ sessionId: 'sK', message: '飞到杭州' }),
    chat({ sessionId: 'sK', message: '图层列表' }),
  ]);
  if (r1.status !== 200) return `并发请求 A 失败：HTTP ${r1.status} ${JSON.stringify(r1.body).slice(0, 120)}`;
  if (r2.status !== 200) return `并发请求 B 失败：HTTP ${r2.status} ${JSON.stringify(r2.body).slice(0, 120)}`;
  return null;
});

scenario('J 长会话：连续多轮后仍满足协议不变式', async () => {
  const sid = 'sJ';
  queue = [];
  for (let i = 0; i < 12; i++) {
    queue.push(asstTc([tc(`c${i}`, 'fly_to', { place: `城市${i}` })]));
    queue.push(asstText(`已到第 ${i} 个城市`));
  }
  for (let i = 0; i < 12; i++) {
    const r1 = await chat({ sessionId: sid, message: `飞到城市${i}` });
    if (r1.status !== 200) return `第 ${i} 轮请求失败：${JSON.stringify(r1.body).slice(0, 160)}`;
    if (r1.body.type !== 'tool_calls') return `第 ${i} 轮不是 tool_calls`;
    const r2 = await chat({ sessionId: sid, toolResults: [okResult(`c${i}`, 'fly_to')] });
    if (r2.status !== 200) return `第 ${i} 轮回传失败：${JSON.stringify(r2.body).slice(0, 160)}`;
  }
  return null;
});

/* ──────────────── 主流程 ──────────────── */

async function waitHealth(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BACKEND}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  return false;
}

async function main() {
  const fake = fakeLlmServer();
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
  console.log(`假模型服务: ${FAKE_BASE}`);

  // Windows 下 node 的 spawn 找不到 npm（PATH 里是 npm.cmd），必须走 cmd
  const backend = spawn('cmd', ['/c', 'npm', '--prefix', 'server', 'run', 'start'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      MOCK_LLM: 'false',
      LLM_PROVIDER: 'custom',
      LLM_BASE_URL: FAKE_BASE,
      LLM_MODEL: 'fake-model',
      LLM_API_KEY: 'sk-fake',
      AGENT_MAX_HISTORY: '40',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const backendLog = [];
  backend.stdout.on('data', (d) => backendLog.push(String(d)));
  backend.stderr.on('data', (d) => backendLog.push(String(d)));

  const up = await waitHealth();
  if (!up) {
    console.error('后端没起来：\n' + backendLog.join(''));
    backend.kill('SIGKILL');
    fake.close();
    process.exit(1);
  }
  console.log(`后端实例: ${BACKEND}\n`);

  let failed = 0;
  for (const s of scenarios) {
    violations.length = 0;
    let err = null;
    try {
      err = await s.fn();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const v = violations.length ? violations[0] : null;
    const bad = err || v;
    if (bad) failed++;
    console.log(`${bad ? '✗' : '✓'} ${s.name}`);
    if (bad) {
      console.log(`    业务结果: ${err ?? '（无）'}`);
      if (v) console.log(`    协议违规: ${v}`);
    }
  }

  console.log(`\n结果：${scenarios.length - failed}/${scenarios.length} 通过`);
  if (failed) {
    console.log('\n最后一批收到的消息结构（诊断用）：');
    console.log(
      lastMessages
        .map((m) => {
          const ids = m.tool_calls ? m.tool_calls.map((c) => c.id).join(',') : '';
          return `  ${m.role}${ids ? `[tc:${ids}]` : ''}${m.tool_call_id ? `[->${m.tool_call_id}]` : ''}`;
        })
        .join('\n'),
    );
  }

  backend.kill('SIGKILL');
  fake.close();
  process.exit(failed ? 1 : 0);
}

void main();
