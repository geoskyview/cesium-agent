import './styles.css';
import { createViewer } from './cesium/viewer';
import { registerAllCommands } from './cesium/commands/register';
import { runCommand } from './cesium/commands';
import { mountChatPanel, geocodeFallback } from './ui/chat';

import { setActiveViewer } from './cesium/commands/util';

async function boot(): Promise<void> {
  const container = document.getElementById('cesium-container');
  const panel = document.getElementById('chat-panel');
  if (!container || !panel) throw new Error('页面结构缺失');

  registerAllCommands();

  let viewer;
  try {
    viewer = await createViewer(container);
  } catch (err) {
    console.error('[aiearth] Viewer 初始化失败', err);
    const mask = document.getElementById('loading-mask');
    if (mask) mask.textContent = `三维地球初始化失败：${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  // 图层注册表要能拿到 viewer 才能做 remove/清空
  setActiveViewer(viewer);
  document.getElementById('loading-mask')?.remove();

  mountChatPanel(panel, {
    runCommand: (name, args) => runCommand(name, args, { viewer, geocode: geocodeFallback }),
  });

  // 暴露到 window，方便控制台调试与自动化验证（不影响生产逻辑）
  (window as unknown as { __aiearth?: unknown }).__aiearth = {
    viewer,
    runCommand: (name: string, args: Record<string, unknown>) =>
      runCommand(name, args, { viewer, geocode: geocodeFallback }),
  };

  console.info('[aiearth] 启动完成');
}

void boot();
