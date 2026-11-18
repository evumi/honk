// The CSS check on the device, the same as the gateway's (gateway/internal/widget):
// card stylesheets drop declarations that would load anything. Keep the two
// in step.

const CSS_IMPORT = /@import|expression\s*\(|\\/i;
const CSS_LOADERS = /(?:^|[^\w-])(?:-webkit-)?(?:image-set|cross-fade|image|element|src)\s*\(/i;
const CSS_URL = /url\s*\(\s*['"]?\s*([^'")\s]*)/gi;

/** CSS that would load something other than an inline data: image. */
export function badCSS(css: string): boolean {
  if (CSS_IMPORT.test(css) || CSS_LOADERS.test(css)) return true;
  for (const m of css.matchAll(CSS_URL)) if (!m[1].toLowerCase().startsWith("data:image/")) return true;
  return false;
}
