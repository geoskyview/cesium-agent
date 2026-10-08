import { Router } from 'express';
import { z } from 'zod';
import { runAgentTurn } from '../agent/loop';
import { LlmError, hintForLlmError } from '../agent/llm';
import { getSession, resetSession, sweep, touch, sessionCount } from '../session/store';
import { assertLlmReady, config } from '../config';
import { TOOLS, getEnabledTools } from '../../../shared/tools';
import { WELCOME } from '../agent/prompt';
import { geoLocate } from '../tools/geo';
import type { ChatRequest } from '../../../shared/protocol';

const ToolResultSchema = z.object({
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});

const ChatRequestSchema = z.object({
  sessionId: z.string().optional(),
  message: z.string().optional(),
  toolResults: z.array(ToolResultSchema).optional(),
});

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  const ready = assertLlmReady();
  res.json({
    ok: true,
    service: 'aiearth-agent-server',
    mode: config.mock ? 'mock' : config.llm.provider,
    provider: config.mock ? '-' : config.llm.provider,
    vendor: config.mock ? '-' : config.llm.label,
    model: config.mock ? '-' : config.llm.model,
    baseURL: config.mock ? '-' : config.llm.baseURL,
    llmReady: ready.ok,
    llmReason: ready.ok ? undefined : ready.reason,
    toolsEnabled: getEnabledTools().map((t) => t.name),
    sessions: sessionCount(),
  });
});

apiRouter.get('/tools', (_req, res) => {
  res.json({ tools: TOOLS, enabled: getEnabledTools().map((t) => t.name) });
});

apiRouter.get('/geocode', (req, res) => {
  const query = String(req.query.query ?? '').trim();
  if (!query) return res.status(400).json({ error: 'query 必填' });
  res.json(geoLocate(query));
});

apiRouter.get('/welcome', (_req, res) => {
  res.json({ content: WELCOME });
});

apiRouter.post('/session/reset', (req, res) => {
  const id = String(req.body?.sessionId ?? '').trim();
  if (!id) return res.status(400).json({ error: 'sessionId 必填' });
  const s = resetSession(id);
  res.json({ ok: true, sessionId: s.id });
});

apiRouter.post('/chat', async (req, res) => {
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: '请求格式不正确', detail: parsed.error.flatten() });
  }

  const ready = assertLlmReady();
  if (!ready.ok) {
    return res.status(503).json({ error: ready.reason });
  }

  const input = parsed.data as ChatRequest;
  const session = getSession(input.sessionId);
  touch(session);

  try {
    const reply = await runAgentTurn(session, input);
    touch(session);
    sweep(config.sessionTtlMs);
    res.json(reply);
  } catch (err) {
    // 模型侧的问题要说人话：用户需要的是「下一步怎么办」，不是英文堆栈
    if (err instanceof LlmError) {
      const status = err.kind === 'quota' ? 402 : err.kind === 'auth' ? 401 : err.kind === 'rate_limit' ? 429 : 502;
      console.warn(`[agent] 模型调用失败(${err.kind}, ${err.status ?? '-'}): ${err.message}`);
      return res.status(status).json({
        type: 'error',
        sessionId: session.id,
        kind: err.kind,
        error: hintForLlmError(err),
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[agent] turn failed:', err);
    res.status(500).json({ type: 'error', sessionId: session.id, error: `Agent 执行失败：${message}` });
  }
});
