# Stacki Studio (emdash-stacki fork)

This is a fork of [flowtricks/stacki](https://github.com/flowtricks/stacki), cut down to what
[emdash-stacki](https://github.com/mhmdjaouhari/emdash-stacki) deploys: **Stacki Studio**, the
hosted visual builder for Astro. The desktop app, its tests and its release tooling are gone.
MIT licensed, like upstream.

## Layout

- `studio/` — Studio: the server, the browser app and collaboration. Its own
  `README.md` and `docs/` describe it.
- `src/`, `shared/`, `electron/` — the editor Studio is built on. Studio's
  `scripts/assemble.ts` copies these into `studio/vendor/stacki` (listed in
  `studio/scripts/shared-source.json`), swapping desktop modules for `studio/adapters`.
  The folder names are upstream's; nothing here runs in Electron any more.
- `tools/` — `check.mts` (every check) and `oxlint-plugin/` (the house lint rules).
- `docs/` — design notes for the editor; `docs/fork/upstream-sync.md` for merging upstream.

## Commands

```sh
pnpm install          # no build step runs on install
pnpm dev              # build Studio and run it against studio/dev-site
pnpm build            # build Studio (studio/dist)
pnpm check            # Prettier, oxlint (type-aware), TypeScript 7, the build
pnpm check lint       # one step: format | lint | types | build
pnpm format           # write Prettier's formatting
```

`pnpm install` sets `core.hooksPath` to `.githooks`: pre-commit checks the staged files,
pre-push runs `pnpm check`. CI (`.github/workflows/check.yml`) runs `pnpm check` too.

## Tooling notes

- **pnpm workspace**: the root (tooling) and `studio/`. One lockfile, `pnpm-lock.yaml`.
- **TypeScript**: Studio uses the TypeScript 5.9 compiler API at runtime (prop and schema
  parsing), so `typescript` stays 5.9. Type checking uses TypeScript 7 (`@typescript/native`),
  which has no API yet.
- **oxlint**: `oxlint.config.ts`. The root sources are linted through their Studio copies, and
  findings are reported against the root files.
