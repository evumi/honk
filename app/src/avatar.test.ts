import { expect, test } from "nsh/test";
import { parseAvatar } from "./components";

test("reads presets, https images and local images", () => {
  expect(parseAvatar("preset:cloud:#2f6f3e")).toMatchObject({ kind: "preset", icon: "cloud", color: "#2f6f3e" });
  expect(parseAvatar("https://e.com/a.png")).toMatchObject({ kind: "image", url: "https://e.com/a.png" });
  expect(parseAvatar("local:ab-12.webp").kind).toBe("local");
  expect(parseAvatar("local:../x.jpg")).toMatchObject({ kind: "preset", icon: "bell", color: "#0a6ed1" });
  expect(parseAvatar("")).toMatchObject({ kind: "preset", icon: "bell", color: "#0a6ed1" });
});

test("a removed preset icon (the ship) keeps its colour with the bell", () => {
  expect(parseAvatar("preset:ship:#c2410c")).toMatchObject({ kind: "preset", icon: "bell", color: "#c2410c" });
});
