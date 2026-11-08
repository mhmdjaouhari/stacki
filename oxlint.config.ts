// Oxlint config: the rule set the two ESLint configs held (the root's strict
// AGENTS.md set, Studio's lighter one), rule for rule.
//
// The root sources (src/, shared/, electron/) compile only inside Studio:
// studio/scripts/assemble.ts copies them to studio/vendor/stacki, swapping
// desktop modules for Studio adapters, and Studio's tsconfig is the one program
// they type-check in. So their type-aware lint runs on those copies, and
// tools/check.mts maps the reported paths back to the files you edit.
//
// Every rule is an error: a finding either blocks the change or carries a
// stated reason in a disable comment (stacki/require-disable-reason).
import { readFileSync } from 'node:fs';
import { defineConfig } from 'oxlint';

const VENDOR = 'studio/vendor/stacki';

// The copies assemble does not take verbatim from a root file: Studio adapters
// in its place, re-export stubs to a Studio module, and root files whose
// imports it rewrites to point into Studio. Their imports cross into studio/ by
// design, so the import-structure rule does not apply to them.
const inventory: unknown = JSON.parse(readFileSync(new URL('./studio/scripts/shared-source.json', import.meta.url), 'utf8'));
function inventoryPaths(key: 'adapters' | 'modules' | 'imports'): string[] {
  if (typeof inventory !== 'object' || inventory === null || !(key in inventory)) {
    throw new Error(`shared-source.json has no ${key}`);
  }
  const value: unknown = Reflect.get(inventory, key);
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return typeof value === 'object' && value !== null ? Object.keys(value) : [];
}
const ASSEMBLED = [...inventoryPaths('adapters'), ...inventoryPaths('modules'), ...inventoryPaths('imports')];

// AGENTS.md §12: no abbreviations. Word → what to write instead. Checked word
// by word on every declared name (tools/oxlint-plugin/naming.mts). Loop
// counters i, j, k are the stated exception; x, y, z are coordinates, not
// abbreviations. `attr` and `env` are left alone: they are the platform's own
// vocabulary (the DOM's Attr, process.env).
const ABBREVIATIONS = {
  a: 'a descriptive name (left, first, …)',
  arr: 'array, or what it lists',
  b: 'a descriptive name (right, second, …)',
  btn: 'button',
  c: 'a descriptive name',
  calc: 'calculate',
  cb: 'callback',
  cfg: 'config',
  ctx: 'context',
  cur: 'current',
  curr: 'current',
  d: 'a descriptive name',
  def: 'definition',
  defs: 'definitions',
  desc: 'description',
  dest: 'target',
  dir: 'directory',
  dirs: 'directories',
  doc: 'document',
  e: 'event or error',
  el: 'element',
  elem: 'element',
  err: 'error',
  ev: 'event',
  evt: 'event',
  f: 'a descriptive name',
  fn: 'callback, handler, or what it computes',
  g: 'a descriptive name',
  h: 'height',
  idx: 'index',
  k: 'key',
  l: 'a descriptive name',
  len: 'length',
  m: 'a descriptive name (match, …)',
  msg: 'message',
  n: 'count, or what it counts',
  num: 'number, or what it counts',
  o: 'a descriptive name',
  obj: 'object, or what it holds',
  opt: 'option',
  opts: 'options',
  p: 'a descriptive name',
  pct: 'percent',
  pos: 'position',
  prev: 'previous',
  q: 'query',
  r: 'a descriptive name',
  req: 'request',
  res: 'result or response',
  s: 'a descriptive name (text, …)',
  sel: 'selection or selector',
  src: 'source',
  str: 'text, or what it spells',
  t: 'a descriptive name',
  temp: 'temporary, or what it holds',
  tmp: 'temporary, or what it holds',
  u: 'a descriptive name',
  util: 'utility',
  utils: 'utilities',
  v: 'value',
  val: 'value',
  w: 'width',
};
// Quantities whose `max`/`min` prefix is a misplaced qualifier (§12:
// latencyMsMax, not maxLatencyMs).
const QUANTITY_WORDS = [
  'bytes',
  'chars',
  'columns',
  'count',
  'depth',
  'entries',
  'height',
  'items',
  'length',
  'lines',
  'ms',
  'nodes',
  'px',
  'retries',
  'rows',
  'seconds',
  'size',
  'width',
];
const NAMING = { words: ABBREVIATIONS, quantityWords: QUANTITY_WORDS };

