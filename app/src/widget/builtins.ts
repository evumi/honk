// The standard library card scripts see: Object, Array, String, Number,
// Boolean, Math, JSON, Date, Map, Set, the Error types and the global
// functions. Each one is written against the interpreter's own values
// (interp.ts), never handing a card a host object or function.

import {
  ARRAY_METHODS, ArrayObj, FnObj, FUNCTION_METHODS, Interp, LIMITS, Native, NUMBER_METHODS, Obj, OBJECT_METHODS, PlainObj,
  STRING_METHODS, type NativeImpl, type Value,
} from "./interp";

function fn(name: string, impl: NativeImpl): Native {
  return new Native(name, impl);
}

function arg(args: Value[], i: number): Value {
  return args[i];
}

function callback(it: Interp, v: Value): FnObj {
  if (!(v instanceof FnObj)) it.throwError("TypeError", `${it.typeOf(v) === "object" ? "object" : String(v)} is not a function`);
  return v;
}

function thisArray(it: Interp, v: Value): ArrayObj {
  if (!(v instanceof ArrayObj)) it.throwError("TypeError", "Array method called on a non-array");
  return v;
}

function thisString(it: Interp, v: Value): string {
  if (v == null) it.throwError("TypeError", "String method called on null or undefined");
  return it.toStr(v);
}

function relIndex(it: Interp, v: Value, len: number, dflt: number): number {
  if (v === undefined) return dflt;
  let n = Math.trunc(it.toNum(v));
  if (Number.isNaN(n)) n = 0;
  return n < 0 ? Math.max(0, len + n) : Math.min(n, len);
}

function newArray(it: Interp, items: Value[]): ArrayObj {
  if (items.length > LIMITS.array) it.throwError("RangeError", "Array too long");
  it.alloc(1 + items.length);
  return new ArrayObj(items);
}

/** A host object of primitives from a card's options object (for toLocaleString and the like). */
function hostOptions(it: Interp, v: Value): Record<string, string | number | boolean> | undefined {
  if (!(v instanceof Obj)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const k of v.keys().slice(0, 32)) {
    const x = v.get(k, it);
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = x;
  }
  return out;
}

function hostLocale(it: Interp, v: Value): string | undefined {
  return typeof v === "string" && v.length < 64 ? v : undefined;
}

// MARK: Object.prototype

OBJECT_METHODS.set("hasOwnProperty", fn("hasOwnProperty", (it, self, args) => {
  const key = it.toKey(arg(args, 0));
  if (self instanceof PlainObj) return self.props.has(key);
  if (self instanceof Obj) return self.has(key);
  return false;
}));
OBJECT_METHODS.set("toString", fn("toString", (it, self) => {
  if (self instanceof PlainObj && self.isA("Error")) return `${it.toStr(self.get("name", it))}: ${it.toStr(self.get("message", it))}`;
  if (self instanceof ArrayObj) return it.toStr(self);
  return `[object ${self instanceof Obj ? self.className : self === null ? "Null" : "Undefined"}]`;
}));
OBJECT_METHODS.set("valueOf", fn("valueOf", (_it, self) => self));

// MARK: Array.prototype

function join(it: Interp, a: ArrayObj, sep: string): string {
  let out = "";
  a.items.forEach((x, i) => {
    if (i > 0) out += sep;
    out += x == null ? "" : it.toStr(x);
    if (out.length > LIMITS.string) it.throwError("RangeError", "String too long");
  });
  it.charge(a.items.length);
  return it.str(out);
}

