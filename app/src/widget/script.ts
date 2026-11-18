// Parser for the JavaScript subset that card scripts are written in (card
// profile 2). It builds a small AST for interp.ts; nothing here runs code.
//
// Supported: var/let/const with destructuring, functions and arrow functions,
// closures, objects, arrays, spread, template literals, optional chaining,
// if/for/for-of/for-in/while/do/switch/try/throw, the usual operators.
// Not supported: classes, generators, async/await, regular expressions,
// labels, getters/setters, tagged templates. Using them is a SyntaxError, and
// the card falls back to its static HTML.

export class ScriptSyntaxError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message);
    this.name = "SyntaxError";
  }
}

// MARK: tokens

type TokType = "num" | "str" | "tpl" | "name" | "punct" | "eof";
interface Tok {
  t: TokType;
  v: string;
  /** Template parts: cooked strings and expression sources, alternating. */
  parts?: string[];
  num?: number;
  pos: number;
  /** A line break comes before this token (for automatic semicolons). */
  nl: boolean;
}

const PUNCT = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "!", "~", "?", ":", "=", ".",
];

const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };

function isIdStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c) || c > "\u007f";
}
function isIdPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c) || c > "\u007f";
}

/** Reads a string escape at src[i] (just after the backslash); returns the text and the next index. */
function readEscape(src: string, i: number): [string, number] {
  const c = src[i];
  if (c === undefined) throw new ScriptSyntaxError("Unterminated string", i);
  if (c in ESC && !(c === "0" && /[0-9]/.test(src[i + 1] ?? ""))) return [ESC[c], i + 1];
  if (c === "x") {
    const h = src.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new ScriptSyntaxError("Bad escape", i);
    return [String.fromCharCode(parseInt(h, 16)), i + 3];
  }
  if (c === "u") {
    if (src[i + 1] === "{") {
      const end = src.indexOf("}", i);
      const h = src.slice(i + 2, end);
      const n = parseInt(h, 16);
      if (end < 0 || !/^[0-9a-fA-F]{1,6}$/.test(h) || n > 0x10ffff) throw new ScriptSyntaxError("Bad escape", i);
      return [String.fromCodePoint(n), end + 1];
    }
    const h = src.slice(i + 1, i + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new ScriptSyntaxError("Bad escape", i);
    return [String.fromCharCode(parseInt(h, 16)), i + 5];
  }
  if (c === "\r" && src[i + 1] === "\n") return ["", i + 2];
  if (c === "\n" || c === "\r" || c === " " || c === " ") return ["", i + 1];
  return [c, i + 1];
}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let nl = false;
  while (true) {
    // Whitespace and comments.
    while (i < src.length) {
      const c = src[i];
      if (c === "\n" || c === "\r" || c === " " || c === " ") { nl = true; i++; }
      else if (c === " " || c === "\t" || c === "\v" || c === "\f" || c === " " || c === "﻿") i++;
      else if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; }
      else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) throw new ScriptSyntaxError("Unterminated comment", i);
        if (/[\n\r]/.test(src.slice(i, end))) nl = true;
        i = end + 2;
      } else break;
    }
    if (i >= src.length) {
      out.push({ t: "eof", v: "", pos: i, nl: true });
      return out;
    }
    const start = i;
    const c = src[i];
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*\.?[0-9_]*|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i, i + 400));
      if (!m) throw new ScriptSyntaxError("Bad number", i);
      const text = m[0].replace(/_/g, "");
      const num = /^0[bB]/.test(text) ? parseInt(text.slice(2), 2) : /^0[oO]/.test(text) ? parseInt(text.slice(2), 8) : Number(text);
      i += m[0].length;
      if (src[i] === "n") throw new ScriptSyntaxError("BigInt is not supported", i);
      if (isIdStart(src[i] ?? "")) throw new ScriptSyntaxError("Bad number", i);
      out.push({ t: "num", v: text, num, pos: start, nl });
    } else if (c === '"' || c === "'") {
      let s = "";
      i++;
      while (true) {
        const d = src[i];
        if (d === undefined || d === "\n" || d === "\r") throw new ScriptSyntaxError("Unterminated string", start);
        if (d === c) { i++; break; }
        if (d === "\\") {
          const [e, n] = readEscape(src, i + 1);
          s += e;
          i = n;
        } else { s += d; i++; }
      }
      out.push({ t: "str", v: s, pos: start, nl });
    } else if (c === "`") {
      const parts: string[] = [];
      let s = "";
      i++;
      while (true) {
        const d = src[i];
        if (d === undefined) throw new ScriptSyntaxError("Unterminated template", start);
        if (d === "`") { i++; break; }
        if (d === "\\") {
          const [e, n] = readEscape(src, i + 1);
          s += e;
          i = n;
        } else if (d === "$" && src[i + 1] === "{") {
          parts.push(s);
          s = "";
          const exprStart = i + 2;
          const end = tokenizeUntilBrace(src, exprStart);
          parts.push(src.slice(exprStart, end));
          i = end + 1;
        } else { s += d; i++; }
      }
      parts.push(s);
      out.push({ t: "tpl", v: "", parts, pos: start, nl });
    } else if (isIdStart(c) || c === "\\") {
      if (c === "\\") throw new ScriptSyntaxError("Escapes in names are not supported", i);
      while (i < src.length && isIdPart(src[i])) i++;
      out.push({ t: "name", v: src.slice(start, i), pos: start, nl });
    } else {
      const p = PUNCT.find((p) => src.startsWith(p, i));
      if (!p) throw new ScriptSyntaxError(`Unexpected character ${JSON.stringify(c)}`, i);
      // `?.` followed by a digit is `? .5`.
      if (p === "?." && /[0-9]/.test(src[i + 2] ?? "")) {
        out.push({ t: "punct", v: "?", pos: start, nl });
        i += 1;
      } else {
        out.push({ t: "punct", v: p, pos: start, nl });
        i += p.length;
      }
    }
    nl = false;
  }
}

