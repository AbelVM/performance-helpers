import js from '@eslint/js';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default [
  js.configs.recommended,
  prettierRecommended,
  {
    languageOptions: {
      // 'latest' rather than a pinned year: the code uses explicit resource
      // management (`Symbol.dispose` / `Symbol.asyncDispose` method names),
      // `??`, optional chaining and class fields, none of which parse under the
      // 2021 setting this replaced.
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      semi: ['error', 'always'],
      // `avoidEscape` is required to agree with eslint-plugin-prettier, which
      // prefers double quotes for a string that contains single quotes. Without
      // it the two rules contradict each other and --fix oscillates.
      quotes: ['error', 'single', { avoidEscape: true }],
      // 'none' keeps the previous behaviour: unused catch bindings are allowed,
      // the codebase uses `catch (e)` purely for the debug-log side channel.
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      // Previously 'off', which permitted every `catch (e) {}` in the tree.
      // All of them have been routed through an `onError`/debug channel, so
      // this can be enforced. `allowEmptyCatch: false` is the point.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-useless-catch': 'error',
      'no-console': ['warn', { allow: ['error', 'warn', 'debug'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unsafe-optional-chaining': 'error',
      'require-atomic-updates': 'warn',
      // A 2800-line class is the biggest structural problem in this repo
      // (see the PowerPool entry in review.md). Surfacing the worst offenders
      // is the first step; tightening the threshold is incremental.
      complexity: ['warn', 25],
      'max-lines-per-function': ['warn', { max: 200, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Benchmarks and throwaway diagnostics are allowed to be less tidy.
    files: ['bench/**/*.js', 'scripts/**/*.{cjs,mjs}'],
    rules: {
      complexity: 'off',
      'max-lines-per-function': 'off',
      'no-console': 'off',
      // The harness accumulates counters that are not always read back - some
      // benchmarks compute a count the report does not surface yet. Demoted to a
      // warning rather than an error so `npm run lint` stays usable while those
      // accumulators are wired up (tracked as BENCH-001). It stays a *warning*
      // so they remain visible.
      'no-unused-vars': 'warn',
    },
  },
];
