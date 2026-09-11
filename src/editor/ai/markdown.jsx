import { useState } from "react";
import { Check, Copy } from "../icons/index.jsx";

/**
 * The assistant writes markdown. Render it.
 *
 * The panel used to print the answer into a `white-space: pre-wrap` div, so a
 * reply arrived as `**Sponza Atrium**`, `` `scenes/Sponza.scene` `` and a wall
 * of `·`-joined names — the literal source, asterisks and all. That is the
 * single largest reason the chat did not read like a chat: every emphasis the
 * model reached for became noise instead of shape.
 *
 * This is a small block/inline parser rather than a dependency. The engine
 * ships no markdown library and the payload here is one panel's prose, so a
 * marked+sanitiser pair (and `dangerouslySetInnerHTML` around model output)
 * would be a lot of surface for very little. Everything below builds React
 * nodes, so there is no HTML string to sanitise in the first place — a `<img
 * onerror>` in an answer is text, not markup.
 *
 * What it supports, chosen from what the model actually emits here: fenced and
 * indented-free code, headings, ordered/unordered lists with one level of
 * nesting, blockquotes, rules, GFM tables, and inline code / bold / italic /
 * strikethrough / links / bare URLs.
 *
 * TWO THINGS IT DOES ON PURPOSE:
 *  - An UNTERMINATED fence still renders as a code block. Answers stream in;
 *    the closing ``` arrives seconds after the opening one, and a block that
 *    only becomes a block at the end flickers the whole transcript.
 *  - A single newline inside a paragraph is a LINE BREAK, not a space. Real
 *    markdown joins them, but these answers are full of paths, entity names
 *    and short enumerations where the author's line ending was meant.
 */

// One alternation, tried left to right: code spans win over everything (so
// `**` inside backticks stays literal), then strong, em, strike, links, and
// finally bare URLs.
const INLINE_RE =
  /(`+)([^]*?)\1|\*\*([^]+?)\*\*|__([^]+?)__|(?<![\w\\*])\*([^*\n]+?)\*(?!\w)|(?<![\w\\_])_([^_\n]+?)_(?!\w)|~~([^]+?)~~|\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(\bhttps?:\/\/[^\s<>()[\]]+)/g;

const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEAD_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** Opens externally; a link inside the editor must never navigate the webview. */
async function openLink(href) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href);
  } catch {
    window.open(href, "_blank", "noopener");
  }
}

/**
 * Inline spans of one line/paragraph, as React nodes.
 *
 * The regex is CLONED per call, not shared. This function recurses (bold
 * wrapping italic wrapping a link), and a `/g/` regex carries `lastIndex` on
 * the object itself — an inner call rewinding it sent the outer scan back to
 * character 0 and looped until the heap died.
 */
function inline(text, key = "i") {
  const re = new RegExp(INLINE_RE.source, "g");
  const out = [];
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}${n++}`;
    const [, , code, strongA, strongB, emA, emB, strike, linkText, href, url] = m;
    if (code !== undefined) out.push(<code key={k}>{code.trim()}</code>);
    else if (strongA ?? strongB) out.push(<strong key={k}>{inline(strongA ?? strongB, `${k}-`)}</strong>);
    else if (emA ?? emB) out.push(<em key={k}>{inline(emA ?? emB, `${k}-`)}</em>);
    else if (strike) out.push(<s key={k}>{inline(strike, `${k}-`)}</s>);
    else if (href)
      out.push(
        <a key={k} href={href} onClick={(e) => (e.preventDefault(), openLink(href))}>
          {linkText || href}
        </a>,
      );
    else if (url)
      out.push(
        <a key={k} href={url} onClick={(e) => (e.preventDefault(), openLink(url))}>
          {url}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A paragraph, keeping authored line breaks. */
function paragraph(text, key) {
  const lines = text.split("\n");
  return (
    <p key={key}>
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <br />}
          {inline(line, `${key}-${i}-`)}
        </span>
      ))}
    </p>
  );
}

