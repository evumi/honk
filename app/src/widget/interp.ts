// A tree-walking interpreter for card scripts (card profile 2).
//
// Why an interpreter: nsh gives an app one QuickJS context and no way to make
// another, and `eval` there would run with the app's own globals and could not
// be stopped. Here a card's values never touch the app's objects: objects are
// Obj instances with their own property maps and no prototype chain into the
// host, functions are Closure or Native, and every step is counted, so a loop
// that runs too long or allocates too much is stopped (Abort) between steps.

import { parseScript, patternNames, type Expr, type FnNode, type Pattern, type Program, type Stmt } from "./script";

export type Value = undefined | null | boolean | number | string | Obj;

/** Limits of one card's interpreter; the sandbox sets the time and allocation budgets per task. */
export const LIMITS = {
  /** Longest string a card may build, in UTF-16 units (Telegram: 32K per value). */
  string: 32 * 1024,
  /** Most elements of one array, or keys of one object. */
  array: 16 * 1024,
  /** Deepest call stack. */
  calls: 64,
  /** Deepest nesting of evaluation (expressions and statements across calls), to keep the host's stack safe. */
  nesting: 900,
};

/** Stops the card: not catchable by the card's own try/catch. */
export class Abort extends Error {
  constructor(readonly reason: "time" | "memory" | "stopped" | "crash", message?: string) {
    super(message ?? `card script stopped: ${reason}`);
  }
}

/** An exception thrown inside the card (`throw`, a TypeError): the card can catch it. */
export class Throw {
  constructor(readonly value: Value) {}
}

// MARK: objects

export abstract class Obj {
  /** For instanceof against native constructors and for Object.prototype.toString. */
  className = "Object";
  callable = false;
  abstract get(key: string, it: Interp): Value;
  abstract set(key: string, v: Value, it: Interp): void;
  abstract has(key: string): boolean;
  abstract del(key: string): boolean;
  /** Own enumerable keys, in order. */
  abstract keys(): string[];
  /** Whether this object counts as an instance of the native constructor named `brand`. */
  isA(brand: string): boolean {
    return brand === "Object" || this.className === brand;
  }
}

export class PlainObj extends Obj {
  props = new Map<string, Value>();
  frozen = false;
  constructor(public proto: Obj | null = null) {
    super();
  }
  get(key: string, it: Interp): Value {
    const v = this.props.get(key);
    if (v !== undefined || this.props.has(key)) return v;
    if (this.proto) return this.proto.get(key, it);
    return OBJECT_METHODS.get(key);
  }
  set(key: string, v: Value, it: Interp): void {
    if (this.frozen) return;
    if (!this.props.has(key)) {
      if (this.props.size >= LIMITS.array) it.throwError("RangeError", "Too many properties");
      it.alloc(2);
    }
    this.props.set(key, v);
  }
  has(key: string): boolean {
    return this.props.has(key) || (this.proto?.has(key) ?? false);
  }
  del(key: string): boolean {
    if (this.frozen) return false;
    return this.props.delete(key);
  }
  keys(): string[] {
    // Integer keys first, ascending, as JS orders them.
    const ints: string[] = [];
    const rest: string[] = [];
    for (const k of this.props.keys()) (/^(0|[1-9]\d{0,8})$/.test(k) ? ints : rest).push(k);
    ints.sort((a, b) => Number(a) - Number(b));
    return ints.length ? [...ints, ...rest] : rest;
  }
  isA(brand: string): boolean {
    if (this.className === brand || brand === "Object") return true;
    if (brand === "Error" && /Error$/.test(this.className)) return true;
    return false;
  }
}

export class ArrayObj extends Obj {
  className = "Array";
  constructor(public items: Value[] = []) {
    super();
  }
  get(key: string, it: Interp): Value {
    if (key === "length") return this.items.length;
    const i = arrayIndex(key);
    if (i >= 0) return this.items[i];
    return ARRAY_METHODS.get(key) ?? OBJECT_METHODS.get(key);
  }
  set(key: string, v: Value, it: Interp): void {
    if (key === "length") {
      const n = it.toNum(v);
      if (!Number.isInteger(n) || n < 0) it.throwError("RangeError", "Invalid array length");
      if (n > LIMITS.array) it.throwError("RangeError", "Array too long");
      if (n > this.items.length) it.alloc(n - this.items.length);
      this.items.length = n;
      return;
    }
    const i = arrayIndex(key);
    if (i < 0) return; // named properties on arrays are not kept
    if (i >= LIMITS.array) it.throwError("RangeError", "Array too long");
    if (i >= this.items.length) {
      it.alloc(i + 1 - this.items.length);
      while (this.items.length < i) this.items.push(undefined);
    }
    this.items[i] = v;
  }
  has(key: string): boolean {
    const i = arrayIndex(key);
    return key === "length" || (i >= 0 && i < this.items.length);
  }
  del(key: string): boolean {
    const i = arrayIndex(key);
    if (i >= 0 && i < this.items.length) this.items[i] = undefined;
    return true;
  }
  keys(): string[] {
    return this.items.map((_, i) => String(i));
  }
}

