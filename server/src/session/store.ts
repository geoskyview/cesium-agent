import type { ToolResultPayload } from '../../../shared/protocol';
import type { Session } from './types';

const sessions = new Map<string, Session>();

export function createSession(id?: string): Session {
  const sid = id && id.trim() ? id.trim() : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const session: Session = {
    id: sid,
    messages: [], // system 由 prompt 层注入，此处只存业务消息
    pendingToolCallIds: new Set<string>(),
    stagedToolResults: new Map<string, ToolResultPayload>(),
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(sid, session);
  return session;
}

export function getSession(id?: string): Session {
  if (id && sessions.has(id)) return sessions.get(id)!;
  return createSession(id);
}

export function resetSession(id: string): Session {
  sessions.delete(id);
  return createSession(id);
}

export function touch(session: Session) {
  session.updatedAt = Date.now();
}

/** 简单的 TTL 清理，避免长期运行内存无限增长 */
export function sweep(ttlMs: number) {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > ttlMs) sessions.delete(id);
  }
}

export function sessionCount() {
  return sessions.size;
}