// typescript-eslint's `recommended` and `eslint-recommended`, which both ESLint
// configs started from.
const TYPESCRIPT_RECOMMENDED = {
  'typescript/ban-ts-comment': 'error',
  'typescript/no-array-constructor': 'error',
  'typescript/no-duplicate-enum-values': 'error',
  'typescript/no-empty-object-type': 'error',
  'typescript/no-explicit-any': 'error',
  'typescript/no-extra-non-null-assertion': 'error',
  'typescript/no-misused-new': 'error',
  'typescript/no-namespace': 'error',
  'typescript/no-non-null-asserted-optional-chain': 'error',
  'typescript/no-require-imports': 'error',
  'typescript/no-this-alias': 'error',
  'typescript/no-unnecessary-type-constraint': 'error',
  'typescript/no-unsafe-declaration-merging': 'error',
  'typescript/no-unsafe-function-type': 'error',
  'typescript/no-wrapper-object-types': 'error',
  'typescript/prefer-as-const': 'error',
  'typescript/prefer-namespace-keyword': 'error',
  'typescript/triple-slash-reference': 'error',
  'eslint/no-unused-expressions': 'error',
  'eslint/no-var': 'error',
  'eslint/prefer-const': 'error',
  'eslint/prefer-rest-params': 'error',
  'eslint/prefer-spread': 'error',
} as const;

// The type-aware rules both configs held.
const TYPE_AWARE = {
  'typescript/no-unsafe-argument': 'error',
  'typescript/no-unsafe-assignment': 'error',
  'typescript/no-unsafe-member-access': 'error',
  'typescript/no-unsafe-call': 'error',
  'typescript/no-unsafe-return': 'error',
  'typescript/switch-exhaustiveness-check': 'error',
  'typescript/prefer-readonly': 'error',
} as const;

// Rules that read syntax only, so they hold for JavaScript and TypeScript
// alike. Type-aware and TypeScript-syntax rules join in the TS block.
const STACKI_SYNTAX_RULES = {
  'stacki/bounded-recursion': 'error',
  'stacki/comment-sentence': 'error',
  'stacki/division-intent': 'error',
  'stacki/naming': ['error', NAMING],
  'stacki/no-compound-assert': 'error',
  'stacki/no-null': 'error',
  'stacki/no-unbounded-loop': 'error',
  'stacki/require-disable-reason': 'error',
} as const;
const STACKI_TYPESCRIPT_RULES = {
  ...STACKI_SYNTAX_RULES,
  'stacki/callback-last': 'error',
  'stacki/catch-unknown': 'error',
  'stacki/no-boolean-parameter': 'error',
  'stacki/no-enum': 'error',
  'stacki/no-overloads': 'error',
  'stacki/no-partial-parameter': 'error',
} as const;

// stacki/restricted-syntax lists replace each other between overrides rather
// than merging, so each group is defined once and composed per override below.

// `as const` is the canonical way to keep literal unions (§5). Reject all
// other assertion syntax while allowing that one language construct.
const NO_ASSERTIONS = [
  {
    selector: "TSAsExpression:not([typeAnnotation.typeName.name='const'])",
    message: 'Type assertions must be replaced with validation and narrowing.',
  },
  { selector: 'TSTypeAssertion', message: 'Type assertions must be replaced with validation and narrowing.' },
];

// Whole-file regeneration: an existing file changes only by splices, so the
// printers may be imported or called only where a file is printed that does not
// exist yet, or where an edit prints just what it adds. Importing the name is
// what is banned, so an alias cannot slip past.
const WHOLE_FILE_REGENERATION_MESSAGE =
  'Whole-file regeneration is confined to the printer boundaries; an existing file changes only through intents and splices.';
