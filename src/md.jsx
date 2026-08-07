// HARE 9835c200 Markdown 渲染模組
// 極輕量 Markdown 渲染模組
/* 極輕量 Markdown 渲染（零依賴、輸出 React elements、不經 innerHTML 防注入）。
   行級：#/##/### 標題、空行＝段落間距、清單行（-、*、•、1.、1、）保留字首只加縮排；
   行內：**粗體**、*斜體*、`code`。卡片說明（desc）用。 */
// 卡號連結（chat 內卡號可點跳卡）：文字中的卡號樣式
// 轉可點元素，點擊發 hare:focus-num 事件（App 統一跳轉，
// 含跨頁；查無此卡＝靜默不動）。linkNums 選擇性開啟——卡片 desc 不套，避免誤觸。
const NUM_RE = /\b([A-Z]{1,4}\d+[A-Z]?(?:-\d+)*)\b/g;
export const LinkNums = ({ text }) => {
  const s = String(text ?? "");
  const out = [];
  let last = 0, m, i = 0;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const num = m[1];
    out.push(<a key={i++} className="md-cardlink nodrag" href="#" title={`跳到 ${num}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.preventDefault(); e.stopPropagation();
        window.dispatchEvent(new CustomEvent("hare:focus-num", { detail: num })); }}>{num}</a>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
};

const mdInline = (text, linkNums) => {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  const seg = (t, k) => (linkNums ? <span key={k}><LinkNums text={t} /></span> : t);
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(seg(text.slice(last, m.index), `s${i++}`));
    if (m[1] !== undefined) out.push(<b key={i++}>{linkNums ? <LinkNums text={m[1]} /> : m[1]}</b>);
    else if (m[2] !== undefined) out.push(<i key={i++}>{m[2]}</i>);
    else out.push(<code key={i++}>{linkNums ? <LinkNums text={m[3]} /> : m[3]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(seg(text.slice(last), `s${i++}`));
  return out;
};
// HARE 95800044 Md
// GFM 管線表支援（chat 內表格）：標頭列＋分隔列（|---|---|）起手，
// 連續含 | 的行收進同一張表；儲存格照走 mdInline（粗體/code/卡號連結都吃）。
const tCells = (ln) => ln.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
const tSep = (ln) => /^[\s|:-]+$/.test(ln) && ln.includes("-");
export function Md({ text, linkNums = false }) {
  const lines = String(text ?? "").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    if (ln.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && tSep(lines[i + 1])) {
      const head = tCells(ln);
      const body = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes("|") && lines[j].trim() !== ""; j += 1) body.push(tCells(lines[j]));
      out.push(
        <span className="md-tbl-wrap" key={i}>
          <table className="md-tbl">
            <thead><tr>{head.map((c, k) => <th key={k}>{mdInline(c, linkNums)}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => (
              <tr key={ri}>{r.map((c, k) => <td key={k}>{mdInline(c, linkNums)}</td>)}</tr>
            ))}</tbody>
          </table>
        </span>,
      );
      i = j - 1;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)/.exec(ln);
    if (h) { out.push(<span key={i} className={`md-h${h[1].length}`}>{mdInline(h[2], linkNums)}</span>); continue; }
    if (ln.trim() === "") { out.push(<span key={i} className="md-gap" />); continue; }
    const isLi = /^\s*([-*•]|\d+[.、）)])\s*/.test(ln);
    out.push(<span key={i} className={isLi ? "md-li" : "md-p"}>{mdInline(ln, linkNums)}</span>);
  }
  return <span className="md">{out}</span>;
}


// 已連線端點對照表（nodeId → Set(handleId)），由 Flow 計算後經 context 下傳
