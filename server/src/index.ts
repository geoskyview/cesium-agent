import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { config } from './config';
import { apiRouter } from './routes/chat';

const here = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', apiRouter);

// 生产形态：如果前端已经 build，直接由后端托管 dist
const dist = path.resolve(here, '../../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(config.port, () => {
  const { provider, label, model, baseURL, apiKey, preset } = config.llm;
  const mode = config.mock ? 'MOCK(离线规则)' : `${label} [${provider}] / ${model}`;
  console.log(`[aiearth] agent server listening on http://localhost:${config.port}`);
  console.log(`[aiearth] 模型模式: ${mode}`);
  if (!config.mock) {
    console.log(`[aiearth] 接口地址: ${baseURL}`);
    if (!apiKey && !preset.allowNoKey) {
      console.warn(`[aiearth] 警告：未检测到 ${label} 的 API Key，请在 server/.env 中配置 ${preset.keyEnv[0]}`);
    }
    // 工具调用是本项目的基础能力，提前提醒不支持的选型
    if (preset.tips) console.warn(`[aiearth] 提示：${preset.tips}`);
  }
});
