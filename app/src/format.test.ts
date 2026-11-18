import { expect, test } from "nsh/test";
import { badgeText } from "./format";

test("badges cap at 99+", () => {
  expect(badgeText(1)).toBe("1");
  expect(badgeText(99)).toBe("99");
  expect(badgeText(100)).toBe("99+");
  expect(badgeText(4821)).toBe("99+");
});
