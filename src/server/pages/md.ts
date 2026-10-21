import { html, join, type Html } from "../html.ts";
import { linkify } from "./common.ts";

// The Markdown agents (and you) write, as a page shows it: paragraphs, line breaks, lists, headings, fenced code,
// `code`, **bold**, [links](https://…) and bare URLs; bug numbers, revisions and the given tests linked too. Every
// piece of text goes through an html`` template, so nothing in it becomes markup.
export function md(text: string, tests: string[] = []): Html {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  const blocks: Html[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  const flushPara = () => {
    if (para.length) blocks.push(html`<p>${join(para.map((l) => inline(l, tests)), html`<br>`)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((x) => html`<li>${inline(x, tests)}</li>`);
      blocks.push(list.ordered ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`);
    }
    list = undefined;
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line.trimStart().startsWith("```")) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (n++; n < lines.length && !lines[n].trimStart().startsWith("```"); n++) code.push(lines[n]);
      blocks.push(html`<pre>${code.join("\n")}</pre>`);
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const ordered = item[2] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[3]);
      continue;
    }
    // A wrapped line of the previous list item.
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push(html`<p><b>${inline(heading[1], tests)}</b></p>`);
    } else if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html`<div class="md">${blocks}</div>`;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;

function inline(text: string, tests: string[]): Html {
  const parts: Html[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    parts.push(linkify(text.slice(last, m.index), tests));
    if (m[1] !== undefined) parts.push(html`<code>${m[1]}</code>`);
    else if (m[2] !== undefined) parts.push(html`<b>${linkify(m[2], tests)}</b>`);
    else parts.push(html`<a href="${m[4] ?? m[5]}" target="_blank" rel="noopener">${m[3] ?? m[5]}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(linkify(text.slice(last), tests));
  return join(parts, "");
}
