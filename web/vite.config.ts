import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);

// workspaces 会把 cesium 提升到仓库根 node_modules，所以不能用相对路径硬写
const cesiumRoot = path.dirname(require.resolve('cesium/package.json')).replace(/\\/g, '/');
const cesiumBuild = path.join(cesiumRoot, 'Build', 'Cesium');

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ktx': 'image/ktx',
  '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** 这些扩展名拿不到文件时按 404 处理，不要回落到 index.html */
const STRICT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.wasm', '.css', '.map']);

/**
 * vite-plugin-static-copy 只在 build 生效，dev 下 /cesium/** 会落到 SPA fallback
 * 返回 index.html，导致 Worker / approximateTerrainHeights.json 全部解析失败。
 * 这里给 dev server 补一个直接读 Cesium Build 目录的静态中间件。
 */
function cesiumDevStatic(): Plugin {
  return {
    name: 'aiearth-cesium-dev-static',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = (req.url ?? '').split('?')[0];
        if (!raw.startsWith('/cesium/')) return next();

        let rel: string;
        try {
          rel = decodeURIComponent(raw.slice('/cesium/'.length));
        } catch {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        const abs = path.resolve(cesiumBuild, rel);
        // 目录穿越防护
        if (!abs.toLowerCase().startsWith(cesiumBuild.toLowerCase() + path.sep)) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }

        fs.stat(abs, (err, stat) => {
          const ext = path.extname(abs).toLowerCase();
          if (err || !stat.isFile()) {
            // 代码/数据类资源缺失必须显式 404，绝不能 fallback 成 index.html
            // （否则会以 "Unexpected token '<'" / MIME 报错的假象出现，极难排查）
            if (STRICT_EXT.has(ext)) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(`Cesium asset not found: /cesium/${rel}`);
              return;
            }
            return next();
          }
          res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
          res.setHeader('Content-Length', String(stat.size));
          res.setHeader('Cache-Control', 'no-cache');
          fs.createReadStream(abs)
            .on('error', () => res.end())
            .pipe(res);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [
    cesiumDevStatic(),
    // Cesium 运行时需要 Workers / Assets / Widgets / ThirdParty 四个目录
    viteStaticCopy({
      targets: ['Workers', 'Assets', 'Widgets', 'ThirdParty'].map((dir) => ({
        src: `${cesiumRoot}/Build/Cesium/${dir}`,
        dest: 'cesium',
      })),
    }),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium/'),
  },
  server: {
    port: 5173,
    strictPort: false,
    // 后端接口代理，前端只认相对路径 /api
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
    fs: {
      // 允许引用仓库根 shared/ 下的类型契约
      allow: [root],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
});
