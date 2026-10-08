/**
 * 校验 LLM 服务商配置解析结果。
 *
 * 用法（用环境变量模拟不同配置）：
 *   LLM_PROVIDER=qwen DASHSCOPE_API_KEY=sk-x npx tsx scripts/check-llm-config.ts
 *
 * 不带任何环境变量时，打印当前 server/.env 的解析结果 + 全部厂商预设表。
 */
import { PROVIDERS, assertLlmReady, config } from '../server/src/config';
import type { LlmProvider } from '../server/src/config';

const l = config.llm;
const ready = assertLlmReady();

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

console.log('当前生效配置');
console.log(`  provider : ${l.provider}`);
console.log(`  厂商     : ${l.label}`);
console.log(`  模型     : ${l.model}`);
console.log(`  接口     : ${l.baseURL}`);
console.log(`  Key      : ${l.apiKey ? `${l.apiKey.slice(0, 6)}…(已配置)` : '(未配置)'}`);
console.log(`  mock     : ${config.mock}   降级兜底: ${config.fallbackToMock}`);
console.log(`  就绪     : ${ready.ok ? 'OK' : ready.reason}`);

console.log('\n全部厂商预设');
for (const [name, p] of Object.entries(PROVIDERS) as Array<[LlmProvider, (typeof PROVIDERS)[LlmProvider]]>) {
  console.log(
    `  ${pad(name, 12)} ${pad(p.label, 22)} ${pad(p.defaultModel, 26)} ${p.baseURL || '(需自填)'}`,
  );
}
console.log('\nKey 环境变量（按顺序取第一个非空）');
for (const [name, p] of Object.entries(PROVIDERS) as Array<[LlmProvider, (typeof PROVIDERS)[LlmProvider]]>) {
  console.log(`  ${pad(name, 12)} ${p.keyEnv.join(' / ')}${p.allowNoKey ? '   (可无 Key)' : ''}`);
}
