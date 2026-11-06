# Syncing the fork with upstream Stacki

This fork (`mhmdjaouhari/stacki`, remote `fork`) carries the AI chat work on top of
`flowtricks/stacki` (remote `origin`). Its `main` is upstream's `main` plus our merged
branches, and emdash-stacki deploys Studio from it (`STACKI_REF` in that repo's
`deploy/Dockerfile`). A sync merges `origin/main` into `main`.

The repository's gates are written for changing the desktop app, and run as-is they make a
sync slow: the 1.0.15 sync spent about 25 minutes in them. Most of that was checking
upstream's own files again, or work that CI repeats. The recipe below takes a few minutes
and still catches what a merge can break.

## Recipe

```sh
# 1. Find the worktree that has main checked out (it is often not this one).
git worktree list
cd <that worktree>
git status --short             # must be clean: someone else may be working here

# 2. Merge.
git fetch origin && git fetch fork
git rev-list --left-right --count main...fork/main    # 0 0, or pull first
git merge origin/main

# 3. Resolve conflicts (see "Conflicts" below), then `git add` them.

# 4. Only if the merge changed a lockfile or a package.json:
npm install --no-save --no-audit --no-fund              # root; --no-save: see "Lockfiles"
npm --prefix studio install --no-save --no-audit --no-fund

# 5. Rebuild dist/ if upstream added or moved files under shared/, electron/ or scripts/.
#    Tests import #dist/..., and type-aware ESLint fails on a stale dist/ with
#    "type that cannot be resolved" errors that are not real.
npm run build:runtime                                   # about 40 s

# 6. Check what the fork ships. Studio is all that emdash-stacki deploys.
node scripts/policy/studioChecks.mts --check            # tsc, ESLint, Prettier; cached
npm --prefix studio test                                # Studio's own suites, about 2.5 min
env -u ELECTRON_RUN_AS_NODE npm test -- mainBoundaries sanityStructure studioLocal studioSetup \
  styleFiles panelBoundary clipPathPaste codeBlock codeDisplayRule cleanInstall lockfileClosure
#   The root suites that read Studio's source. Upstream adds repository-wide rules
#   (1.0.15's code display rule) that the fork's Studio code must meet.

# 7. Commit. The pre-commit hook checks only the files the merge created.
git commit --no-edit

# 8. Push, skipping the local full gate (the user approves this per sync).
git push --no-verify fork main
```

Then, in emdash-stacki, set `STACKI_REF` in `deploy/Dockerfile` to the pushed commit and
update the version named in its `CLAUDE.md`. Until then, deployment still builds the old commit.

## What runs, and why the rest is skipped

| Step | Cold | Warm | In the recipe |
| --- | --- | --- | --- |
| Full gate, `npm test` (also the pre-push hook) | 18.7 min | — | No: CI (`.github/workflows/check.yml`) runs it on every push, cold |
| Root `npm ci` (the postinstall builds dist/) | 162 s | — | No: `npm install --no-save` only when packages changed |
| npm's own resolution | 2 s | 2 s | — |
| Studio checks (tsc, ESLint, Prettier) | 96 s | 11 s | Yes |
| Root suites that read Studio's source (step 6) | 35 s | — | Yes |
| Root ESLint over the whole tree, alone | 112 s | 1 s | No (the gate's; cached since this guide) |
| Pre-commit on the 1.0.15 merge, before the merge rule | ~3.5 min | — | — |
| `check:changed` on a small branch | 75 s | 24 s | — |

- **The full gate** builds and runs all 551 suites of the desktop app. Locally it repeats CI.
  Push with `--no-verify` and read the CI result. Upstream suites can fail here for
  machine reasons: in the 1.0.15 sync, `propertyFormLayout` (a chip 2 px off, from font
  rounding) and `revealScrollsDown` (timing, passes alone) failed without the merge being
  the cause.
- **pnpm** would save about a second. npm's own work is 2 s of an install; the rest is the
  postinstall build. Upstream's lockfiles are npm's, every release rewrites them, and the
  Dockerfile builds Studio with `npm ci`. Switching would conflict on every sync.
- **Caches.** The pre-commit hook, `check:changed`, the Studio checks and the gate share
  caches under `node_modules/.cache` (root) and `studio/node_modules/.cache/studio-checks`.
  They key on file content, and tsc's on dependencies too. A suspected stale result goes
  away with `rm -rf node_modules/.cache studio/node_modules/.cache`.

## Conflicts

- **Our own pull requests coming back.** Upstream merges our PRs, and the same lines
  then conflict with later fork work on top of them. In 1.0.15, PR #74 (chat React keys)
  conflicted in `ChatPanel.tsx`, `ChatMessages.tsx` and `studio/test/ai.browser.ts`: the
  fork's side already held the change, so `git checkout --ours` was right. Diff
  `git merge-base HEAD origin/main..origin/main` for the file first to confirm that
  upstream changed nothing else in it.
- **Deleted or moved upstream modules** break fork files that did not conflict: 1.0.15
  replaced `src/features/git/Code.tsx` with `src/ui/CodeBlock.tsx` and
  `src/ui/codeHighlight.ts`, and the fork's `MergeDiff.tsx` imported from the old file.
  The Studio type check in step 6 is what finds these.
- **New repository rules.** Upstream adds suites that scan both apps' source. The root
  suites in step 6 are the ones that read `studio/`; a new one is found with
  `grep -rl "studio/src" test`.

## Lockfiles

npm 11 rewrites `peer` flags in upstream's lockfiles on a plain `npm install`, which leaves
unrelated lockfile changes in the merge. `--no-save` installs without writing them. If
they appear anyway, `git checkout -- package-lock.json studio/package-lock.json` is safe
unless the fork itself changed dependencies.