/** The index of the `}` closing a template substitution that starts at `from`. */
function tokenizeUntilBrace(src: string, from: number, nesting = 0): number {
  if (nesting > MAX_NESTING) throw new ScriptSyntaxError("Script nests too deeply", from);
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
    } else if (c === "`") {
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "$" && src[i + 1] === "{") i = tokenizeUntilBrace(src, i + 2, nesting + 1) + 1;
        else i++;
      }
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
    }
    i++;
  }
  throw new ScriptSyntaxError("Unterminated template", from);
}

// MARK: AST

export type Node = Expr | Stmt;

export type Pattern =
  | { type: "Id"; name: string }
  | { type: "ObjPat"; props: { key: Expr | string; value: Pattern }[]; rest?: string }
  | { type: "ArrPat"; elems: (Pattern | null)[]; rest?: Pattern }
  | { type: "DefPat"; target: Pattern; init: Expr };

export interface FnNode {
  type: "Fn";
  name: string;
  params: Pattern[];
  rest?: Pattern;
  body: Stmt[] | Expr;
  arrow: boolean;
  /** Names declared with var in the body, hoisted to its top. (Function declarations are hoisted per statement list.) */
  vars: string[];
}

export type Expr =
  | { type: "Lit"; value: string | number | boolean | null | undefined }
  | { type: "Tpl"; quasis: string[]; exprs: Expr[] }
  | { type: "Id"; name: string }
  | { type: "This" }
  | { type: "Arr"; elems: (Expr | { type: "Spread"; arg: Expr } | null)[] }
  | { type: "Obj"; props: ({ kind: "init"; key: Expr | string; value: Expr } | { kind: "spread"; arg: Expr })[] }
  | FnNode
  | { type: "Un"; op: string; arg: Expr }
  | { type: "Upd"; op: "++" | "--"; prefix: boolean; arg: Expr }
  | { type: "Bin"; op: string; left: Expr; right: Expr }
  | { type: "Log"; op: "&&" | "||" | "??"; left: Expr; right: Expr }
  | { type: "Cond"; test: Expr; then: Expr; else: Expr }
  | { type: "Assign"; op: string; target: Expr; value: Expr }
  | { type: "Seq"; exprs: Expr[] }
  | { type: "Mem"; obj: Expr; prop: Expr | string; optional: boolean }
  | { type: "Call"; callee: Expr; args: (Expr | { type: "Spread"; arg: Expr })[]; optional: boolean }
  | { type: "New"; callee: Expr; args: (Expr | { type: "Spread"; arg: Expr })[] }
  /** Ends an optional chain: `a?.b.c` is undefined when `a` is nullish. */
  | { type: "Chain"; expr: Expr };

