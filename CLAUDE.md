@AGENTS.md

## This fork

`mhmdjaouhari/stacki` (remote `fork`), cut down to Stacki Studio for emdash-stacki: no
desktop app, no tests, pnpm instead of npm, oxlint instead of ESLint, TypeScript 7 for
checking. `README.md` has the layout and commands. Upstream is `flowtricks/stacki`
(remote `origin`); `docs/fork/upstream-sync.md` covers merging it in, and contributing back.

## Checks

- `pnpm check` runs everything (Prettier, oxlint type-aware, TypeScript 7, the Studio
  build) in about 15 seconds. Run it before you say you are done. `pnpm check lint` (or
  `format`, `types`, `build`) runs one step.
- Root sources (`src/`, `shared/`, `electron/`) are checked through their copies in
  `studio/vendor/stacki`; findings name the root file. Fix the root file, never the copy.
- Studio needs the TypeScript 5.9 API at runtime, so `typescript` stays 5.9;
  `@typescript/native` (TypeScript 7) is for checking only.
- To see a change work, run `pnpm dev` and use Studio against `studio/dev-site`.
