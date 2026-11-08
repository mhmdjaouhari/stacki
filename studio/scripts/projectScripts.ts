// Installed projects build their pinned source; repository-only test fixtures
// and release tooling stay in the canonical development checkout.
export const projectScripts = {
  assemble: 'tsx scripts/assemble.ts',
  prebuild: 'npm run assemble',
  build: 'tsx scripts/build.ts',
  precheck: 'npm run assemble',
  check: 'tsc -p tsconfig.app.json && tsc -p tsconfig.worker.json',
  // Keep output and shutdown attached to the terminal that owns the preview.
  dev: 'npm run build && node dist/cli.mjs dev ..',
};
