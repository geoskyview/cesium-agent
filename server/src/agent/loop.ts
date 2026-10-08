import { config } from '../config';
import {
  callLlm,
  classifyLlmError,
  LlmError,
  type LlmResult,
} from './llm';
import { mockLlm } from './mock';
import { SYSTEM_PROMPT } from './prompt';
import { buildKnowledgeContext, buildKnowledgeIndex } from './knowledge';
import { describeRepair, hasRepair, sanitizeMessages, stripToolMessages } from './history';
import { getTool, getToolsForIntent, type ToolDefinition } from '../../../shared/tools';
import type { ChatReply, ChatRequest, LlmMessage, ToolResultPayload } from '../../../shared/protocol';
import type { Session, ToolTraceItem } from '../session/types';
import { executeServerTool } from '../tools/serverTools';

/**
 * system prompt 不进会话存储，每次调用时前置，便于热更新。
 * 知识片段按本轮意图检索后拼进去，避免 14 个领域全量注入撑爆上下文。
 *
 * 前置动作：调用模型前先给会话历史做一次「协议体检」——
 * 前端刷新、工具执行异常、用户中途插话都会让 tool_calls 协议破裂，
 * 一旦破了，这个会话后面每次问模型都是 400，只能重置。所以这里就地修好。
 */
function buildLlmMessages(session: Session, knowledge: string): LlmMessage[] {
  const { messages, report } = sanitizeMessages(session.messages);
  if (hasRepair(report)) {
    console.warn(`[agent] 会话历史已修复：${describeRepair(report)}`);
    session.messages = messages;
    // 已经补成「未执行」的调用不再等待回传，否则再来一次结果会写出重复的 tool 消息
    for (const id of report.filledIds) {
      session.pendingToolCallIds.delete(id);
      session.stagedToolResults.delete(id);
    }
  }

  const history = session.messages.slice(-config.maxHistory);
  const system = knowledge ? `${SYSTEM_PROMPT}\n\n${KNOWLEDGE_HINT}\n\n${knowledge}` : SYSTEM_PROMPTwithIndex();
  return [{ role: 'system', content: system }, ...history];
}

/** 没有命中任何领域时，至少让模型知道有哪些领域可查 */
function SYSTEM_PROMPTwithIndex(): string {
  const index = buildKnowledgeIndex();
  return index ? `${SYSTEM_PROMPT}\n\n${KNOWLEDGE_HINT}\n\n# 可用领域索引\n${index}` : SYSTEM_PROMPT;
}

const KNOWLEDGE_HINT =
  '# CesiumJS 知识库\n' +
  '下面是 CesiumJS 官方权威用法片段。当你需要判断某个 Cesium 能力怎么表达、参数怎么给时，' +
  '优先遵守它，不要凭记忆想当然（尤其是坐标系顺序、贴地选项、异步加载这些坑点）。';

/** 代表「工具协议被打破」的 400，值得自愈而不是直接抛给用户 */
const PROTOCOL_ERROR = /tool_calls|role 'tool'|tool_call_id/i;

/** 取本轮用于意图识别的文本：新消息优先，否则会话里最后一条用户消息 */
function intentText(session: Session, input: ChatRequest): string {
  if (input.message && input.message.trim()) return input.message.trim();
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === 'user') return session.messages[i].content ?? '';
  }
  return '';
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function resultToToolMessage(res: ToolResultPayload): LlmMessage {
  const payload =
    res.ok && res.result && typeof res.result === 'object'
      ? { ok: true, ...(res.result as Record<string, unknown>) }
      : res.ok
        ? { ok: true, value: res.result }
        : { ok: false, error: res.error ?? '工具执行失败' };
  return {
    role: 'tool',
    tool_call_id: res.toolCallId,
    name: res.name,
    content: JSON.stringify(payload),
  };
}

/** 找历史里最后一条带 tool_calls 的 assistant（末尾只允许隔着 tool 消息） */
function lastToolCallIndex(session: Session): number {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) return i;
    if (m.role === 'tool') continue;
    break;
  }
  return -1;
}

/**
 * 把本轮结果写进历史，顺序严格按模型给出的 tool_calls 顺序。
 * 顺序不是洁癖：一轮里服务端工具和浏览器工具混排时，
 * 服务端结果会先落地，若直接追加就会和 tool_calls 的次序对不上，
 * 部分厂商（DeepSeek 已实测）会直接 400。
 */