function sortItems(it: Interp, items: Value[], cmp: FnObj | null): Value[] {
  const compare = (x: Value, y: Value): number => {
    if (x === undefined) return y === undefined ? 0 : 1;
    if (y === undefined) return -1;
    if (cmp) {
      const r = it.toNum(it.call(cmp, undefined, [x, y]));
      return Number.isNaN(r) ? 0 : r;
    }
    const a = it.toStr(x);
    const b = it.toStr(y);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  // Merge sort, so every comparison goes through the card's budget.
  const sort = (xs: Value[]): Value[] => {
    if (xs.length < 2) return xs;
    const mid = xs.length >> 1;
    const l = sort(xs.slice(0, mid));
    const r = sort(xs.slice(mid));
    const out: Value[] = [];
    let i = 0;
    let j = 0;
    while (i < l.length && j < r.length) out.push(compare(l[i], r[j]) <= 0 ? l[i++] : r[j++]);
    while (i < l.length) out.push(l[i++]);
    while (j < r.length) out.push(r[j++]);
    it.charge(xs.length);
    return out;
  };
  return sort(items);
}

const arrayMethods: Record<string, NativeImpl> = {
  push(it, self, args) {
    const a = thisArray(it, self);
    if (a.items.length + args.length > LIMITS.array) it.throwError("RangeError", "Array too long");
    it.alloc(args.length);
    a.items.push(...args);
    return a.items.length;
  },
  pop: (it, self) => thisArray(it, self).items.pop(),
  shift: (it, self) => {
    const a = thisArray(it, self);
    it.charge(a.items.length >> 4);
    return a.items.shift();
  },
  unshift(it, self, args) {
    const a = thisArray(it, self);
    if (a.items.length + args.length > LIMITS.array) it.throwError("RangeError", "Array too long");
    it.alloc(args.length);
    it.charge(a.items.length >> 4);
    a.items.unshift(...args);
    return a.items.length;
  },
  slice(it, self, args) {
    const a = thisArray(it, self);
    const len = a.items.length;
    return newArray(it, a.items.slice(relIndex(it, args[0], len, 0), relIndex(it, args[1], len, len)));
  },
  splice(it, self, args) {
    const a = thisArray(it, self);
    const len = a.items.length;
    const start = relIndex(it, args[0], len, 0);
    const count = args.length < 2 ? len - start : Math.max(0, Math.min(len - start, Math.trunc(it.toNum(args[1])) || 0));
    const add = args.slice(2);
    if (len - count + add.length > LIMITS.array) it.throwError("RangeError", "Array too long");
    it.alloc(add.length);
    it.charge(len >> 4);
    return newArray(it, a.items.splice(start, count, ...add));
  },
  concat(it, self, args) {
    const a = thisArray(it, self);
    const out = a.items.slice();
    for (const x of args) {
      if (x instanceof ArrayObj) out.push(...x.items);
      else out.push(x);
      if (out.length > LIMITS.array) it.throwError("RangeError", "Array too long");
    }
    return newArray(it, out);
  },
  join: (it, self, args) => join(it, thisArray(it, self), args[0] === undefined ? "," : it.toStr(args[0])),
  toString: (it: Interp, self: Value) => join(it, thisArray(it, self), ","),
  indexOf(it, self, args) {
    const a = thisArray(it, self);
    it.charge(a.items.length);
    return a.items.indexOf(args[0], relIndex(it, args[1], a.items.length, 0));
  },
  lastIndexOf(it, self, args) {
    const a = thisArray(it, self);
    it.charge(a.items.length);
    return a.items.lastIndexOf(args[0]);
  },
  includes(it, self, args) {
    const a = thisArray(it, self);
    it.charge(a.items.length);
    return a.items.includes(args[0]);
  },
  reverse(it, self) {
    const a = thisArray(it, self);
    a.items.reverse();
    return a;
  },
  sort(it, self, args) {
    const a = thisArray(it, self);
    a.items = sortItems(it, a.items, args[0] === undefined ? null : callback(it, args[0]));
    return a;
  },
  forEach(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    const items = a.items.slice();
    for (let i = 0; i < items.length; i++) it.call(f, args[1], [items[i], i, a]);
    return undefined;
  },
  map(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    const items = a.items.slice();
    return newArray(it, items.map((x, i) => it.call(f, args[1], [x, i, a])));
  },
  filter(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    return newArray(it, a.items.slice().filter((x, i) => it.truthy(it.call(f, args[1], [x, i, a]))));
  },
  find(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    return a.items.slice().find((x, i) => it.truthy(it.call(f, args[1], [x, i, a])));
  },
  findIndex(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    return a.items.slice().findIndex((x, i) => it.truthy(it.call(f, args[1], [x, i, a])));
  },
  findLast(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    const items = a.items.slice();
    for (let i = items.length - 1; i >= 0; i--) if (it.truthy(it.call(f, args[1], [items[i], i, a]))) return items[i];
    return undefined;
  },
  findLastIndex(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    const items = a.items.slice();
    for (let i = items.length - 1; i >= 0; i--) if (it.truthy(it.call(f, args[1], [items[i], i, a]))) return i;
    return -1;
  },
  some(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    return a.items.slice().some((x, i) => it.truthy(it.call(f, args[1], [x, i, a])));
  },
  every(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    return a.items.slice().every((x, i) => it.truthy(it.call(f, args[1], [x, i, a])));
  },
  reduce(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    const items = a.items.slice();
    let i = 0;
    let acc: Value;
    if (args.length > 1) acc = args[1];
    else {
      if (items.length === 0) it.throwError("TypeError", "Reduce of empty array with no initial value");
      acc = items[i++];
    }
    for (; i < items.length; i++) acc = it.call(f, undefined, [acc, items[i], i, a]);
    return acc;
  },
  reduceRight(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    const items = a.items.slice();
    let i = items.length - 1;
    let acc: Value;
    if (args.length > 1) acc = args[1];
    else {
      if (items.length === 0) it.throwError("TypeError", "Reduce of empty array with no initial value");
      acc = items[i--];
    }
    for (; i >= 0; i--) acc = it.call(f, undefined, [acc, items[i], i, a]);
    return acc;
  },
  flat(it, self, args) {
    const depth = args[0] === undefined ? 1 : Math.min(8, Math.max(0, Math.trunc(it.toNum(args[0])) || 0));
    const out: Value[] = [];
    const walk = (xs: Value[], d: number) => {
      for (const x of xs) {
        if (x instanceof ArrayObj && d > 0) walk(x.items, d - 1);
        else out.push(x);
        if (out.length > LIMITS.array) it.throwError("RangeError", "Array too long");
      }
    };
    walk(thisArray(it, self).items, depth);
    return newArray(it, out);
  },
  flatMap(it, self, args) {
    const a = thisArray(it, self);
    const f = callback(it, args[0]);
    const out: Value[] = [];
    a.items.slice().forEach((x, i) => {
      const r = it.call(f, args[1], [x, i, a]);
      if (r instanceof ArrayObj) out.push(...r.items);
      else out.push(r);
      if (out.length > LIMITS.array) it.throwError("RangeError", "Array too long");
    });
    return newArray(it, out);
  },
  fill(it, self, args) {
    const a = thisArray(it, self);
    const len = a.items.length;
    a.items.fill(args[0], relIndex(it, args[1], len, 0), relIndex(it, args[2], len, len));
    it.charge(len >> 4);
    return a;
  },
  at(it, self, args) {
    const a = thisArray(it, self);
    let i = Math.trunc(it.toNum(args[0])) || 0;
    if (i < 0) i += a.items.length;
    return a.items[i];
  },
  keys: (it, self) => newArray(it, thisArray(it, self).items.map((_, i) => i)),
  values: (it, self) => newArray(it, thisArray(it, self).items.slice()),
  entries: (it, self) => newArray(it, thisArray(it, self).items.map((x, i) => newArray(it, [i, x]))),
};
for (const [k, impl] of Object.entries(arrayMethods)) ARRAY_METHODS.set(k, fn(k, impl));

// MARK: String.prototype

function replaceWith(it: Interp, s: string, pattern: string, repl: Value, all: boolean): string {
  let out = "";
  let from = 0;
  while (true) {
    const at = pattern === "" && from > s.length ? -1 : s.indexOf(pattern, from);
    if (at < 0) break;
    out += s.slice(from, at);
    out += repl instanceof FnObj ? it.toStr(it.call(repl, undefined, [pattern, at, s])) : it.toStr(repl).replace(/\$\$|\$&/g, (m) => (m === "$$" ? "$" : pattern));
    if (out.length > LIMITS.string) it.throwError("RangeError", "String too long");
    from = at + pattern.length;
    it.charge(1);
    if (!all) break;
    if (pattern === "") {
      if (at < s.length) out += s[at];
      from = at + 1;
    }
  }
  if (from <= s.length) out += s.slice(from);
  return it.str(out);
}

function pad(it: Interp, s: string, args: Value[], start: boolean): string {
  const len = Math.trunc(it.toNum(args[0])) || 0;
  if (len > LIMITS.string) it.throwError("RangeError", "String too long");
  const fill = args[1] === undefined ? " " : it.toStr(args[1]);
  return it.str(start ? s.padStart(len, fill) : s.padEnd(len, fill));
}

const stringMethods: Record<string, NativeImpl> = {
  charAt: (it, self, args) => thisString(it, self).charAt(it.toNum(args[0] ?? 0)),
  charCodeAt: (it, self, args) => thisString(it, self).charCodeAt(it.toNum(args[0] ?? 0)),
  codePointAt: (it, self, args) => thisString(it, self).codePointAt(it.toNum(args[0] ?? 0)),
  at: (it, self, args) => thisString(it, self).at(Math.trunc(it.toNum(args[0] ?? 0)) || 0),
  indexOf: (it, self, args) => thisString(it, self).indexOf(it.toStr(args[0]), args[1] === undefined ? 0 : it.toNum(args[1])),
  lastIndexOf: (it, self, args) => thisString(it, self).lastIndexOf(it.toStr(args[0])),
  includes: (it, self, args) => thisString(it, self).includes(it.toStr(args[0])),
  startsWith: (it, self, args) => thisString(it, self).startsWith(it.toStr(args[0]), args[1] === undefined ? 0 : it.toNum(args[1])),
  endsWith: (it, self, args) => thisString(it, self).endsWith(it.toStr(args[0])),
  slice(it, self, args) {
    const s = thisString(it, self);
    return s.slice(relIndex(it, args[0], s.length, 0), relIndex(it, args[1], s.length, s.length));
  },
  substring(it, self, args) {
    const s = thisString(it, self);
    return s.substring(it.toNum(args[0] ?? 0), args[1] === undefined ? s.length : it.toNum(args[1]));
  },
  substr(it, self, args) {
    const s = thisString(it, self);
    const start = relIndex(it, args[0], s.length, 0);
    return s.substr(start, args[1] === undefined ? undefined : Math.max(0, it.toNum(args[1])));
  },
  toUpperCase: (it, self) => it.str(thisString(it, self).toUpperCase()),
  toLowerCase: (it, self) => it.str(thisString(it, self).toLowerCase()),
  toLocaleUpperCase: (it, self) => it.str(thisString(it, self).toUpperCase()),
  toLocaleLowerCase: (it, self) => it.str(thisString(it, self).toLowerCase()),
  trim: (it, self) => thisString(it, self).trim(),
  trimStart: (it, self) => thisString(it, self).trimStart(),
  trimEnd: (it, self) => thisString(it, self).trimEnd(),
  padStart: (it, self, args) => pad(it, thisString(it, self), args, true),
  padEnd: (it, self, args) => pad(it, thisString(it, self), args, false),
  repeat(it, self, args) {
    const s = thisString(it, self);
    const n = Math.trunc(it.toNum(args[0])) || 0;
    if (n < 0 || n === Infinity) it.throwError("RangeError", "Invalid count value");
    if (s.length * n > LIMITS.string) it.throwError("RangeError", "String too long");
    return it.str(s.repeat(n));
  },
  split(it, self, args) {
    const s = thisString(it, self);
    const limit = args[1] === undefined ? LIMITS.array + 1 : Math.min(LIMITS.array + 1, it.toNum(args[1]) >>> 0);
    if (args[0] === undefined) return newArray(it, limit === 0 ? [] : [s]);
    const parts = s.split(it.toStr(args[0]), limit);
    it.charge(parts.length);
    return newArray(it, parts);
  },
  concat(it, self, args) {
    let s = thisString(it, self);
    for (const a of args) {
      s += it.toStr(a);
      if (s.length > LIMITS.string) it.throwError("RangeError", "String too long");
    }
    return it.str(s);
  },
  replace: (it, self, args) => replaceWith(it, thisString(it, self), it.toStr(args[0]), args[1], false),
  replaceAll: (it, self, args) => replaceWith(it, thisString(it, self), it.toStr(args[0]), args[1], true),
  localeCompare: (it, self, args) => thisString(it, self).localeCompare(it.toStr(args[0])),
  normalize: (it, self, args) => thisString(it, self).normalize(args[0] === undefined ? "NFC" : (it.toStr(args[0]) as "NFC")),
  toString: (it: Interp, self: Value) => thisString(it, self),
  valueOf: (it: Interp, self: Value) => thisString(it, self),
};
for (const [k, impl] of Object.entries(stringMethods)) STRING_METHODS.set(k, fn(k, impl));

// MARK: Number.prototype

function thisNumber(it: Interp, v: Value): number {
  if (typeof v !== "number") it.throwError("TypeError", "Number method called on a non-number");
  return v;
}

const numberMethods: Record<string, NativeImpl> = {
  toFixed: (it, self, args) => thisNumber(it, self).toFixed(Math.trunc(it.toNum(args[0] ?? 0)) || 0),
  toPrecision: (it, self, args) => (args[0] === undefined ? String(thisNumber(it, self)) : thisNumber(it, self).toPrecision(Math.trunc(it.toNum(args[0])))),
  toString(it: Interp, self: Value, args: Value[]) {
    if (typeof self === "boolean") return String(self);
    return thisNumber(it, self).toString(args[0] === undefined ? 10 : Math.trunc(it.toNum(args[0])));
  },
  toLocaleString: (it: Interp, self: Value, args: Value[]) => thisNumber(it, self).toLocaleString(hostLocale(it, args[0]), hostOptions(it, args[1])),
  valueOf: (it: Interp, self: Value) => (typeof self === "boolean" ? self : thisNumber(it, self)),
};
for (const [k, impl] of Object.entries(numberMethods)) NUMBER_METHODS.set(k, fn(k, impl));

// MARK: Function.prototype

FUNCTION_METHODS.set("call", fn("call", (it, self, args) => it.call(self, args[0], args.slice(1))));
FUNCTION_METHODS.set("apply", fn("apply", (it, self, args) => {
  const list = args[1] == null ? [] : args[1] instanceof ArrayObj ? args[1].items.slice() : it.throwError("TypeError", "apply needs an array");
  return it.call(self, args[0], list);
}));
FUNCTION_METHODS.set("bind", fn("bind", (it, self, args) => {
  const target = callback(it, self);
  const bound = args[0];
  const pre = args.slice(1);
  it.alloc(4 + pre.length);
  return new Native(`bound ${target.name}`, (it2, _this, rest) => it2.call(target, bound, [...pre, ...rest]));
}));
FUNCTION_METHODS.set("toString", fn("toString", (_it, self) => `function ${self instanceof FnObj ? self.name : ""}() { [code] }`));

// MARK: Date

const DATE_LIMIT = 8.64e15;

export class DateObj extends Obj {
  className = "Date";
  constructor(public t: number) {
    super();
  }
  get(key: string): Value {
    return DATE_METHODS.get(key) ?? OBJECT_METHODS.get(key);
  }
  set(): void {}
  has(key: string): boolean {
    return DATE_METHODS.has(key);
  }
  del(): boolean {
    return false;
  }
  keys(): string[] {
    return [];
  }
  primitive(hint: string): string | number {
    return hint === "number" ? this.t : new Date(this.t).toString();
  }
}

const DATE_METHODS = new Map<string, Native>();

function thisDate(it: Interp, v: Value): Date {
  if (!(v instanceof DateObj)) it.throwError("TypeError", "this is not a Date object.");
  return new Date(v.t);
}

const dateGetters = [
  "getTime", "valueOf", "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds", "getMilliseconds",
  "getTimezoneOffset", "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours", "getUTCMinutes", "getUTCSeconds",
  "getUTCMilliseconds", "toISOString", "toJSON", "toString", "toDateString", "toTimeString", "toUTCString",
] as const;
for (const name of dateGetters) {
  DATE_METHODS.set(name, fn(name, (it, self) => {
    const d = thisDate(it, self);
    if (name === "toJSON") return Number.isNaN(d.getTime()) ? null : d.toISOString();
    return (d[name] as () => string | number).call(d);
  }));
}
for (const name of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"] as const) {
  DATE_METHODS.set(name, fn(name, (it, self, args) => thisDate(it, self)[name](hostLocale(it, args[0]), hostOptions(it, args[1]) as Intl.DateTimeFormatOptions)));
}
DATE_METHODS.set("setTime", fn("setTime", (it, self, args) => {
  thisDate(it, self);
  const t = it.toNum(args[0]);
  (self as DateObj).t = Math.abs(t) <= DATE_LIMIT ? Math.trunc(t) : NaN;
  return (self as DateObj).t;
}));

function makeDate(it: Interp, args: Value[]): DateObj {
  it.alloc(2);
  if (args.length === 0) return new DateObj(Date.now());
  if (args.length === 1) {
    const v = args[0] instanceof DateObj ? args[0].t : it.toPrimitive(args[0]);
    return new DateObj(typeof v === "string" ? Date.parse(v) : new Date(Number(v)).getTime());
  }
  const n = args.slice(0, 7).map((x) => it.toNum(x));
  return new DateObj(new Date(n[0], n[1], n[2] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0, n[6] ?? 0).getTime());
}

// MARK: Map and Set

export class MapObj extends Obj {
  className = "Map";
  m = new Map<Value, Value>();
  get(key: string): Value {
    return key === "size" ? this.m.size : MAP_METHODS.get(key) ?? OBJECT_METHODS.get(key);
  }
  set(): void {}
  has(key: string): boolean {
    return key === "size" || MAP_METHODS.has(key);
  }
  del(): boolean {
    return false;
  }
  keys(): string[] {
    return [];
  }
  iterate(it: Interp): Value[] {
    it.alloc(this.m.size * 3);
    return [...this.m].map(([k, v]) => new ArrayObj([k, v]));
  }
}

export class SetObj extends Obj {
  className = "Set";
  s = new Set<Value>();
  get(key: string): Value {
    return key === "size" ? this.s.size : SET_METHODS.get(key) ?? OBJECT_METHODS.get(key);
  }
  set(): void {}
  has(key: string): boolean {
    return key === "size" || SET_METHODS.has(key);
  }
  del(): boolean {
    return false;
  }
  keys(): string[] {
    return [];
  }
  iterate(it: Interp): Value[] {
    it.alloc(this.s.size);
    return [...this.s];
  }
}

const MAP_METHODS = new Map<string, Native>();
const SET_METHODS = new Map<string, Native>();

function thisMap(it: Interp, v: Value): MapObj {
  if (!(v instanceof MapObj)) it.throwError("TypeError", "Map method called on a non-Map");
  return v;
}
function thisSet(it: Interp, v: Value): SetObj {
  if (!(v instanceof SetObj)) it.throwError("TypeError", "Set method called on a non-Set");
  return v;
}

const mapMethods: Record<string, NativeImpl> = {
  get: (it, self, args) => thisMap(it, self).m.get(args[0]),
  set(it, self, args) {
    const m = thisMap(it, self);
    if (!m.m.has(args[0])) {
      if (m.m.size >= LIMITS.array) it.throwError("RangeError", "Map too large");
      it.alloc(3);
    }
    m.m.set(args[0], args[1]);
    return m;
  },
  has: (it, self, args) => thisMap(it, self).m.has(args[0]),
  delete: (it, self, args) => thisMap(it, self).m.delete(args[0]),
  clear: (it, self) => void thisMap(it, self).m.clear(),
  forEach(it, self, args) {
    const m = thisMap(it, self);
    const f = callback(it, args[0]);
    for (const [k, v] of [...m.m]) it.call(f, args[1], [v, k, m]);
    return undefined;
  },
  keys: (it, self) => newArray(it, [...thisMap(it, self).m.keys()]),
  values: (it, self) => newArray(it, [...thisMap(it, self).m.values()]),
  entries: (it, self) => newArray(it, thisMap(it, self).iterate(it)),
};
for (const [k, impl] of Object.entries(mapMethods)) MAP_METHODS.set(k, fn(k, impl));

const setMethods: Record<string, NativeImpl> = {
  add(it, self, args) {
    const s = thisSet(it, self);
    if (!s.s.has(args[0])) {
      if (s.s.size >= LIMITS.array) it.throwError("RangeError", "Set too large");
      it.alloc(2);
    }
    s.s.add(args[0]);
    return s;
  },
  has: (it, self, args) => thisSet(it, self).s.has(args[0]),
  delete: (it, self, args) => thisSet(it, self).s.delete(args[0]),
  clear: (it, self) => void thisSet(it, self).s.clear(),
  forEach(it, self, args) {
    const s = thisSet(it, self);
    const f = callback(it, args[0]);
    for (const v of [...s.s]) it.call(f, args[1], [v, v, s]);
    return undefined;
  },
  keys: (it, self) => newArray(it, [...thisSet(it, self).s]),
  values: (it, self) => newArray(it, [...thisSet(it, self).s]),
  entries: (it, self) => newArray(it, [...thisSet(it, self).s].map((v) => new ArrayObj([v, v]))),
};
for (const [k, impl] of Object.entries(setMethods)) SET_METHODS.set(k, fn(k, impl));

// MARK: JSON

export function stringify(it: Interp, v: Value, space: string): string | undefined {
  const stack: Obj[] = [];
  let size = 0;
  const ser = (x: Value, indent: string): string | undefined => {
    it.charge(1);
    if (x === null) return "null";
    if (typeof x === "boolean") return String(x);
    if (typeof x === "number") return Number.isFinite(x) ? String(x) : "null";
    if (typeof x === "string") {
      size += x.length;
      if (size > LIMITS.string) it.throwError("RangeError", "String too long");
      return JSON.stringify(x);
    }
    if (x === undefined || (x instanceof Obj && x.callable)) return undefined;
    if (x instanceof DateObj) return Number.isNaN(x.t) ? "null" : JSON.stringify(new Date(x.t).toISOString());
    if (stack.includes(x)) it.throwError("TypeError", "Converting circular structure to JSON");
    if (stack.length >= 64) it.throwError("RangeError", "JSON nests too deeply");
    stack.push(x);
    const inner = indent + space;
    const nl = space ? "\n" : "";
    let out: string;
    if (x instanceof ArrayObj) {
      const parts = x.items.map((y) => ser(y, inner) ?? "null");
      out = parts.length === 0 ? "[]" : `[${nl}${parts.map((p) => inner + p).join("," + nl)}${nl}${indent}]`;
    } else {
      const parts: string[] = [];
      for (const k of x.keys()) {
        const s = ser(x.get(k, it), inner);
        if (s !== undefined) parts.push(`${inner}${JSON.stringify(k)}:${space ? " " : ""}${s}`);
      }
      out = parts.length === 0 ? "{}" : `{${nl}${parts.join("," + nl)}${nl}${indent}}`;
    }
    stack.pop();
    size += out.length >> 2;
    if (out.length > LIMITS.string) it.throwError("RangeError", "String too long");
    return out;
  };
  const r = ser(v, "");
  return r === undefined ? undefined : it.str(r);
}

/** A card value from parsed JSON (or another host value made of plain data). */
export function fromHost(it: Interp, v: unknown, depth = 0): Value {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (depth > 64) it.throwError("RangeError", "JSON nests too deeply");
  if (Array.isArray(v)) return newArray(it, v.map((x) => fromHost(it, x, depth + 1)));
  if (typeof v === "object") {
    const o = new PlainObj();
    it.alloc(1);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o.set(k, fromHost(it, x, depth + 1), it);
    return o;
  }
  return undefined;
}

const JSON_OBJ = new PlainObj();
JSON_OBJ.props.set("stringify", fn("stringify", (it, _self, args) => {
  const sp = args[2];
  const space = typeof sp === "number" ? " ".repeat(Math.max(0, Math.min(10, Math.trunc(sp)))) : typeof sp === "string" ? sp.slice(0, 10) : "";
  return stringify(it, args[0], space);
}));
JSON_OBJ.props.set("parse", fn("parse", (it, _self, args) => {
  const text = it.toStr(args[0]);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    it.throwError("SyntaxError", e instanceof Error ? e.message : "Bad JSON");
  }
  return fromHost(it, v);
}));
JSON_OBJ.frozen = true;

