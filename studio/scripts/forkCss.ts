// emdash-stacki's fork: the light theme and the 13px monospace floor, applied to Studio's
// stylesheets while the client is bundled, so the stylesheets themselves stay upstream's and
// merge without conflicts. Earlier syncs edited about 25 upstream files in place, and every
// upstream change to them conflicted; new upstream CSS also arrived unthemed.
//
// Three passes over each stylesheet Studio bundles from its own sources (not node_modules):
//
// 1. Theme: a hard-coded neutral colour becomes a variable whose fallback is that colour, so
//    dark mode is unchanged and only the light theme sets the variable. Dark surfaces become
//    --tone-<hex> (borders and outlines --line-<hex>), near-white text --ink-<hex>, and faint
//    white overlays rgba(var(--fg-rgb), a).
// 2. Pastel: a light saturated text colour becomes --pastel-<hex>, darkened for light mode.
// 3. Monospace: a rule that sets a monospace face below 13px is raised to 13px.
//
// Each generated variable's light value depends only on its dark colour, so each stylesheet
// gets its own `:root[data-theme='light']` block at its end, with nothing gathered across
// files. The hand-written light values (the named tokens, syntax colours) stay in
// src/app/theme-light.css, and src/app/theme.ts sets data-theme.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import postcss, { type ChildNode, type Container, type Declaration, type Rule } from 'postcss';

export interface ForkCssResult {
  readonly css: string;
  /** Declarations rewritten: colours made themeable, monospace sizes raised. */
  readonly changes: number;
}

const STUDIO_ROOT = path.resolve(import.meta.dirname, '..');
const STYLESHEET_ROOTS: readonly string[] = [path.join(STUDIO_ROOT, 'src') + path.sep, path.join(STUDIO_ROOT, 'vendor', 'stacki', 'src') + path.sep];
// Hand-written light values; the transform must not wrap the values it defines.
const LIGHT_THEME_FILE = path.join(STUDIO_ROOT, 'src', 'app', 'theme-light.css');

/** Bundles Studio's own stylesheets through transformForkCss. */
export const forkCss: Plugin = {
  name: 'fork-css',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      if (!isStudioStylesheet(args.path)) {
        return undefined;
      }
      const source = await readFile(args.path, 'utf8');
      return { contents: transformForkCss(source, args.path).css, loader: 'css' };
    });
  },
};

export function isStudioStylesheet(file: string): boolean {
  const resolved = path.resolve(file);
  if (resolved === LIGHT_THEME_FILE) {
    return false;
  }
  if (resolved.includes(`${path.sep}node_modules${path.sep}`)) {
    return false;
  }
  return STYLESHEET_ROOTS.some((root) => resolved.startsWith(root));
}

