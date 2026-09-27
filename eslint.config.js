import js from '@eslint/js';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';

export default [
  js.configs.recommended,
  prettierRecommended,
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      // 'none' keeps the ESLint 8 behaviour: unused catch bindings are allowed,
      // the codebase uses `catch (e)` purely for the debug-log side channel.
      'no-unused-vars': ['warn', { caughtErrors: 'none' }],
      'no-empty': 'off',
      'no-useless-catch': 'off',
    },
  },
];
