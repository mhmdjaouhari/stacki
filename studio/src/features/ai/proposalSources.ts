import { parse } from '@astrojs/compiler';
import { string, MAX_SOURCE } from '../../shared/validation';
import { readSource } from '../project/projectServer';
import { appliedSource, checkSources, CHECK_LIMITS, type Problem } from './checks';

// Reading the files a proposal touches, and what they become with it applied.

export interface ProposedChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

/** The file's source, or undefined when it doesn't exist. */
export async function optionalSource(root: string, file: string): Promise<string | undefined> {
  try {
    return await readSource(root, file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function proposedSource(root: string, change: ProposedChange): Promise<string> {
  const current = await optionalSource(root, change.file);
  if (current === undefined && !(change.before === '' && creatable(change.file))) {
    throw new Error('File does not exist');
  }
  const after = appliedSource(current, change);
  await validatedSource(change.file, after);
  return after;
}

export function creatable(file: string): boolean {
  return file.startsWith('src/') || ['.stacki/components.json', '.stacki/guide.json'].includes(file);
}

/** Throws when `source` is too large or isn't valid Astro or JSON for its file. */
export async function validatedSource(file: string, source: string): Promise<void> {
  string(source, MAX_SOURCE);
  if (file.endsWith('.astro')) {
    const result = await parse(source);
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === 1)) {
      throw new Error('AI generated invalid Astro markup');
    }
  }
  if (file.endsWith('.json')) {
    JSON.parse(source);
  }
}

/** Everything wrong with a proposal before it reaches the person: changes that can't apply, and files that won't compile. */
export async function checkProposal(root: string, changes: readonly ProposedChange[]): Promise<readonly Problem[]> {
  const problems: Problem[] = [];
  const candidates: { file: string; source: string }[] = [];
  for (const change of changes) {
    try {
      const current = await optionalSource(root, change.file);
      if (current === undefined && !(change.before === '' && creatable(change.file))) {
        throw new Error('File does not exist');
      }
      candidates.push({ file: change.file, source: appliedSource(current, change) });
    } catch (error) {
      problems.push({ file: change.file, message: error instanceof Error ? error.message : 'The change cannot be applied' });
    }
  }
  return [...problems, ...(await checkSources(candidates))].slice(0, CHECK_LIMITS.problemsMax);
}
