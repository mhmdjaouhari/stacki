# Syncing the fork with upstream Stacki

This fork (`mhmdjaouhari/stacki`, remote `fork`) is cut down from `flowtricks/stacki`
(remote `upstream`) to what emdash-stacki deploys: Studio. The desktop app, every test,
the npm lockfiles, ESLint and the gate tooling are gone; pnpm, oxlint and TypeScript 7
replace them (README.md). emdash-stacki builds Studio from a pinned commit of `main`
(`STACKI_REF` in its `deploy/Dockerfile`).

Upstream still changes the files this fork deleted, so a merge conflicts on them, and
it brings back new tests and desktop code. `tools/prune.mts` cuts those again.

## Recipe

```sh
# 1. Work where main is checked out, with a clean tree.
git worktree list
git status --short

# 2. Merge.
git fetch upstream && git fetch fork
git rev-list --left-right --count main...fork/main    # 0 0, or pull first
git merge upstream/main

# 3. Resolve conflicts (see below), then cut again what upstream brought back.
node tools/prune.mts            # lists what would go
node tools/prune.mts --write    # git rm it

# 4. Install and check.
pnpm install                    # updates pnpm-lock.yaml if a package.json changed
pnpm check                      # Prettier, oxlint, TypeScript 7, the build: ~15 s

# 5. Commit, push, and pin.
git commit --no-edit
git push fork main
```

Then in emdash-stacki, set `STACKI_REF` in `deploy/Dockerfile` to the pushed commit and
update the version named in its `CLAUDE.md`. Wait for this repository's CI first if you
want a second run of the same checks before deploying.

## Conflicts

- **Stylesheets** (`src/**/*.css`, `studio/src/**/*.css`): always upstream's, even when the
  merge resolved them cleanly: `git checkout upstream/main -- <file>`. The fork never edits
  them. Its look lives beside them: `studio/scripts/forkCss.ts` makes colours themeable and
  raises monospace to 13px while Studio bundles (so upstream's new CSS is covered too),
  `studio/src/app/theme-light.css` holds the hand-written light values, and
  `studio/src/app/fork.css` the layout overrides (loaded after `studio.css`).
- **A deleted file Studio now vendors**: assemble stops with `ENOENT` on it. Restore it with
  `git checkout upstream/main -- <file>`; prune keeps every file the inventory vendors.
- **Modify/delete** (upstream changed a file the fork deleted: a test, desktop code, a
  gate script, `package-lock.json`): keep it deleted, `git rm <file>`. `tools/prune.mts`
  will also catch any that slipped through.
- **`package.json` (root)**: keep ours. Upstream's root manifest is the desktop app's.
  Only its `version` matters here: `assemble` writes it into Studio's release info, so
  take upstream's version number.
- **`studio/package.json`**: keep ours (pnpm scripts, `@typescript/native`, the dependencies
  pnpm showed were missing), then carry over upstream's dependency changes with
  `pnpm --filter @stacki/studio add <name>@<range>` and its version number by hand.
- **`studio/scripts/shared-source.json`**: take upstream's. It decides which root files
  Studio uses, so run `tools/prune.mts` after it is resolved.
- **Our own pull requests coming back**: upstream merges PRs from this fork, and the same
  lines then conflict with later fork work. If the fork's side already holds the change,
  `git checkout --ours <file>`; check `git diff $(git merge-base HEAD upstream/main) upstream/main -- <file>`
  first to confirm upstream changed nothing else in it.
- **Deleted or moved upstream modules** break fork files that did not conflict.
  `pnpm check types` finds them.
- **New dependencies imported from root sources**: pnpm installs strictly, so an import
  Studio does not declare fails `pnpm check types` with "Cannot find module". Add it to
  `studio/package.json`; under npm it resolved by accident from a hoisted package.
- **TypeScript 7 rejects something upstream wrote for 5.9**: fix it in the root file
  (one such fix so far: an explicit type argument in `src/editor/editorTree.ts`).

## Contributing a change upstream

Upstream keeps npm, ESLint and its test gate, so prepare a pull request in a separate
worktree of upstream and delete it afterwards:

```sh
git worktree add ../stacki-upstream -b fix/<name> upstream/main
cd ../stacki-upstream
npm ci && npm --prefix studio ci       # upstream's postinstall builds the desktop app
git cherry-pick <fork commits>          # or redo the change by hand
env -u ELECTRON_RUN_AS_NODE npm test    # upstream's full gate
git push fork fix/<name>                # open the PR from the fork's branch
cd - && git worktree remove --force ../stacki-upstream
```

Fork-only changes (tooling, `oxlint.config.ts`, deleted files) don't belong in such a
PR: cherry-pick the Studio or editor commits only.
