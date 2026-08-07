// 訊號對帳層——卡片「宣稱」對 changelog／git「事實」的唯讀對質。
// 原則（主張錨定證據）：矛盾只浮出、不自動改狀態；查不到證據＝誠實計數跳過，不硬判。
// 兩個檢查：
//   A auditClaims（純函式）：claimed 卡心跳逾時，且 claim 之後 changelog 對該卡零寫入
//     ＝認領了但沒有可對帳的產出（claim 本身不入 changelog 指紋，故任何觸卡＝真動作）。
//   B auditRealRefs（git）：status=real 卡的 refs 檔案，在其 doneTasks 標記的 commit 之後
//     又被改動＝「已實跑驗證」的宣稱可能過期（tag_commit 反向）。
// HARE b25a0d17 audit
import { git, chatBranchPrefix, defaultBase } from "./worktree.mjs";

const idTail = (id) => `#${String(id || "").slice(-4)}`;
const numOf = (n) => n?.data?.num || idTail(n?.id);
const labelOf = (n) => n?.data?.label ?? n?.data?.title ?? "";

// A：claim 逾時且無產出。changelogLines＝jsonl 原始行；staleMs 預設沿 claim 心跳 15 分。
export function auditClaims(pages, changelogLines, { now = Date.now(), staleMs = 15 * 60 * 1000 } = {}) {
  // changelog → 每卡最後觸及時間（bulk 行無逐卡明細＝略過；寧可少報不誤報）
  const lastTouch = new Map();
  for (const raw of changelogLines || []) {
    const line = String(raw).trim();
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ch = e.changed;
    if (!ch || ch.bulk) continue;
    const t = Date.parse(e.t || "") || 0;
    for (const id of [...(ch.a || []), ...(ch.u || []), ...(ch.r || [])]) {
      if ((lastTouch.get(id) || 0) < t) lastTouch.set(id, t);
    }
  }
  const out = [];
  for (const p of pages || []) {
    for (const n of p?.nodes || []) {
      const c = n?.data?.claim;
      if (!c?.t) continue;
      const ct = Date.parse(c.t);
      if (Number.isNaN(ct) || now - ct <= staleMs) continue; // 心跳仍新鮮＝正常工作中
      if ((lastTouch.get(n.id) || 0) > ct) continue; // claim 後有寫入＝有產出
      out.push({ kind: "claim_stale_no_output", id: n.id, card: numOf(n), label: labelOf(n),
        page: p.name || null, agent: c.agent || "?", claimed_at: c.t,
        stale_minutes: Math.round((now - ct) / 60000) });
    }
  }
  return out;
}

// B：real 卡 refs 檔案在標記 commit 之後被改動。runGit 可注入（單元測試假 git）。
// 證據鏈：doneTasks[].commit（tag_commit 寫入）→ 取提交時間最新的有效 hash 當基準 →
// `git log --name-only <hash>..HEAD` 改動集 ∩ 卡 refs 路徑（換算 repo 相對）。
export async function auditRealRefs(pages, refBase, { runGit = git, maxLogFiles = 20000 } = {}) {
  const empty = { available: false, mismatches: [], skipped: { no_commit_tag: 0, bad_hash: [] } };
  if (!refBase) return empty;
  const inTree = await runGit(["rev-parse", "--is-inside-work-tree"], refBase);
  if (inTree.code !== 0 || inTree.stdout.trim() !== "true") return empty;
  const prefixR = await runGit(["rev-parse", "--show-prefix"], refBase);
  const prefix = (prefixR.code === 0 ? prefixR.stdout : "").trim().replace(/\\/g, "/");
  const commitTime = new Map(); // hash → epoch 秒｜null（壞 hash）
  const changedSince = new Map(); // hash → Set(repo 相對路徑)
  const timeOf = async (h) => {
    if (commitTime.has(h)) return commitTime.get(h);
    const r = await runGit(["show", "-s", "--format=%ct", h], refBase);
    const t = r.code === 0 ? Number(r.stdout.trim()) || null : null;
    commitTime.set(h, t);
    return t;
  };
  const filesSince = async (h) => {
    if (changedSince.has(h)) return changedSince.get(h);
    const r = await runGit(["log", "--name-only", "--format=", `${h}..HEAD`], refBase);
    const set = new Set(r.code === 0
      ? r.stdout.split(/\r?\n/).map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean).slice(0, maxLogFiles)
      : []);
    changedSince.set(h, set);
    return set;
  };
  const mismatches = [];
  let noTag = 0;
  const badHash = new Set();
  for (const p of pages || []) {
    for (const n of p?.nodes || []) {
      if ((n?.data?.status || "") !== "real") continue;
      // 只對相對路徑 refs 對帳（絕對路徑＝refBase 外，git 管不到）
      const refPaths = (n.data?.refs || []).map((r) => r?.path)
        .filter((x) => typeof x === "string" && x && !/^[A-Za-z]:\//.test(x) && !x.startsWith("//"))
        .map((x) => x.replace(/\\/g, "/").replace(/^\/+/, ""));
      if (!refPaths.length) continue;
      const hashes = [...new Set((n.data?.doneTasks || [])
        .map((d) => (d && typeof d === "object" ? d.commit : null)).filter(Boolean))];
      if (!hashes.length) { noTag += 1; continue; } // 無 commit 標記＝無證據可對帳
      // 多 hash＝取提交時間最新者當基準（最後一輪工作之後的改動才算「其後」）
      let best = null, bestT = -1;
      for (const h of hashes) {
        const t = await timeOf(h);
        if (t == null) { badHash.add(h); continue; }
        if (t > bestT) { bestT = t; best = h; }
      }
      if (!best) continue; // 全壞 hash＝已入 bad_hash，誠實跳過
      const changed = await filesSince(best);
      const hit = refPaths.filter((rp) => changed.has(prefix + rp));
      if (hit.length) {
        mismatches.push({ kind: "refs_changed_after_real", id: n.id, card: numOf(n),
          label: labelOf(n), page: p.name || null, commit: best, files: [...new Set(hit)] });
      }
    }
  }
  return { available: true, mismatches, skipped: { no_commit_tag: noTag, bad_hash: [...badHash] } };
}