// MARK: Math

const MATH = new PlainObj();
for (const name of ["abs", "acos", "asin", "atan", "atan2", "ceil", "cos", "exp", "floor", "hypot", "log", "log10", "log2", "max", "min", "pow", "round", "sign", "sin", "sqrt", "tan", "trunc", "cbrt"] as const) {
  const f = Math[name] as (...xs: number[]) => number;
  MATH.props.set(name, fn(name, (it, _self, args) => f(...args.slice(0, 64).map((x) => it.toNum(x)))));
}
MATH.props.set("random", fn("random", () => Math.random()));
for (const name of ["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"] as const) MATH.props.set(name, Math[name]);
MATH.frozen = true;

// MARK: constructors and globals

function objectArg(it: Interp, v: Value): Obj | string | null {
  if (v instanceof Obj || typeof v === "string") return v;
  if (v == null) it.throwError("TypeError", "Cannot convert undefined or null to object");
  return null;
}

function ownKeys(it: Interp, v: Value): string[] {
  const o = objectArg(it, v);
  if (o === null) return [];
  if (typeof o === "string") return o.split("").map((_, i) => String(i));
  return o.keys();
}

function makeObject(it: Interp, args: Value[]): Value {
  if (args[0] instanceof Obj) return args[0];
  it.alloc(1);
  return new PlainObj();
}