export type Stmt =
  | { type: "Expr"; expr: Expr }
  | { type: "Decl"; kind: "var" | "let" | "const"; decls: { id: Pattern; init: Expr | null }[] }
  | { type: "FnDecl"; fn: FnNode }
  | { type: "Return"; arg: Expr | null }
  | { type: "If"; test: Expr; then: Stmt; else: Stmt | null }
  | { type: "Block"; body: Stmt[] }
  | { type: "For"; init: Stmt | null; test: Expr | null; update: Expr | null; body: Stmt }
  | { type: "ForOf"; of: boolean; kind: "var" | "let" | "const" | null; left: Pattern | Expr; right: Expr; body: Stmt }
  | { type: "While"; test: Expr; body: Stmt }
  | { type: "DoWhile"; test: Expr; body: Stmt }
  | { type: "Break" }
  | { type: "Continue" }
  | { type: "Throw"; arg: Expr }
  | { type: "Try"; block: Stmt[]; param: Pattern | null; handler: Stmt[] | null; finalizer: Stmt[] | null }
  | { type: "Switch"; disc: Expr; cases: { test: Expr | null; body: Stmt[] }[] }
  | { type: "Empty" };

export interface Program {
  body: Stmt[];
  vars: string[];
}

// MARK: parser

const UNSUPPORTED = new Set(["class", "async", "await", "yield", "import", "export", "with", "debugger", "super", "get", "set"]);
const RESERVED = new Set([
  "break", "case", "catch", "const", "continue", "default", "delete", "do", "else", "finally", "for", "function", "if", "in",
  "instanceof", "let", "new", "return", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "true", "false", "null",
  "class", "import", "export", "with", "debugger", "super", "yield",
]);

const BIN_PREC: Record<string, number> = {
  "??": 1, "||": 2, "&&": 3, "|": 4, "^": 5, "&": 6,
  "==": 7, "!=": 7, "===": 7, "!==": 7,
  "<": 8, ">": 8, "<=": 8, ">=": 8, instanceof: 8, in: 8,
  "<<": 9, ">>": 9, ">>>": 9, "+": 10, "-": 10, "*": 11, "/": 11, "%": 11, "**": 12,
};
const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);

/** Nesting deeper than this is refused, so a hostile card cannot overflow the host's stack. */
const MAX_NESTING = 96;

interface FnScope {
  vars: Set<string>;
}

class Parser {
  private i = 0;
  private depth = 0;
  private fnScopes: FnScope[] = [];

  constructor(private toks: Tok[]) {}