/** A fenced block, with its language and a copy button. */
function CodeBlock({ code, lang }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "code"}</span>
        <button className="md-code-copy" title="Copy code" onClick={copy}>
          {done ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** A list and everything nested under it. Returns `[node, nextLineIndex]`. */
function takeList(lines, start, key) {
  const ordered = OL_RE.test(lines[start]);
  const baseIndent = (lines[start].match(/^\s*/) ?? [""])[0].length;
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(UL_RE) ?? line.match(OL_RE);
    if (m) {
      const indent = m[1].length;
      if (indent < baseIndent) break;
      // A bulleted list that turns numbered is a NEW list, not more of this
      // one — swallowing it printed "1. first" as another bullet.
      if (indent === baseIndent && OL_RE.test(line) !== ordered) break;
      if (indent >= baseIndent + 2 && items.length) {
        const [sub, next] = takeList(lines, i, `${key}-${items.length}`);
        items[items.length - 1].children.push(sub);
        i = next;
        continue;
      }
      items.push({ text: m[m.length - 1], children: [] });
      i += 1;
      continue;
    }
    if (!line.trim()) {
      // A blank line only ends the list if what follows is not still in it.
      const next = lines[i + 1] ?? "";
      if (UL_RE.test(next) || OL_RE.test(next)) {
        i += 1;
        continue;
      }
      break;
    }
    // A wrapped item: indented prose under the marker.
    if (/^\s{2,}\S/.test(line) && items.length) {
      items[items.length - 1].text += `\n${line.trim()}`;
      i += 1;
      continue;
    }
    break;
  }

  const startAt = ordered ? Number(lines[start].match(OL_RE)[2]) : undefined;
  const List = ordered ? "ol" : "ul";
  const node = (
    <List key={key} start={startAt !== 1 ? startAt : undefined}>
      {items.map((item, n) => (
        <li key={n}>
          {inline(item.text, `${key}-${n}-`)}
          {item.children}
        </li>
      ))}
    </List>
  );
  return [node, i];
}

const cells = (row) =>
  row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

/** A GFM table, or null when these lines are not one. Returns `[node, next]`. */
function takeTable(lines, start, key) {
  const head = lines[start];
  const sep = lines[start + 1] ?? "";
  if (!head.includes("|") || !sep.includes("|") || !TABLE_SEP_RE.test(sep)) return null;
  const headers = cells(head);
  const align = cells(sep).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : undefined,
  );
  const rows = [];
  let i = start + 2;
  for (; i < lines.length && lines[i].includes("|") && lines[i].trim(); i += 1) rows.push(cells(lines[i]));

  const node = (
    <table key={key} className="md-table">
      <thead>
        <tr>
          {headers.map((h, n) => (
            <th key={n} style={{ textAlign: align[n] }}>
              {inline(h, `${key}h${n}-`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {headers.map((_, c) => (
              <td key={c} style={{ textAlign: align[c] }}>
                {inline(row[c] ?? "", `${key}${r}-${c}-`)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return [node, i];
}

/** Blocks of one markdown document, as React nodes. */
function blocks(src, key = "b") {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let n = 0;
  const k = () => `${key}${n++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const body = [];
      i += 1;
      // No closing fence yet is the normal state mid-stream, not an error.
      while (i < lines.length && !FENCE_RE.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i += 1;
      out.push(<CodeBlock key={k()} code={body.join("\n")} lang={fence[1]} />);
      continue;
    }

    const head = line.match(HEAD_RE);
    if (head) {
      const H = `h${Math.min(head[1].length + 2, 6)}`;
      out.push(<H key={k()}>{inline(head[2], `${k()}-`)}</H>);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push(<hr key={k()} />);
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) body.push(lines[i++].match(QUOTE_RE)[1]);
      out.push(
        <blockquote key={k()} className="md-quote">
          {blocks(body.join("\n"), `${key}q${n}`)}
        </blockquote>,
      );
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const [node, next] = takeList(lines, i, k());
      out.push(node);
      i = next;
      continue;
    }

    const table = line.includes("|") ? takeTable(lines, i, k()) : null;
    if (table) {
      out.push(table[0]);
      i = table[1];
      continue;
    }

    // A paragraph runs to the next blank line or the next block opener.
    const body = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (FENCE_RE.test(l) || HEAD_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || UL_RE.test(l) || OL_RE.test(l))
        break;
      body.push(l);
      i += 1;
    }
    if (body.length) out.push(paragraph(body.join("\n"), k()));
  }

  return out;
}

/** Rendered markdown. `className` is appended to `md` for the caller's spacing. */
export function Markdown({ text, className = "" }) {
  return <div className={`md ${className}`.trim()}>{blocks(text)}</div>;
}
