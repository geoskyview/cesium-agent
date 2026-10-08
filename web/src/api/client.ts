import type { ChatReply, ChatRequest } from '../../../shared/protocol';

const BASE: string = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!resp.ok) {
    const msg =
      (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : null) ?? `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/** 一轮对话：可以只带 message，也可以只带 toolResults */
export function postChat(payload: ChatRequest): Promise<ChatReply> {
  return request<ChatReply>('/chat', { method: 'POST', body: JSON.stringify(payload) });
}

export interface GeocodeResponse {
  found: boolean;
  query: string;
  name?: string;
  longitude?: number;
  latitude?: number;
}

/** 地名解析兜底（模型只给了地名没给坐标时，前端也能自己查） */
export function geocode(query: string): Promise<GeocodeResponse> {
  return request<GeocodeResponse>(`/geocode?query=${encodeURIComponent(query)}`);
}

export interface HealthResponse {
  ok: boolean;
  mode: string;
  model: string;
  llmReady: boolean;
  llmReason?: string;
  toolsEnabled: string[];
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}
