// Stylesheets are imported for their side effect: the build (esbuild, Vite)
// bundles them. TypeScript 7 checks side-effect imports by default
// (noUncheckedSideEffectImports), so it needs to know a stylesheet is a module.
declare module '*.css';
