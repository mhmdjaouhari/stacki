import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../../../vendor/stacki/shared/core/assert';

// Pictures of a page: for a vision model that asks how a page looks (the
// `screenshot` tool), and before and after thumbnails of an applied change for
// the person. Studio's server has no browser of its own, and drawing the canvas
// in the person's browser can't reproduce stylesheets and images faithfully
// without a large library, so a Chrome or Chromium binary configured on the
// server (AI_SCREENSHOT_BROWSER) takes the picture with its own headless mode:
// one process per shot, about two seconds, no new dependency. Without one, there
// are no screenshots and nothing else changes.

export type ShotSize = 'model' | 'thumbnail';

export const SCREENSHOT_LIMITS = {
  timeoutMs: 20_000,
  concurrentMax: 2,
  /** PNG bytes; a larger picture is refused rather than sent. */
  modelBytesMax: 700_000,
  thumbnailBytesMax: 200_000,
} as const satisfies Record<string, number>;

// A 1280×800 viewport, scaled down: 960×600 for a model, 640×400 for a thumbnail.
const SIZES: Readonly<Record<ShotSize, { readonly scale: number; readonly bytesMax: number }>> = {
  model: { scale: 0.75, bytesMax: SCREENSHOT_LIMITS.modelBytesMax },
  thumbnail: { scale: 0.5, bytesMax: SCREENSHOT_LIMITS.thumbnailBytesMax },
};

/** The configured browser binary, or undefined when screenshots are off or it doesn't exist. */
export function screenshotBrowser(value: string | undefined = process.env['AI_SCREENSHOT_BROWSER']): string | undefined {
  const browser = value?.trim();
  if (!browser) {
    return undefined;
  }
  if (!path.isAbsolute(browser) || !existsSync(browser)) {
    throw new Error('AI_SCREENSHOT_BROWSER must be the absolute path of a Chrome or Chromium binary');
  }
  return browser;
}

let running = 0;

/** A PNG of `url` as a data URL. */
export async function captureScreenshot(browser: string, url: string, size: ShotSize): Promise<string> {
  assert(/^http:\/\/127\.0\.0\.1:\d+\//.test(url), 'screenshot: only the local dev server is captured');
  if (running >= SCREENSHOT_LIMITS.concurrentMax) {
    throw new Error('Two screenshots are already being taken. Try again shortly.');
  }
  running++;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'studio-shot-'));
  try {
    const file = path.join(directory, 'shot.png');
    await run(browser, chromeArguments(directory, file, url, SIZES[size].scale));
    const png = await readFile(file);
    if (png.length > SIZES[size].bytesMax) {
      throw new Error('The screenshot is too large to send');
    }
    return `data:image/png;base64,${png.toString('base64')}`;
  } finally {
    running--;
    await rm(directory, { recursive: true, force: true });
  }
}

export function chromeArguments(directory: string, file: string, url: string, scale: number): readonly string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    // Chrome refuses to run as root with its sandbox, which is how containers usually run it.
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    `--user-data-dir=${path.join(directory, 'profile')}`,
    '--window-size=1280,800',
    `--force-device-scale-factor=${scale}`,
    `--screenshot=${file}`,
    url,
  ];
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('The screenshot took too long'));
    }, SCREENSHOT_LIMITS.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`The browser could not take the screenshot (exit ${String(code)})`));
      }
    });
  });
}