const ObjectCtor = new Native("Object", (it, _self, args) => makeObject(it, args), { brand: "Object", make: makeObject }, {
  keys: fn("keys", (it, _s, args) => newArray(it, ownKeys(it, args[0]))),
  values: fn("values", (it, _s, args) => newArray(it, ownKeys(it, args[0]).map((k) => it.getMember(args[0], k)))),
  entries: fn("entries", (it, _s, args) => newArray(it, ownKeys(it, args[0]).map((k) => newArray(it, [k, it.getMember(args[0], k)])))),
  assign: fn("assign", (it, _s, args) => {
    const target = args[0];
    if (!(target instanceof Obj)) return it.throwError("TypeError", "Object.assign needs an object");
    for (const src of args.slice(1)) {
      if (src == null) continue;
      for (const k of ownKeys(it, src)) target.set(k, it.getMember(src, k), it);
    }
    return target;
  }),
  freeze: fn("freeze", (_it, _s, args) => {
    if (args[0] instanceof PlainObj) args[0].frozen = true;
    return args[0];
  }),
  isFrozen: fn("isFrozen", (_it, _s, args) => (args[0] instanceof PlainObj ? args[0].frozen : true)),
  fromEntries: fn("fromEntries", (it, _s, args) => {
    const o = new PlainObj();
    for (const e of it.iterate(args[0])) o.set(it.toKey(it.getMember(e, 0)), it.getMember(e, 1), it);
    return o;
  }),
  create: fn("create", (it, _s, args) => {
    const p = args[0];
    if (p !== null && !(p instanceof Obj)) return it.throwError("TypeError", "Object prototype may only be an Object or null");
    it.alloc(1);
    return new PlainObj(p);
  }),
  getPrototypeOf: fn("getPrototypeOf", (_it, _s, args) => (args[0] instanceof PlainObj ? args[0].proto : null)),
});

