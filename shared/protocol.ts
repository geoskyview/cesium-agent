/**
 * 前后端通信协议（与 shared/tools.ts 一起构成唯一契约）
 *
 * 一次「用户提问」的完整往返：
 *
 *   web  --POST /api/chat {sessionId, message}-->            server
 *   web  <--{type:'tool_calls', toolCalls:[...]}--           server   (模型要求执行工具)
 *   web  执行 Cesium 命令（flyTo / addMarker ...）
 *   web  --POST /api/chat {sessionId, toolResults:[...]}-->   server
 *   web  <--{type:'final', content:'已经飞到北京...'}--       server
 *
 * 之所以把工具执行放在前端：Cesium 实例在浏览器里，服务端拿不到相机和 Entity，
 * 所以服务端只做「大脑」（编排 + 记忆 + 鉴权），前端做「手脚」（真实操作地球）。
 */

import type { ToolTarget } from './tools';

/** 发给模型的消息（OpenAI 兼容格式） */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant 发起的工具调用 */
  tool_calls?: ToolCall[];
  /** role=tool 时对应的调用 id */
  tool_call_id?: string;
  /** role=tool 时的工具名 */
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON 字符串 */
    arguments: string;
  };
}

/** 工具执行结果（前端执行后回传，或后端本地执行后生成） */
export interface ToolResultPayload {
  toolCallId: string;
  name: string;
  ok: boolean;
  /** 结构化结果，会喂回模型 */
  result?: unknown;
  /** 失败原因 */
  error?: string;
  /** 执行耗时 ms，便于前端展示与后端 trace */
  durationMs?: number;
}

export interface ChatRequest {
  sessionId: string;
  /** 新的用户消息（第一轮） */
  message?: string;
  /** 上一轮工具的执行结果（后续轮） */
  toolResults?: ToolResultPayload[];
}

export type ChatReply =
  | {
      type: 'tool_calls';
      sessionId: string;
      /** 模型这轮的说明文字（可能为空） */
      content?: string | null;
      /** 需要前端执行的调用 */
      toolCalls: ToolCall[];
      /** 本轮被后端就地执行的工具（geo_locate 等），用于前端展示过程 */
      executedOnServer?: ToolResultPayload[];
    }
  | {
      type: 'final';
      sessionId: string;
      content: string;
      /** 本轮执行过的工具摘要，用于 UI 展示 */
      toolTrace?: { name: string; target: ToolTarget; ok: boolean }[];
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    }
  | {
      type: 'error';
      sessionId: string;
      error: string;
    };

/** 前端执行器的统一返回 */
export interface CommandResult {
  ok: boolean;
  /** 给模型看的结构化结果 */
  data?: Record<string, unknown>;
  error?: string;
}