const NO_ASTRO_PRINTING = [
  { selector: 'ImportSpecifier[imported.name=/^serialize(Page|Nodes)$/]', message: WHOLE_FILE_REGENERATION_MESSAGE },
  { selector: 'CallExpression[callee.name=/^serialize(Page|Nodes)$/]', message: WHOLE_FILE_REGENERATION_MESSAGE },
  { selector: 'ImportDeclaration[source.value=/astroParser(\\.js)?$/] > ImportNamespaceSpecifier', message: WHOLE_FILE_REGENERATION_MESSAGE },
];
const NO_MARKDOWN_PRINTING = [
  { selector: 'ImportSpecifier[imported.name=/^serializeMarkdownPage$/]', message: WHOLE_FILE_REGENERATION_MESSAGE },
  { selector: 'CallExpression[callee.name=/^serializeMarkdownPage$/]', message: WHOLE_FILE_REGENERATION_MESSAGE },
  { selector: 'ImportDeclaration[source.value=/markdownParser(\\.js)?$/] > ImportNamespaceSpecifier', message: WHOLE_FILE_REGENERATION_MESSAGE },
];
const NO_WHOLE_FILE_REGENERATION = [...NO_ASTRO_PRINTING, ...NO_MARKDOWN_PRINTING];
// Where the .astro printers may run: their definitions; new files (a component
// made from a piece of a page, a new page); the nodes and the frontmatter block
// an edit adds, printed alone (editRequests.ts); and Markdown's HTML blocks.
const ASTRO_PRINTER_BOUNDARY = ['electron/parse/astroParser.ts', 'electron/documents/componentFile.ts', 'electron/documents/editRequests.ts'];
// Markdown's parser module holds the page printer, and prints its HTML blocks
// with the .astro printer.
const PRINTER_BOUNDARY = ['electron/parse/markdownParser.ts'];

// Determinism is structural: the engine contracts run on no clock, no timer,
// no promise and no OS.
const NO_ASYNC = [
  { selector: 'AwaitExpression', message: 'Deterministic code has no async steps.' },
  { selector: ':function[async=true]', message: 'Deterministic code has no async steps.' },
  { selector: "Identifier[name='Promise']", message: 'Deterministic code has no promises.' },
];
const DETERMINISM_RULES = {
  'eslint/no-restricted-globals': [
    'error',
    ...[
      'setTimeout',
      'setInterval',
      'setImmediate',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'queueMicrotask',
      'Date',
      'performance',
      'process',
      'fetch',
    ].map((name) => ({ name, message: `${name} is nondeterministic; the scheduler owns time.` })),
  ],
  'eslint/no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'Use the seeded Prng.' },
    { object: 'crypto', property: 'randomUUID', message: 'Use the seeded Prng.' },
    { object: 'crypto', property: 'getRandomValues', message: 'Use the seeded Prng.' },
  ],
  'eslint/no-restricted-imports': [
    'error',
    {
      paths: [
        'fs',
        'node:fs',
        'node:fs/promises',
        'timers',
        'node:timers',
        'node:timers/promises',
        'node:child_process',
        'node:worker_threads',
        'node:perf_hooks',
        'node:os',
        'node:net',
        'node:http',
        'node:https',
      ].map((name) => ({ name, message: 'Deterministic code does no I/O; fake it behind an interface.' })),
    },
  ],
} as const;
// Pure engine contracts.
const ENGINE_CONTRACTS = [
  'shared/page/capability.ts',
  'shared/engine/codePatch.ts',
  'shared/engine/diff.ts',
  'shared/engine/documentActor.ts',
  'shared/engine/intent.ts',
  'shared/engine/mapSpan.ts',
  'shared/engine/inlineStyle.ts',
  'shared/engine/loopScope.ts',
  'shared/engine/markdownLayout.ts',
  'shared/engine/planMarkdown.ts',
  'shared/engine/planner.ts',
  'shared/engine/planSupport.ts',
  'shared/engine/planText.ts',
  'shared/engine/planTree.ts',
  'shared/engine/rebase.ts',
  'shared/page/ref.ts',
  'shared/page/snapshot.ts',
  'shared/page/sourceProjection.ts',
  'shared/core/span.ts',
  'shared/engine/splice.ts',
];

