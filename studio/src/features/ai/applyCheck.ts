import { assert } from '../../../vendor/stacki/shared/core/assert';
import { pageOutline } from './aiContext';
import { fileDiff } from './lineDiff';

// Apply and check: after an AI change is written to the draft, the pages it can
// affect are rendered again, and a page that rendered before but fails now means
// the change broke it, so it is undone straight away and the error goes back to
// the chat. The syntax check before proposing (checks.ts) can't see this: a
// missing prop, a wrong import or a runtime error only shows when the page renders.
//
// The change is briefly on the shared draft, so a collaborator can see it for
// the second or two the check takes; that is why it runs only when the person
// presses Apply, never while the model is still proposing. Pages that already
// failed before the change are reported but don't count against it.

export const APPLY_CHECK_LIMITS = {
  pagesMax: 5,
  errorCharsMax: 600,
  renderedLinesMax: 60,
} as const satisfies Record<string, number>;

/** A page's render: status and HTML, as the dev server answered. */
export interface PageResponse {
  readonly status: number;
  readonly html: string;
  /** The error behind a failed render, when the server knows it (devErrors.ts). */
  readonly error?: string;
}
export type PageRender = { readonly kind: 'ok'; readonly outline: string } | { readonly kind: 'failed'; readonly error: string };
export interface BrokenPage {
  readonly path: string;
  readonly error: string;
}
/** How a page's rendered text changed: counts and a few changed lines. */
export interface RenderedChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly string[];
}

/** The pages to check: the one on the canvas, then each changed page file with a fixed route. */
export function affectedPages(files: readonly string[], canvas: string | undefined): readonly string[] {
  const routes = files.flatMap((file) => {
    const route = pageRoute(file);
    return route ? [route] : [];
  });
  return [...new Set([...(canvas ? [canvas] : []), ...routes])].slice(0, APPLY_CHECK_LIMITS.pagesMax);
}

/** Renders each page, never throwing: a failed request is a failed render. */
export async function renderPages(paths: readonly string[], fetchPage: (path: string) => Promise<PageResponse>): Promise<ReadonlyMap<string, PageRender>> {
  assert(paths.length <= APPLY_CHECK_LIMITS.pagesMax, 'apply check: too many pages');
  const entries = await Promise.all(
    paths.map(async (path): Promise<[string, PageRender]> => {
      try {
        return [path, pageRender(await fetchPage(path))];
      } catch (error) {
        return [path, { kind: 'failed', error: clip(error instanceof Error ? error.message : 'The page could not be rendered') }];
      }
    }),
  );
  return new Map(entries);
}

/** Pages that rendered before the change and fail after it. */
export function brokenPages(before: ReadonlyMap<string, PageRender>, after: ReadonlyMap<string, PageRender>): readonly BrokenPage[] {
  const broken: BrokenPage[] = [];
  for (const [path, render] of after) {
    if (render.kind === 'failed' && before.get(path)?.kind === 'ok') {
      broken.push({ path, error: render.error });
    }
  }
  return broken;
}

/** The rendered text each page gained and lost: the evidence that the change did what it says. */
export function renderedChanges(before: ReadonlyMap<string, PageRender>, after: ReadonlyMap<string, PageRender>): readonly RenderedChange[] {
  const changes: RenderedChange[] = [];
  for (const [path, render] of after) {
    const previous = before.get(path);
    if (render.kind !== 'ok' || previous?.kind !== 'ok' || previous.outline === render.outline) {
      continue;
    }
    // Outlines are text, not files; the line diff only needs a name for its record.
    const diff = fileDiff({ file: 'src/rendered.txt', previous: `${previous.outline}\n`, next: `${render.outline}\n` }, APPLY_CHECK_LIMITS.renderedLinesMax);
    const lines = diff.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.startsWith('+') || line.startsWith('-')));
    changes.push({ path, added: diff.added, removed: diff.removed, lines: lines.map((line) => `${line.charAt(0)}${line.slice(1).trim()}`) });
  }
  return changes;
}

// A render fails on a server error, or on Astro's error page in development, which some
// errors answer with a success status.
function pageRender(response: PageResponse): PageRender {
  const overlay = /<vite-error-overlay|id="astro-error"|class="astro-error/i.test(response.html);
  if (response.status >= 500 || overlay) {
    return { kind: 'failed', error: errorText(response) };
  }
  return { kind: 'ok', outline: pageOutline(response.html) };
}

// The error page's own words: its title and first lines, without markup.
function errorText(response: PageResponse): string {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(response.html)?.[1]?.trim();
  const body = pageOutline(response.html)
    .split('\n')
    .map((line) => line.replace(/^\s*\w+(?: \([^)]*\))?: /, '').trim())
    .filter((line) => line && line !== title)
    .slice(0, 6)
    .join(' · ');
  return clip([`Status ${response.status}`, title, response.error ?? body].filter(Boolean).join(': '));
}

function pageRoute(file: string): string | undefined {
  const match = /^src\/pages\/(.+)\.(astro|md|mdx)$/.exec(file);
  if (!match?.[1] || match[1].includes('[')) {
    return undefined;
  }
  const route = match[1].replace(/(^|\/)index$/, '');
  return `/${route}`;
}

function clip(text: string): string {
  return text.length > APPLY_CHECK_LIMITS.errorCharsMax ? `${text.slice(0, APPLY_CHECK_LIMITS.errorCharsMax)}…` : text;
}
