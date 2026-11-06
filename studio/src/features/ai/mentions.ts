// `@` in the composer attaches a project file: typing `@hero` offers the files whose
// path matches, and choosing one writes `@src/components/Hero.astro` into the prompt.
// The server reads mentioned files into the request (agent.ts), so the model starts
// with them instead of asking. These helpers are pure; the composer owns the state.

export const MENTION_LIMITS = {
  optionsMax: 8,
  queryCharsMax: 80,
} as const satisfies Record<string, number>;

export interface MentionQuery {
  /** Index of the `@` in the draft. */
  readonly start: number;
  readonly text: string;
}

/** The mention being typed at the caret: an `@` at the start or after a space, then a path-like word. */
export function mentionQuery(draft: string, caret: number): MentionQuery | undefined {
  const before = draft.slice(0, caret);
  const match = /(?:^|\s)@([\w./[\]-]*)$/.exec(before);
  if (!match || (match[1] ?? '').length > MENTION_LIMITS.queryCharsMax) {
    return undefined;
  }
  const text = match[1] ?? '';
  return { start: caret - text.length - 1, text };
}

/** The files that match: names starting with the text first, then paths containing it. */
export function mentionOptions(files: readonly string[], text: string): readonly string[] {
  const needle = text.toLowerCase();
  const name = (file: string) => (file.split('/').pop() ?? file).toLowerCase();
  const starts = files.filter((file) => name(file).startsWith(needle));
  const contains = files.filter((file) => !name(file).startsWith(needle) && file.toLowerCase().includes(needle));
  return [...starts, ...contains].slice(0, MENTION_LIMITS.optionsMax);
}

/** The draft with the query replaced by `@file `, and where the caret goes after it. */
export function insertMention(draft: string, query: MentionQuery, file: string): { readonly draft: string; readonly caret: number } {
  const end = query.start + 1 + query.text.length;
  const inserted = `@${file} `;
  return { draft: draft.slice(0, query.start) + inserted + draft.slice(end).replace(/^ /, ''), caret: query.start + inserted.length };
}
