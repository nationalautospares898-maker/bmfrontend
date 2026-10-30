import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'coverage', 'playwright-report', 'src/api/generated'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.node.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `any` in a path that renders money or stock is how a wrong number reaches a
      // customer (ADR-023).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // An unhandled ErrorCode must break the build — that is intentional (ADR-029).
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // ADR-013: money arithmetic happens only in src/lib/money.ts. These bans are
      // relaxed for that one file below.
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'Money arithmetic belongs in src/lib/money.ts (ADR-013).',
        },
        {
          name: 'parseInt',
          message: 'Money arithmetic belongs in src/lib/money.ts (ADR-013).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message: 'Money arithmetic belongs in src/lib/money.ts (ADR-013).',
        },
      ],

      // Rule 14: every request goes through src/api/client.ts so it gets auth,
      // idempotency, retry and error handling.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'axios', message: 'Use the project client in src/api/ (rule 14).' },
            {
              name: 'moment',
              message: 'No date library (ADR-024). Use Intl and the print formatter.',
            },
            { name: 'lodash', message: 'Not an approved dependency (ADR-024).' },
          ],
          patterns: [
            {
              group: ['@mui/*', 'antd', '@chakra-ui/*'],
              message:
                'No component framework (ADR-024). Use the owned shadcn/ui subset.',
            },
          ],
        },
      ],
    },
  },
  // `src/lib/money.ts` is the one place decimal parsing is allowed to live.
  {
    files: ['src/lib/money.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  // `src/api/` is the one place a network call may originate.
  {
    files: ['src/api/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
