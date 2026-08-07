// 卡片對話面板前端——「卡片即對話」。
// 選取卡片後在此面板跟綁定該卡的 headless agent session 講話：
//   訊息（樂觀更新）→ POST /api/chat/<card> → SSE 事件（msg/status/perm/queue）即時回貼。
// 權限回問的待裁定列貼在輸入列上緣，允許/拒絕直接回 POST /api/chat/permission/<id>。
// HARE c7a7face chat-panel
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Panel } from "@xyflow/react";
import { Md, LinkNums } from "./md.jsx";
import { t as T } from "./i18n.mjs";
import { alertDialog } from "./confirm.mjs"; // 置中提示（取代原生 alert）

const ROLE_ICON = { user: "🧑", tool: "🔧", perm: "🔒", system: "⏹", error: "❌" };
const ST_CLASS = { idle: "c-idle", running: "c-run", waiting: "c-wait", error: "c-err" };
// 訊息文字→圖片連結：/api/assets/ 圖檔連結抽出（去重）供圖片膠囊列
const MSG_IMG_RE = /\/api\/assets\/[\w-]+\/[\w.-]+\.(?:png|jpe?g|gif|webp)/gi;
const msgImgsOf = (t) => [...new Set(String(t || "").match(MSG_IMG_RE) || [])];
// 「[圖片] URL」整段自顯示文字剝除（訊息內圖片同輸入列附件膠囊樣式，
// 不露原始 URL）；裸 URL（assistant 行文內）保留原句，僅另加膠囊
const stripImgMarkers = (t) => String(t || "")
  .replace(/\[圖片\]\s*\/api\/assets\/[\w-]+\/[\w.-]+\.(?:png|jpe?g|gif|webp)/gi, "")
  .replace(/\n{3,}/g, "\n\n").trim();

