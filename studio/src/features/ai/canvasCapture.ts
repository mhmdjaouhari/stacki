import { useSyncExternalStore } from 'react';

// Before and after pictures of an applied change, taken in the person's own browser:
// the canvas exactly as they see it, with no browser on the server. The browser only
// lets a page capture itself through screen sharing (getDisplayMedia), which asks for
// permission and shows a "sharing this tab" bar, so it is opt-in: the person turns it
// on once per session, and the stream stays open until they stop it. Each picture is
// one frame of the shared tab, cropped to the canvas iframe and scaled down.
//
// Only a shared browser tab can be cropped to the canvas: a window or a screen is
// refused. Chrome offers this tab first (preferCurrentTab); other browsers show their
// own picker.

export const CAPTURE_LIMITS = {
  widthMax: 640,
  /** A JPEG data URL; larger pictures are dropped rather than stored with the chat. */
  urlCharsMax: 270_000,
  /** An attached image's bound (parseImages in chatContracts.ts). */
  modelUrlCharsMax: 180_000,
  settleMsMax: 5000,
  pollMs: 250,
} as const satisfies Record<string, number>;

interface Capture {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
}
let capture: Capture | undefined;
const listeners = new Set<() => void>();

/** Whether before/after pictures are on, for the toggle. */
export function useCanvasCapture(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => capture !== undefined,
  );
}

/** Asks to share this tab; must run from a click. Throws when sharing is refused or isn't a tab. */
export async function startCanvasCapture(): Promise<void> {
  if (capture) {
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('This browser cannot share a tab, so it cannot take before and after pictures.');
  }
  // TypeScript's DOM types don't list Chrome's preferCurrentTab yet; other browsers ignore it.
  const options: DisplayMediaStreamOptions & { readonly preferCurrentTab: boolean } = { video: { frameRate: 5 }, audio: false, preferCurrentTab: true };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const [track] = stream.getVideoTracks();
  if (!track || track.getSettings().displaySurface !== 'browser') {
    stream.getTracks().forEach((each) => each.stop());
    throw new Error('Share this tab, not a window or the screen, to take pictures of the canvas.');
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  // The browser's own "Stop sharing" ends the track; the toggle follows.
  track.addEventListener('ended', stopCanvasCapture, { once: true });
  capture = { stream, video };
  emit();
}

export function stopCanvasCapture(): void {
  capture?.stream.getTracks().forEach((track) => track.stop());
  capture = undefined;
  emit();
}

/** A JPEG of the canvas as it is now, or undefined when pictures are off or the canvas isn't shown. */
export function captureCanvas(): string | undefined {
  const frame = canvasFrame();
  if (!capture || !frame) {
    return undefined;
  }
  const url = drawCrop(capture.video, frame, CAPTURE_LIMITS.widthMax).toDataURL('image/jpeg', 0.8);
  return url.length <= CAPTURE_LIMITS.urlCharsMax ? url : undefined;
}

/**
 * A picture of the canvas for a vision model: as wide as 960, within the chat's limit for an attached
 * image (chatContracts.ts), smaller if it doesn't fit.
 */
export function captureCanvasForModel(): string | undefined {
  const frame = canvasFrame();
  if (!capture || !frame) {
    return undefined;
  }
  for (const [width, quality] of [
    [960, 0.75],
    [720, 0.7],
    [560, 0.6],
  ] as const) {
    const url = drawCrop(capture.video, frame, width).toDataURL('image/jpeg', quality);
    if (url.length <= CAPTURE_LIMITS.modelUrlCharsMax) {
      return url;
    }
  }
  return undefined;
}

/**
 * The canvas after a change: polls until the picture differs from `before` and holds still for one
 * more poll (the canvas morphs or reloads after an edit), or gives up after a few seconds with the
 * latest picture, since a change may not show at all.
 */
export async function captureAfterChange(before: string): Promise<string | undefined> {
  const frame = canvasFrame();
  if (!capture || !frame) {
    return undefined;
  }
  const baseline = signatureOf(before);
  let previous: Uint8ClampedArray | undefined;
  for (let waited = 0; waited < CAPTURE_LIMITS.settleMsMax; waited += CAPTURE_LIMITS.pollMs) {
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_LIMITS.pollMs));
    if (!capture) {
      return undefined;
    }
    const now = signature(drawCrop(capture.video, frame, 32));
    if (previous && distance(now, previous) < 2 && distance(now, await baseline) >= 2) {
      break;
    }
    previous = now;
  }
  return captureCanvas();
}

function emit() {
  listeners.forEach((listener) => listener());
}

function canvasFrame(): HTMLIFrameElement | undefined {
  return document.querySelector<HTMLIFrameElement>('iframe[title="Site preview"], iframe[title="Site preview (interactive)"]') ?? undefined;
}

// The frame's rectangle in the shared tab: its place in this document, plus the place of each
// enclosing frame up to the top (Studio runs inside the EmDash admin), as far as the frames are
// same-origin. The video is the top document at the tab's size, so it scales by the top's width.
function cropOf(frame: HTMLIFrameElement, video: HTMLVideoElement) {
  const rect = frame.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  let view: Window = window;
  for (let depth = 0; depth < 8 && view !== view.parent; depth++) {
    const outer = sameOriginFrame(view);
    if (!outer) {
      break;
    }
    const outerRect = outer.getBoundingClientRect();
    x += outerRect.left;
    y += outerRect.top;
    view = view.parent;
  }
  const scale = video.videoWidth / Math.max(1, view.innerWidth);
  return { x: x * scale, y: y * scale, width: rect.width * scale, height: rect.height * scale };
}

function sameOriginFrame(view: Window): Element | undefined {
  try {
    return view.frameElement ?? undefined;
  } catch {
    return undefined; // A cross-origin parent hides its frame element.
  }
}

function drawCrop(video: HTMLVideoElement, frame: HTMLIFrameElement, width: number): HTMLCanvasElement {
  const crop = cropOf(frame, video);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(Math.min(width, crop.width)));
  canvas.height = Math.max(1, Math.round((canvas.width * crop.height) / Math.max(1, crop.width)));
  canvas.getContext('2d')?.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// A 32-pixel-wide grey thumbnail: enough to tell a changed canvas from an unchanged one.
function signature(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const context = canvas.getContext('2d');
  const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? new Uint8ClampedArray();
  const grey = new Uint8ClampedArray(Math.floor(pixels.length / 4));
  for (let index = 0; index < grey.length; index++) {
    grey[index] = Math.round(((pixels[index * 4] ?? 0) + (pixels[index * 4 + 1] ?? 0) + (pixels[index * 4 + 2] ?? 0)) / 3);
  }
  return grey;
}

async function signatureOf(url: string): Promise<Uint8ClampedArray> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = Math.max(1, Math.round((32 * image.naturalHeight) / Math.max(1, image.naturalWidth)));
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return signature(canvas);
}

/** Mean absolute difference of two signatures, 0 to 255; different sizes count as different. */
function distance(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length || !a.length) {
    return 255;
  }
  let total = 0;
  for (let index = 0; index < a.length; index++) {
    total += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  }
  return total / a.length;
}
