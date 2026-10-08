import type { LlmMessage } from '../../../shared/protocol';

/**
 * 会话历史的「协议体检」。
 *
 * OpenAI / DeepSeek 对 tool_calls 有两条硬性不变式，违反就直接 400：
 *   1. 每条 role=tool 必须回应它前面那条 assistant.tool_calls 里的某个 id
 *   2. 一条 assistant.tool_calls 的每个 id 都必须被后续的 tool 消息回应，
 *      期间不能插入新的 user / assistant 消息
 *
 * 现实里这两条很容易被打破：前端执行到一半刷新页面、某个工具抛异常没回传、
 * 用户中途又发了一条新指令……只要历史脏了，这个会话就再也问不动模型，
 * 只能重置。所以每次调用模型前都体检一次，脏了就地修，而不是等 400。
 */
export interface SanitizeReport {
  /** 被丢弃的「孤儿」tool 消息数（前面没有对应的 assistant.tool_calls） */
  droppedOrphanTools: number;
  /** 被补成「未执行」的 tool_call 数（前端一直没回传结果） */
  filledMissing: number;
  filledIds: string[];
}

const NOT_EXECUTED = JSON.stringify({
  ok: false,
  error: '未执行：这一步的结果没有回传（页面可能刷新过，或执行被中断）',
});

export function sanitizeMessages(messages: LlmMessage[]): {
  messages: LlmMessage[];
  report: SanitizeReport;
} {
  const out: LlmMessage[] = [];
  const report: SanitizeReport = { droppedOrphanTools: 0, filledMissing: 0, filledIds: [] };
  /** 当前还没被回应完的那条 assistant.tool_calls */
  let open: { ids: string[]; names: Map<string, string> } | null = null;

  /** 把 open 里剩下的 id 全部补一条「未执行」结果，顺序与 tool_calls 一致 */
  const flushOpen = () => {
    if (!open) return;
    for (const id of open.ids) {
      out.push({
        role: 'tool',
        tool_call_id: id,
        name: open.names.get(id) ?? 'unknown',
        content: NOT_EXECUTED,
      });
      report.filledMissing++;
      report.filledIds.push(id);
    }
    open = null;
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      if (!open || !open.ids.includes(id)) {
        // 前面没有对应的 tool_calls（或 id 对不上），留着必然 400，直接丢
        report.droppedOrphanTools++;
        continue;
      }
      open.ids = open.ids.filter((x) => x !== id);
      out.push(m);
      if (open.ids.length === 0) open = null;
      continue;
    }

    // 非 tool 消息之前，上一条 assistant 的调用必须全部结清
    flushOpen();

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      open = {
        ids: m.tool_calls.map((c) => c.id),
        names: new Map(m.tool_calls.map((c) => [c.id, c.function?.name ?? 'unknown'])),
      };
    }
    out.push(m);
  }

  // 末尾还挂着没回应完的调用（前端没回来），同样补齐
  flushOpen();

  return { messages: out, report };
}

/**
 * 兜底手段：把历史里所有工具相关的消息剥掉，只留「人话」部分。
 * 只在协议错误自愈时用——宁可丢掉一轮工具上下文，也别让会话整个废掉。
 */
export function stripToolMessages(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') continue;
    if (m.role === 'assistant' && m.tool_calls?.length) {
      // 丢掉这段工具调用，但保留它自带的文字说明（若有）
      if (m.content) out.push({ role: 'assistant', content: m.content });
      continue;
    }
    out.push(m);
  }
  return out;
}

export function hasRepair(report: SanitizeReport): boolean {
  return report.droppedOrphanTools > 0 || report.filledMissing > 0;
}

export function describeRepair(report: SanitizeReport): string {
  const parts: string[] = [];
  if (report.droppedOrphanTools) parts.push(`丢弃孤儿 tool 消息 ${report.droppedOrphanTools} 条`);
  if (report.filledMissing)
    parts.push(`补齐未回传的调用 ${report.filledMissing} 个（${report.filledIds.join(', ')}）`);
  return parts.join('；');
}