export function arrayIndex(key: string): number {
  if (key.length === 0 || key.length > 9) return -1;
  const c = key.charCodeAt(0);
  if (c < 48 || c > 57 || (c === 48 && key.length > 1)) return -1;
  for (let i = 1; i < key.length; i++) {
    const d = key.charCodeAt(i);
    if (d < 48 || d > 57) return -1;
  }
  return Number(key);
}

export abstract class FnObj extends PlainObj {
  className = "Function";
  callable = true;
  abstract name: string;
  abstract call(it: Interp, thisVal: Value, args: Value[]): Value;
  get(key: string, it: Interp): Value {
    if (key === "name") return this.name;
    const own = this.props.get(key);
    if (own !== undefined || this.props.has(key)) return own;
    return FUNCTION_METHODS.get(key);
  }
}

export class Closure extends FnObj {
  constructor(readonly node: FnNode, readonly scope: Scope) {
    super();
  }
  get name(): string {
    return this.node.name;
  }
  get(key: string, it: Interp): Value {
    if (key === "prototype" && !this.node.arrow && !this.props.has("prototype")) {
      const proto = new PlainObj();
      proto.props.set("constructor", this);
      this.props.set("prototype", proto);
      it.alloc(4);
    }
    return super.get(key, it);
  }
  call(it: Interp, thisVal: Value, args: Value[]): Value {
    return it.callClosure(this, thisVal, args);
  }
}

// `void` so a native with nothing to return can be a one-line arrow.
export type NativeImpl = (it: Interp, thisVal: Value, args: Value[]) => Value | void;

/** A function the interpreter provides. Shared between cards, so it is frozen. */
export class Native extends FnObj {
  constructor(
    readonly name: string,
    readonly impl: NativeImpl,
    /** `new X(...)`: builds the instance; also the brand `instanceof X` checks. */
    readonly ctor?: { brand: string; make: (it: Interp, args: Value[]) => Value },
    statics?: Record<string, Value>,
  ) {
    super();
    if (statics) for (const [k, v] of Object.entries(statics)) this.props.set(k, v);
    this.frozen = true;
  }
  call(it: Interp, thisVal: Value, args: Value[]): Value {
    return this.impl(it, thisVal, args) as Value;
  }
}

/** Methods every plain object has, its stand-in for Object.prototype. */
export const OBJECT_METHODS = new Map<string, Native>();
/** Array.prototype's methods. */
export const ARRAY_METHODS = new Map<string, Native>();
export const STRING_METHODS = new Map<string, Native>();
export const NUMBER_METHODS = new Map<string, Native>();
export const FUNCTION_METHODS = new Map<string, Native>();

// MARK: scopes

interface Binding {
  v: Value;
  konst: boolean;
}

export class Scope {
  vars = new Map<string, Binding>();
  /** Set on a non-arrow function's scope (and the global one). */
  thisVal?: Value;
  hasThis = false;
  constructor(readonly parent: Scope | null) {}

  lookup(name: string): Binding | undefined {
    let s: Scope | null = this;
    while (s) {
      const b = s.vars.get(name);
      if (b) return b;
      s = s.parent;
    }
    return undefined;
  }
  declare(name: string, v: Value, konst = false): void {
    this.vars.set(name, { v, konst });
  }
}

// MARK: completions

const BREAK = { k: "break" } as const;
const CONTINUE = { k: "continue" } as const;
class Ret {
  constructor(readonly value: Value) {}
}
type Signal = typeof BREAK | typeof CONTINUE | Ret | undefined;

/** Thrown by `a?.b` when `a` is nullish; caught by the end of the chain. */
const SHORT = { short: true };

// MARK: interpreter

export class Interp {
  readonly global = new Scope(null);
  private steps = 0;
  private checkAt = 1024;
  private deadline = Infinity;
  private allocated = 0;
  private maxAlloc = Infinity;
  private calls = 0;
  private nesting = 0;
  /** Set to stop the card at the next step (from the outside). */
  stopped = false;

