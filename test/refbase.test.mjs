// B2 去 CoTechne 化·per 專案 refBase 單元測試（零依賴，node --test）。
// 隔離：HARE_DATA_DIR 指向暫存 data/、HARE_DATA_PATH 指向暫存的預設專案 legacy 檔——
// 全程不碰 repo 內真實資料。env 在動態 import 前設好，store.mjs 的路徑常數才會落在暫存區。
//
// 驗收：
//   1) 設了 refBase 的專案，refs.path 相對「該 refBase」解析。
//   2) 預設專案（未設 refBase）相對 repo 根解析＝今日行為（向後相容）。
//   3) 路徑穿越（../）一律拒絕（resolveRefPath 回 null；validate_cards 標記穿越）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hare-refbase-"));
process.env.HARE_DATA_DIR = join(TMP, "data");
process.env.HARE_DATA_PATH = join(TMP, "repo-root", "roadmap-data.json");

// 預設專案 legacy 檔所在目錄＝repo 根（未設 refBase 的解析基準）。
const REPO_ROOT = join(TMP, "repo-root");
mkdirSync(REPO_ROOT, { recursive: true });
writeFileSync(join(REPO_ROOT, "hello.txt"), "hi", "utf8");

// 另一個獨立目錄當某專案的 refBase，內含自己的檔案。
const REFBASE = join(TMP, "custom-refbase");
mkdirSync(REFBASE, { recursive: true });
writeFileSync(join(REFBASE, "inside.txt"), "yo", "utf8");

const { createProject, getProjectRefBase } = await import("../lib/projects.mjs");
const { resolveRefPath, TOOLS } = await import("../lib/tools.mjs");

test("預設專案：未設 refBase → refs.path 相對 repo 根解析（向後相容）", async () => {
  const base = await getProjectRefBase(); // 省略 project＝default
  assert.equal(base, resolve(REPO_ROOT));
  assert.equal(await resolveRefPath("hello.txt"), resolve(REPO_ROOT, "hello.txt"));
  // 反斜線與開頭斜線正規化後仍相對 repo 根
  assert.equal(await resolveRefPath("/hello.txt"), resolve(REPO_ROOT, "hello.txt"));
});

test("專案設 refBase → refs.path 相對該 refBase 解析（非 repo 根）", async () => {
  const r = await createProject("beta", { title: "Beta 板", refBase: REFBASE }, "test");
  assert.equal(r.refBase, REFBASE);
  const base = await getProjectRefBase("beta");
  assert.equal(base, resolve(REFBASE));
  assert.equal(await resolveRefPath("inside.txt", "beta"), resolve(REFBASE, "inside.txt"));
  // 同一相對路徑，default 與 beta 解析到不同根（證明 per 專案生效）
  assert.notEqual(await resolveRefPath("inside.txt", "beta"), await resolveRefPath("inside.txt"));
});

test("路徑穿越（../）一律拒絕：resolveRefPath 回 null", async () => {
  assert.equal(await resolveRefPath("../escape.txt", "beta"), null); // 逸出 refBase
  assert.equal(await resolveRefPath("../../etc/passwd"), null);      // 逸出 repo 根（default）
  // refBase 根本身（空相對）合法，不算穿越
  assert.equal(await resolveRefPath("", "beta"), resolve(REFBASE));
});

test("validate_cards 依專案 refBase 檢查 refs.path 存在性與穿越", async () => {
  await createProject("gamma", { title: "Gamma 板", refBase: REFBASE }, "test");
  // ref 指向 refBase 內存在的檔 → 不應報「檔案不存在」
  await TOOLS.add_card.run(
    { label: "存在", type: "note", desc: "d", refs: [{ path: "inside.txt", label: "in" }], project: "gamma" },
    { writer: "test" },
  );
  // ref 為穿越路徑 → 應報「逸出 refBase」
  await TOOLS.add_card.run(
    { label: "穿越", type: "note", desc: "d", refs: [{ path: "../secret.txt", label: "bad" }], project: "gamma" },
    { writer: "test" },
  );
  // ref 指向 refBase 內不存在的檔 → 應報「檔案不存在」
  await TOOLS.add_card.run(
    { label: "缺檔", type: "note", desc: "d", refs: [{ path: "nope.txt", label: "x" }], project: "gamma" },
    { writer: "test" },
  );

  const { problems } = await TOOLS.validate_cards.run({ project: "gamma" });
  const issuesFor = (label) =>
    problems.filter((p) => p.label === label).map((p) => p.issue);

  assert.ok(!issuesFor("存在").includes("refs.path 檔案不存在"),
    "refBase 內存在的檔不應被報檔案不存在");
  assert.ok(issuesFor("穿越").some((i) => i.includes("逸出 refBase")),
    "穿越路徑應被標記逸出 refBase");
  assert.ok(issuesFor("缺檔").includes("refs.path 檔案不存在"),
    "refBase 內不存在的檔應被報檔案不存在");
});

test("refs 寫入正規化：refBase 內絕對路徑轉相對；外部絕對路徑原樣", async () => {
  await createProject("delta", { title: "Delta 板", refBase: REFBASE }, "test");
  // 絕對路徑落在 refBase 內 → 存成相對（正斜線）
  const r1 = await TOOLS.add_card.run(
    { label: "絕內", refs: [{ path: join(REFBASE, "inside.txt") }], project: "delta" },
    { writer: "test" },
  );
  assert.equal(r1.card.refs[0].path, "inside.txt");
  // refBase 外的絕對路徑 → 原樣保留（正斜線化），validate 另行把關
  const outside = join(REPO_ROOT, "hello.txt");
  const r2 = await TOOLS.add_card.run(
    { label: "絕外", refs: [{ path: outside }], project: "delta" },
    { writer: "test" },
  );
  assert.equal(r2.card.refs[0].path, outside.replace(/\\/g, "/"));
  // update_card 同樣正規化
  const r3 = await TOOLS.update_card.run(
    { card: "絕內", refs: [{ path: join(REFBASE, "inside.txt"), label: "fn", uuid: "deadbeef" }], project: "delta" },
    { writer: "test" },
  );
  assert.equal(r3.card.refs[0].path, "inside.txt");
  // add_cards 批次同樣正規化
  const r4 = await TOOLS.add_cards.run(
    { cards: [{ label: "批次卡", refs: [{ path: join(REFBASE, "inside.txt") }] }], project: "delta" },
    { writer: "test" },
  );
  assert.equal(r4.count, 1);
  const got = await TOOLS.get_card.run({ card: "批次卡", fields: ["refs"], project: "delta" }, {});
  assert.equal(got.refs[0].path, "inside.txt");
});
