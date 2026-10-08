import OpenAI from 'openai';
import { config } from '../config.js';
import { getEnabledTools, type ToolDefinition } from '../../../shared/tools.js';
import type { LlmMessage, ToolCall } from '../../../shared/protocol.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: config.llm.apiKey || 'sk-placeholder',
      baseURL: config.llm.baseURL,
      timeout: 60_000,
      maxRetries: 2,
    });
  }
  return client;
}

export interface LlmResult {
  message: LlmMessage;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * LLM 调用失败的分类。
 * 目的：余额不足、Key 失效、限流、网络不通这些情况，用户需要的是「下一步怎么办」，
 * 而不是一串英文堆栈。
 */
export type LlmErrorKind = 'auth' | 'quota' | 'rate_limit' | 'network' | 'server' | 'unknown';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;

  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
  }
}

/** 把 OpenAI SDK / 网络层抛出的各种错误归一成 LlmError */
export function classifyLlmError(err: unknown): LlmError {
  const status = (err as { status?: number } | null)?.status;
  const code = (err as { code?: string } | null)?.code ?? '';
  const raw = err instanceof Error ? err.message : String(err);
  // OpenAI SDK 的类名比 message 可靠（连接失败时 message 只是 "Connection error."）
  const ctor = (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? '';

  if (ctor === 'APIConnectionTimeoutError') return new LlmError('network', `请求 ${vendor()} 超时`, status);
  if (ctor === 'APIConnectionError') return new LlmError('network', `连接 ${vendor()} 失败（网络不通或被代理拦截）`, status);

  if (status === 401) return new LlmError('auth', 'API Key 无效或已过期', status);
  if (status === 402) return new LlmError('quota', `${vendor()} 账户余额不足`, status);
  if (status === 403) return new LlmError('auth', 'API Key 无权限访问该模型', status);
  if (status === 429) return new LlmError('rate_limit', '请求过于频繁，已被限流', status);
  if (typeof status === 'number' && status >= 500) {
    return new LlmError('server', `${vendor()} 服务异常（HTTP ${status}）`, status);
  }
  if (
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    /timeout|socket hang up|fetch failed/i.test(raw)
  ) {
    return new LlmError('network', '连接 DeepSeek 失败（网络超时或被代理拦截）', status);
  }
  return new LlmError('unknown', raw.slice(0, 200), status);
}

/** 当前服务商名，用于把提示语说准确 */
function vendor(): string {
  return config.llm.label;
}

/** 给用户看的可操作提示 */
export function hintForLlmError(e: LlmError): string {
  const keyName = config.llm.preset.keyEnv[0];
  switch (e.kind) {
    case 'quota':
      return `${vendor()} 账户余额不足或已欠费，请到服务商控制台充值。想继续验证界面，可在 server/.env 里设 MOCK_LLM=true 用离线规则模式。`;
    case 'auth':
      return `${vendor()} 的 API Key 无效、过期或无权限，请检查 server/.env 里的 ${keyName}。`;
    case 'rate_limit':
      return '请求太频繁被限流了，稍等一会再试。';
    case 'network':
      return `连不上 ${vendor()}（${config.llm.baseURL}）：请检查网络或代理设置（注意 HTTP_PROXY 可能指向无效代理）。`;
    case 'server':
      return `${vendor()} 服务端暂时不可用，请稍后重试。`;
    default:
      return `调用模型失败：${e.message}`;
  }
}

/**
 * 调用 DeepSeek（OpenAI 兼容协议），返回 assistant 消息（可能带 tool_calls）
 *
 * toolsOverride：由 loop 按用户意图挑选的工具子集。工具全量下发会显著拉低
 * 模型的选择准确率（尤其是参数相近的 fly_to / set_view / look_at_transform），
 * 所以默认走意图路由；传 undefined 时才全量下发。
 */
export async function callLlm(messages: LlmMessage[], toolsOverride?: ToolDefinition[]): Promise<LlmResult> {
  const list = toolsOverride?.length ? toolsOverride : getEnabledTools();
  const tools = list.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> },
  }));

  let resp: Awaited<ReturnType<ReturnType<typeof getClient>['chat']['completions']['create']>>;
  try {
    resp = await getClient().chat.completions.create({
      model: config.llm.model,
      messages: messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      tool_choice: 'auto',
      temperature: config.llm.temperature,
      max_tokens: config.llm.maxTokens,
      stream: false,
    });
  } catch (err) {
    throw classifyLlmError(err);
  }

  const choice = resp.choices[0];
  const raw = choice?.message;
  if (!raw) throw new Error(`${vendor()} 返回为空`);

  const message: LlmMessage = {
    role: 'assistant',
    content: raw.content ?? null,
  };
  if (raw.tool_calls?.length) {
    message.tool_calls = raw.tool_calls.map(
      (c): ToolCall => ({
        id: c.id,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments },
      }),
    );
  }

  const usage = resp.usage
    ? {
        promptTokens: resp.usage.prompt_tokens,
        completionTokens: resp.usage.completion_tokens,
        totalTokens: resp.usage.total_tokens,
      }
    : undefined;

  return { message, usage };
}