// The renderer's layers, lowest first: a module imports only the layers below
// its own. A feature imports another feature only along an edge listed here,
// by file, never through a barrel.
const REPOSITORY = `${import.meta.dirname}/${VENDOR}`;
const SOURCE_LAYERS = {
  repository: REPOSITORY,
  root: 'src',
  layers: ['lib', 'ipc', 'editor', 'ui', 'features', 'app'],
  featureLayer: 'features',
  featureEdges: {
    // Property defaults and options are edited with the props panel's fields.
    componentProperties: ['features/props/ListField', 'features/props/arrayValue', 'features/props/propBindings'],
    // CMS fields are the component props panel's fields, so both read and work alike.
    cms: [
      'features/props/PropField',
      'features/props/PropTip',
      'features/props/propValuePolicy',
      // A colour value is chosen with the style panel's swatch and picker.
      'features/style/components/ColorSwatch',
    ],
    // The history panel draws commits with git's file and branch widgets.
    history: ['features/git/BranchActions', 'features/git/FileBrowser', 'features/git/FileStatus'],
    // The column guide's menu is built from the style panel's controls.
    preview: [
      'features/style/LayerPopover',
      'features/style/SizeKit',
      'features/style/VariableConnect',
      'features/style/components/ColorSwatch',
      'features/style/components/DragSlider',
      'features/style/components/FieldLabel',
      'features/style/components/Select',
      'features/style/components/useScrub',
    ],
    // A variable's value is edited with the style panel's value editors.
    variables: [
      'features/style/CustomValueEditor',
      'features/style/EasingEditor',
      'features/style/VariableConnect',
      'features/style/components/ColorSwatch',
      'features/style/model/host',
      'features/style/model/transition',
      'features/style/utilities',
    ],
  },
  outside: ['shared'],
};
// The main process's areas: each folder imports only the areas listed for it.
const ELECTRON_AREAS = {
  repository: REPOSITORY,
  root: 'electron',
  outside: ['shared'],
  areas: {
    main: ['*'],
    lib: [],
    parse: ['lib'],
    documents: ['lib', 'parse'],
    content: ['lib', 'documents'],
    project: ['lib', 'documents'],
    git: ['lib', 'documents'],
    terminal: ['lib'],
    properties: ['lib', 'parse', 'documents', 'content'],
    preview: ['lib', 'git'],
    app: ['lib', 'content'],
    handlers: ['lib', 'parse', 'documents', 'content', 'project', 'git', 'properties', 'preview', 'app', 'previewServer'],
    previewServer: ['parse'],
    previewClient: [],
    preload: [],
  },
};
// The contract layer's areas: core is the floor; shared/ reaches nothing
// outside itself.
const SHARED_AREAS = {
  repository: REPOSITORY,
  root: 'shared',
  outside: [],
  areas: {
    core: [],
    page: ['core'],
    properties: ['core'],
    engine: ['core', 'page'],
    ipc: ['core', 'page', 'engine', 'properties'],
  },
};

const vendor = (files: readonly string[]): string[] => files.map((file) => `${VENDOR}/${file}`);

