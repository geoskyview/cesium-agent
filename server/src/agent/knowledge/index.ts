/**
 * CesiumJS 官方领域知识库（来源：CesiumGS/cesiumjs-skills）
 *
 * 为什么不做全量注入：14 个领域 SKILL.md 合计约 311KB，全部塞进 system prompt
 * 会直接撑爆上下文预算，且无关领域反而干扰模型判断。
 *
 * 因此这里做的是「轻量 RAG」：
 * 1. 启动时把 14 个领域文档读入内存，解析 frontmatter 的 description；
 * 2. 按中英文关键词做领域打分（比向量库轻，但对本场景足够——领域词非常集中）；
 * 3. 只把 Top-N 领域的正文片段拼进 system prompt，并做字符预算截断。
 *
 * 领域正文的开头通常是该领域最容易出错的规则（如 entities 的「经度在前、西半球为负」），
 * 因此截断时保留开头，性价比最高。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(here, 'cesiumjs');

export interface KnowledgeDoc {
  /** 目录名，如 cesiumjs-entities */
  id: string;
  name: string;
  description: string;
  body: string;
  /** 用于意图匹配的关键词 */
  keywords: string[];
}

/** 领域 → 中英文关键词（覆盖用户口语说法 + Cesium API 名） */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  'cesiumjs-viewer-setup': [
    'viewer', '初始化', '创建球', 'widget', '控件', 'ion', 'token', '启动', '容器', 'boot', 'cesiumwidget',
  ],
  'cesiumjs-camera': [
    '相机', '视角', 'camera', 'flyto', '飞行', '定位', '俯视', 'heading', 'pitch', 'roll', 'range',
    'zoomto', 'lookat', '环绕', 'orbit', '视锥', 'frustum', '镜头',
  ],
  'cesiumjs-entities': [
    'entity', '实体', '标注', '打点', 'marker', 'label', '标签', 'point', 'polyline', 'polygon',
    'geojson', 'kml', 'czml', 'gpx', 'datasource', '数据源', 'billboard', 'path',
    '画', '绘制', '折线', '多边形', '图标', '模型', '拉伸',
  ],
  'cesiumjs-3d-tiles': [
    '3dtiles', '3d tiles', 'tileset', '白模', '倾斜摄影', '点云', 'bim', 'gltf', 'glb',
    'cesium3dtileset', '裁剪', 'clipping', 'metadata', 'voxel', 'mvt',
  ],
  'cesiumjs-imagery': [
    '底图', '影像', 'imagery', 'basemap', '瓦片', 'wms', 'wmts', 'xyz', 'arcgis', 'provider',
    'imagerylayer', '切换底图', '分屏', 'split',
    '图层', '图层管理', '隐藏图层', '显示图层', '移除图层', '删除图层', '透明度',
  ],
  'cesiumjs-terrain-environment': [
    '地形', '高程', 'terrain', 'dem', '采样高度', 'sampleterrain', '大气', 'atmosphere', '天空',
    'sky', '雾', 'fog', '光照', 'lighting', '阴影', 'shadow', '环境',
  ],
  'cesiumjs-primitives': [
    'primitive', '图元', 'geometry', '几何', '性能', '批量', 'batching', 'bufferprimitive',
    'geojsonprimitive', '静态', '大量',
  ],
  'cesiumjs-materials-shaders': [
    '材质', 'material', 'fabric', '着色器', 'shader', 'glsl', '后处理', 'postprocess', 'bloom',
    '泛光', 'tonemapping', 'ibl', 'pbr',
  ],
  'cesiumjs-custom-shader': [
    'customshader', '自定义着色器', 'glsl', 'featureid', '结构元数据', 'vertex shader', '片元',
    'model shader', 'voxel shader',
  ],
  'cesiumjs-time-properties': [
    '时间', '时钟', 'clock', '动画', 'animation', 'sampledproperty', '插值', 'interpolation',
    'timeinterval', '时变', '时序', 'juliandate', 'property',
  ],
  'cesiumjs-spatial-math': [
    '坐标', '转换', 'cartesian', 'cartographic', '矩阵', 'matrix', 'headingpitchroll',
    'ellipsoid', '椭球', '相交', 'intersection', '投影', 'projection', '距离', '测距',
    '量算', '量一下', '量一量', '测量', '面积', '周长', '多长', '多大',
  ],
  'cesiumjs-interaction': [
    '点击', '交互', 'interaction', 'pick', '拾取', '选择', 'selection', 'hover', '悬停',
    'screenSpaceEventHandler', '鼠标', '拖拽', 'drag', 'snapshot',
    '截图', '截个', '拍照', '快照', '保存图片', '导出图片', 'canvas',
  ],
  'cesiumjs-models-particles': [
    '模型', 'model', 'gltf', 'glb', 'meshopt', '粒子', 'particle', '动画模型', 'cad',
  ],
  'cesiumjs-core-utilities': [
    'resource', 'http', '请求', 'color', '颜色', 'event', '事件', '工具函数', 'utility', '错误处理',
  ],
};