/** The three passes over one stylesheet, with the light values for the variables it now uses. */
export function transformForkCss(css: string, from: string): ForkCssResult {
  const root = postcss.parse(css, { from });
  const light = new Map<string, string>(); // Variable name → its light value.
  // Whether text sits on a coloured background is judged on the values as written, before
  // this pass rewrites a rule's background into a variable.
  const original = new Map<Declaration, string>();
  root.walkDecls((declaration) => {
    original.set(declaration, declaration.value);
  });
  let changes = 0;
  root.walkDecls((declaration) => {
    if (insideRoot(declaration)) {
      return;
    }
    const themed = themeValue(declaration, light, original);
    const pastel = pastelValue(declaration.prop, themed, light);
    if (pastel !== declaration.value) {
      declaration.value = pastel;
      changes += 1;
    }
  });
  root.walkRules((rule) => {
    changes += raiseMonospace(rule);
  });
  if (light.size > 0) {
    const block = postcss.rule({ selector: ":root[data-theme='light']" });
    for (const [name, value] of [...light.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      block.append(postcss.decl({ prop: name, value }));
    }
    root.append(block);
  }
  return { css: root.toString(), changes };
}

// ───────────────────────────── Theme ─────────────────────────────

const INK_PROPERTIES: ReadonlySet<string> = new Set(['color', 'fill', 'stroke', 'caret-color', '-webkit-text-fill-color']);
const PASTEL_PROPERTIES: ReadonlySet<string> = new Set([...INK_PROPERTIES, 'text-decoration-color']);
// A block whose background is one of these stays as it is: its light text is on a coloured
// surface in both themes.
const COLORED_BACKGROUND =
  /var\(--(?:accent|selection|red|green|orange|amber|color-selection-bg|color-class-tag-bg|color-tag-bg|color-success|color-danger|color-component-tag-bg-active|component-green|collection-purple)/i;
const HEX = /(?<![\w-])#[0-9a-fA-F]{3,8}\b/g;
const HEX_SHORT_OR_LONG = /(?<![\w-])#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const WHITE_OVERLAY = /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([0-9.]+)\s*\)/g;
const OVERLAY_ALPHA_MAX = 0.3;
const NEUTRAL_SPREAD_MAX = 8;
const SATURATED_SPREAD_MIN = 40;
const TONE_MIN = 0x0c;
const TONE_MAX = 0x50;
const INK_MIN = 0xd0;

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function themeValue(declaration: Declaration, light: Map<string, string>, original: ReadonlyMap<Declaration, string>): string {
  const overlaid = declaration.value.replace(WHITE_OVERLAY, (match, alpha: string) =>
    Number(alpha) > OVERLAY_ALPHA_MAX ? match : `rgba(var(--fg-rgb), ${alpha})`,
  );
  return overlaid.replace(HEX, (match) => {
    const colour = parseHex(match);
    if (colour === undefined) {
      return match;
    }
    if (colour.a !== 255) {
      return match;
    }
    if (spread(colour) > NEUTRAL_SPREAD_MAX) {
      return match;
    }
    const key = hexKey(colour);
    const brightest = Math.max(colour.r, colour.g, colour.b);
    const darkest = Math.min(colour.r, colour.g, colour.b);
    if (brightest >= TONE_MIN && brightest <= TONE_MAX) {
      if (/border|outline/i.test(declaration.prop)) {
        const level = 200 + pyRound(brightest * 0.3);
        light.set(`--line-${key}`, grey(level));
        return `var(--line-${key}, ${match})`;
      }
      const level = Math.min(255, 238 + pyRound((brightest - 12) * 0.32));
      light.set(`--tone-${key}`, grey(level));
      return `var(--tone-${key}, ${match})`;
    }
    if (darkest >= INK_MIN && INK_PROPERTIES.has(declaration.prop.toLowerCase())) {
      if (onColoredBackground(declaration, original)) {
        return match;
      }
      const level = pyRound(26 + (255 - darkest) * 1.2);
      light.set(`--ink-${key}`, grey(level));
      return `var(--ink-${key}, ${match})`;
    }
    return match;
  });
}

function onColoredBackground(declaration: Declaration, original: ReadonlyMap<Declaration, string>): boolean {
  const parent = declaration.parent;
  if (parent === undefined) {
    return false;
  }
  const backgrounds = siblingDeclarations(parent)
    .filter((sibling) => /^background/i.test(sibling.prop))
    .map((sibling) => original.get(sibling) ?? sibling.value);
  const colored = backgrounds.find((value) => COLORED_BACKGROUND.test(value) || /#[0-9a-fA-F]{6}/.test(value));
  if (colored === undefined) {
    return false;
  }
  const hex = /#([0-9a-fA-F]{6})/.exec(colored);
  if (hex !== null && !colored.includes('var(')) {
    const colour = parseHex(`#${hex[1] ?? ''}`);
    return colour !== undefined && spread(colour) > SATURATED_SPREAD_MIN;
  }
  return true;
}

// ───────────────────────────── Pastel ─────────────────────────────

const PASTEL_LUMINANCE_MIN = 0.3;
const PASTEL_LIGHTNESS = 0.36;
// Saturation scaled and capped, so the violets stay readable rather than turning near-black.
const PASTEL_SATURATION_SCALE = 0.85;
const PASTEL_SATURATION_MAX = 0.75;

function pastelValue(property: string, value: string, light: Map<string, string>): string {
  if (!PASTEL_PROPERTIES.has(property.toLowerCase())) {
    return value;
  }
  return value.replace(HEX_SHORT_OR_LONG, (match, digits: string) => {
    const colour = parseHex(`#${digits}`);
    if (colour === undefined) {
      return match;
    }
    if (spread(colour) <= SATURATED_SPREAD_MIN) {
      return match;
    }
    if (luminance(colour) < PASTEL_LUMINANCE_MIN) {
      return match;
    }
    const key = hexKey(colour);
    const [hue, , saturation] = rgbToHls(colour.r / 255, colour.g / 255, colour.b / 255);
    const [red, green, blue] = hlsToRgb(hue, PASTEL_LIGHTNESS, Math.min(PASTEL_SATURATION_MAX, saturation * PASTEL_SATURATION_SCALE));
    light.set(`--pastel-${key}`, `#${[red, green, blue].map((channel) => byteHex(pyRound(channel * 255))).join('')}`);
    return `var(--pastel-${key}, ${match})`;
  });
}

// ───────────────────────────── Monospace ─────────────────────────────

const MONOSPACE = /(var\(--(mono|font-family-mono|font-mono)\b|monospace|iosevka)/i;
const MONOSPACE_SIZE_PX_MIN = 13;
// The named sizes a monospace rule may use, in pixels.
const SIZE_VARIABLES: ReadonlyMap<string, number> = new Map([
  ['--font-size-2xs', 10],
  ['--font-size-xs', 11],
  ['--font-size-sm', 12],
]);
// Monospace by inheritance, so the rule itself names no face.
const MONOSPACE_SELECTORS: ReadonlySet<string> = new Set(['.bind-input .expr-chip']);

function raiseMonospace(rule: Rule): number {
  const declarations = siblingDeclarations(rule);
  const family = declarations.find((declaration) => declaration.prop === 'font-family');
  const shorthand = declarations.find((declaration) => declaration.prop === 'font');
  const named = MONOSPACE_SELECTORS.has(rule.selector.trim());
  const monospace = named || MONOSPACE.test(family?.value ?? '') || MONOSPACE.test(shorthand?.value ?? '');
  if (!monospace) {
    return 0;
  }
  let changes = 0;
  const size = declarations.find((declaration) => declaration.prop === 'font-size');
  if (size !== undefined) {
    const pixels = sizePixels(size.value);
    if (pixels !== undefined && pixels < MONOSPACE_SIZE_PX_MIN) {
      size.value = `${MONOSPACE_SIZE_PX_MIN}px`;
      changes += 1;
    }
  }
  if (shorthand !== undefined) {
    const sized = /^\s*((?:[a-z-]+\s+)*)([0-9.]+)px/.exec(shorthand.value);
    const pixels = sized?.[2];
    if (pixels !== undefined && Number(pixels) < MONOSPACE_SIZE_PX_MIN) {
      shorthand.value = shorthand.value.replace(`${pixels}px`, `${MONOSPACE_SIZE_PX_MIN}px`);
      changes += 1;
    }
  }
  return changes;
}

function sizePixels(value: string): number | undefined {
  const pixels = /^\s*([0-9.]+)px/.exec(value);
  if (pixels?.[1] !== undefined) {
    return Number(pixels[1]);
  }
  const variable = /^\s*var\((--font-size-[a-z0-9]+)/.exec(value);
  return variable?.[1] === undefined ? undefined : SIZE_VARIABLES.get(variable[1]);
}

// ───────────────────────────── Helpers ─────────────────────────────

// The declarations directly in a rule or at-rule, not in rules nested inside it.
function siblingDeclarations(container: Container<ChildNode>): readonly Declaration[] {
  return (container.nodes ?? []).filter((node): node is Declaration => node.type === 'decl');
}

// Custom properties and colours set on :root are the theme's own values; they stay.
function insideRoot(declaration: Declaration): boolean {
  const parent = declaration.parent;
  if (parent?.type !== 'rule') {
    return false;
  }
  return 'selector' in parent && typeof parent.selector === 'string' && parent.selector.trim().startsWith(':root');
}

function parseHex(text: string): Rgba | undefined {
  let digits = text.slice(1);
  if (digits.length === 3 || digits.length === 4) {
    digits = [...digits].map((digit) => digit + digit).join('');
  }
  if (digits.length !== 6 && digits.length !== 8) {
    return undefined;
  }
  const byte = (at: number) => Number.parseInt(digits.slice(at, at + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) : 255 };
}

function spread(colour: Rgba): number {
  return Math.max(colour.r, colour.g, colour.b) - Math.min(colour.r, colour.g, colour.b);
}

function hexKey(colour: Rgba): string {
  return [colour.r, colour.g, colour.b].map(byteHex).join('');
}

function byteHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function grey(level: number): string {
  return `#${byteHex(level).repeat(3)}`;
}

// WCAG relative luminance.
function luminance(colour: Rgba): number {
  const channel = (value: number) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

// Python's round(): halves go to the even neighbour. The values the earlier scripts wrote
// were rounded this way, and the light theme keeps them.
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) {
    return floor + 1;
  }
  if (fraction < 0.5) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

// Python's colorsys.rgb_to_hls and hls_to_rgb, as the earlier pastel script used them.
function rgbToHls(red: number, green: number, blue: number): readonly [number, number, number] {
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const lightness = (low + high) / 2;
  if (high === low) {
    return [0, lightness, 0];
  }
  const range = high - low;
  const saturation = lightness <= 0.5 ? range / (high + low) : range / (2 - high - low);
  const redPart = (high - red) / range;
  const greenPart = (high - green) / range;
  const bluePart = (high - blue) / range;
  let hue: number;
  if (red === high) {
    hue = bluePart - greenPart;
  } else if (green === high) {
    hue = 2 + redPart - bluePart;
  } else {
    hue = 4 + greenPart - redPart;
  }
  hue = (((hue / 6) % 1) + 1) % 1;
  return [hue, lightness, saturation];
}

function hlsToRgb(hue: number, lightness: number, saturation: number): readonly [number, number, number] {
  if (saturation === 0) {
    return [lightness, lightness, lightness];
  }
  const high = lightness <= 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const low = 2 * lightness - high;
  return [hueChannel(low, high, hue + 1 / 3), hueChannel(low, high, hue), hueChannel(low, high, hue - 1 / 3)];
}

function hueChannel(low: number, high: number, input: number): number {
  const hue = ((input % 1) + 1) % 1;
  if (hue < 1 / 6) {
    return low + (high - low) * hue * 6;
  }
  if (hue < 0.5) {
    return high;
  }
  if (hue < 2 / 3) {
    return low + (high - low) * (2 / 3 - hue) * 6;
  }
  return low;
}
