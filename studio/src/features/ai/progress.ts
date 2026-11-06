import { assert } from '../../../vendor/stacki/shared/core/assert';

// What the agent did on the way to a reply, step by step: "Rendered /",
// "Read src/components/Hero.astro", "Checked the proposal: 1 problem". The steps
// stream to the chat while a reply runs (aiRoutes.ts, as server-sent events) and
// come back with it, so a long reasoning run shows what it is doing and a reply
// shows how it was made.

export interface Step {
  readonly label: string;
  /** Milliseconds since the request started. */
  readonly atMs: number;
}
/** Records a step; the agent calls it as it works. */
export type Progress = (label: string) => void;

export const STEP_LIMITS = {
  stepsMax: 60,
  labelCharsMax: 200,
} as const satisfies Record<string, number>;

export const ignoreProgress: Progress = () => {};

/** A recorder for one request: `progress` records and forwards to `emit`, `steps` returns what was kept. */
export function stepRecorder(startedAtMs: number, emit: (step: Step) => void = () => {}) {
  assert(Number.isFinite(startedAtMs), 'steps: the start must be a time');
  const steps: Step[] = [];
  const progress: Progress = (label) => {
    const step = { label: label.replace(/\s+/g, ' ').trim().slice(0, STEP_LIMITS.labelCharsMax), atMs: Math.max(0, Date.now() - startedAtMs) };
    // Past the bound the steps keep streaming but aren't stored: the reply carries the first ones.
    if (steps.length < STEP_LIMITS.stepsMax) {
      steps.push(step);
    }
    emit(step);
  };
  return { progress, steps: (): readonly Step[] => [...steps] };
}

/** The step a check records: passed, sent back to fix, or kept with its problems. */
export function checkLabel(changes: number, problems: number, canFix: boolean): string {
  if (!changes) {
    return 'Answered without changes';
  }
  if (!problems) {
    return `Checked ${changes} changed file${changes === 1 ? '' : 's'}: no problems`;
  }
  const found = `${problems} problem${problems === 1 ? '' : 's'}`;
  return canFix ? `Checked the proposal: ${found}; asked the model to fix them` : `Checked the proposal: ${found} remain`;
}

/** A short list of files for a step label: "a.astro, b.astro and 3 more". */
export function fileList(files: readonly string[]): string {
  const names = files.map((file) => file.replace(/^src\//, ''));
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
}
