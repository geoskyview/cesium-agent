import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

// 依次尝试 server/.env 与仓库根 .env，后者作为兜底
dotenv.config({ path: path.resolve(here, '../.env') });
dotenv.config({ path: path.resolve(here, '../../.env') });

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
const str = (v: string | undefined) => (v ?? '').trim();

/** 支持的厂商。全部走 OpenAI 兼容协议，所以 SDK 层零改动 */
export type LlmProvider =
  | 'deepseek'
  | 'openai'
  | 'qwen'
  | 'moonshot'
  | 'glm'
  | 'siliconflow'
  | 'ollama'
  | 'custom';

export interface ProviderPreset {
  label: string;
  baseURL: string;
  defaultModel: string;
  /** 依次尝试的 Key 环境变量名，第一个非空的生效 */
  keyEnv: string[];
  /** 本地部署 / 网关类服务允许没有 Key */
  allowNoKey?: boolean;
  /** 该厂商下推荐的支持工具调用的模型，用于启动日志提示 */
  tips?: string;
}

export const PROVIDERS: Record<LlmProvider, ProviderPreset> = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    keyEnv: ['DEEPSEEK_API_KEY', 'LLM_API_KEY'],
    tips: 'deepseek-reasoner 不支持工具调用，请用 deepseek-chat',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyEnv: ['OPENAI_API_KEY', 'LLM_API_KEY'],
  },
  qwen: {
    label: '通义千问 (DashScope)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    keyEnv: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'LLM_API_KEY'],
    tips: '国际版用 https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
  moonshot: {
    label: 'Moonshot (Kimi)',
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    keyEnv: ['MOONSHOT_API_KEY', 'LLM_API_KEY'],
  },
  glm: {
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    keyEnv: ['ZHIPU_API_KEY', 'GLM_API_KEY', 'LLM_API_KEY'],
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    keyEnv: ['SILICONFLOW_API_KEY', 'LLM_API_KEY'],
  },
  ollama: {
    label: 'Ollama (本地)',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5:7b',
    keyEnv: ['LLM_API_KEY'],
    allowNoKey: true,
    tips: '本地小模型多数不支持工具调用，需装 qwen2.5 / llama3.1 等支持 function calling 的版本',
  },
  custom: {
    label: '自定义 (OpenAI 兼容)',
    baseURL: '',
    defaultModel: '',
    keyEnv: ['LLM_API_KEY'],
    tips: '必须自己填 LLM_BASE_URL 与 LLM_MODEL',
  },
};

/** provider 的口语别名，写错也能认 */
const PROVIDER_ALIASES: Record<string, LlmProvider> = {
  ds: 'deepseek',
  deepseek: 'deepseek',
  openai: 'openai',
  gpt: 'openai',
  qwen: 'qwen',
  tongyi: 'qwen',
  aliyun: 'qwen',
  dashscope: 'qwen',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  glm: 'glm',
  zhipu: 'glm',
  chatglm: 'glm',
  siliconflow: 'siliconflow',
  silicon: 'siliconflow',
  ollama: 'ollama',
  local: 'ollama',
  custom: 'custom',
};

function firstNonEmpty(names: string[]): string {
  for (const n of names) {
    const v = str(process.env[n]);
    if (v) return v;
  }
  return '';
}

function resolveProvider(): LlmProvider {
  const raw = str(process.env.LLM_PROVIDER).toLowerCase();
  if (raw && PROVIDER_ALIASES[raw]) return PROVIDER_ALIASES[raw];
  if (raw) {
    // 未知 provider：当作自定义处理，但保留用户输入以便日志里看出来
    console.warn(`[aiearth] 未知的 LLM_PROVIDER="${raw}"，按 custom 处理（请自行填 LLM_BASE_URL / LLM_MODEL）`);
    return 'custom';
  }
  // 没显式指定时，看哪个厂商的 Key 配了
  if (str(process.env.OPENAI_API_KEY)) return 'openai';
  if (str(process.env.DASHSCOPE_API_KEY) || str(process.env.QWEN_API_KEY)) return 'qwen';
  if (str(process.env.MOONSHOT_API_KEY)) return 'moonshot';
  if (str(process.env.ZHIPU_API_KEY) || str(process.env.GLM_API_KEY)) return 'glm';
  if (str(process.env.SILICONFLOW_API_KEY)) return 'siliconflow';
  return 'deepseek';
}

function resolveLlm() {
  const provider = resolveProvider();
  const preset = PROVIDERS[provider];

  // 通用变量优先；厂商专属变量作为回退（保证老的 .env 不用改）
  const baseURL =
    str(process.env.LLM_BASE_URL) ||
    (provider === 'deepseek' ? str(process.env.DEEPSEEK_BASE_URL) : '') ||
    preset.baseURL;

  const model =
    str(process.env.LLM_MODEL) ||
    (provider === 'deepseek' ? str(process.env.DEEPSEEK_MODEL) : '') ||
    preset.defaultModel;

  const apiKey = firstNonEmpty(preset.keyEnv);

  const temperature = num(
    str(process.env.LLM_TEMPERATURE) || str(process.env.DEEPSEEK_TEMPERATURE) || '',
    0.2,
  );
  const maxTokens = num(
    str(process.env.LLM_MAX_TOKENS) || str(process.env.DEEPSEEK_MAX_TOKENS) || '',
    2048,
  );

  return { provider, label: preset.label, baseURL, model, apiKey, temperature, maxTokens, preset };
}

const llm = resolveLlm();

export const config = {
  port: num(process.env.PORT, 8787),
  /** 不配 key 时用规则引擎兜底，保证前后端链路可跑通 */
  mock: String(process.env.MOCK_LLM ?? '').toLowerCase() === 'true',
  /** 真实模型调用失败（余额不足/限流/断网）时，自动用离线规则兜底而不是报错。默认关，避免静默误导 */
  fallbackToMock: String(process.env.LLM_FALLBACK_TO_MOCK ?? '').toLowerCase() === 'true',
  /** 单轮里最多让模型决策几步，防止工具死循环 */
  maxSteps: num(process.env.AGENT_MAX_STEPS, 6),
  /** 会话保留的最大消息条数（不含 system），超出后丢弃最早的非 system 消息 */
  maxHistory: num(process.env.AGENT_MAX_HISTORY, 40),
  sessionTtlMs: num(process.env.SESSION_TTL_MS, 1000 * 60 * 60 * 6),
  llm,
} as const;

export function assertLlmReady(): { ok: true } | { ok: false; reason: string } {
  if (config.mock) return { ok: true };
  const { apiKey, provider, label, preset, baseURL, model } = config.llm;
  if (!apiKey && !preset.allowNoKey) {
    return {
      ok: false,
      reason: `缺少 ${label} 的 API Key：请在 server/.env 里配置 ${preset.keyEnv[0]}，或设置 MOCK_LLM=true 使用离线规则模式`,
    };
  }
  if (!baseURL) {
    return { ok: false, reason: `provider=${provider} 缺少 LLM_BASE_URL，请在 server/.env 中配置` };
  }
  if (!model) {
    return { ok: false, reason: `provider=${provider} 缺少 LLM_MODEL，请在 server/.env 中配置` };
  }
  return { ok: true };
}
