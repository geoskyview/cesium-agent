import type { LlmMessage } from '../../../shared/protocol';
import type { ToolResultPayload } from '../../../shared/protocol';

export interface Session {
  id: string;
  /** 业务消息（不含 system，system 在调用模型时前置） */
  messages: LlmMessage[];
  /** 当前等待前端回传结果的 tool_call_id，用于校验，防止伪造结果注入 */
  pendingToolCallIds: Set<string>;
  /**
   * 本轮已在服务端执行完、但还没写进历史的工具结果（按 tool_call_id 索引）。
   * 之所以要「暂存」：一轮里服务端工具和浏览器工具混在一起时，
   * 工具结果必须按模型给出的 tool_calls 顺序写回历史，否则部分厂商会报协议错误。
   */
  stagedToolResults: Map<string, ToolResultPayload>;
  createdAt: number;
  updatedAt: number;
}

/** 展示用：一条工具执行的痕迹 */
export interface ToolTraceItem {
  name: string;
  target: 'client' | 'server';
  ok: boolean;
}

export type { ToolResultPayload };
