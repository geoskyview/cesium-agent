import type {
  ChatReply,
  ChatRequest,
  CommandResult,
  ToolResultPayload,
} from '../../../shared/protocol';
import { fetchHealth, geocode, postChat } from '../api/client';

export interface ChatPanelDeps {
  /** 真正操作 Cesium 的入口 */
  runCommand: (name: string, args: Record<string, unknown>) => Promise<CommandResult>;
}

const TOOL_LABELS: Record<string, string> = {
  fly_to: '飞行定位',
  add_marker: '添加标注',
  clear_markers: '清除标注',
  geo_locate: '地名解析',
  load_data: '加载数据',
  screenshot: '截图输出',
  terrain_analysis: '地形分析',
  spatial_analysis: '空间分析',
  feature_extract: '地物提取',
  stat_query: '统计查询',
};

const EXAMPLES = ['定位到北京', '三维视角飞到深圳并加个标注', '飞到珠穆朗玛峰，标注它', '清空标注'];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // 始终用 textContent，避免注入
  return node;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function briefArgs(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  const place = args.place;
  if (typeof place === 'string' && place) parts.push(place);
  if (typeof args.longitude === 'number' && typeof args.latitude === 'number') {
    parts.push(`${Number(args.longitude).toFixed(3)}, ${Number(args.latitude).toFixed(3)}`);
  }
  if (typeof args.height === 'number') parts.push(`高度 ${Math.round(args.height)}m`);
  if (typeof args.pitch === 'number') parts.push(`俯仰 ${Math.round(args.pitch)}°`);
  if (typeof args.name === 'string' && args.name) parts.push(args.name);
  if (typeof args.color === 'string' && args.color) parts.push(args.color);
  return parts.length ? parts.join(' · ') : name;
}