let cache: KnowledgeDoc[] | null = null;

/** 解析 YAML frontmatter（只取 name / description，够用且避免引入 yaml 依赖） */
function parseFrontmatter(raw: string): { name: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { name: '', description: '', body: raw };
  const meta = m[1];
  const name = /^name:\s*(.+)$/m.exec(meta)?.[1]?.trim() ?? '';
  const desc = /^description:\s*(.+)$/m.exec(meta)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { name, description: desc, body: m[2] };
}

export function loadKnowledge(): KnowledgeDoc[] {
  if (cache) return cache;
  const docs: KnowledgeDoc[] = [];
  try {
    const dirs = fs.readdirSync(KNOWLEDGE_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory() || d.name === 'using-cesiumjs-skills') continue;
      const file = path.join(KNOWLEDGE_DIR, d.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const { name, description, body } = parseFrontmatter(raw);
      docs.push({
        id: d.name,
        name: name || d.name,
        description,
        body,
        keywords: DOMAIN_KEYWORDS[d.name] ?? [],
      });
    }
  } catch (err) {
    console.warn('[aiearth] 知识库加载失败：', err instanceof Error ? err.message : err);
  }
  cache = docs;
  return docs;
}

/** 领域索引（常驻 system prompt，让模型知道有哪些领域可查） */
export function buildKnowledgeIndex(): string {
  const docs = loadKnowledge();
  if (docs.length === 0) return '';
  return docs.map((d) => `- ${d.id}：${d.description.slice(0, 110)}`).join('\n');
}

export interface KnowledgeOptions {
  /** 最多注入几个领域 */
  maxDomains?: number;
  /** 每个领域最多注入多少字符 */
  perDomainChars?: number;
  /** 总字符预算 */
  totalChars?: number;
}

/**
 * 按用户意图检索领域知识，返回可直接拼进 system prompt 的文本。
 * 打分 = 关键词命中（权重 3） + 正文直接命中查询片段（权重 1）。
 */
export function buildKnowledgeContext(query: string, opts: KnowledgeOptions = {}): string {
  const { maxDomains = 2, perDomainChars = 4200, totalChars = 9000 } = opts;
  const docs = loadKnowledge();
  if (docs.length === 0) return '';

  const q = query.toLowerCase();
  const scored = docs
    .map((doc) => {
      let score = 0;
      for (const kw of doc.keywords) {
        if (q.includes(kw.toLowerCase())) score += 3;
      }
      // 正文里出现用户原话片段也算命中（覆盖未列入关键词表的说法）
      const bodyLower = doc.body.toLowerCase();
      for (const token of q.split(/[\s，,。、]+/)) {
        if (token.length >= 4 && bodyLower.includes(token)) score += 1;
      }
      return { doc, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxDomains);

  if (scored.length === 0) return '';

  const parts: string[] = [];
  let used = 0;
  for (const { doc } of scored) {
    if (used >= totalChars) break;
    const room = Math.min(perDomainChars, totalChars - used);
    const chunk = doc.body.slice(0, room);
    parts.push(`### 领域知识：${doc.id}\n${chunk}`);
    used += chunk.length;
  }

  return `# CesiumJS 权威用法参考（务必遵守，不要凭记忆写 Cesium 代码）\n\n${parts.join('\n\n')}`;
}

/** 已加载的领域数量，用于 /api/health 自检 */
export function knowledgeStats(): { domains: number; chars: number } {
  const docs = loadKnowledge();
  return {
    domains: docs.length,
    chars: docs.reduce((sum, d) => sum + d.body.length, 0),
  };
}
