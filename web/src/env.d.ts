/// <reference types="vite/client" />

/** Cesium 静态资源根（由 vite define 注入，同时在 index.html 里也设了 window.CESIUM_BASE_URL） */
declare const CESIUM_BASE_URL: string;

interface Window {
  CESIUM_BASE_URL?: string;
}
