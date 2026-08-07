// MCP Streamable HTTP transport（最小可用實作，無 session 狀態）。
// 沿用手寫零依賴風格：POST 單則 JSON-RPC 訊息 → 單一 JSON 回應（不需要伺服器主動推送時，
// Streamable HTTP 規範允許直接回 application/json，不強制升級成 SSE 串流）。
// 與 stdio transport（mcp-server.mjs）共用同一份 lib/tools.mjs，工具行為完全一致。
import { TOOLS, SERVER_INFO, roleFor, validateToolArgs, buildInstructions } from "./tools.mjs";
import { authorize } from "./auth.mjs";

// 此 transport 無 session 狀態（每則 POST 各自獨立），故不做
// stdio（mcp-server.mjs）那種「每連線首次工具呼叫注入一次 G0 摘要」——沒有可掛旗標的連線概念。
// initialize.instructions 只描述何時使用 HARE，不附專案背景或工作流程；此 transport 的
// 專案語意由呼叫端主動讀 get_overview.entry 承接。

// broadcaster：寫入工具成功後 in-process 直呼 broadcast(rev)，讓同進程的 SSE 訂閱者立即收到，
// 不必等 fs.watch（fs.watch 只保留給「外部行程」，如 stdio MCP 另開一支 process 直接改檔案）。
// HARE 0ce3fa10 createMcpHttpHandler
export function createMcpHttpHandler({ broadcaster } = {}) {
  return function handleMcp(req, res) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "method not allowed：MCP Streamable HTTP 端點僅接受 POST（最小可用實作，未提供 GET 伺服器推送串流）" }));
      return;
    }
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      let msg;
      try {
        msg = JSON.parse(body || "{}");
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        return;
      }
      const { id, method, params } = msg;
      const isNotification = id === undefined || id === null;
      const reply = (result, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      const fail = (code, message, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
      };
      const noContent = () => { res.statusCode = 202; res.end(); };

      try {
        if (method === "initialize") {
          // initialize 只注入 HARE 的能力觸發；專案背景由 get_overview 提供。
          const instructions = await buildInstructions();
          return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} },
            serverInfo: SERVER_INFO, instructions });
        }
        if (method === "notifications/initialized" || method === "initialized") return noContent();
        if (method === "ping") return reply({});
        if (method === "tools/list") {
          return reply({ tools: Object.entries(TOOLS).map(([name, t]) => ({
            name, description: t.description, inputSchema: t.inputSchema })) });
        }
        if (method === "tools/call") {
          const t = TOOLS[params?.name];
          if (!t) return fail(-32602, `未知工具：${params?.name}`);
          // 參數驗證（HARE a29v8a1d）：錯誤參數名/缺必填＝明確報錯，不沉默吞
          const argErr = validateToolArgs(t, params?.arguments);
          if (argErr) return fail(-32602, `${params?.name}：${argErr}`);
          // 依工具所需角色（read/write/admin）＋目標專案授權；讀取工具在私有專案也需 token。
          const need = roleFor(params?.name);
          const auth = await authorize(req, { project: params?.arguments?.project, need });
          if (!auth.ok) {
            // 401＝未提供／未知憑證；403＝憑證有效但權限不足或跨專案越權。
            return fail(auth.status === 403 ? -32002 : -32001, auth.error, auth.status);
          }
          try {
            // writer 由 token 反查而來（identity）；無 identity 時沿用預設 mcp-http。不可由呼叫端自報。
            // /mcp?chat=<card>&chatProject=<pid> 由 spawned claude 的 mcp-config 帶入，
            // request_permission 靠它知道回問綁哪張卡（見 tools.mjs 錨 9e77a5c0）。
            let chatCard = null, chatProject = null;
            try {
              const q = new URL(req.url || "/mcp", "http://x").searchParams;
              chatCard = q.get("chat"); chatProject = q.get("chatProject");
            } catch { /* 無 query＝一般連線 */ }
            const ctx = { writer: auth.writer || "mcp-http", chatCard, chatProject,
              onWrite: (rev, project) => broadcaster?.broadcast(rev, project) };
            // 通道專案綁定：
            // chatProject 存在且工具吃 project 參數、呼叫端未指定時，預設落在綁定專案
            // ——不再靠 agent 自己記得帶 project；明確指定者以指定為準。
            let args = params?.arguments || {};
            if (chatProject && t.inputSchema?.properties?.project && args.project === undefined) {
              args = { ...args, project: chatProject };
            }
            const result = await t.run(args, ctx);
            return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
          } catch (e) {
            return reply({ content: [{ type: "text", text: `錯誤：${e.message}` }], isError: true });
          }
        }
        if (isNotification) return noContent();
        return fail(-32601, `未支援方法：${method}`);
      } catch (e) {
        if (isNotification) return noContent();
        return fail(-32603, String(e));
      }
    });
  };
}