export function mountChatPanel(root: HTMLElement, deps: ChatPanelDeps): void {
  root.replaceChildren();

  const panel = el('div', 'chat');

  /* ---------- 头部 ---------- */
  const header = el('div', 'chat-header');
  const titleBox = el('div', 'chat-title-box');
  titleBox.appendChild(el('div', 'chat-title', 'AIEarth 助手'));
  const badge = el('span', 'chat-badge', '连接中…');
  titleBox.appendChild(badge);
  header.appendChild(titleBox);
  const resetBtn = el('button', 'chat-reset', '重置会话');
  resetBtn.type = 'button';
  header.appendChild(resetBtn);
  panel.appendChild(header);

  /* ---------- 消息区 ---------- */
  const messages = el('div', 'chat-messages');
  panel.appendChild(messages);

  /* ---------- 示例 ---------- */
  const examples = el('div', 'chat-examples');
  for (const text of EXAMPLES) {
    const b = el('button', 'chip', text);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (busy) return;
      input.value = text;
      void send(text);
    });
    examples.appendChild(b);
  }
  panel.appendChild(examples);

  /* ---------- 输入区 ---------- */
  const inputWrap = el('div', 'chat-input');
  const input = el('textarea', 'chat-textarea');
  input.rows = 2;
  input.placeholder = '用自然语言指挥地球，例如：三维视角飞到北京并添加标注';
  const sendBtn = el('button', 'chat-send', '发送');
  sendBtn.type = 'button';
  inputWrap.appendChild(input);
  inputWrap.appendChild(sendBtn);
  panel.appendChild(inputWrap);

  root.appendChild(panel);

  /* ---------- 会话与状态 ---------- */
  const SESSION_KEY = 'aiearth.sessionId';
  let sessionId = localStorage.getItem(SESSION_KEY) ?? '';
  if (!sessionId) {
    sessionId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(SESSION_KEY, sessionId);
  }
  let busy = false;
  /** 空闲时 badge 该显示什么（健康检查结果），忙碌时临时换成「执行中」 */
  let badgeIdleText = '连接中…';

  function setBusy(v: boolean) {
    busy = v;
    sendBtn.disabled = v;
    input.disabled = v;
    sendBtn.textContent = v ? '执行中…' : '发送';
    badge.textContent = v ? '执行中…' : badgeIdleText;
    badge.classList.toggle('busy', v);
  }

  function addUser(text: string) {
    const wrap = el('div', 'msg msg-user');
    wrap.appendChild(el('div', 'bubble', text));
    messages.appendChild(wrap);
    scrollBottom();
  }

  function addAssistant(text: string) {
    const wrap = el('div', 'msg msg-assistant');
    wrap.appendChild(el('div', 'bubble', text));
    messages.appendChild(wrap);
    scrollBottom();
  }

  function addSystem(text: string) {
    const wrap = el('div', 'msg msg-system');
    wrap.appendChild(el('div', 'bubble', text));
    messages.appendChild(wrap);
    scrollBottom();
  }

  function addToolCard(name: string, args: Record<string, unknown>): HTMLElement {
    const card = el('div', 'tool-card running');
    const head = el('div', 'tool-head');
    head.appendChild(el('span', 'tool-dot'));
    head.appendChild(el('span', 'tool-name', TOOL_LABELS[name] ?? name));
    head.appendChild(el('span', 'tool-args', briefArgs(name, args)));
    card.appendChild(head);
    const status = el('div', 'tool-status', '执行中…');
    card.appendChild(status);
    messages.appendChild(card);
    scrollBottom();
    return card;
  }

  function finishToolCard(card: HTMLElement, ok: boolean, text: string) {
    card.classList.remove('running');
    card.classList.add(ok ? 'done' : 'failed');
    const status = card.querySelector('.tool-status');
    if (status) status.textContent = text;
  }

  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  /** 超过这个秒数还没回来，就把文案换成「还在等」，避免用户以为卡死 */
  const SLOW_HINT_SEC = 6;

  interface ThinkingHandle {
    setText: (t: string) => void;
    remove: () => void;
  }

  /** 等待 LLM 时的「思考中」气泡：跳动的三点 + 已等待秒数 */
  function addThinking(text: string): ThinkingHandle {
    const wrap = el('div', 'msg msg-assistant msg-thinking');
    const bubble = el('div', 'bubble thinking');
    const label = el('span', 'thinking-text', text);
    const dots = el('span', 'dots');
    dots.append(el('i'), el('i'), el('i'));
    const clock = el('span', 'thinking-timer', '0s');
    bubble.append(label, dots, clock);
    wrap.appendChild(bubble);
    messages.appendChild(wrap);
    scrollBottom();

    const t0 = Date.now();
    let hinted = false;
    const tick = window.setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      clock.textContent = `${sec}s`;
      if (!hinted && sec >= SLOW_HINT_SEC) {
        hinted = true;
        label.textContent = '模型还在思考，通常需要十几秒';
      }
    }, 1000);

    return {
      setText: (t) => {
        label.textContent = t;
        hinted = true; // 手动设过文案就别再被慢提示覆盖
      },
      remove: () => {
        window.clearInterval(tick);
        wrap.remove();
      },
    };
  }

  async function runToolCall(
    callId: string,
    name: string,
    rawArgs: string,
  ): Promise<ToolResultPayload> {
    const args = parseArgs(rawArgs);
    const card = addToolCard(name, args);
    const t0 = performance.now();
    const res = await deps.runCommand(name, args);
    const ms = Math.round(performance.now() - t0);
    const detail = res.ok
      ? JSON.stringify(res.data ?? {})
      : String(res.error ?? '执行失败');
    finishToolCard(card, res.ok, `${res.ok ? '完成' : '失败'} · ${ms}ms · ${detail}`);
    return {
      toolCallId: callId,
      name,
      ok: res.ok,
      result: res.data,
      error: res.error,
      durationMs: ms,
    };
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    addUser(content);
    input.value = '';
    setBusy(true);
    try {
      await converse(content);
    } catch (err) {
      addSystem(
        `请求失败：${err instanceof Error ? err.message : String(err)}\n请确认后端已启动（npm run dev:server，默认 8787 端口）。`,
      );
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  /** 一轮完整对话：可能多轮「模型决策 → 前端执行 → 回传结果」 */
  async function converse(userText?: string) {
    let payload: ChatRequest = { sessionId, message: userText };

    for (let round = 0; round < 6; round++) {
      // 每次等后端都给个可见的等待状态，否则模型思考的十几秒里界面像是卡死了
      const thinking = addThinking(round === 0 ? '正在理解你的指令' : '正在汇总上一步结果');
      let reply: ChatReply;
      try {
        reply = await postChat(payload);
      } finally {
        thinking.remove();
      }

      if (reply.type === 'error') {
        addSystem(`出错了：${reply.error}`);
        return;
      }
      if (reply.type === 'final') {
        addAssistant(reply.content);
        return;
      }

      // reply.type === 'tool_calls'
      if (reply.content && reply.content.trim()) {
        addAssistant(reply.content.trim());
      }
      const results: ToolResultPayload[] = [];
      for (const call of reply.toolCalls ?? []) {
        results.push(await runToolCall(call.id, call.function.name, call.function.arguments));
      }
      payload = { sessionId, toolResults: results };
    }
    addSystem('这一轮执行的步骤过多，我先停下了。可以把任务拆细一点。');
  }

  /* ---------- 事件绑定 ---------- */
  sendBtn.addEventListener('click', () => void send(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input.value);
    }
  });
  resetBtn.addEventListener('click', () => {
    sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(SESSION_KEY, sessionId);
    messages.replaceChildren();
    addSystem('会话已重置。');
  });

  /* ---------- 启动：健康检查 + 欢迎语 ---------- */
  addSystem('你好，我是 AIEarth 助手。试着对我说：定位到北京、三维视角飞到深圳并加个标注、清空标注。');
  void (async () => {
    try {
      const health = await fetchHealth();
      badgeIdleText = health.llmReady
        ? `${health.mode === 'mock' ? '离线规则' : health.model} · 就绪`
        : '未配置模型';
      if (!busy) badge.textContent = badgeIdleText;
      badge.classList.add(health.llmReady ? 'ok' : 'warn');
      if (!health.llmReady) {
        addSystem(`提示：${health.llmReason ?? '模型未就绪'}`);
      }
    } catch {
      badgeIdleText = '后端未连接';
      if (!busy) badge.textContent = badgeIdleText;
      badge.classList.add('warn');
      addSystem('连接后端失败，请确认已执行 npm run dev:server（端口 8787）。');
    }
  })();
}

/** 供命令执行器使用的地名兜底（模型没给坐标时） */
export async function geocodeFallback(query: string) {
  try {
    const r = await geocode(query);
    return r.found && r.longitude !== undefined && r.latitude !== undefined
      ? { name: r.name ?? query, longitude: r.longitude, latitude: r.latitude }
      : null;
  } catch {
    return null;
  }
}
