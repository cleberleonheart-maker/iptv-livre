import js from '@eslint/js';
import globals from 'globals';

const correctness = {
  'no-unreachable': 'error',
  'no-constant-condition': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
};

export default [
  { ignores: ['node_modules/**', 'public/vendor/**', 'android/build/**', 'apk/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    rules: correctness,
  },
  {
    files: ['server.js', 'auth.js',   'health.js', 'streamstate.js', 'hosthealth.js', 'notify.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Hls: 'readonly',
        mpegts: 'readonly',
        Player: 'readonly',
        Login: 'readonly',
        cast: 'readonly',
        chrome: 'readonly',
      },
    },
    rules: {
      'no-redeclare': 'off',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^(Player|Login)$' }],
    },
  },
];