// C：完工未整合＋同檔並行。
// 掃 hare/chat/<project>/* 分支：領先 base 者＝待整合（附「這張卡改了哪些檔」＝
// diff --name-only base...branch 的登記）；兩卡登記交集非空＝同步修改（autoLand 會退
// 人審的那種），以 concurrent 列浮出。分支尾段＝卡片 id（safe() 對 mcp_/note_ 系不變形）。
// HARE ma4b4a9c auditWorktrees
export async function auditWorktrees(pages, refBase, project, { runGit = git, base, prefix } = {}) {
  const empty = { available: false, unintegrated: [], concurrent: [] };
  if (!refBase) return empty;
  const inTree = await runGit(["rev-parse", "--is-inside-work-tree"], refBase);
  if (inTree.code !== 0 || inTree.stdout.trim() !== "true") return empty;
  if (!base) base = await defaultBase(refBase, runGit); // 通用化：偵測專案預設分支，不假設 main
  const pfx = prefix || chatBranchPrefix(project);
  const ls = await runGit(["for-each-ref", "--format=%(refname:short)", `refs/heads/${pfx}*`], refBase);
  if (ls.code !== 0) return { available: true, unintegrated: [], concurrent: [] };
  const byId = new Map();
  for (const p of pages || []) for (const n of p?.nodes || []) byId.set(n.id, { n, page: p.name || null });
  const out = [];
  for (const branch of ls.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (branch.slice(pfx.length) === "__integration__") continue; // 整合分支不是卡片工作
    const ahead = await runGit(["rev-list", "--count", `${base}..${branch}`], refBase);
    const nAhead = ahead.code === 0 ? Number(ahead.stdout.trim()) || 0 : 0;
    if (!nAhead) continue; // 與 base 齊平＝沒有待整合工作
    const tail = branch.slice(pfx.length);
    const hit = byId.get(tail);
    const df = await runGit(["diff", "--name-only", `${base}...${branch}`], refBase);
    const files = df.code === 0
      ? df.stdout.split(/\r?\n/).map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean) : [];
    out.push({ kind: "branch_unintegrated", branch, ahead: nAhead, files,
      id: hit ? hit.n.id : null, card: hit ? numOf(hit.n) : tail,
      label: hit ? labelOf(hit.n) : "", page: hit ? hit.page : null });
  }
  // 同檔並行：檔 → 觸及它的卡清單；≥2 張卡＝同步修改警示（一檔一列）
  const touch = new Map();
  for (const u of out) for (const f of u.files) {
    if (!touch.has(f)) touch.set(f, []);
    touch.get(f).push(u.card);
  }
  const concurrent = [...touch.entries()].filter(([, cs]) => cs.length >= 2)
    .map(([file, cs]) => ({ kind: "concurrent_edit", file, cards: cs, id: null,
      card: cs.join("、"), label: file, page: null }));
  return { available: true, unintegrated: out, concurrent };
}
