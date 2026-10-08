/** 临时校验脚本：知识库加载 + 工具意图路由（用完删除） */
import { knowledgeStats, buildKnowledgeContext, buildKnowledgeIndex, loadKnowledge } from './server/src/agent/knowledge/index';
import { getToolsForIntent, detectGroups, getEnabledTools } from './shared/tools';

console.log('=== 知识库 ===');
console.log('stats:', knowledgeStats());
console.log('domains:', loadKnowledge().map((d) => d.id).join(', '));
console.log('\n=== 领域索引（前 3 行） ===');
console.log(buildKnowledgeIndex().split('\n').slice(0, 3).join('\n'));

const cases = [
  '定位到北京，添加一个标注',
  '加载这个 geojson 文件',
  '叠加一个 WMS 影像服务',
  '把那个图层隐藏掉',
  '画一条从北京到上海的线',
  '量一下这个多边形的面积',
  '当前相机视角是多少',
  '打开雾效和阴影',
  '截个图',
  '今天天气怎么样',
];

console.log('\n=== 意图路由 ===');
for (const c of cases) {
  const groups = detectGroups(c);
  const tools = getToolsForIntent(c);
  const kb = buildKnowledgeContext(c);
  console.log(
    `「${c}」\n  分组: ${groups.join('>')}\n  工具数: ${tools.length}/${getEnabledTools().length} -> ${tools.map((t) => t.name).join(', ')}\n  知识: ${kb.length} 字符`,
  );
}
