import { expect, test } from "nsh/test";
import { reuse } from "./stable";

test("keeps unchanged items and takes changed or new ones", () => {
  const a = { id: "a", n: 1 };
  const b = { id: "b", n: 1 };
  const next = reuse([a, b], [{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "c", n: 1 }], (x) => x.id);
  expect(next[0]).toBe(a);
  expect(next[1]).not.toBe(b);
  expect(next[1].n).toBe(2);
  expect(next[2].id).toBe("c");
});
