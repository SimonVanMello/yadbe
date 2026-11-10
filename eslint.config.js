import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      '.claude',
      'src-tauri',
      'test-results',
      'playwright-report',
      'docs',
      'src/ipc/bindings.ts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Rule 8 of CLAUDE.md: the frontend talks to the backend only through src/ipc.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@tauri-apps/api',
                '@tauri-apps/api/*',
                '**/ipc/bindings',
                '**/ipc/tauriClient',
              ],
              message: 'Talk to the backend through `src/ipc` (`ipc` client) only.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ipc/**'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['*.config.{js,ts}', 'e2e/**', 'scripts/**'],
    languageOptions: { globals: globals.node },
  },
);