function flushToolRound(
  session: Session,
  posted: Map<string, ToolResultPayload>,
): ToolResultPayload[] {
  const idx = lastToolCallIndex(session);
  if (idx < 0) return [];

  const written: ToolResultPayload[] = [];
  for (const c of session.messages[idx].tool_calls ?? []) {
    const r = posted.get(c.id) ?? session.stagedToolResults.get(c.id);
    if (!r) continue; // 没回来的那部分由 sanitize 补「未执行」
    session.messages.push(resultToToolMessage(r));
    session.pendingToolCallIds.delete(c.id);
    written.push(r);
  }
  session.stagedToolResults.clear();
  return written;
}

/**
 * 一次模型决策。真实模型不可用时：
 * - LLM_FALLBACK_TO_MOCK=true → 降级到离线规则，并在最终回复里明确告知，绝不静默假装是 AI 干的
 * - 否则抛出 LlmError，由路由层翻译成用户能看懂的提示
 */
async function decide(
  messages: LlmMessage[],
  tools: ToolDefinition[] | undefined,
  degraded: { current: LlmError | null },
): Promise<LlmResult> {
  if (config.mock) return mockLlm(messages);
  try {
    return await callLlm(messages, tools);
  } catch (err) {
    const e = err instanceof LlmError ? err : classifyLlmError(err);
    if (!config.fallbackToMock) throw e;
    degraded.current = e;
    return mockLlm(messages);
  }
}

/**
 * 带自愈的模型调用：万一协议还是被打破（模型返回了畸形 id、
 * 或厂商校验比我们更严），就地修历史重试，而不是让整个会话废掉。
 */
async function decideWithRepair(
  session: Session,
  tools: ToolDefinition[] | undefined,
  degraded: { current: LlmError | null },
  knowledge: string,
): Promise<LlmResult> {
  const attempt = () => decide(buildLlmMessages(session, knowledge), tools, degraded);

  try {
    return await attempt();
  } catch (err) {
    const e = err instanceof LlmError ? err : classifyLlmError(err);
    if (config.fallbackToMock) {
      degraded.current = e;
      return mockLlm(buildLlmMessages(session, knowledge));
    }
    if (e.status !== 400 || !PROTOCOL_ERROR.test(e.message)) throw e;

    // 温和修复没生效 → 动手术：剥掉历史里所有工具相关消息
    session.messages = stripToolMessages(session.messages);
    session.pendingToolCallIds.clear();
    session.stagedToolResults.clear();
    console.warn(`[agent] 工具协议错误，已剥离历史中的工具消息后重试：${e.message}`);
    try {
      return await attempt();
    } catch {
      // 还不行就把历史压到最后一条用户消息，保证这个会话还能继续用
      const lastUser = [...session.messages].reverse().find((m) => m.role === 'user');
      session.messages = lastUser ? [lastUser] : [];
      console.warn('[agent] 剥离后仍失败，已重置会话历史后重试');
      return await attempt();
    }
  }
}

function degradedPrefix(e: LlmError): string {
  return `⚠️ 模型调用失败（${e.message}），本次由**离线规则模式**兜底执行，不是模型真实理解的结果。\n\n`;
}

/**
 * Agent 主循环（服务端视角）
 *
 * 一次 turn 里可能反复「模型决策 → 服务端执行 → 再决策」，
 * 一旦出现需要浏览器执行的工具，就把调用单返回给前端，等前端回传结果后继续。
 */
