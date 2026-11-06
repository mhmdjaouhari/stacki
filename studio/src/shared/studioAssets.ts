// The files of Studio's own build that its server hands out under /studio/.
const STUDIO_FILES = new Set(['index.html', 'studio.js', 'studio.css', 'preview.js', 'morph.js']);
/** The UI fonts the build emits beside studio.css (scripts/build.ts). */
const STUDIO_FONT = /^fonts\/[\w-]+\.woff2?$/;

/** Whether `name`, a path relative to the build directory, is one of Studio's UI fonts. */
export function isStudioFont(name: string): boolean {
  return STUDIO_FONT.test(name);
}

/** Whether `name`, a path relative to the build directory, is a file Studio serves. */
export function isStudioAsset(name: string): boolean {
  return STUDIO_FILES.has(name) || isStudioFont(name);
}