export default defineConfig({
  // Only the rules below: oxlint's default categories would add rules neither
  // ESLint config held.
  categories: { correctness: 'off' },
  plugins: ['typescript', 'react'],
  jsPlugins: [{ name: 'stacki', specifier: './tools/oxlint-plugin/index.mts' }],
  options: { reportUnusedDisableDirectives: 'error' },
  ignorePatterns: ['**/dist/**', '**/node_modules/**', 'studio/dev-site/**', 'studio/.studio/**', 'studio/.studio-image/**', '**/.wrangler/**'],
  overrides: [
    {
      // Studio's own code: the lighter set Studio's ESLint config held.
      files: ['studio/src/**/*.{ts,tsx}', 'studio/scripts/**/*.ts'],
      rules: {
        ...TYPESCRIPT_RECOMMENDED,
        ...TYPE_AWARE,
        'react/rules-of-hooks': 'error',
        'react/exhaustive-deps': 'error',
        'typescript/no-non-null-assertion': 'error',
        'typescript/consistent-type-imports': 'error',
        'eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        'eslint/curly': ['error', 'all'],
        'stacki/restricted-syntax': ['error', { selector: 'TSEnumDeclaration', message: 'Use a literal union.' }],
      },
    },
    {
      // The root sources, through their Studio copies: the AGENTS.md set.
      files: [`${VENDOR}/**/*.{ts,tsx,mts}`],
      rules: {
        ...TYPESCRIPT_RECOMMENDED,
        ...TYPE_AWARE,
        ...STACKI_TYPESCRIPT_RULES,
        // The migration ratchet is zero, so unchecked files cannot re-enter the
        // tree; a type test's expected error must say what it proves.
        'typescript/ban-ts-comment': ['error', { 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' }],
        'typescript/no-non-null-assertion': 'error',
        'stacki/restricted-syntax': ['error', ...NO_ASSERTIONS, ...NO_WHOLE_FILE_REGENERATION],
        'eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        'eslint/curly': ['error', 'all'],
        // Effect dependencies are correctness: a stale closure is a real bug.
        'react/exhaustive-deps': 'error',
        'react/rules-of-hooks': 'error',
        // §3: all errors are handled. A promise nobody awaits drops its
        // rejection; `void` is the explicit, reviewable way to say "detached".
        'typescript/no-floating-promises': 'error',
        'typescript/no-misused-promises': 'error',
        'typescript/only-throw-error': 'error',
        'typescript/use-unknown-in-catch-callback-variable': 'error',
        'eslint/eqeqeq': ['error', 'always'],
        // §7: construct and return, never mutate a parameter. DOM elements,
        // React refs, canvas 2D contexts, and style declarations are mutable by
        // platform design; a function that takes one exists to change it.
        'eslint/no-param-reassign': [
          'error',
          { props: true, ignorePropertyModificationsForRegex: ['[eE]lement$', '[rR]ef$', '^(?:canvas|drawing)?[cC]ontext$', '^style$'] },
        ],
      },
    },
    {
      // The JavaScript content-tool workers and this repository's own tooling:
      // syntax rules only, as no program types them.
      files: [`${VENDOR}/**/*.mjs`],
      rules: { 'eslint/curly': ['error', 'all'], ...STACKI_SYNTAX_RULES },
    },
    {
      files: ['tools/**/*.mts', 'oxlint.config.ts'],
      rules: { 'eslint/curly': ['error', 'all'], ...STACKI_TYPESCRIPT_RULES },
    },
    {
      // The Result constructor pair is the canonical `ok`/`err` of AGENTS.md §3.
      files: vendor(['shared/core/result.ts']),
      rules: { 'stacki/naming': ['error', { ...NAMING, allowedNames: ['err'] }] },
    },
    {
      // shared/ is the validated-constructor layer (AGENTS.md §2): assertions
      // are permitted here immediately after validation.
      files: vendor(['shared/**/*.{ts,tsx}']),
      rules: { 'stacki/restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION] },
    },
    { files: vendor(['src/**/*.{ts,tsx}']), rules: { 'stacki/source-layers': ['error', SOURCE_LAYERS] } },
    { files: vendor(['electron/**/*.ts']), rules: { 'stacki/source-layers': ['error', ELECTRON_AREAS] } },
    { files: vendor(['shared/**/*.ts']), rules: { 'stacki/source-layers': ['error', SHARED_AREAS] } },
    { files: vendor(ASSEMBLED), rules: { 'stacki/source-layers': 'off' } },
    {
      // These adapters validate values from PostCSS, DOM storage, and the host
      // bridge before constructing trusted values (AGENTS.md §2).
      files: vendor([
        'src/features/style/model/css.ts',
        'src/features/style/model/cssRegions.ts',
        'src/features/style/model/host.ts',
        'src/features/style/model/webflow.ts',
      ]),
      rules: { 'stacki/restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION] },
    },
    {
      files: vendor(ASTRO_PRINTER_BOUNDARY),
      rules: { 'stacki/restricted-syntax': ['error', ...NO_ASSERTIONS, ...NO_MARKDOWN_PRINTING] },
    },
    {
      files: vendor(PRINTER_BOUNDARY),
      rules: { 'stacki/restricted-syntax': ['error', ...NO_ASSERTIONS] },
    },
    {
      files: vendor(ENGINE_CONTRACTS),
      rules: { ...DETERMINISM_RULES, 'stacki/restricted-syntax': ['error', ...NO_WHOLE_FILE_REGENERATION, ...NO_ASYNC] },
    },
  ],
});