function makeArray(it: Interp, args: Value[]): ArrayObj {
  if (args.length === 1 && typeof args[0] === "number") {
    if (!Number.isInteger(args[0]) || args[0] < 0 || args[0] > LIMITS.array) it.throwError("RangeError", "Invalid array length");
    return newArray(it, new Array<Value>(args[0]).fill(undefined));
  }
  return newArray(it, args.slice());
}

const ArrayCtor = new Native("Array", (it, _self, args) => makeArray(it, args), { brand: "Array", make: makeArray }, {
  isArray: fn("isArray", (_it, _s, args) => args[0] instanceof ArrayObj),
  of: fn("of", (it, _s, args) => newArray(it, args.slice())),
  from: fn("from", (it, _s, args) => {
    const src = args[0];
    let items: Value[];
    if (src instanceof Obj && !(src instanceof ArrayObj) && !(src as { iterate?: unknown }).iterate) {
      const len = Math.trunc(it.toNum(src.get("length", it))) || 0;
      if (len < 0 || len > LIMITS.array) it.throwError("RangeError", "Invalid array length");
      items = [];
      for (let i = 0; i < len; i++) items.push(src.get(String(i), it));
    } else items = it.iterate(src);
    if (args[1] !== undefined) {
      const f = callback(it, args[1]);
      items = items.map((x, i) => it.call(f, undefined, [x, i]));
    }
    return newArray(it, items);
  }),
});

