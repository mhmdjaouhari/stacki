@AGENTS.md

## Gates

- Before you finish, run `npm run check:changed`. It is the same check the stop hook runs.
- The full gate is `env -u ELECTRON_RUN_AS_NODE npm test`; CI runs it on every pull request.
- While iterating, `env -u ELECTRON_RUN_AS_NODE npm test -- <suite>` runs only the named suites:
  incremental builds, no clean, no whole-tree checks. It never replaces the full gate.
- `docs/enforcement.md` maps every AGENTS.md rule to the check that holds it.

## Fork

This is the fork `mhmdjaouhari/stacki`. To merge upstream (`origin`, `flowtricks/stacki`) into `main`,
follow `docs/fork/upstream-sync.md`: it says which checks a sync needs and which it can skip.
