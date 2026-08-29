import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'node_modules/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsparser, parserOptions: { sourceType: 'module' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      // Underscore prefix = deliberately unused (Fastify handlers must accept
      // (req, reply) even when they ignore one).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'warn',
    },
  },
  {
    // Seed and other CLI scripts talk to the operator through stdout — that IS
    // their interface (e.g. printing the generated admin password once).
    files: ['prisma/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    /*
     * The browser code.
     *
     * Until now the only config block matched TypeScript files, so the browser code,
     * which is the majority of the UI by line count including a 16,500-line app.js,
     * was parsed
     * and nothing more. A syntax error was caught; an accidental global, a dead
     * variable, a stray '==' or a duplicated declaration were not. One such edit
     * blanked the whole workspace on 2026-08-28 and was caught only by the commit
     * hook, by luck rather than by a rule.
     *
     * Everything here is 'warn' rather than 'error', deliberately. `eslint .` runs in
     * the pre-push hook, and a rule set that turns a 16,500-line file's accumulated
     * history into a wall of errors would block every push on day one — which ends
     * with someone deleting the block. Warnings surface the backlog without stopping
     * work; as screens are extracted into their own files (AUD-003), each extracted
     * file gets promoted to 'error' via its own block.
     *
     * Run `pnpm lint:count` to see the current warning count. It should fall, never
     * rise.
     */
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      // Classic scripts, not modules: these files are loaded with plain <script src>
      // and communicate through window globals.
      sourceType: 'script',
      globals: {
        // Browser surface these files actually use.
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        location: 'readonly',
        history: 'readonly',
        navigator: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        Image: 'readonly',
        Option: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        DOMParser: 'readonly',
        XMLHttpRequest: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        matchMedia: 'readonly',
        getComputedStyle: 'readonly',
        structuredClone: 'readonly',
        ClipboardItem: 'readonly',
        // The screens' own cross-file contract. Each of these is a window global one
        // file defines and another reads; listed so no-undef reports a genuine typo
        // rather than the architecture.
        SSGCrossBorder: 'writable',
        SSGContractPages: 'writable',
        SSGAccountsReceivable: 'writable',
        SSGBeltShipments: 'writable',
        SSGFreightTrueUp: 'writable',
        SSGPortalDelivery: 'writable',
        SSGVendorColors: 'writable',
        SSGProposalFrontMatter: 'writable',
        SSGIntroAdventure: 'writable',
        SSGIntroSoar: 'writable',
        SSGIntroFlex: 'writable',
        SSGIntroCover: 'writable',
        SSGIntroAdmin: 'writable',
        SSGInsights: 'writable',
        SSGGoals: 'writable',
        // The shared UI primitives, read by every file in here.
        SSGUI: 'writable',
        SSGStandardNotes: 'writable',
        SSGVendorParts: 'writable',
        SSGCatalog: 'writable',
      },
    },
    rules: {
      // A typo'd identifier is the one browser mistake that is always a bug: it
      // throws at runtime, on a screen, in front of a customer.
      'no-undef': 'warn',
      /*
       * caughtErrors: 'none' — `catch (e) {}` is this codebase's deliberate idiom for
       * "a failure here is not worth reporting" (a JSON body that is not JSON, a
       * localStorage read in a locked-down browser). There are roughly 200 of them and
       * they are all intentional, so reporting each one buries the findings that
       * matter: on the first run, three real bugs sat inside 223 warnings.
       */
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      // An accidental assignment to an undeclared name becomes a global and works
      // until two screens use the same name.
      'no-implicit-globals': 'off',
      'no-redeclare': 'warn',
      'no-dupe-keys': 'warn',
      'no-dupe-args': 'warn',
      'no-duplicate-case': 'warn',
      'no-unreachable': 'warn',
      'no-fallthrough': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-cond-assign': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-self-assign': 'warn',
      'no-self-compare': 'warn',
      'no-sparse-arrays': 'warn',
      'no-unsafe-negation': 'warn',
      'valid-typeof': 'warn',
      'use-isnan': 'warn',
      eqeqeq: ['warn', 'smart'],
      // Not 'no-console': these files log deliberately when an integration fails,
      // and a browser console message is how a rep's problem gets diagnosed.
      'no-console': 'off',
    },
  },

  {
    /*
     * The shared primitives module, held to 'error' rather than 'warn'.
     *
     * This is the promotion the block above describes: a file extracted under AUD-003
     * starts clean and stays clean, so there is no accumulated backlog to bury a push
     * under. Everything in the app depends on this one file — esc alone has 780 call
     * sites — so it is the last place a warning should be allowed to sit unread.
     */
    files: [
      'public/ssg-ui.js',
      'public/ssg-standard-notes.js',
      'public/ssg-vendor-parts.js',
      'public/catalog.js',
    ],
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  prettier,
];
