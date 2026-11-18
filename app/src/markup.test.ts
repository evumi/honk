import { expect, test } from "nsh/test";
import { inline, linkify, markdown, plainSpans, plainText, safeUrl } from "./markup";

test("links https urls in plain text, leaving sentence punctuation out", () => {
  expect(plainSpans("见 https://a.example/b?x=1。然后")).toEqual([
    { text: "见 " },
    { text: "https://a.example/b?x=1", href: "https://a.example/b?x=1" },
    { text: "。然后" },
  ]);
  expect(plainSpans("(see https://a.example/x), ok")).toEqual([
    { text: "(see " },
    { text: "https://a.example/x", href: "https://a.example/x" },
    { text: "), ok" },
  ]);
  // A ")" that closes a "(" in the url stays.
  expect(plainSpans("https://en.example/wiki/A_(b)")[0].href).toBe("https://en.example/wiki/A_(b)");
  expect(plainSpans("no links here, http://plain.example is not linked")).toEqual([{ text: "no links here, http://plain.example is not linked" }]);
  expect(plainSpans("https://")).toEqual([{ text: "https://" }]);
  expect(plainSpans("")).toEqual([]);
  expect(plainSpans("两个 https://a.example 和 https://b.example").filter((s) => s.href).length).toBe(2);
});

test("inline marks", () => {
  expect(inline("a **b** *c* `d` _e_")).toEqual([
    { text: "a " },
    { text: "b", bold: true },
    { text: " " },
    { text: "c", italic: true },
    { text: " " },
    { text: "d", code: true },
    { text: " " },
    { text: "e", italic: true },
  ]);
  expect(inline("**粗 *斜***")).toEqual([{ text: "粗 ", bold: true }, { text: "斜", bold: true, italic: true }]);
  expect(inline("__b__")).toEqual([{ text: "b", bold: true }]);
});

test("marks that do not close, or are not marks, stay text", () => {
  expect(plainText(inline("2 * 3 * 4"))).toBe("2 * 3 * 4");
  expect(plainText(inline("snake_case_name"))).toBe("snake_case_name");
  expect(plainText(inline("**open"))).toBe("**open");
  expect(plainText(inline("a `open"))).toBe("a `open");
  expect(inline("`a*b*c`")).toEqual([{ text: "a*b*c", code: true }]);
});

test("markdown links", () => {
  expect(inline("[详情](https://a.example/d)")).toEqual([{ text: "详情", href: "https://a.example/d" }]);
  expect(inline("**[粗](https://a.example)**")).toEqual([{ text: "粗", bold: true, href: "https://a.example" }]);
  // Only https links open; http stays text.
  expect(plainText(inline("[x](http://a.example)"))).toBe("[x](http://a.example)");
  expect(inline("[x](http://a.example)").some((s) => s.href && s.text.startsWith("["))).toBe(false);
  expect(safeUrl("http://a.example")).toBe(false);
  expect(plainText(inline("[x](javascript:alert(1))"))).toBe("[x](javascript:alert(1))");
  expect(inline("[x](javascript:alert(1))").some((s) => s.href)).toBe(false);
  expect(safeUrl("https://a.example")).toBe(true);
  expect(safeUrl("ftp://a.example")).toBe(false);
  expect(safeUrl("https://")).toBe(false);
});

test("link text that names another host shows the real target", () => {
  expect(inline("[paypal.com](https://evil.example/x)")).toEqual([{ text: "https://evil.example/x", href: "https://evil.example/x" }]);
  expect(inline("[https://bank.example/login](https://evil.example)")).toEqual([{ text: "https://evil.example", href: "https://evil.example" }]);
  // The same host (www aside) or ordinary words keep their text.
  expect(inline("[www.a.example](https://a.example/d)")).toEqual([{ text: "www.a.example", href: "https://a.example/d" }]);
  expect(inline("[A.Example/docs](https://a.example/d)")).toEqual([{ text: "A.Example/docs", href: "https://a.example/d" }]);
  expect(inline("[详情 paypal.com](https://evil.example)")).toEqual([{ text: "详情 paypal.com", href: "https://evil.example" }]);
});

test("bare urls inside Markdown are linked too", () => {
  expect(inline("**看 https://a.example**")).toEqual([{ text: "看 ", bold: true }, { text: "https://a.example", bold: true, href: "https://a.example" }]);
});

test("blocks: paragraphs, headings, lists and code", () => {
  const blocks = markdown("# 标题\n正文第一行\n第二行\n\n- 一\n* 二 **粗**\n  - 嵌套\n1. 三\n\n```\nx := a * b\n\n```\n结束");
  expect(blocks.map((b) => b.kind)).toEqual(["p", "p", "li", "li", "li", "li", "code", "p"]);
  expect(blocks[0]).toEqual({ kind: "p", spans: [{ text: "标题", bold: true }] });
  expect(blocks[1]).toEqual({ kind: "p", spans: [{ text: "正文第一行\n第二行" }] });
  expect(blocks[2]).toEqual({ kind: "li", marker: "•", level: 0, spans: [{ text: "一" }] });
  expect(blocks[3]).toEqual({ kind: "li", marker: "•", level: 0, spans: [{ text: "二 " }, { text: "粗", bold: true }] });
  expect(blocks[4]).toMatchObject({ kind: "li", level: 1 });
  expect(blocks[5]).toMatchObject({ kind: "li", marker: "1." });
  expect(blocks[6]).toEqual({ kind: "code", text: "x := a * b\n" });
  expect(blocks[7]).toEqual({ kind: "p", spans: [{ text: "结束" }] });
});

test("an unclosed code block takes the rest", () => {
  expect(markdown("```\na\nb")).toEqual([{ kind: "code", text: "a\nb" }]);
  expect(markdown("")).toEqual([]);
  expect(markdown("a\r\nb")).toEqual([{ kind: "p", spans: [{ text: "a\nb" }] }]);
});

test("linkify keeps the base style", () => {
  expect(linkify("x https://a.example", { italic: true })).toEqual([
    { text: "x ", italic: true },
    { text: "https://a.example", italic: true, href: "https://a.example" },
  ]);
});
