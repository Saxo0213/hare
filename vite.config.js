import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createBroadcaster } from "./lib/sse.mjs";
import { createRoadmapHandler } from "./lib/roadmap-api.mjs";
import { createMcpHttpHandler } from "./lib/mcp-http.mjs";

// 開發用 middleware：/api/roadmap（GET/PUT）＋ SSE /api/roadmap/events。
// 邏輯與正式對外服務共用同一份 lib/roadmap-api.mjs（含 Bearer 驗證、rev 樂觀鎖），行為保證一致。
// 僅供開發（npm run dev / preview）；對外部署改用 server.mjs（`npm run serve`，見該檔說明）。
function roadmapApi() {
  // 延遲初始化：handler（含 fs.watch）只在 dev/preview 伺服器真的啟動時才建立。
  // 若在 config 載入期就建，`vite build` 也會掛起 fs.watch → build 完程序不退出。
  let handler;
  const use = (server) => {
    if (!handler) {
      const broadcaster = createBroadcaster();
      const roadmap = createRoadmapHandler({ broadcaster, watchFile: true });
      // /mcp 也掛進 dev：通道 MVP 的權限回問（--permission-prompt-tool）要回打本服務的
      // /mcp（spawned claude 的 mcp-config 指到 http://localhost:5233/mcp?chat=<card>）。
      const mcp = createMcpHttpHandler({ broadcaster });
      handler = (req, res, next) => {
        if ((req.url || "").split("?")[0] === "/mcp") return mcp(req, res);
        return roadmap.handler(req, res, next);
      };
    }
    server.middlewares.use(handler);
  };
  return { name: "roadmap-api", configureServer: use, configurePreviewServer: use };
}

// 相對 base 讓 build 出來的 dist 可直接用 file:// 或任意路徑開啟
export default defineConfig({
  plugins: [react(), roadmapApi()],
  base: "./",
  server: { port: 5233, open: false },
  // 前端建置時間戳（2026-07-18 舊 bundle 快取偵錯）：儀錶板顯示，一眼判斷新舊
  define: { __BUILD_TS__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")) },
});
