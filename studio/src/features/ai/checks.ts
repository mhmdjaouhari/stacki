import { transform } from '@astrojs/compiler';
import postcss from 'postcss';
import ts from 'typescript';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { MAX_SOURCE } from '../../shared/validation';
import type { ProposedChange } from './proposalSources';

// Checks a proposal's files before the person sees it. Applying already refuses
// markup that doesn't parse; this goes further and compiles each candidate the
// way the dev server will (`.astro` through the Astro compiler's transform, its
// frontmatter and every script file through TypeScript's syntax check, JSON and
// CSS through their parsers), so a proposal that would break the page comes back
// to the model with the diagnostics instead of reaching the canvas.
//
// Only syntax is checked: types and imports need the whole project, and a
// type error doesn't stop Astro from rendering.

export interface Problem {
  readonly file: string;
  /** 1-based line in the candidate source, when the diagnostic has one. */
  readonly line?: number;
  readonly message: string;
}

export const CHECK_LIMITS = {
  problemsMax: 20,
  messageCharsMax: 300,
} as const satisfies Record<string, number>;

/** The problems a set of candidate sources has, at most `problemsMax`. */
export async function checkSources(candidates: readonly { readonly file: string; readonly source: string }[]): Promise<readonly Problem[]> {
  const problems: Problem[] = [];
  for (const candidate of candidates) {
    if (problems.length >= CHECK_LIMITS.problemsMax) {
      break;
    }
    problems.push(...(await sourceProblems(candidate.file, candidate.source)));
  }
  return problems.slice(0, CHECK_LIMITS.problemsMax).map((problem) => ({ ...problem, message: problem.message.slice(0, CHECK_LIMITS.messageCharsMax) }));
}

/** The file's source with the change applied; throws when the change's `before` isn't exactly once in it. */
export function appliedSource(current: string | undefined, change: ProposedChange): string {
  const before = current ?? '';
  if (!change.before) {
    if (before) {
      throw new Error('An existing file cannot be overwritten as a new file');
    }
    return change.after;
  }
  const at = before.indexOf(change.before);
  if (at === -1 || at !== before.lastIndexOf(change.before)) {
    throw new Error('AI change is stale or ambiguous. Ask it to regenerate.');
  }
  const after = before.slice(0, at) + change.after + before.slice(at + change.before.length);
  assert(after.length === before.length - change.before.length + change.after.length, 'applied source: length mismatch');
  return after;
}

async function sourceProblems(file: string, source: string): Promise<Problem[]> {
  if (source.length > MAX_SOURCE) {
    return [{ file, message: 'The file would be larger than 1 MB.' }];
  }
  if (file.endsWith('.astro')) {
    return astroProblems(file, source);
  }
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    return scriptProblems(file, source, 0);
  }
  if (file.endsWith('.json')) {
    return jsonProblems(file, source);
  }
  if (file.endsWith('.css')) {
    return cssProblems(file, source);
  }
  return [];
}

async function astroProblems(file: string, source: string): Promise<Problem[]> {
  const result = await transform(source, { filename: file });
  const problems: Problem[] = result.diagnostics
    .filter((diagnostic) => diagnostic.severity === 1)
    .map((diagnostic) => ({ file, line: diagnostic.location.line, message: diagnostic.text }));
  if (problems.length) {
    return problems;
  }
  // The compiler passes the frontmatter and template expressions through as written; TypeScript reads
  // their syntax. The frontmatter is checked on its own for its lines, then the compiled module for the
  // expressions, whose lines are the compiled module's and so aren't reported.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  const head = frontmatter === undefined ? [] : scriptProblems(file, frontmatter, 1);
  if (head.length) {
    return head;
  }
  return scriptProblems(file, result.code, 0).map(({ file: name, message }) => ({ file: name, message: `In the template: ${message}` }));
}

// `lineOffset` places a fragment's lines in its file: the frontmatter starts after the opening fence.
function scriptProblems(file: string, source: string, lineOffset: number): Problem[] {
  const output = ts.transpileModule(source, {
    fileName: /\.[cm]?[jt]sx?$/.test(file) ? file : `${file}.ts`,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
  });
  return (output.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const line =
        diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 + lineOffset : undefined;
      return { file, ...(line === undefined ? {} : { line }), message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') };
    });
}

function jsonProblems(file: string, source: string): Problem[] {
  try {
    JSON.parse(source);
    return [];
  } catch (error) {
    return [{ file, message: error instanceof Error ? error.message : 'Invalid JSON' }];
  }
}

function cssProblems(file: string, source: string): Problem[] {
  try {
    postcss.parse(source);
    return [];
  } catch (error) {
    const line = error instanceof postcss.CssSyntaxError ? error.line : undefined;
    const message = error instanceof postcss.CssSyntaxError ? error.reason : 'Invalid CSS';
    return [{ file, ...(line === undefined ? {} : { line }), message }];
  }
}