  constructor() {
    this.global.hasThis = true;
    this.global.thisVal = undefined;
  }

  /** Starts a task: `ms` of wall time and `alloc` units of allocation from now. */
  begin(ms: number, alloc: number): void {
    this.deadline = performance.now() + ms;
    this.allocated = 0;
    this.maxAlloc = alloc;
    this.steps = 0;
    this.checkAt = 256;
    this.calls = 0;
    this.nesting = 0;
  }

  /** Counts work; stops the card past its time. */
  charge(n = 1): void {
    this.steps += n;
    if (this.steps >= this.checkAt) {
      this.checkAt = this.steps + 512;
      if (this.stopped) throw new Abort("stopped");
      if (performance.now() > this.deadline) throw new Abort("time", "card script ran too long");
    }
  }

  /** Counts allocation (roughly, in values and 8-character string chunks). */
  alloc(n: number): void {
    this.allocated += n;
    if (this.allocated > this.maxAlloc) throw new Abort("memory", "card script allocated too much");
  }

  // Errors

  makeError(name: string, message: string): PlainObj {
    const e = new PlainObj();
    e.className = name;
    e.props.set("name", name);
    e.props.set("message", message);
    e.props.set("stack", "");
    return e;
  }
  throwError(name: string, message: string): never {
    throw new Throw(this.makeError(name, message));
  }

  // Conversions

  typeOf(v: Value): string {
    if (v === null) return "object";
    if (v instanceof Obj) return v.callable ? "function" : "object";
    return typeof v;
  }

  truthy(v: Value): boolean {
    if (v instanceof Obj) return true;
    return !!v;
  }

  toPrimitive(v: Value, hint: "number" | "string" | "default" = "default"): Exclude<Value, Obj> {
    if (!(v instanceof Obj)) return v;
    const prim = (v as { primitive?: (hint: string) => string | number }).primitive;
    if (prim) return prim.call(v, hint);
    const order = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
    for (const name of order) {
      const f = v.get(name, this);
      if (f instanceof FnObj) {
        const r = this.call(f, v, []);
        if (!(r instanceof Obj)) return r;
      }
    }
    this.throwError("TypeError", "Cannot convert object to primitive value");
  }

  toStr(v: Value): string {
    if (typeof v === "string") return v;
    if (v instanceof Obj) return this.toStr(this.toPrimitive(v, "string"));
    return String(v);
  }

  toNum(v: Value): number {
    if (typeof v === "number") return v;
    if (v instanceof Obj) return this.toNum(this.toPrimitive(v, "number"));
    return Number(v);
  }

  toKey(v: Value): string {
    return typeof v === "string" ? v : this.toStr(v);
  }

  /** Checks a new string's length and counts it. */
  str(s: string): string {
    if (s.length > LIMITS.string) this.throwError("RangeError", "String too long");
    this.alloc(1 + (s.length >> 3));
    return s;
  }