const StringCtor = new Native("String", (it, _self, args) => (args.length === 0 ? "" : it.toStr(args[0])), undefined, {
  fromCharCode: fn("fromCharCode", (it, _s, args) => it.str(String.fromCharCode(...args.slice(0, 4096).map((x) => it.toNum(x) & 0xffff)))),
  fromCodePoint: fn("fromCodePoint", (it, _s, args) => it.str(String.fromCodePoint(...args.slice(0, 4096).map((x) => it.toNum(x))))),
});

const NumberCtor = new Native("Number", (it, _self, args) => (args.length === 0 ? 0 : it.toNum(args[0])), undefined, {
  isInteger: fn("isInteger", (_it, _s, args) => Number.isInteger(args[0])),
  isSafeInteger: fn("isSafeInteger", (_it, _s, args) => Number.isSafeInteger(args[0])),
  isFinite: fn("isFinite", (_it, _s, args) => Number.isFinite(args[0])),
  isNaN: fn("isNaN", (_it, _s, args) => Number.isNaN(args[0])),
  parseFloat: fn("parseFloat", (it, _s, args) => parseFloat(it.toStr(args[0]))),
  parseInt: fn("parseInt", (it, _s, args) => parseInt(it.toStr(args[0]), args[1] === undefined ? undefined : it.toNum(args[1]))),
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  EPSILON: Number.EPSILON,
  MAX_VALUE: Number.MAX_VALUE,
  MIN_VALUE: Number.MIN_VALUE,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
  NaN: NaN,
});