function ChatPanelInner({ cardId, cardNum, cardLabel, pos, onHeadDown, onClose, api, size, onResizeStart,
  resolveCard, onPickCard, taskApi, commentApi, mini = false, fold = false, onToggleFold,
  pinned = null, onTogglePin }) {
  // 側欄雙膠囊：對話卡＝chat 清單；討論＝有留言的卡（屬性框討論區整併於此）
  const [sideTab, setSideTab] = useState("chats");
  const [chat, setChat] = useState({ status: "idle", messages: [], pending: [], queue: 0 });
  const [active, setActive] = useState([]); // 作業中卡片清單（右側欄）：{card,status,queue}
  const [hoverTip, setHoverTip] = useState(null); // 對話卡懸停說明氣泡 {text,x,y}（fixed 顯示不受捲動容器夾切）
  const [input, setInput] = useState("");
  // 任務整併（底部輸入列併入 chat 框）——
  // 同一個輸入框、右側直排雙鈕：送出＝對 agent 說話；任務＝加進綁定卡的任務（或編輯存回）。
  const [attach, setAttach] = useState(null); // 附件（圖片上傳）{url,name}——送出/任務都會帶連結
  // 訊息內圖片（貼圖要顯示在訊息下方、點擊閱覽）：
  // 抓訊息文字裡的 /api/assets/ 圖片連結出縮圖；imgView＝點開的大圖 overlay
  const [imgView, setImgView] = useState(null);
  const fileRef = useRef(null);
  const edit = taskApi?.edit || null;
  useEffect(() => { if (edit) setInput(edit.text || ""); }, [edit?.num, edit?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  const withAttach = (t) => (attach ? `${t}${t ? "\n" : ""}[圖片] ${attach.url}` : t);
  // 輸入框自適應高度：最小高＝同排按鈕（30px），內容多行自動長高
  const taRef = useRef(null);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input, sideTab, mini]);
  const taskSubmit = () => {
    const t = withAttach(input.trim());
    if (!t && !edit) return;
    if (taskApi?.submit?.(t) !== false) { setInput(""); setAttach(null); }
  };
  // 權限釋放快速選單（輸入框旁、CC 權限模式選擇器風格）
  const [permPop, setPermPop] = useState(false);
  const [bashPolicy, setBashPolicy] = useState(null);
  // 開面板即載入政策（鈕面狀態色用：綠=safe-auto、黃=strict、白=trust）
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(api("/api/chat/settings"));
        if (r.ok) setBashPolicy((await r.json()).settings?.bashPolicy || "safe-auto");
      } catch { /* noop */ }
    })();
  }, [api]);
  const openPermPop = useCallback(async () => {
    setPermPop((v) => !v);
    try {
      const r = await fetch(api("/api/chat/settings"));
      if (r.ok) setBashPolicy((await r.json()).settings?.bashPolicy || "safe-auto");
    } catch { /* noop */ }
  }, [api]);
  // 點外自動關閉：pointerdown 捕獲，點到 perm-wrap 外＝收
  useEffect(() => {
    if (!permPop) return;
    const h = (e) => {
      if (e.target instanceof Node && e.target.closest && e.target.closest(".perm-wrap")) return;
      setPermPop(false);
    };
    window.addEventListener("pointerdown", h, true);
    return () => window.removeEventListener("pointerdown", h, true);
  }, [permPop]);
  const pickPolicy = useCallback(async (v) => {
    setBashPolicy(v);
    setPermPop(false);
    try {
      await fetch(api("/api/chat/settings"), { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bashPolicy: v }) });
    } catch { /* noop */ }
  }, [api]);
  // 討論模式送出＝留言（走 App 的 addComment：add_comment 優先、失敗退 board PUT）
  const cmtSend = () => {
    const t = withAttach(input.trim());
    if (!t || !commentApi?.canUse) return;
    commentApi.add(t);
    setInput("");
    setAttach(null);
  };
  const pickFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || !taskApi?.upload) return;
    try { const { url, name } = await taskApi.upload(f); setAttach({ url, name }); }
    catch (err) { alertDialog(String(err?.message || err)); }
  };
  // 剪貼簿貼圖（Ctrl+V 貼不上）：paste 截取圖片項→同附件管道
  const onPaste = async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item || !taskApi?.upload) return;
    e.preventDefault();
    const f = item.getAsFile();
    if (!f) return;
    try {
      const named = f.name && f.name !== "image.png" ? f
        : new File([f], `paste-${Date.now().toString(36)}.png`, { type: f.type || "image/png" });
      const { url, name } = await taskApi.upload(named);
      setAttach({ url, name });
    } catch (err) { alertDialog(String(err?.message || err)); }
  };
  const bodyRef = useRef(null);
  const loadTimer = useRef(null);
  const actTimer = useRef(null);
  // 折疊（所有視窗點標題折疊，chat 框也要）：收剩標題列，持久化
  // 折疊狀態上提 App（輸入狀態模式：App 需知道折疊與否來出迷你輸入列）
  const headAt = useRef(null);
  const headDown = (e) => { headAt.current = { x: e.clientX, y: e.clientY }; };
  const headClick = (e) => {
    if (e.target.closest("button, input, select, textarea")) return;
    const d = headAt.current;
    if (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) return;
    if (onToggleFold) onToggleFold();
  };

  const load = useCallback(async () => {
    if (!cardId) return;
    try {
      const r = await fetch(api(`/api/chat/${encodeURIComponent(cardId)}`));
      if (r.ok) setChat(await r.json());
    } catch { /* 伺服器未起＝面板顯示空 */ }
  }, [cardId, api]);

  const loadActive = useCallback(async () => {
    try {
      const r = await fetch(api("/api/chat/active"));
      if (r.ok) setActive((await r.json()).chats || []);
    } catch { /* noop */ }
  }, [api]);

  // 開面板／換卡＝重載；SSE：本卡事件＝debounce 重載對話，任何 chat 事件＝更新作業中側欄
  useEffect(() => {
    load();
    loadActive();
    if (typeof EventSource === "undefined") return;
    let es;
    try { es = new EventSource(api("/api/roadmap/events")); } catch { return; }
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type !== "chat") return;
        clearTimeout(actTimer.current);
        actTimer.current = setTimeout(loadActive, 150);
        if (d.card !== cardId) return;
        clearTimeout(loadTimer.current);
        loadTimer.current = setTimeout(load, 120);
      } catch { /* 心跳等非 JSON 忽略 */ }
    };
    return () => { clearTimeout(loadTimer.current); clearTimeout(actTimer.current); es.close(); };
  }, [cardId, api, load, loadActive]);

  // 新訊息進來自動捲到底
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length]);

  const send = useCallback(async () => {
    const text = attach ? `${input.trim()}${input.trim() ? "\n" : ""}[圖片] ${attach.url}` : input.trim();
    if (!text || !cardId) return;
    setInput("");
    setAttach(null);
    // 樂觀更新：送出即顯示暫存訊息（伺服器回貼後 load 覆蓋）
    setChat((c) => ({ ...c, messages: [...c.messages, { t: new Date().toISOString(), role: "user", text }] }));
    try {
      await fetch(api(`/api/chat/${encodeURIComponent(cardId)}`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
    } catch { /* 失敗時下次 load 會校正 */ }
    load();
  }, [input, attach, cardId, api, load]);

  const interrupt = useCallback(async () => {
    if (!cardId) return;
    try { await fetch(api(`/api/chat/${encodeURIComponent(cardId)}/interrupt`), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { /* noop */ }
    load();
  }, [cardId, api, load]);

  // 三檔核可：scope＝once（僅此次）/session（本會話白名單）/always（永久白名單）
  const decide = useCallback(async (id, allow, scope = "once") => {
    try {
      await fetch(api(`/api/chat/permission/${encodeURIComponent(id)}`), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allow, scope }),
      });
    } catch { /* noop */ }
    load();
  }, [api, load]);

  const busy = chat.status === "running" || chat.status === "waiting";
  // ---- 共用區塊（完整面板與 mini 輸入狀態模式共用） ----
  const pendingUI = chat.pending.length > 0 && (
    <div className="chat-perms nodrag">
      {chat.pending.map((p) => p.danger ? (
        /* 危險指令系統提醒：紅色、僅此次/15 分鐘放行/拒絕 */
        /* 按鈕獨立一列排最下（不與說明同列擠版面） */
        <div key={p.id} className="chat-perm chat-perm-danger">
          <span className="chat-perm-t">⚠ {T("c_dangerPending")}</span>
          {p.input?.command && (
            <code className="chat-perm-cmd" title={p.input.command}>
              {String(p.input.command).slice(0, 80)}</code>
          )}
          <div className="chat-perm-btns">
            <button className="chat-allow" onClick={() => decide(p.id, true, "once")}>{T("c_allowOnce")}</button>
            <button className="chat-allow" onClick={() => decide(p.id, true, "15min")}>{T("c_allow15m")}</button>
            <button className="chat-deny" onClick={() => decide(p.id, false)}>{T("c_deny")}</button>
          </div>
        </div>
      ) : (
        <div key={p.id} className="chat-perm">
          <span className="chat-perm-t">🔒 {T("c_permPending")}：{p.tool}</span>
          {(p.input?.command || p.input?.file_path) && (
            <code className="chat-perm-cmd" title={p.input?.command || p.input?.file_path}>
              {String(p.input?.command || p.input?.file_path).slice(0, 80)}</code>
          )}
          <div className="chat-perm-btns">
            <button className="chat-allow" title={T("c_allowOnceTip")}
              onClick={() => decide(p.id, true, "once")}>{T("c_allowOnce")}</button>
            <button className="chat-allow" title={T("c_allowSessionTip")}
              onClick={() => decide(p.id, true, "session")}>{T("c_allowSession")}</button>
            <button className="chat-allow" title={T("c_allowAlwaysTip")}
              onClick={() => decide(p.id, true, "always")}>{T("c_allowAlways")}</button>
            <button className="chat-deny" onClick={() => decide(p.id, false)}>{T("c_deny")}</button>
          </div>
        </div>
      ))}
    </div>
  );
  const chipsUI = (
    <div className="chat-chips nodrag">
      {edit && (
        <span className="ci-chip">✎ {T("c_editingTask", { num: edit.num })}
          <button onClick={() => { taskApi?.cancel?.(); setInput(""); }}>✕</button></span>
      )}
      {taskApi?.regionTag && (
        <span className="ci-chip">
          {taskApi.regionTag.shot && <img src={taskApi.regionTag.shot} alt={`R${taskApi.regionTag.n}`} />}
          {taskApi.regionTag.cardNum}·R{taskApi.regionTag.n}
          {!edit && <button onClick={() => taskApi.cancelRegion?.()}>✕</button>}
        </span>
      )}
      {attach && (
        <span className="ci-chip"><img src={attach.url} alt={attach.name} />{attach.name}
          <button onClick={() => setAttach(null)}>✕</button></span>
      )}
    </div>
  );
  // 輸入列基本高：跟著左右按鈕直排總高（全功能雙鈕 64px、
  // 精簡單鈕 30px＝ci-slim），內容多行再自適應長高——尺寸由 CSS min-height 承載
  const inputUI = (
    <div className={`chat-input-row nodrag${mini || sideTab === "cmts" ? " ci-slim" : ""}`}>
      <span className="ci-side">
        {/* mini＝純任務欄：🛡 與送出隱藏，只留 ＋ 與任務；
            討論模式（sideTab=cmts）＝留言欄：🛡 與任務也隱藏，高度隨之縮 */}
        {!mini && sideTab !== "cmts" && (
          <span className="perm-wrap">
            <button className={`ci-attach perm-${bashPolicy || "safe-auto"}`}
              title={T("c_permBtn")} onClick={openPermPop}>🛡</button>
            {permPop && (
              <div className="perm-pop">
                <div className="perm-pop-t">{T("ag_bashPolicy")}</div>
                {[["safe-auto", T("ag_bpSafeAuto")], ["strict", T("ag_bpStrict")], ["trust", T("ag_bpTrust")], ["all", T("ag_bpAll")]].map(([v, label]) => (
                  <button key={v} className={bashPolicy === v ? "on" : ""}
                    onClick={() => pickPolicy(v)}>{bashPolicy === v ? "● " : "○ "}{label}</button>
                ))}
              </div>
            )}
          </span>
        )}
        <button className="ci-attach" title={T("c_attach")} onClick={() => fileRef.current?.click()}>＋</button>
      </span>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: "none" }} onChange={pickFile} />
      <textarea ref={taRef} rows={1} value={input}
        placeholder={edit ? T("c_editTaskPh") : mini ? T("inputTask") : sideTab === "cmts" ? T("c_cmtPh") : T("c_inputPh")}
        onPaste={onPaste}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (edit || mini) taskSubmit(); else if (sideTab === "cmts") cmtSend(); else send();
          }
          if (e.key === "Escape" && edit) { taskApi?.cancel?.(); setInput(""); }
        }} />
      <div className="ci-btns">
        {!mini && (
          <button onClick={sideTab === "cmts" ? cmtSend : send} disabled={!input.trim() || !!edit}>{T("c_send")}</button>
        )}
        {(mini || sideTab !== "cmts") && (
          <button className="ci-task" onClick={taskSubmit}
            disabled={edit ? false : (!input.trim() && !attach) || !taskApi?.canAdd}>
            {edit ? T("c_taskSave") : T("c_taskBtn")}</button>
        )}
      </div>
    </div>
  );
  // 輸入狀態模式：CHAT 關閉/折疊時，選卡即出迷你輸入列——
  // 全功能（送出/任務/附件/🛡/貼圖/待裁定）但不佔畫面，快速瀏覽卡片下任務
  if (mini) return (
    <Panel position="bottom-center" className="float-box chat-mini nodrag">
      <div className="chat-mini-head">
        <span className="fb-title">💬 {cardNum || ""} {cardLabel || ""}</span>
        <span className={`chat-st ${ST_CLASS[chat.status] || "c-idle"}`}>
          {T(`c_st${chat.status[0].toUpperCase()}${chat.status.slice(1)}`)}
          {chat.queue > 0 ? `・${T("c_queued", { n: chat.queue })}` : ""}
        </span>
        {busy && <button className="fb-round nodrag" title={T("c_interrupt")} onClick={interrupt}>⏹</button>}
      </div>
      {pendingUI}
      {chipsUI}
      {inputUI}
    </Panel>
  );
  return (
    <Panel position="top-left" className={`float-box edge-panel chat-panel ${fold ? "collapsed" : ""}`}
      style={{ left: pos.x, top: pos.y, right: "auto", transform: "none", margin: 0,
        width: size.w, height: size.h }}
      onMouseDown={onHeadDown}>
      {/* 邊緣調整大小（同卡片）：八向隱形把手（App useEdgeResize），
          拖左/上緣同步移框讓對邊視覺固定；mousedown 已 stopPropagation 不觸發移動拖曳 */}
      {["t", "b", "l", "r", "tl", "tr", "bl", "br"].map((d) => (
        <div key={d} className={`pr-rz pr-rz-${d} nodrag`} onMouseDown={(e) => onResizeStart(e, d)} />
      ))}
      <div className="fb-head" style={{ cursor: "move" }} onMouseDown={headDown} onClick={headClick}>
        <span className="fb-title">💬 {T("c_title")}{cardId ? `：${cardNum || ""} ${cardLabel || ""}` : ""}</span>
        <span className={`chat-st ${ST_CLASS[chat.status] || "c-idle"}`}>
          {T(`c_st${chat.status[0].toUpperCase()}${chat.status.slice(1)}`)}
          {chat.queue > 0 ? `・${T("c_queued", { n: chat.queue })}` : ""}
        </span>
        {busy && <button className="fb-round nodrag" title={T("c_interrupt")} onClick={interrupt}>⏹</button>}
        <button className="fb-toggle" title={T("a_close")} onClick={onClose}>✕</button>
      </div>
      <div className="chat-main">
        {/* 對話卡側欄（置左）：所有有聊天狀態的卡——
            作業中排最前（綠點閃＝工作中、橙＝等裁定、灰＝閒置、紅＝錯誤），
            點標籤＝跳到該卡並切換面板綁定。任何 chat 事件都會刷新。 */}
        <div className="chat-side nodrag">
          {hoverTip && (
            <div className="chat-tip" style={{ left: hoverTip.x, top: hoverTip.y }}>{hoverTip.text}</div>
          )}
          {/* 單膠囊模式切換（兩膠囊合併、點擊切換） */}
          <div className="tl-tabs side-tabs">
            <button className="on" title={T("c_tabSwitchTip")}
              onClick={() => setSideTab((t) => (t === "chats" ? "cmts" : "chats"))}>
              {sideTab === "chats" ? T("c_tabChats") : T("c_tabCmts")} ⇄
            </button>
          </div>
          {sideTab === "cmts" && (
            <>
              {!(commentApi?.cards || []).length && <div className="chat-side-empty">{T("c_activeEmpty")}</div>}
              {(commentApi?.cards || []).map((a) => (
                <button key={a.card} className={`chat-act c-idle${a.card === cardId ? " on" : ""}`}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setHoverTip({ text: `${a.num} ${a.label}${a.page ? `｜${a.page}` : ""}・💬${a.count}`, x: r.left, y: r.top });
                  }}
                  onMouseLeave={() => setHoverTip(null)}
                  onClick={() => onPickCard && onPickCard(a)}>
                  <span className="dot" style={{ background: "var(--warn)" }} />
                  <span className="t">{a.num || a.label.slice(0, 6)}</span>
                </button>
              ))}
            </>
          )}
          {sideTab === "chats" && active.length === 0 && <div className="chat-side-empty">{T("c_activeEmpty")}</div>}
          {sideTab === "chats" && active.map((a) => {
            // 標籤解析：伺服器 listChats 已帶 num/label/page（跨頁到位）；缺（舊格式/
            // 讀板失敗）才退本地 resolveCard；卡已刪＝missing 灰列，仍可點開讀轉錄；
            // __project__＝專案助理（專案級對話）
            const info = a.projectChat ? { num: "", label: T("c_projAssistant") }
              : a.label !== undefined && !a.missing ? a
                : (resolveCard && resolveCard(a.card)) || { num: "", label: a.card };
            const gone = !a.projectChat && a.missing && info.label === a.card;
            const stCls = a.status === "waiting" ? "c-wait" : a.status === "running" ? "c-run"
              : a.status === "error" ? "c-err" : "c-idle";
            // 窄欄只放編號（名稱擠不下就別截半），
            // 完整說明改懸停浮出（fixed 氣泡——側欄是捲動容器，::after 會被夾住）
            const tip = `${gone ? T("c_cardGone") : `${info.num} ${info.label}`}${a.page ? `｜${a.page}` : ""}${a.queue ? `・${T("c_queued", { n: a.queue })}` : ""}`;
            return (
              <button key={a.card}
                className={`chat-act ${stCls}${a.card === cardId ? " on" : ""}${gone ? " gone" : ""}`}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setHoverTip({ text: tip, x: r.left, y: r.top });
                }}
                onMouseLeave={() => setHoverTip(null)}
                onClick={() => onPickCard && onPickCard(a)}>
                <span className="dot" />
                <span className="t">{a.projectChat ? T("c_projAssistant") : gone ? a.card.slice(0, 8) : (info.num || info.label.slice(0, 6))}</span>
                {/* 釘選（唯一）：對話固定在此卡，選板上卡片不切走 */}
                {onTogglePin && (
                  <span className={`chat-pin nodrag${a.card === pinned ? " on" : ""}`} title={T("c_pinChatTip")}
                    onClick={(e) => { e.stopPropagation(); onTogglePin(a.card); }}>📌</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="chat-left">
          {!cardId && <div className="chat-body"><div className="tl-empty">{T("c_selectCard")}</div></div>}
          {cardId && (
            <>
              <div className="chat-body nodrag" ref={bodyRef}>
                {sideTab === "cmts" ? (
                  <>
                    {/* 討論串（屬性框整併）：綁定卡的留言；browser 留言可刪 */}
                    {!(commentApi?.list || []).length && <div className="tl-empty">{T("c_noComments")}</div>}
                    {(commentApi?.list || []).map((c, i) => (
                      <div key={i} className="chat-m chat-m-cmt">
                        <span className="cmt-meta-line">💬 {c.writer || "?"}・{(c.t || "").slice(5, 16).replace("T", " ")}
                          {c.writer === "browser" && (
                            <button className="cmt-del nodrag" onClick={() => commentApi?.del?.(i)}>✕</button>
                          )}
                        </span>
                        <Md text={c.text || ""} />
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    {chat.messages.length === 0 && (
                      <div className="tl-empty">{cardId === "__project__" ? T("c_emptyProj") : T("c_empty")}</div>
                    )}
                    {/* 最後一則 user 訊息 sticky 置頂（同 VS Code） */}
                    {(() => {
                      let lastUser = -1;
                      for (let i = chat.messages.length - 1; i >= 0; i--) {
                        if (chat.messages[i].role === "user") { lastUser = i; break; }
                      }
                      return chat.messages.map((m, i) => {
                        const imgs = msgImgsOf(m.text);
                        const shown = imgs.length ? stripImgMarkers(m.text) : m.text;
                        return (
                          <div key={i} className={`chat-m chat-m-${m.role}${i === lastUser ? " chat-m-pin" : ""}${m.role === "tool" && String(m.text).startsWith("$ ") ? " chat-m-cmd" : ""}`}>
                            {/* 卡號可點跳卡：assistant 走 Md linkNums、其他角色走 LinkNums */}
                            {m.role === "assistant"
                              ? <Md text={shown} linkNums />
                              : <span>{ROLE_ICON[m.role] || ""} <LinkNums text={shown} /></span>}
                            {/* 訊息內圖片＝附件膠囊同款：小縮圖＋檔名，點擊開閱覽 */}
                            {imgs.length > 0 && (
                              <div className="chat-m-imgs">
                                {imgs.map((u) => (
                                  <button key={u} type="button" className="ci-chip chat-img-chip nodrag"
                                    title={T("c_viewImg")} onClick={() => setImgView(u)}>
                                    <img src={u} alt="" loading="lazy" />{u.split("/").pop()}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </>
                )}
              </div>
              {/* 待裁定列貼輸入列上緣（核可動作靠近互動處） */}
              {pendingUI}
              {chipsUI}
              {inputUI}
            </>
          )}
        </div>
      </div>
      {/* 圖片閱覽 overlay：點縮圖放大，點任意處關閉 */}
      {imgView && (
        <div className="chat-imgview nodrag" onClick={() => setImgView(null)}>
          <img src={imgView} alt="" />
        </div>
      )}
    </Panel>
  );
}

export const ChatPanel = memo(ChatPanelInner);

// Agent 設定頁：對話 agent 選擇（EXECUTORS 列驅動＋本機 CLI 偵測）、
// 權限回問逾時秒數、永久白名單檢視/清空。資料走 /api/chat/settings（GET/POST）。
// HARE a9e2757e agent-settings-pane
// 各 agent 的安裝管道（資料列， ：設定頁要讓非程式人看得懂怎麼接）。
// npm 者給一鍵複製指令；原生安裝者給官網（不編指令，誠實）。
const AGENT_SETUP = {
  claude: { title: "Claude Code", install: "npm install -g @anthropic-ai/claude-code", url: "https://claude.com/claude-code" },
  codex: { title: "Codex CLI（OpenAI）", install: "npm install -g @openai/codex", url: "https://github.com/openai/codex" },
};

// 儲存制：executor/逾時/政策改動先進草稿，「儲存」才 POST、「取消」還原
function AgentSettingsPaneInner({ api, onDirty, bind }) {
  const [info, setInfo] = useState(null); // {settings, executors:[{name,available,version,note}], whitelist}
  const [draft, setDraft] = useState(null); // {executor}（核可/逾時已移安全性頁，W1-6-2）
  const [copied, setCopied] = useState(null);
  const [authMsg, setAuthMsg] = useState(null); // {name, text}：登入/登出開窗回饋
  const load = useCallback(async () => {
    try {
      const r = await fetch(api("/api/chat/settings"));
      if (r.ok) { setInfo(await r.json()); setDraft(null); }
    } catch { /* 伺服器未起 */ }
  }, [api]);
  useEffect(() => { load(); }, [load]);
  const baseOf = (j) => ({ executor: j?.settings?.executor || "claude" });
  useEffect(() => { if (info && !draft) setDraft(baseOf(info)); }, [info, draft]);
  const dirty = !!info && !!draft && JSON.stringify(draft) !== JSON.stringify(baseOf(info));
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false); }, [dirty, onDirty]);
  const save = useCallback(async () => {
    try {
      await fetch(api("/api/chat/settings"), { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executor: draft.executor }) });
    } catch { /* noop */ }
    load();
  }, [api, draft, load]);
  // 帳號切換：登入/登出＝伺服器開系統終端機視窗跑該 CLI 的互動流程
  const agentAuth = useCallback(async (name, action) => {
    try {
      const r = await fetch(api("/api/chat/agent-auth"), { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ executor: name, action }) });
      const j = await r.json();
      setAuthMsg(j.ok ? { name, text: `${T("ag_authOpened")}（${j.command}）` } : { name, text: `⚠ ${j.error || j.command || ""}` });
    } catch { setAuthMsg({ name, text: "⚠" }); }
  }, [api]);
  // 儲存/取消動作註冊給設定頁共用頁尾（全頁籤共用一組）
  //（必在 save 宣告之後——依賴陣列在渲染期取值，先引用＝TDZ 崩潰）
  useEffect(() => {
    bind?.({ save, cancel: () => setDraft(info ? baseOf(info) : null) });
  }, [bind, save, info]);
  const copy = useCallback((name, text) => {
    try { navigator.clipboard.writeText(text); setCopied(name); setTimeout(() => setCopied(null), 1500); }
    catch { /* 剪貼簿不可用 */ }
  }, []);
  if (!info || !draft) return <div className="ep-body"><div className="tl-empty">…</div></div>;
  const cur = draft.executor;
  return (
    <div className="ep-body nodrag">
      {/* 這台電腦上的 agent：偵測結果一列一張——已裝可選用；未裝給安裝指引。
          左側欄位標籤已依 2026-08-02 使用者指示移除（卡片清單滿版） */}
      <div className="ep-row">
        <div className="set-line" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          {(info.executors || []).map((x) => {
            const s = AGENT_SETUP[x.name] || { title: x.name };
            return (
              <div key={x.name} className={`ag-card${x.name === cur ? " on" : ""}${x.available ? "" : " off"}`}>
                {/* 帳號列（與名稱列上下對調）：左＝標籤/開窗回饋，右＝登入登出群組鎖最右 */}
                {x.available && (
                  <div className="ag-auth">
                    <span className="set-hint">{authMsg?.name === x.name ? authMsg.text : T("ag_account")}</span>
                    <div className="ag-auth-btns">
                      <button className="nodrag" onClick={() => agentAuth(x.name, "login")}>{T("ag_login")}</button>
                      <button className="nodrag" onClick={() => agentAuth(x.name, "logout")}>{T("ag_logout")}</button>
                    </div>
                  </div>
                )}
                <div className="ag-head">
                  <span className="ag-st">{x.available ? "✅" : "⬜"}</span>
                  <span className="ag-name">{s.title}</span>
                  {x.available && x.version && <span className="set-hint">{x.version}</span>}
                  {x.available ? (
                    x.name === cur
                      ? <span className="ag-cur">{T("ag_inUse")}</span>
                      : <button className="nodrag" onClick={() => setDraft((d) => ({ ...d, executor: x.name }))}>{T("ag_use")}</button>
                  ) : <span className="set-hint">{T("ag_notInstalled")}</span>}
                </div>
                {!x.available && (
                  <div className="ag-install">
                    {s.install ? (
                      <>
                        <code>{s.install}</code>
                        <button className="nodrag" onClick={() => copy(x.name, s.install)}>
                          {copied === x.name ? T("ag_copied") : T("ag_copy")}
                        </button>
                      </>
                    ) : (
                      <span className="set-hint">{T("ag_seeSite")}{s.url ? `：${s.url}` : ""}</span>
                    )}
                  </div>
                )}
                {x.note && x.name === cur && <div className="set-hint">{x.note}</div>}
              </div>
            );
          })}
        </div>
      </div>
      {/* 下方說明列已移除（核可/逾時/白名單在「安全性」頁籤） */}
    </div>
  );
}
export const AgentSettingsPane = memo(AgentSettingsPaneInner);

// 安全性頁（白名單自 Agent 設定頁移入）：永久白名單檢視/清空
// HARE 5ec9a9e1 security-pane
// 儲存制：清單編輯只動草稿，「儲存」才整份覆寫、「取消」還原；
// 髒狀態經 onDirty 回報 App（關設定頁前提醒）
function SecurityPaneInner({ api, onDirty, bind }) {
  const [saved, setSaved] = useState(null); // 伺服器版 {tools, bash, permSec, bashPolicy}（核可/逾時自 Agent 頁移入，W1-6-2）
  const [draft, setDraft] = useState(null);
  const [txt, setTxt] = useState("");
  const cloneOf = (s) => ({ ...s, tools: [...s.tools], bash: [...s.bash] });
  const load = useCallback(async () => {
    try {
      const r = await fetch(api("/api/chat/settings"));
      if (r.ok) {
        const j = await r.json();
        const st = { tools: j.whitelist?.tools || [], bash: j.whitelist?.bash || [],
          permSec: Math.round((j.settings?.permissionTimeoutMs || 180000) / 1000),
          bashPolicy: j.settings?.bashPolicy || "safe-auto" };
        setSaved(st); setDraft(cloneOf(st));
      }
    } catch { /* 伺服器未起 */ }
  }, [api]);
  useEffect(() => { load(); }, [load]);
  const dirty = !!saved && !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false); }, [dirty, onDirty]);
  const add = useCallback(() => {
    const v = txt.trim();
    if (!v || !draft) return;
    setDraft((d) => {
      const n = { tools: [...d.tools], bash: [...d.bash] };
      if (/^bash:/i.test(v)) { const h = v.slice(5).trim(); if (h && !n.bash.includes(h)) n.bash.push(h); }
      else if (!n.tools.includes(v)) n.tools.push(v);
      return n;
    });
    setTxt("");
  }, [txt, draft]);
  const save = useCallback(async () => {
    try {
      await fetch(api("/api/chat/settings"), { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ whitelist: { tools: draft.tools, bash: draft.bash },
          permissionTimeoutMs: Math.max(10, Number(draft.permSec) || 180) * 1000,
          bashPolicy: draft.bashPolicy }) });
    } catch { /* noop */ }
    load();
  }, [api, draft, load]);
  // 儲存/取消動作註冊給設定頁共用頁尾（全頁籤共用一組）
  //（必在 save 宣告之後——依賴陣列在渲染期取值，先引用＝TDZ 崩潰）
  useEffect(() => {
    bind?.({ save, cancel: () => setDraft(saved ? cloneOf(saved) : null) });
  }, [bind, save, saved]);
  if (!draft) return <div className="ep-body"><div className="tl-empty">…</div></div>;
  const items = [...draft.tools.map((t) => ({ kind: "tools", v: t, show: t })),
    ...draft.bash.map((b) => ({ kind: "bash", v: b, show: `Bash:${b}` }))];
  const remove = (it) => setDraft((d) => ({ ...d, [it.kind]: d[it.kind].filter((x) => x !== it.v) }));
  return (
    <div className="ep-body nodrag">
      {/* 核可與逾時（自 Agent 設定頁移入） */}
      <div className="ep-row">
        <span className="ep-k">{T("ag_permTitle")}</span>
        <div className="set-line" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <div className="set-line">
            <span>{T("ag_timeout")}</span>
            <input className="ep-input nodrag" type="number" min="10" step="10" style={{ width: 90 }}
              value={draft.permSec}
              onChange={(e) => setDraft((d) => ({ ...d, permSec: e.target.value }))} />
            <span className="set-hint">{T("ag_timeoutHint")}</span>
          </div>
          {/* Bash 核可政策（重複核可改由系統裁決） */}
          <div className="set-line">
            <span>{T("ag_bashPolicy")}</span>
            <select className="ep-input nodrag" value={draft.bashPolicy}
              onChange={(e) => setDraft((d) => ({ ...d, bashPolicy: e.target.value }))}>
              <option value="safe-auto">{T("ag_bpSafeAuto")}</option>
              <option value="strict">{T("ag_bpStrict")}</option>
              <option value="trust">{T("ag_bpTrust")}</option>
              <option value="all">{T("ag_bpAll")}</option>
            </select>
          </div>
          <span className="set-hint">{T("ag_bashPolicyHint")}</span>
        </div>
      </div>
      <div className="ep-row" style={{ alignItems: "flex-start" }}>
        <span className="ep-k">{T("ag_whitelist")}</span>
        <div className="set-line" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <div className="sec-add">
            <input className="ep-input nodrag" value={txt} placeholder={T("sec_addPh")}
              onChange={(e) => setTxt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
            <button className="sec-sq nodrag" title={T("sec_addTip")} onClick={add}>＋</button>
          </div>
          {items.length
            ? (
              <div className="sec-wl">
                {items.map((it, i) => (
                  <span key={i} className="sec-wl-i" title={it.show}>
                    <span className="sec-wl-t">{it.show}</span>
                    <button className="sec-sq sec-rm nodrag" title={T("sec_rmTip")} onClick={() => remove(it)}>−</button>
                  </span>
                ))}
              </div>
            )
            : <span className="set-hint">{T("ag_wlEmpty")}</span>}
          {items.length > 0 && (
            <div className="sec-foot">
              <button className="nodrag" onClick={() => setDraft({ tools: [], bash: [] })}>{T("ag_wlClear")}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
export const SecurityPane = memo(SecurityPaneInner);

// 儀錶板頁（DashPane，額度偵測源 UI）已依 W1-6-2整頁移除；
// 伺服器端 /api/dash* 端點保留（匣圖示/迷你浮窗仍用），需要時從 git 歷史還原 UI。
