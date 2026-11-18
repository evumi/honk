// The Markdown subset of `parse_mode=Markdown` and the https auto-linking of
// plain bodies. Pure functions; `MessageBody.tsx` draws the result. The gateway's
// `StripMarkdown` (gateway/internal/api/markdown.go) makes the banner text
// from the same subset: keep the two in step.
//
// Subset: **bold** or __bold__, *italic* or _italic_, `code`, fenced code
// blocks, [text](url) with an https url (text that looks like another site's address shows the url instead), "-", "*", "+" and "1." lists, and
// "#" headings (drawn bold). Everything else is text.

/** A run of text with one style. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Present on a link; always https. */
  href?: string;
}

export type Block =
  | { kind: "p"; spans: Span[] }
  | { kind: "code"; text: string }
  /** One list item; `level` is the nesting (0 to 3). */
  | { kind: "li"; marker: string; level: number; spans: Span[] };

// A url ends at whitespace, quotes and CJK or full-width punctuation.
const URL_RE = /https:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef]+/g;
// What a url does not end with when it closes a sentence or a bracket.
const TRAILING = /[.,;:!?)\]}'"。，；：！？）】」』、]/;

/** Whether `url` is one a link may open: https with a host (as the auto-links and cards). */
export function safeUrl(url: string): boolean {
  return /^https:\/\/[^\s/?#]+/i.test(url);
}

const hostOf = (url: string) => /^(?:https?:\/\/)?([^\s/?#:]+)/i.exec(url.trim())?.[1].toLowerCase().replace(/^www\./, "");
// Link text that reads as a web address: an optional scheme, a dotted host, an optional port and path.
const LOOKS_LIKE_URL = /^(?:https?:\/\/)?(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?(?:[/?#]\S*)?$/u;

/** Link text that names another site than the link opens is a disguise. */
function misleading(text: string, target: string): boolean {
  const t = text.trim();
  return LOOKS_LIKE_URL.test(t) && hostOf(t) !== hostOf(target);
}

/** Splits text into plain spans and https links (a link closing a sentence leaves its punctuation outside). */
export function linkify(text: string, base: Omit<Span, "text" | "href"> = {}): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    // A closing ")" belongs to the url only when it closes an "(" inside it.
    while (url.length > 0 && TRAILING.test(url[url.length - 1])) {
      if (url.endsWith(")") && count(url, "(") >= count(url, ")")) break;
      url = url.slice(0, -1);
    }
    if (url.length <= "https://".length || m.index === undefined) continue;
    if (m.index > last) out.push({ ...base, text: text.slice(last, m.index) });
    out.push({ ...base, text: url, href: url });
    last = m.index + url.length;
  }
  if (last < text.length) out.push({ ...base, text: text.slice(last) });
  return out;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** A plain body: its text with https links tapable. */
export function plainSpans(body: string): Span[] {
  return linkify(body);
}

const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Parses one line's inline marks into spans. */
export function inline(s: string, base: Omit<Span, "text" | "href"> = {}): Span[] {
  const out: Span[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push(...linkify(text, base));
    text = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ ...base, text: s.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    } else if (c === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m && safeUrl(m[2])) {
        flush();
        const label = inline(m[1], base);
        // Text that looks like a url for another host: show where the link really goes.
        if (misleading(plainText(label), m[2])) out.push({ ...base, text: m[2], href: m[2] });
        else out.push(...label.map((sp) => ({ ...sp, href: m[2] })));
        i += m[0].length;
        continue;
      }
    } else if ((c === "*" || c === "_") && s[i + 1] === c) {
      let end = s.indexOf(c + c, i + 2);
      // "***": the closing pair is the last two.
      while (end > 0 && s[end + 2] === c) end++;
      if (end > i + 2) {
        flush();
        out.push(...inline(s.slice(i + 2, end), { ...base, bold: true }));
        i = end + 2;
        continue;
      }
    } else if (c === "*" || c === "_") {
      const next = s[i + 1];
      const opens = next !== undefined && !/\s/.test(next) && next !== c && (c === "*" || !isWord(s[i - 1]));
      if (opens) {
        let end = i + 1;
        for (;;) {
          end = s.indexOf(c, end + 1);
          // `*` closes at the next `*`; `_` only at the end of a word.
          if (end < 0 || c === "*" || !isWord(s[end + 1])) break;
        }
        if (end > i + 1) {
          flush();
          out.push(...inline(s.slice(i + 1, end), { ...base, italic: true }));
          i = end + 1;
          continue;
        }
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** Parses a Markdown body into blocks. */
export function markdown(body: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ kind: "p", spans: inline(para.join("\n")) });
    para = [];
  };
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (/^\s*```/.test(line)) {
      endPara();
      const code: string[] = [];
      for (n++; n < lines.length && !/^\s*```/.test(lines[n]); n++) code.push(lines[n]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      endPara();
      continue;
    }
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (head) {
      endPara();
      blocks.push({ kind: "p", spans: inline(head[1], { bold: true }) });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      endPara();
      const marker = /\d/.test(item[2]) ? item[2] : "•";
      blocks.push({ kind: "li", marker, level: Math.min(3, Math.floor(item[1].replace(/\t/g, "  ").length / 2)), spans: inline(item[3]) });
      continue;
    }
    para.push(line);
  }
  endPara();
  return blocks;
}

/** The plain text of spans, as the banner shows it. */
export function plainText(spans: Span[]): string {
  return spans.map((s) => s.text).join("");
}