const DateCtor = new Native("Date", () => new Date().toString(), { brand: "Date", make: makeDate }, {
  now: fn("now", () => Date.now()),
  parse: fn("parse", (it, _s, args) => Date.parse(it.toStr(args[0]))),
  UTC: fn("UTC", (it, _s, args) => {
    const n = args.slice(0, 7).map((x) => it.toNum(x));
    return Date.UTC(n[0], n[1] ?? 0, n[2] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0, n[6] ?? 0);
  }),
});

function errorCtor(name: string): Native {
  const make = (it: Interp, args: Value[]) => {
    it.alloc(4);
    return it.makeError(name, args[0] === undefined ? "" : it.toStr(args[0]));
  };
  return new Native(name, (it, _self, args) => make(it, args), { brand: name, make });
}

function collectionCtor<T extends MapObj | SetObj>(name: "Map" | "Set", make: () => T): Native {
  return new Native(name, (it) => it.throwError("TypeError", `Constructor ${name} requires 'new'`), {
    brand: name,
    make(it, args) {
      const c = make();
      it.alloc(2);
      if (args[0] != null) {
        for (const e of it.iterate(args[0])) {
          if (c instanceof MapObj) c.m.set(it.getMember(e, 0), it.getMember(e, 1));
          else (c as SetObj).s.add(e);
          if ((c instanceof MapObj ? c.m.size : (c as SetObj).s.size) > LIMITS.array) it.throwError("RangeError", `${name} too large`);
        }
        it.alloc(c instanceof MapObj ? c.m.size * 3 : (c as SetObj).s.size);
      }
      return c;
    },
  });
}

/** The globals every card gets, besides what the sandbox adds (document, TelegramWidget, timers, console). */
export const GLOBALS: Record<string, Value> = {
  Object: ObjectCtor,
  Array: ArrayCtor,
  String: StringCtor,
  Number: NumberCtor,
  Boolean: fn("Boolean", (it, _s, args) => it.truthy(args[0])),
  Math: MATH,
  JSON: JSON_OBJ,
  Date: DateCtor,
  Map: collectionCtor("Map", () => new MapObj()),
  Set: collectionCtor("Set", () => new SetObj()),
  Error: errorCtor("Error"),
  TypeError: errorCtor("TypeError"),
  RangeError: errorCtor("RangeError"),
  SyntaxError: errorCtor("SyntaxError"),
  ReferenceError: errorCtor("ReferenceError"),
  parseInt: NumberCtor.props.get("parseInt"),
  parseFloat: NumberCtor.props.get("parseFloat"),
  isNaN: fn("isNaN", (it, _s, args) => Number.isNaN(it.toNum(args[0]))),
  isFinite: fn("isFinite", (it, _s, args) => Number.isFinite(it.toNum(args[0]))),
  NaN: NaN,
  Infinity: Infinity,
};
