import { colorScheme } from "nsh";

export interface Palette {
  bg: string;
  groupedBg: string;
  card: string;
  text: string;
  hint: string;
  separator: string;
  accent: string;
  accentText: string;
  destructive: string;
  good: string;
  chatWall: string;
  bubble: string;
  pill: string;
  glass: string;
}

const light: Palette = {
  bg: "#ffffff",
  groupedBg: "#f2f2f7",
  card: "#ffffff",
  text: "#000000",
  hint: "#6d6d72",
  separator: "#d1d1d6",
  accent: "#0a6ed1",
  accentText: "#ffffff",
  destructive: "#c42b2b",
  good: "#1a9e6e",
  chatWall: "#d7e4c6",
  bubble: "#ffffff",
  pill: "#f2f2f7",
  glass: "rgba(255,255,255,0.88)",
};

const dark: Palette = {
  bg: "#000000",
  groupedBg: "#000000",
  card: "#1c1c1e",
  text: "#ffffff",
  hint: "#98989f",
  separator: "#38383a",
  accent: "#3a95f0",
  accentText: "#ffffff",
  destructive: "#ff6961",
  good: "#30c48d",
  chatWall: "#0f1a12",
  bubble: "#1c1c1e",
  pill: "#2c2c2e",
  glass: "rgba(28,28,30,0.88)",
};

/** The palette for the current appearance (reactive). */
export function palette(): Palette {
  return colorScheme() === "dark" ? dark : light;
}

/** Telegram widget theme variables (`--tg-theme-*`) mapped to the palette. */
export function widgetVars(p: Palette): Record<string, string> {
  return {
    "--tg-theme-bg-color": p.bubble,
    "--tg-theme-secondary-bg-color": p.groupedBg,
    "--tg-theme-text-color": p.text,
    "--tg-theme-hint-color": p.hint,
    "--tg-theme-subtitle-text-color": p.hint,
    "--tg-theme-link-color": p.accent,
    "--tg-theme-accent-text-color": p.accent,
    "--tg-theme-button-color": p.accent,
    "--tg-theme-button-text-color": p.accentText,
    "--tg-theme-destructive-text-color": p.destructive,
    "--tg-theme-section-separator-color": p.separator,
    "--tg-color-scheme": p === dark ? "dark" : "light",
  };
}