  looseEq(a: Value, b: Value): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == null && b == null;
    if (a instanceof Obj && b instanceof Obj) return false;
    if (a instanceof Obj) return this.looseEq(this.toPrimitive(a), b);
    if (b instanceof Obj) return this.looseEq(a, this.toPrimitive(b));
    if (typeof a === "boolean") return this.looseEq(Number(a), b);
    if (typeof b === "boolean") return this.looseEq(a, Number(b));
    if (typeof a !== typeof b) return Number(a) === Number(b);
    return false;
  }

  // Properties

  getMember(obj: Value, key: Value): Value {
    if (obj instanceof Obj) return obj.get(typeof key === "number" && obj instanceof ArrayObj && Number.isInteger(key) && key >= 0 ? String(key) : this.toKey(key), this);
    if (obj == null) this.throwError("TypeError", `Cannot read properties of ${obj} (reading '${this.keyLabel(key)}')`);
    if (typeof obj === "string") {
      if (typeof key === "number") return Number.isInteger(key) && key >= 0 && key < obj.length ? obj[key] : undefined;
      const k = this.toKey(key);
      if (k === "length") return obj.length;
      const i = arrayIndex(k);
      if (i >= 0) return i < obj.length ? obj[i] : undefined;
      return STRING_METHODS.get(k);
    }
    if (typeof obj === "number") return NUMBER_METHODS.get(this.toKey(key));
    if (typeof obj === "boolean") return this.toKey(key) === "toString" ? NUMBER_METHODS.get("toString") : undefined;
    return undefined;
  }

  private keyLabel(key: Value): string {
    return key instanceof Obj ? "[object]" : String(key);
  }

  setMember(obj: Value, key: Value, v: Value): void {
    if (obj instanceof Obj) {
      obj.set(this.toKey(key), v, this);
      return;
    }
    if (obj == null) this.throwError("TypeError", `Cannot set properties of ${obj} (setting '${this.keyLabel(key)}')`);
    // Properties of primitives are dropped, as in sloppy mode.
  }

  // Calls

  call(f: Value, thisVal: Value, args: Value[]): Value {
    if (!(f instanceof FnObj)) this.throwError("TypeError", `${this.typeOf(f) === "object" && f !== null ? "object" : String(f)} is not a function`);
    if (++this.calls > LIMITS.calls) {
      this.calls--;
      this.throwError("RangeError", "Maximum call stack size exceeded");
    }
    try {
      if (f instanceof Native) {
        try {
          return f.impl(this, thisVal, args) as Value;
        } catch (e) {
          throw this.wrapHostError(e);
        }
      }
      return f.call(this, thisVal, args);
    } finally {
      this.calls--;
    }
  }

  /** A host exception from a native (a RangeError from toFixed, say) becomes the card's own error. */
  wrapHostError(e: unknown): unknown {
    if (e instanceof Throw || e instanceof Abort) return e;
    if (e === SHORT) return e;
    const name = e instanceof RangeError ? "RangeError" : e instanceof SyntaxError ? "SyntaxError" : e instanceof TypeError ? "TypeError" : "Error";
    const msg = e instanceof Error ? e.message : String(e);
    if (/stack overflow|too much recursion|call stack/i.test(msg)) return new Abort("crash", msg);
    return new Throw(this.makeError(name, msg));
  }

  construct(f: Value, args: Value[]): Value {
    if (f instanceof Native && f.ctor) {
      try {
        return f.ctor.make(this, args);
      } catch (e) {
        throw this.wrapHostError(e);
      }
    }
    if (!(f instanceof Closure) || f.node.arrow) this.throwError("TypeError", `${f instanceof FnObj ? f.name || "anonymous" : String(f)} is not a constructor`);
    const proto = f.get("prototype", this);
    const obj = new PlainObj(proto instanceof Obj ? proto : null);
    this.alloc(4);
    const r = this.call(f, obj, args);
    return r instanceof Obj ? r : obj;
  }

  callClosure(f: Closure, thisVal: Value, args: Value[]): Value {
    const node = f.node;
    const scope = new Scope(f.scope);
    this.alloc(2 + args.length);
    if (!node.arrow) {
      scope.hasThis = true;
      scope.thisVal = thisVal;
      if (node.name) scope.declare(node.name, f);
    }
    for (const name of node.vars) scope.declare(name, undefined);
    node.params.forEach((p, i) => this.bindPattern(p, args[i], scope, "let"));
    if (node.rest) this.bindPattern(node.rest, new ArrayObj(args.slice(node.params.length)), scope, "let");
    if (!Array.isArray(node.body)) return this.eval(node.body, scope);
    const sig = this.execList(node.body, scope);
    return sig instanceof Ret ? sig.value : undefined;
  }

  // Programs

  /** Parses and runs a script in the global scope. Throws ScriptSyntaxError, Throw or Abort. */
  run(src: string | Program): void {
    const prog = typeof src === "string" ? parseScript(src) : src;
    for (const name of prog.vars) if (!this.global.vars.has(name)) this.global.declare(name, undefined);
    this.execList(prog.body, this.global);
  }

  // Patterns

  bindPattern(p: Pattern, v: Value, scope: Scope, kind: "var" | "let" | "const" | null): void {
    switch (p.type) {
      case "Id":
        if (kind === null) this.assignName(p.name, v, scope);
        else if (kind === "var") {
          const b = scope.lookup(p.name);
          if (b) b.v = v;
          else scope.declare(p.name, v);
        } else scope.declare(p.name, v, kind === "const");
        return;
      case "DefPat":
        this.bindPattern(p.target, v === undefined ? this.eval(p.init, scope) : v, scope, kind);
        return;
      case "ArrPat": {
        const items = this.iterate(v);
        p.elems.forEach((e, i) => e && this.bindPattern(e, items[i], scope, kind));
        if (p.rest) this.bindPattern(p.rest, new ArrayObj(items.slice(p.elems.length)), scope, kind);
        return;
      }
      case "ObjPat": {
        if (v == null) this.throwError("TypeError", `Cannot destructure ${v}`);
        const used = new Set<string>();
        for (const prop of p.props) {
          const key = typeof prop.key === "string" ? prop.key : this.toKey(this.eval(prop.key, scope));
          used.add(key);
          this.bindPattern(prop.value, this.getMember(v, key), scope, kind);
        }
        if (p.rest) {
          const rest = new PlainObj();
          if (v instanceof Obj) for (const k of v.keys()) if (!used.has(k)) rest.set(k, v.get(k, this), this);
          this.bindPattern({ type: "Id", name: p.rest }, rest, scope, kind);
        }
        return;
      }
    }
  }

  private assignName(name: string, v: Value, scope: Scope): void {
    const b = scope.lookup(name);
    if (b) {
      if (b.konst) this.throwError("TypeError", "Assignment to constant variable.");
      b.v = v;
    } else {
      this.global.declare(name, v);
    }
  }

  /** The values of an iterable: arrays, strings, Maps (entries) and Sets. */
  iterate(v: Value): Value[] {
    if (v instanceof ArrayObj) return v.items.slice();
    if (typeof v === "string") {
      this.alloc(v.length);
      return Array.from(v);
    }
    const it = v instanceof Obj ? (v as { iterate?: (it: Interp) => Value[] }).iterate : undefined;
    if (it) return it.call(v, this);
    this.throwError("TypeError", `${v instanceof Obj ? "object" : String(v)} is not iterable`);
  }

  // Statements

  /** Runs a statement list in `scope`, hoisting its function declarations first. */
  execList(list: Stmt[], scope: Scope): Signal {
    for (const s of list) if (s.type === "FnDecl") scope.declare(s.fn.name, new Closure(s.fn, scope));
    for (const s of list) {
      const sig = this.exec(s, scope);
      if (sig) return sig;
    }
    return undefined;
  }

  exec(s: Stmt, scope: Scope): Signal {
    this.charge();
    if (++this.nesting > LIMITS.nesting) {
      this.nesting--;
      this.throwError("RangeError", "Maximum call stack size exceeded");
    }
    try {
      return this.execInner(s, scope);
    } finally {
      this.nesting--;
    }
  }

  private execInner(s: Stmt, scope: Scope): Signal {
    switch (s.type) {
      case "Expr":
        this.eval(s.expr, scope);
        return undefined;
      case "Decl":
        for (const d of s.decls) {
          if (s.kind === "var" && d.init === null) continue;
          this.bindPattern(d.id, d.init ? this.eval(d.init, scope) : undefined, scope, s.kind);
        }
        return undefined;
      case "FnDecl":
      case "Empty":
        return undefined;
      case "Return":
        return new Ret(s.arg ? this.eval(s.arg, scope) : undefined);
      case "If":
        if (this.truthy(this.eval(s.test, scope))) return this.exec(s.then, scope);
        return s.else ? this.exec(s.else, scope) : undefined;
      case "Block":
        return this.execList(s.body, new Scope(scope));
      case "For":
        return this.execFor(s, scope);
      case "ForOf": {
        const right = this.eval(s.right, scope);
        let keys: Value[];
        if (s.of) keys = this.iterate(right);
        else if (right instanceof Obj) keys = right.keys();
        else if (typeof right === "string") keys = right.split("").map((_, i) => String(i));
        else keys = [];
        for (const k of keys) {
          const iter = new Scope(scope);
          if (s.kind) this.bindPattern(s.left as Pattern, k, s.kind === "var" ? scope : iter, s.kind);
          else this.assignTo(s.left as Expr, k, scope);
          const sig = this.exec(s.body, iter);
          if (sig === BREAK) break;
          if (sig instanceof Ret) return sig;
        }
        return undefined;
      }
      case "While":
        while (this.truthy(this.eval(s.test, scope))) {
          const sig = this.exec(s.body, scope);
          if (sig === BREAK) break;
          if (sig instanceof Ret) return sig;
        }
        return undefined;
      case "DoWhile":
        do {
          const sig = this.exec(s.body, scope);
          if (sig === BREAK) break;
          if (sig instanceof Ret) return sig;
        } while (this.truthy(this.eval(s.test, scope)));
        return undefined;
      case "Break":
        return BREAK;
      case "Continue":
        return CONTINUE;
      case "Throw":
        throw new Throw(this.eval(s.arg, scope));
      case "Try":
        return this.execTry(s, scope);
      case "Switch": {
        const v = this.eval(s.disc, scope);
        const inner = new Scope(scope);
        let start = s.cases.findIndex((c) => c.test !== null && this.eval(c.test, inner) === v);
        if (start < 0) start = s.cases.findIndex((c) => c.test === null);
        if (start < 0) return undefined;
        for (let k = start; k < s.cases.length; k++) {
          const sig = this.execList(s.cases[k].body, inner);
          if (sig === BREAK) return undefined;
          if (sig) return sig;
        }
        return undefined;
      }
    }
  }

  private execFor(s: Stmt & { type: "For" }, scope: Scope): Signal {
    let cur = new Scope(scope);
    const perIteration = s.init?.type === "Decl" && s.init.kind !== "var";
    if (s.init) this.exec(s.init, cur);
    while (true) {
      if (s.test && !this.truthy(this.eval(s.test, cur))) break;
      const sig = this.exec(s.body, cur);
      if (sig === BREAK) break;
      if (sig instanceof Ret) return sig;
      if (perIteration) {
        // A fresh binding per iteration, so closures made in the body keep their own `i`.
        const next = new Scope(scope);
        for (const [k, b] of cur.vars) next.vars.set(k, { v: b.v, konst: b.konst });
        cur = next;
        this.alloc(2);
      }
      if (s.update) this.eval(s.update, cur);
    }
    return undefined;
  }

  private execTry(s: Stmt & { type: "Try" }, scope: Scope): Signal {
    let sig: Signal;
    let pending: unknown = null;
    let failed = false;
    try {
      sig = this.execList(s.block, new Scope(scope));
    } catch (e) {
      if (!(e instanceof Throw) || !s.handler) {
        if (e instanceof Abort || !s.finalizer) throw e;
        pending = e;
        failed = true;
      } else {
        const inner = new Scope(scope);
        if (s.param) this.bindPattern(s.param, e.value, inner, "let");
        try {
          sig = this.execList(s.handler, inner);
        } catch (e2) {
          if (e2 instanceof Abort || !s.finalizer) throw e2;
          pending = e2;
          failed = true;
        }
      }
    }
    if (s.finalizer) {
      const fin = this.execList(s.finalizer, new Scope(scope));
      if (fin) return fin;
    }
    if (failed) throw pending;
    return sig;
  }

  // Expressions

  eval(e: Expr, scope: Scope): Value {
    this.charge();
    if (++this.nesting > LIMITS.nesting) {
      this.nesting--;
      this.throwError("RangeError", "Maximum call stack size exceeded");
    }
    try {
      return this.evalInner(e, scope);
    } finally {
      this.nesting--;
    }
  }

  private evalInner(e: Expr, scope: Scope): Value {
    switch (e.type) {
      case "Lit":
        return e.value;
      case "Id": {
        if (e.name === "undefined") return undefined;
        const b = scope.lookup(e.name);
        if (!b) this.throwError("ReferenceError", `${e.name} is not defined`);
        return b.v;
      }
      case "This": {
        let s: Scope | null = scope;
        while (s && !s.hasThis) s = s.parent;
        return s?.thisVal;
      }
      case "Tpl": {
        let out = e.quasis[0];
        for (let k = 0; k < e.exprs.length; k++) {
          out += this.toStr(this.eval(e.exprs[k], scope)) + e.quasis[k + 1];
          if (out.length > LIMITS.string) this.throwError("RangeError", "String too long");
        }
        return this.str(out);
      }
      case "Arr": {
        const items: Value[] = [];
        for (const el of e.elems) {
          if (el === null) items.push(undefined);
          else if (el.type === "Spread") items.push(...this.iterate(this.eval(el.arg, scope)));
          else items.push(this.eval(el, scope));
          if (items.length > LIMITS.array) this.throwError("RangeError", "Array too long");
        }
        this.alloc(1 + items.length);
        return new ArrayObj(items);
      }
      case "Obj": {
        const o = new PlainObj();
        this.alloc(1);
        for (const p of e.props) {
          if (p.kind === "spread") {
            const src = this.eval(p.arg, scope);
            if (src instanceof Obj) for (const k of src.keys()) o.set(k, src.get(k, this), this);
            else if (typeof src === "string") for (let i = 0; i < src.length; i++) o.set(String(i), src[i], this);
          } else {
            const key = typeof p.key === "string" ? p.key : this.toKey(this.eval(p.key, scope));
            o.set(key, this.eval(p.value, scope), this);
          }
        }
        return o;
      }
      case "Fn":
        this.alloc(4);
        return new Closure(e, scope);
      case "Un":
        return this.unary(e.op, e.arg, scope);
      case "Upd": {
        if (e.arg.type === "Mem") {
          const obj = this.eval(e.arg.obj, scope);
          const key = typeof e.arg.prop === "string" ? e.arg.prop : this.eval(e.arg.prop, scope);
          const old = this.toNum(this.getMember(obj, key));
          const next = e.op === "++" ? old + 1 : old - 1;
          this.setMember(obj, key, next);
          return e.prefix ? next : old;
        }
        const old = this.toNum(this.eval(e.arg, scope));
        const next = e.op === "++" ? old + 1 : old - 1;
        this.assignTo(e.arg, next, scope);
        return e.prefix ? next : old;
      }
      case "Bin":
        return this.binary(e.op, this.eval(e.left, scope), this.eval(e.right, scope));
      case "Log": {
        const l = this.eval(e.left, scope);
        if (e.op === "&&") return this.truthy(l) ? this.eval(e.right, scope) : l;
        if (e.op === "||") return this.truthy(l) ? l : this.eval(e.right, scope);
        return l == null ? this.eval(e.right, scope) : l;
      }
      case "Cond":
        return this.truthy(this.eval(e.test, scope)) ? this.eval(e.then, scope) : this.eval(e.else, scope);
      case "Assign":
        return this.assign(e, scope);
      case "Seq": {
        let v: Value;
        for (const x of e.exprs) v = this.eval(x, scope);
        return v;
      }
      case "Mem": {
        const obj = this.eval(e.obj, scope);
        if (e.optional && obj == null) throw SHORT;
        return this.getMember(obj, typeof e.prop === "string" ? e.prop : this.eval(e.prop, scope));
      }
      case "Chain":
        try {
          return this.eval(e.expr, scope);
        } catch (x) {
          if (x === SHORT) return undefined;
          throw x;
        }
      case "Call": {
        let f: Value;
        let thisVal: Value;
        if (e.callee.type === "Mem") {
          thisVal = this.eval(e.callee.obj, scope);
          if (e.callee.optional && thisVal == null) throw SHORT;
          const key = typeof e.callee.prop === "string" ? e.callee.prop : this.eval(e.callee.prop, scope);
          f = this.getMember(thisVal, key);
          if (!(f instanceof FnObj) && !(e.optional && f == null)) {
            this.throwError("TypeError", `${this.describe(e.callee)} is not a function`);
          }
        } else {
          f = this.eval(e.callee, scope);
          if (!(f instanceof FnObj) && !(e.optional && f == null)) this.throwError("TypeError", `${this.describe(e.callee)} is not a function`);
        }
        if (e.optional && f == null) throw SHORT;
        return this.call(f, thisVal, this.evalArgs(e.args, scope));
      }
      case "New":
        return this.construct(this.eval(e.callee, scope), this.evalArgs(e.args, scope));
    }
  }

  private describe(e: Expr): string {
    if (e.type === "Id") return e.name;
    if (e.type === "Mem" && typeof e.prop === "string") return `${this.describe(e.obj)}.${e.prop}`;
    if (e.type === "This") return "this";
    return "expression";
  }

  private evalArgs(args: (Expr | { type: "Spread"; arg: Expr })[], scope: Scope): Value[] {
    const out: Value[] = [];
    for (const a of args) {
      if (a.type === "Spread") out.push(...this.iterate(this.eval(a.arg, scope)));
      else out.push(this.eval(a, scope));
      if (out.length > LIMITS.array) this.throwError("RangeError", "Too many arguments");
    }
    return out;
  }

  private unary(op: string, arg: Expr, scope: Scope): Value {
    if (op === "typeof" && arg.type === "Id" && !scope.lookup(arg.name)) return "undefined";
    if (op === "delete") {
      if (arg.type !== "Mem") return true;
      const obj = this.eval(arg.obj, scope);
      const key = typeof arg.prop === "string" ? arg.prop : this.toKey(this.eval(arg.prop, scope));
      return obj instanceof Obj ? obj.del(key) : true;
    }
    const v = this.eval(arg, scope);
    switch (op) {
      case "!": return !this.truthy(v);
      case "-": return -this.toNum(v);
      case "+": return this.toNum(v);
      case "~": return ~this.toNum(v);
      case "typeof": return this.typeOf(v);
      case "void": return undefined;
    }
    this.throwError("SyntaxError", `Unknown operator ${op}`);
  }

  binary(op: string, a: Value, b: Value): Value {
    switch (op) {
      case "+": {
        const pa = this.toPrimitive(a);
        const pb = this.toPrimitive(b);
        if (typeof pa === "string" || typeof pb === "string") {
          const sa = this.toStr(pa);
          const sb = this.toStr(pb);
          if (sa.length + sb.length > LIMITS.string) this.throwError("RangeError", "String too long");
          return this.str(sa + sb);
        }
        return Number(pa) + Number(pb);
      }
      case "-": return this.toNum(a) - this.toNum(b);
      case "*": return this.toNum(a) * this.toNum(b);
      case "/": return this.toNum(a) / this.toNum(b);
      case "%": return this.toNum(a) % this.toNum(b);
      case "**": return this.toNum(a) ** this.toNum(b);
      case "&": return this.toNum(a) & this.toNum(b);
      case "|": return this.toNum(a) | this.toNum(b);
      case "^": return this.toNum(a) ^ this.toNum(b);
      case "<<": return this.toNum(a) << this.toNum(b);
      case ">>": return this.toNum(a) >> this.toNum(b);
      case ">>>": return this.toNum(a) >>> this.toNum(b);
      case "===": return a === b;
      case "!==": return a !== b;
      case "==": return this.looseEq(a, b);
      case "!=": return !this.looseEq(a, b);
      case "<": case ">": case "<=": case ">=": {
        const pa = this.toPrimitive(a, "number");
        const pb = this.toPrimitive(b, "number");
        if (typeof pa === "string" && typeof pb === "string") {
          return op === "<" ? pa < pb : op === ">" ? pa > pb : op === "<=" ? pa <= pb : pa >= pb;
        }
        const x = Number(pa);
        const y = Number(pb);
        return op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
      }
      case "in":
        if (!(b instanceof Obj)) this.throwError("TypeError", "Cannot use 'in' operator to search for a key in a primitive");
        return b.has(this.toKey(a));
      case "instanceof": {
        if (!(b instanceof FnObj)) this.throwError("TypeError", "Right-hand side of 'instanceof' is not callable");
        if (!(a instanceof Obj)) return false;
        if (b instanceof Native) return b.ctor ? a.isA(b.ctor.brand) : false;
        const proto = b.get("prototype", this);
        let p = a instanceof PlainObj ? a.proto : null;
        for (let n = 0; p && n < 64; n++) {
          if (p === proto) return true;
          p = p instanceof PlainObj ? p.proto : null;
        }
        return false;
      }
    }
    this.throwError("SyntaxError", `Unknown operator ${op}`);
  }

  private assign(e: Expr & { type: "Assign" }, scope: Scope): Value {
    if (e.op === "=") {
      // Evaluate the target's object before the value, as JS does.
      if (e.target.type === "Mem") {
        const obj = this.eval(e.target.obj, scope);
        const key = typeof e.target.prop === "string" ? e.target.prop : this.eval(e.target.prop, scope);
        const v = this.eval(e.value, scope);
        this.setMember(obj, key, v);
        return v;
      }
      const v = this.eval(e.value, scope);
      this.assignTo(e.target, v, scope);
      return v;
    }
    let obj: Value;
    let key: Value;
    let cur: Value;
    if (e.target.type === "Mem") {
      obj = this.eval(e.target.obj, scope);
      key = typeof e.target.prop === "string" ? e.target.prop : this.eval(e.target.prop, scope);
      cur = this.getMember(obj, key);
    } else {
      cur = this.eval(e.target, scope);
    }
    let v: Value;
    if (e.op === "&&=" || e.op === "||=" || e.op === "??=") {
      const keep = e.op === "&&=" ? !this.truthy(cur) : e.op === "||=" ? this.truthy(cur) : cur != null;
      if (keep) return cur;
      v = this.eval(e.value, scope);
    } else {
      v = this.binary(e.op.slice(0, -1), cur, this.eval(e.value, scope));
    }
    if (e.target.type === "Mem") this.setMember(obj, key!, v);
    else this.assignTo(e.target, v, scope);
    return v;
  }

  private assignTo(target: Expr, v: Value, scope: Scope): void {
    if (target.type === "Id") this.assignName(target.name, v, scope);
    else if (target.type === "Mem") {
      const obj = this.eval(target.obj, scope);
      this.setMember(obj, typeof target.prop === "string" ? target.prop : this.eval(target.prop, scope), v);
    } else this.throwError("SyntaxError", "Invalid assignment target");
  }
}

export { patternNames };
