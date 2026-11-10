import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/.react-router/**',
      '**/e2e-report/**',
      '**/test-results/**',
      '**/*.d.ts',
    ],
  },

  // Base config for all files
  js.configs.recommended,

  // TypeScript config for all TS files
  ...tseslint.configs.recommended,

  // Global settings
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      // TypeScript specific
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-this-alias': 'off',

      // General
      'no-console': ['warn', { allow: ['warn', 'error', 'info', 'debug'] }],
      'prefer-const': 'error',
      'no-var': 'error',

      // Never a browser prompt: confirmations are in-page dialogs, notices are
      // in-page messages, and nothing asks before the tab closes.
      'no-alert': 'error',
      'no-restricted-globals': ['error',
        { name: 'confirm', message: 'Use an in-page confirmation dialog, never a browser prompt.' },
        { name: 'alert', message: 'Show the message in the page (role="alert"), never a browser prompt.' },
        { name: 'prompt', message: 'Use an in-page dialog with an input, never a browser prompt.' },
      ],
      'no-restricted-syntax': ['error',
        { selector: "Literal[value='beforeunload']", message: 'No beforeunload: guard in-app navigation with a dialog; flush on pagehide.' },
        { selector: "TemplateElement[value.raw=/beforeunload/]", message: 'No beforeunload: guard in-app navigation with a dialog; flush on pagehide.' },
      ],
    },
  },

  // Cloudflare Workers apps (auth, audit-consumer, profile)
  {
    files: ['apps/auth/**/*.ts', 'apps/audit-consumer/**/*.ts', 'apps/profile/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.worker,
        // Cloudflare Workers globals
        D1Database: 'readonly',
        D1PreparedStatement: 'readonly',
        D1Result: 'readonly',
        D1ExecResult: 'readonly',
        D1DatabaseSession: 'readonly',
        ExecutionContext: 'readonly',
        KVNamespace: 'readonly',
        DurableObjectNamespace: 'readonly',
        Queue: 'readonly',
        MessageBatch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        caches: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },

  // React app (admin)
  {
    files: ['apps/admin/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', {
        allowConstantExport: true,
        allowExportNames: [
          // React Router 7 route module exports
          'meta',
          'links',
          'headers',
          'loader',
          'clientLoader',
          'action',
          'clientAction',
          'ErrorBoundary',
          'HydrateFallback',
          'handle',
          'shouldRevalidate',
          // shadcn/ui variant exports
          'badgeVariants',
          'buttonVariants',
        ],
      }],
    },
  },

  // Test files
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**', '**/__mocks__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // E2E test files
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