  private get tok(): Tok {
    return this.toks[this.i];
  }
  private peek(n = 1): Tok {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)];
  }
  private fail(msg?: string, t: Tok = this.tok): never {
    throw new ScriptSyntaxError(msg ?? (t.t === "eof" ? "Unexpected end of script" : `Unexpected token ${t.v || t.t}`), t.pos);
  }
  private is(v: string): boolean {
    const t = this.tok;
    return (t.t === "punct" || t.t === "name") && t.v === v;
  }
  private eat(v: string): boolean {
    if (this.is(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(v: string): void {
    if (!this.eat(v)) this.fail();
  }
  private semicolon(): void {
    if (this.eat(";")) return;
    if (this.is("}") || this.tok.t === "eof" || this.tok.nl) return;
    this.fail();
  }
  private ident(): string {
    const t = this.tok;
    if (t.t !== "name") this.fail();
    if (UNSUPPORTED.has(t.v) && t.v !== "get" && t.v !== "set" && t.v !== "async") this.fail(`${t.v} is not supported in card scripts`);
    if (RESERVED.has(t.v)) this.fail();
    this.i++;
    return t.v;
  }
  private enter(): void {
    if (++this.depth > MAX_NESTING) this.fail("Script nests too deeply");
  }
  private leave(): void {
    this.depth--;
  }

  program(): Program {
    const scope: FnScope = { vars: new Set() };
    this.fnScopes.push(scope);
    const body: Stmt[] = [];
    while (this.tok.t !== "eof") body.push(this.statement());
    this.fnScopes.pop();
    return { body, vars: [...scope.vars] };
  }

  // Statements

  private statement(): Stmt {
    this.enter();
    try {
      return this.statementInner();
    } finally {
      this.leave();
    }
  }

  private statementInner(): Stmt {
    const t = this.tok;
    if (t.t === "punct") {
      if (t.v === "{") return { type: "Block", body: this.block() };
      if (t.v === ";") { this.i++; return { type: "Empty" }; }
    }
    if (t.t === "name") {
      switch (t.v) {
        case "var": case "const": {
          const d = this.declaration();
          this.semicolon();
          return d;
        }
        case "let":
          if (this.peek().t === "name" || this.peek().v === "[" || this.peek().v === "{") {
            const d = this.declaration();
            this.semicolon();
            return d;
          }
          break;
        case "function": {
          this.i++;
          if (this.is("*")) this.fail("Generators are not supported in card scripts");
          const name = this.ident();
          return { type: "FnDecl", fn: this.functionRest(name, false) };
        }
        case "return": {
          this.i++;
          if (this.fnScopes.length < 2) this.fail("return outside a function");
          const arg = this.is(";") || this.is("}") || this.tok.t === "eof" || this.tok.nl ? null : this.expression();
          this.semicolon();
          return { type: "Return", arg };
        }
        case "if": {
          this.i++;
          this.expect("(");
          const test = this.expression();
          this.expect(")");
          const then = this.statement();
          const els = this.eat("else") ? this.statement() : null;
          return { type: "If", test, then, else: els };
        }
        case "for": return this.forStatement();
        case "while": {
          this.i++;
          this.expect("(");
          const test = this.expression();
          this.expect(")");
          return { type: "While", test, body: this.statement() };
        }
        case "do": {
          this.i++;
          const body = this.statement();
          this.expect("while");
          this.expect("(");
          const test = this.expression();
          this.expect(")");
          this.eat(";");
          return { type: "DoWhile", test, body };
        }
        case "break": case "continue": {
          this.i++;
          if (this.tok.t === "name" && !this.tok.nl) this.fail("Labels are not supported in card scripts");
          this.semicolon();
          return { type: t.v === "break" ? "Break" : "Continue" };
        }
        case "throw": {
          this.i++;
          if (this.tok.nl) this.fail();
          const arg = this.expression();
          this.semicolon();
          return { type: "Throw", arg };
        }
        case "try": return this.tryStatement();
        case "switch": return this.switchStatement();
        case "class": case "import": case "export": case "with": case "debugger": case "yield":
          this.fail(`${t.v} is not supported in card scripts`);
      }
      if (t.v === "async" && this.peek().v === "function") this.fail("async functions are not supported in card scripts");
      if (this.peek().v === ":" && this.peek().t === "punct" && !RESERVED.has(t.v)) this.fail("Labels are not supported in card scripts");
    }
    const expr = this.expression();
    this.semicolon();
    return { type: "Expr", expr };
  }

  private block(): Stmt[] {
    this.expect("{");
    const body: Stmt[] = [];
    while (!this.is("}")) {
      if (this.tok.t === "eof") this.fail();
      body.push(this.statement());
    }
    this.i++;
    return body;
  }

  private declare(p: Pattern): void {
    const scope = this.fnScopes[this.fnScopes.length - 1];
    for (const n of patternNames(p)) scope.vars.add(n);
  }

  private declaration(noIn = false): Stmt & { type: "Decl" } {
    const kind = this.tok.v as "var" | "let" | "const";
    this.i++;
    const decls: { id: Pattern; init: Expr | null }[] = [];
    do {
      const id = this.pattern();
      if (kind === "var") this.declare(id);
      let init: Expr | null = null;
      if (this.eat("=")) init = this.assignment(noIn);
      else if (kind === "const" && !(noIn && (this.is("of") || this.is("in")))) this.fail("Missing initializer in const declaration");
      else if (id.type !== "Id" && !(noIn && (this.is("of") || this.is("in")))) this.fail("Missing initializer in destructuring declaration");
      decls.push({ id, init });
    } while (this.eat(","));
    return { type: "Decl", kind, decls };
  }

  private forStatement(): Stmt {
    this.i++;
    if (this.is("await")) this.fail("for await is not supported in card scripts");
    this.expect("(");
    let init: Stmt | null = null;
    if (this.is(";")) {
      // no init
    } else if (this.is("var") || this.is("const") || (this.is("let") && (this.peek().t === "name" || this.peek().v === "[" || this.peek().v === "{"))) {
      const decl = this.declaration(true);
      if ((this.is("of") || this.is("in")) && decl.decls.length === 1 && decl.decls[0].init === null) {
        const of = this.tok.v === "of";
        this.i++;
        const right = of ? this.assignment() : this.expression();
        this.expect(")");
        return { type: "ForOf", of, kind: decl.kind, left: decl.decls[0].id, right, body: this.statement() };
      }
      init = decl;
    } else {
      const expr = this.expression(true);
      if (this.is("of") || this.is("in")) {
        if (expr.type !== "Id" && expr.type !== "Mem") this.fail("Invalid left side in for loop");
        const of = this.tok.v === "of";
        this.i++;
        const right = of ? this.assignment() : this.expression();
        this.expect(")");
        return { type: "ForOf", of, kind: null, left: expr, right, body: this.statement() };
      }
      init = { type: "Expr", expr };
    }
    this.expect(";");
    const test = this.is(";") ? null : this.expression();
    this.expect(";");
    const update = this.is(")") ? null : this.expression();
    this.expect(")");
    return { type: "For", init, test, update, body: this.statement() };
  }

  private tryStatement(): Stmt {
    this.i++;
    const block = this.block();
    let param: Pattern | null = null;
    let handler: Stmt[] | null = null;
    let finalizer: Stmt[] | null = null;
    if (this.eat("catch")) {
      if (this.eat("(")) {
        param = this.pattern();
        this.expect(")");
      }
      handler = this.block();
    }
    if (this.eat("finally")) finalizer = this.block();
    if (!handler && !finalizer) this.fail("Missing catch or finally after try");
    return { type: "Try", block, param, handler, finalizer };
  }

  private switchStatement(): Stmt {
    this.i++;
    this.expect("(");
    const disc = this.expression();
    this.expect(")");
    this.expect("{");
    const cases: { test: Expr | null; body: Stmt[] }[] = [];
    while (!this.eat("}")) {
      let test: Expr | null = null;
      if (this.eat("case")) test = this.expression();
      else this.expect("default");
      this.expect(":");
      const body: Stmt[] = [];
      while (!this.is("case") && !this.is("default") && !this.is("}")) {
        if (this.tok.t === "eof") this.fail();
        body.push(this.statement());
      }
      cases.push({ test, body });
    }
    return { type: "Switch", disc, cases };
  }

  // Patterns

  private pattern(): Pattern {
    this.enter();
    try {
      let p: Pattern;
      if (this.eat("[")) {
        const elems: (Pattern | null)[] = [];
        let rest: Pattern | undefined;
        while (!this.eat("]")) {
          if (this.eat(",")) { elems.push(null); continue; }
          if (this.eat("...")) {
            rest = this.pattern();
            this.eat(",");
            this.expect("]");
            break;
          }
          elems.push(this.patternWithDefault());
          if (!this.is("]")) this.expect(",");
        }
        p = { type: "ArrPat", elems, rest };
      } else if (this.eat("{")) {
        const props: { key: Expr | string; value: Pattern }[] = [];
        let rest: string | undefined;
        while (!this.eat("}")) {
          if (this.eat("...")) {
            rest = this.ident();
            this.eat(",");
            this.expect("}");
            break;
          }
          let key: Expr | string;
          let shorthand = false;
          if (this.eat("[")) {
            key = this.assignment();
            this.expect("]");
          } else {
            const t = this.tok;
            if (t.t === "name") { key = t.v; shorthand = !RESERVED.has(t.v); }
            else if (t.t === "str") key = t.v;
            else if (t.t === "num") key = String(t.num);
            else this.fail();
            this.i++;
          }
          let value: Pattern;
          if (this.eat(":")) value = this.patternWithDefault();
          else {
            if (!shorthand || typeof key !== "string") this.fail();
            value = { type: "Id", name: key };
            if (this.eat("=")) value = { type: "DefPat", target: value, init: this.assignment() };
          }
          props.push({ key, value });
          if (!this.is("}")) this.expect(",");
        }
        p = { type: "ObjPat", props, rest };
      } else {
        p = { type: "Id", name: this.ident() };
      }
      return p;
    } finally {
      this.leave();
    }
  }

  private patternWithDefault(): Pattern {
    const target = this.pattern();
    return this.eat("=") ? { type: "DefPat", target, init: this.assignment() } : target;
  }

  // Functions

  private functionRest(name: string, arrow: false): FnNode {
    this.expect("(");
    const params: Pattern[] = [];
    let rest: Pattern | undefined;
    while (!this.eat(")")) {
      if (this.eat("...")) {
        rest = this.pattern();
        this.expect(")");
        break;
      }
      params.push(this.patternWithDefault());
      if (!this.is(")")) this.expect(",");
    }
    return this.functionBody(name, params, rest, arrow);
  }

  private functionBody(name: string, params: Pattern[], rest: Pattern | undefined, arrow: boolean): FnNode {
    const scope: FnScope = { vars: new Set() };
    this.fnScopes.push(scope);
    try {
      let body: Stmt[] | Expr;
      if (arrow && !this.is("{")) body = this.assignment();
      else body = this.block();
      return { type: "Fn", name, params, rest, body, arrow, vars: [...scope.vars] };
    } finally {
      this.fnScopes.pop();
    }
  }

  /** Whether the `(` at the current token starts an arrow function's parameters. */
  private arrowAhead(): boolean {
    let depth = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.t === "eof") return false;
      if (t.t !== "punct") continue;
      if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
      else if (t.v === ")" || t.v === "]" || t.v === "}") {
        depth--;
        if (depth === 0) {
          const n = this.toks[j + 1];
          return n.t === "punct" && n.v === "=>" && !n.nl;
        }
      }
    }
    return false;
  }

  private arrowFromParens(): FnNode {
    this.expect("(");
    const params: Pattern[] = [];
    let rest: Pattern | undefined;
    while (!this.eat(")")) {
      if (this.eat("...")) {
        rest = this.pattern();
        this.expect(")");
        break;
      }
      params.push(this.patternWithDefault());
      if (!this.is(")")) this.expect(",");
    }
    this.expect("=>");
    return this.functionBody("", params, rest, true);
  }

  // Expressions

  expression(noIn = false): Expr {
    const first = this.assignment(noIn);
    if (!this.is(",")) return first;
    const exprs = [first];
    while (this.eat(",")) exprs.push(this.assignment(noIn));
    return { type: "Seq", exprs };
  }

  private assignment(noIn = false): Expr {
    this.enter();
    try {
      const t = this.tok;
      if (t.t === "name" && t.v === "async" && (this.peek().t === "name" || this.peek().v === "(") && !this.peek().nl) {
        this.fail("async functions are not supported in card scripts");
      }
      if (t.t === "name" && this.peek().v === "=>" && this.peek().t === "punct" && !RESERVED.has(t.v)) {
        const name = this.ident();
        this.expect("=>");
        return this.functionBody("", [{ type: "Id", name }], undefined, true);
      }
      if (this.is("(") && this.arrowAhead()) return this.arrowFromParens();
      const left = this.conditional(noIn);
      if (this.tok.t === "punct" && ASSIGN.has(this.tok.v)) {
        const op = this.tok.v;
        if (left.type !== "Id" && left.type !== "Mem") this.fail("Invalid assignment target");
        this.i++;
        return { type: "Assign", op, target: left, value: this.assignment(noIn) };
      }
      return left;
    } finally {
      this.leave();
    }
  }

  private conditional(noIn: boolean): Expr {
    const test = this.binary(0, noIn);
    if (!this.eat("?")) return test;
    const then = this.assignment();
    this.expect(":");
    return { type: "Cond", test, then, else: this.assignment(noIn) };
  }

  private binary(minPrec: number, noIn: boolean): Expr {
    let left = this.unary();
    while (true) {
      const t = this.tok;
      if (t.t !== "punct" && !(t.t === "name" && (t.v === "instanceof" || t.v === "in"))) break;
      if (noIn && t.v === "in") break;
      const prec = BIN_PREC[t.v];
      if (prec === undefined || prec <= minPrec) break;
      this.i++;
      // ** is right-associative.
      const right = t.v === "**" ? this.binary(prec - 1, noIn) : this.binary(prec, noIn);
      if (t.v === "&&" || t.v === "||" || t.v === "??") left = { type: "Log", op: t.v, left, right };
      else left = { type: "Bin", op: t.v, left, right };
    }
    return left;
  }

  private unary(): Expr {
    this.enter();
    try {
      const t = this.tok;
      if ((t.t === "punct" && (t.v === "!" || t.v === "-" || t.v === "+" || t.v === "~")) || (t.t === "name" && (t.v === "typeof" || t.v === "void" || t.v === "delete"))) {
        this.i++;
        const arg = this.unary();
        if (this.is("**")) this.fail("Unary operator before ** needs parentheses");
        return { type: "Un", op: t.v, arg };
      }
      if (t.t === "name" && t.v === "await") this.fail("await is not supported in card scripts");
      if (t.t === "punct" && (t.v === "++" || t.v === "--")) {
        this.i++;
        const arg = this.unary();
        if (arg.type !== "Id" && arg.type !== "Mem") this.fail("Invalid update target");
        return { type: "Upd", op: t.v, prefix: true, arg };
      }
      const expr = this.postfix();
      return expr;
    } finally {
      this.leave();
    }
  }

  private postfix(): Expr {
    const expr = this.callOrMember();
    const t = this.tok;
    if (t.t === "punct" && (t.v === "++" || t.v === "--") && !t.nl) {
      if (expr.type !== "Id" && expr.type !== "Mem") this.fail("Invalid update target");
      this.i++;
      return { type: "Upd", op: t.v, prefix: false, arg: expr };
    }
    return expr;
  }

  private args(): (Expr | { type: "Spread"; arg: Expr })[] {
    const out: (Expr | { type: "Spread"; arg: Expr })[] = [];
    this.expect("(");
    while (!this.eat(")")) {
      if (this.eat("...")) out.push({ type: "Spread", arg: this.assignment() });
      else out.push(this.assignment());
      if (!this.is(")")) this.expect(",");
    }
    return out;
  }

  private callOrMember(): Expr {
    let expr: Expr;
    if (this.eat("new")) {
      if (this.is(".")) this.fail("new.target is not supported in card scripts");
      this.enter();
      let callee = this.primary();
      while (true) {
        if (this.eat(".")) callee = { type: "Mem", obj: callee, prop: this.propName(), optional: false };
        else if (this.eat("[")) {
          const prop = this.expression();
          this.expect("]");
          callee = { type: "Mem", obj: callee, prop, optional: false };
        } else break;
      }
      this.leave();
      expr = { type: "New", callee, args: this.is("(") ? this.args() : [] };
    } else {
      expr = this.primary();
    }
    let chained = false;
    let n = 0;
    while (true) {
      if (++n > MAX_NESTING) this.fail("Script nests too deeply");
      if (this.eat(".")) expr = { type: "Mem", obj: expr, prop: this.propName(), optional: false };
      else if (this.is("?.")) {
        this.i++;
        chained = true;
        if (this.is("(")) expr = { type: "Call", callee: expr, args: this.args(), optional: true };
        else if (this.eat("[")) {
          const prop = this.expression();
          this.expect("]");
          expr = { type: "Mem", obj: expr, prop, optional: true };
        } else expr = { type: "Mem", obj: expr, prop: this.propName(), optional: true };
      } else if (this.eat("[")) {
        const prop = this.expression();
        this.expect("]");
        expr = { type: "Mem", obj: expr, prop, optional: false };
      } else if (this.is("(")) expr = { type: "Call", callee: expr, args: this.args(), optional: false };
      else if (this.tok.t === "tpl") this.fail("Tagged templates are not supported in card scripts");
      else break;
    }
    return chained ? { type: "Chain", expr } : expr;
  }

  private propName(): string {
    const t = this.tok;
    if (t.t !== "name") this.fail();
    this.i++;
    return t.v;
  }

  private primary(): Expr {
    const t = this.tok;
    switch (t.t) {
      case "num": this.i++; return { type: "Lit", value: t.num! };
      case "str": this.i++; return { type: "Lit", value: t.v };
      case "tpl": {
        this.i++;
        const parts = t.parts!;
        const quasis: string[] = [];
        const exprs: Expr[] = [];
        for (let k = 0; k < parts.length; k++) {
          if (k % 2 === 0) quasis.push(parts[k]);
          else {
            const sub = new Parser(tokenize(parts[k]));
            sub.depth = this.depth;
            sub.fnScopes = this.fnScopes;
            const e = sub.expression();
            if (sub.tok.t !== "eof") sub.fail();
            exprs.push(e);
          }
        }
        return { type: "Tpl", quasis, exprs };
      }
      case "name":
        switch (t.v) {
          case "true": this.i++; return { type: "Lit", value: true };
          case "false": this.i++; return { type: "Lit", value: false };
          case "null": this.i++; return { type: "Lit", value: null };
          case "this": this.i++; return { type: "This" };
          case "function": {
            this.i++;
            if (this.is("*")) this.fail("Generators are not supported in card scripts");
            const name = this.tok.t === "name" && !this.is("(") ? this.ident() : "";
            return this.functionRest(name, false);
          }
          case "class": this.fail("class is not supported in card scripts");
        }
        return { type: "Id", name: this.ident() };
      case "punct":
        if (t.v === "(") {
          this.i++;
          const e = this.expression();
          this.expect(")");
          return e;
        }
        if (t.v === "[") return this.arrayLiteral();
        if (t.v === "{") return this.objectLiteral();
        if (t.v === "/" || t.v === "/=") this.fail("Regular expressions are not supported in card scripts");
    }
    this.fail();
  }

  private arrayLiteral(): Expr {
    this.expect("[");
    const elems: (Expr | { type: "Spread"; arg: Expr } | null)[] = [];
    while (!this.eat("]")) {
      if (this.eat(",")) { elems.push(null); continue; }
      if (this.eat("...")) elems.push({ type: "Spread", arg: this.assignment() });
      else elems.push(this.assignment());
      if (!this.is("]")) this.expect(",");
    }
    return { type: "Arr", elems };
  }

  private objectLiteral(): Expr {
    this.expect("{");
    const props: ({ kind: "init"; key: Expr | string; value: Expr } | { kind: "spread"; arg: Expr })[] = [];
    while (!this.eat("}")) {
      if (this.eat("...")) {
        props.push({ kind: "spread", arg: this.assignment() });
      } else {
        let key: Expr | string;
        let ident = false;
        const t = this.tok;
        if ((t.v === "get" || t.v === "set" || t.v === "async") && t.t === "name" && this.peek().t !== "punct") this.fail(`${t.v} methods are not supported in card scripts`);
        if (t.t === "punct" && t.v === "*") this.fail("Generators are not supported in card scripts");
        if (this.eat("[")) {
          key = this.assignment();
          this.expect("]");
        } else if (t.t === "name") { key = t.v; ident = !RESERVED.has(t.v); this.i++; }
        else if (t.t === "str") { key = t.v; this.i++; }
        else if (t.t === "num") { key = String(t.num); this.i++; }
        else this.fail();
        if (this.eat(":")) props.push({ kind: "init", key, value: this.assignment() });
        else if (this.is("(")) props.push({ kind: "init", key, value: this.functionRest(typeof key === "string" ? key : "", false) });
        else if (ident && typeof key === "string") props.push({ kind: "init", key, value: { type: "Id", name: key } });
        else this.fail();
      }
      if (!this.is("}")) this.expect(",");
    }
    return { type: "Obj", props };
  }
}

export function patternNames(p: Pattern): string[] {
  switch (p.type) {
    case "Id": return [p.name];
    case "DefPat": return patternNames(p.target);
    case "ArrPat": return [...p.elems.flatMap((e) => (e ? patternNames(e) : [])), ...(p.rest ? patternNames(p.rest) : [])];
    case "ObjPat": return [...p.props.flatMap((x) => patternNames(x.value)), ...(p.rest ? [p.rest] : [])];
  }
}

/** Parses a card script. Throws ScriptSyntaxError. */
export function parseScript(src: string): Program {
  return new Parser(tokenize(src)).program();
}
