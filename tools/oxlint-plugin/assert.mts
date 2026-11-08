// The tooling's copy of shared/core/assert.ts, with the same contract. The policy
// tooling runs natively under Node's type stripping, and importing shared/ from
// there makes Node reparse a typeless-package .ts file as ESM with a warning on
// every run; shared/ stays compiled to CommonJS for the app. One meaning, two
// processes: programmer errors crash loudly (AGENTS.md §9).

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
