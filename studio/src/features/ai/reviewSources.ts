import { record, sourcePath, string, MAX_SOURCE } from '../../shared/validation';
import { request } from '../project/projectClient';
import type { ReversibleChange } from './reversible';

// The whole files the review compares. The chat keeps only capped hunks, so the
// review asks the server for both sides of one file when it is opened: from the
// live proposal while it exists, and from the current file and its undo record
// once it is applied (proposalStore.ts).

export interface ReviewSources {
  readonly file: string;
  /** Undefined when the change creates the file. */
  readonly previous: string | undefined;
  readonly next: string;
}

/** Where a reviewed change's files come from. */
export type ReviewOrigin =
  | { readonly kind: 'proposal'; readonly id: string }
  | { readonly kind: 'applied'; readonly changes: readonly ReversibleChange[]; readonly state: 'applied' | 'undone' };

export async function loadReviewSources(origin: ReviewOrigin, file: string, signal: AbortSignal): Promise<ReviewSources> {
  switch (origin.kind) {
    case 'proposal':
      return parseReviewSources(
        await request(`/studio/api/ai/proposals/${encodeURIComponent(origin.id)}/files?file=${encodeURIComponent(file)}`, { signal }),
        file,
      );
    case 'applied': {
      const change = origin.changes.find((candidate) => candidate.file === file);
      if (!change) {
        throw new Error('This file has no undo record, so only its changed lines can be shown.');
      }
      const body = JSON.stringify({ change, state: origin.state });
      return parseReviewSources(
        await request('/studio/api/ai/changes/file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
        file,
      );
    }
  }
}

export function parseReviewSources(value: unknown, file: string): ReviewSources {
  const input = record(value);
  if (sourcePath(input['file']) !== file) {
    throw new Error('The server sent another file');
  }
  const previous = input['previous'];
  return {
    file,
    previous: previous === null ? undefined : string(previous, MAX_SOURCE),
    next: string(input['next'], MAX_SOURCE),
  };
}