export async function runAgentTurn(session: Session, input: ChatRequest): Promise<ChatReply> {
  const trace: ToolTraceItem[] = [];
  const serverExecuted: ToolResultPayload[] = [];

  if (input.message && input.message.trim()) {
    session.messages.push({ role: 'user', content: input.message.trim() });
  }

  // 回传的前端执行结果：只接受本会话真正等待的 id
  const posted = new Map<string, ToolResultPayload>();
  for (const r of input.toolResults ?? []) {
    if (!r?.toolCallId || !session.pendingToolCallIds.has(r.toolCallId)) continue;
    posted.set(r.toolCallId, r);
  }
  // 按模型给的 tool_calls 顺序写回，服务端结果与前端结果一起排好序
  if (posted.size) {
    for (const r of flushToolRound(session, posted)) {
      trace.push({ name: r.name, target: 'client', ok: r.ok });
    }
  }

  if (!input.message && posted.size === 0) {
    return {
      type: 'error',
      sessionId: session.id,
      error: input.toolResults?.length
        ? '这批工具结果已经没有对应的等待项了（后端可能重启过，或会话已重置），请重新发送一次指令。'
        : '请求既没有新消息，也没有匹配的工具结果',
    };
  }

  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  /** 本轮是否曾因真实模型不可用而降级到离线规则 */
  const degraded: { current: LlmError | null } = { current: null };

  // 意图路由：本轮只下发相关工具组，并只注入相关领域知识
  const intent = intentText(session, input);
  const knowledge = buildKnowledgeContext(intent);
  const tools: ToolDefinition[] | undefined = getToolsForIntent(intent);

  for (let step = 0; step < config.maxSteps; step++) {
    const res: LlmResult = await decideWithRepair(session, tools, degraded, knowledge);
    if (res.usage) {
      usage.promptTokens += res.usage.promptTokens;
      usage.completionTokens += res.usage.completionTokens;
      usage.totalTokens += res.usage.totalTokens;
    }

    const msg = res.message;
    session.messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const text = msg.content?.trim() || '（模型没有返回文字，但操作已执行）';
      return {
        type: 'final',
        sessionId: session.id,
        content: degraded.current ? degradedPrefix(degraded.current) + text : text,
        toolTrace: trace,
        usage,
      };
    }

    // 拆分：服务端能做的就地做掉，浏览器做的交给前端
    const serverCalls = msg.tool_calls.filter((c) => getTool(c.function.name)?.target === 'server');
    const clientCalls = msg.tool_calls.filter((c) => getTool(c.function.name)?.target === 'client');
    const unknownCalls = msg.tool_calls.filter((c) => !getTool(c.function.name));

    /** 本轮在服务端就能拿到结果的调用 */
    const localResults = new Map<string, ToolResultPayload>();

    for (const c of serverCalls) {
      const started = Date.now();
      const args = safeParseArgs(c.function.arguments);
      const out = executeServerTool(c.function.name, args);
      const payload: ToolResultPayload = {
        toolCallId: c.id,
        name: c.function.name,
        ok: out.ok,
        result: out.data,
        error: out.error,
        durationMs: Date.now() - started,
      };
      localResults.set(c.id, payload);
      serverExecuted.push(payload);
      trace.push({ name: c.function.name, target: 'server', ok: out.ok });
    }

    // 模型调了不存在的工具也要有结果，否则同样缺 tool_call_id
    for (const c of unknownCalls) {
      localResults.set(c.id, {
        toolCallId: c.id,
        name: c.function.name,
        ok: false,
        error: `工具 ${c.function.name} 未实现`,
      });
      trace.push({ name: c.function.name, target: 'client', ok: false });
    }

    /**
     * 关键：只要这一轮里还有要交给浏览器执行的工具，就必须先返回给前端，
     * 不能再调模型 —— 否则这条 assistant 消息的 tool_calls 里会有一部分
     * tool_call_id 没有对应的 tool 消息，模型会直接报
     * "must be followed by tool messages responding to each tool_call_id"。
     */
    if (clientCalls.length) {
      // 服务端结果先暂存，等前端结果回来后一起按 tool_calls 顺序写回历史
      for (const [id, r] of localResults) session.stagedToolResults.set(id, r);
      session.pendingToolCallIds = new Set(clientCalls.map((c) => c.id));
      return {
        type: 'tool_calls',
        sessionId: session.id,
        content: msg.content ?? null,
        toolCalls: clientCalls,
        executedOnServer: serverExecuted.length ? serverExecuted : undefined,
      };
    }

    // 本轮调用全都在服务端消化完了，按 tool_calls 顺序写回后让模型继续决策
    for (const c of msg.tool_calls) {
      const r = localResults.get(c.id);
      if (r) session.messages.push(resultToToolMessage(r));
    }
  }

  const tail = `已达到单轮最大步数（${config.maxSteps}），我先停在这里。可以把任务拆细一点再说。`;
  return {
    type: 'final',
    sessionId: session.id,
    content: degraded.current ? degradedPrefix(degraded.current) + tail : tail,
    toolTrace: trace,
    usage,
  };
}
