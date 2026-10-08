import { geoLocate, type LocateResult } from './geo';

export interface ServerToolOutcome {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * 服务端就地执行的工具（不依赖浏览器）。
 * 新增服务端工具：在这里加一个 case 即可，shared/tools.ts 里把 target 标成 'server'。
 */
export function executeServerTool(name: string, args: Record<string, unknown>): ServerToolOutcome {
  switch (name) {
    case 'geo_locate': {
      const query = String(args?.query ?? '').trim();
      if (!query) return { ok: false, error: 'query 不能为空' };
      const r: LocateResult = geoLocate(query);
      if (!r.found) {
        return { ok: true, data: { found: false, query, hint: '内置词典未命中，请使用地理知识给出近似坐标' } };
      }
      return {
        ok: true,
        data: {
          found: true,
          name: r.name,
          longitude: r.longitude,
          latitude: r.latitude,
          admin: r.admin,
          candidates: r.candidates,
        },
      };
    }
    default:
      return { ok: false, error: `未知的服务端工具: ${name}` };
  }
}
