import { expect, test } from "nsh/test";
import { badgeText, deviceJoined } from "./format";

test("badges cap at 99+", () => {
  expect(badgeText(1)).toBe("1");
  expect(badgeText(99)).toBe("99");
  expect(badgeText(100)).toBe("99+");
  expect(badgeText(4821)).toBe("99+");
});

test("a device joined only between two successful lists", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  expect(deviceJoined([a], [a, b])).toBe(true);
  expect(deviceJoined([a], [a])).toBe(false);
  expect(deviceJoined(null, [a, b])).toBe(false);
  expect(deviceJoined([a], null)).toBe(false);
  expect(deviceJoined([a, b], [a])).toBe(false);
});
