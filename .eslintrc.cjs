module.exports = {
  env: {
    es2021: true,
    node: true,
    browser: true,
  },
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
  },
  extends: [
    'eslint:recommended',
    'plugin:prettier/recommended'
  ],
  rules: {
    semi: ['error', 'always'],
    quotes: ['error', 'single'],
    'no-unused-vars': ['warn'],
    'no-empty': 'off',
    'no-useless-catch': 'off',
  },
};
