// @ts-check
/**
 * Dedicated flat config for the error-envelope lint. Only `tools/audit/gates/lint-envelopes.mjs`
 * uses it, on the unfiltered `grep-gates` lane.
 *
 * It stays separate from the shared `eslint.config.js`, which must remain a fast, syntax-only
 * configuration. A type-aware rule there turns every shared lint run into a type-checked run.
 *
 * The glob covers only `src/verbs/**`, the registration surface, to bound the cost of the
 * type-aware run. `parserOptions.project` still lets the type checker resolve handler symbols in
 * other files. The glob bounds only the number of files that ESLint reports on.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import tseslint from 'typescript-eslint';
import noHandlerThrow from './tools/eslint-rules/no-handler-throw.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    /**
     * `tsconfig.json` excludes test files, so the `parserOptions.project` program below does not
     * hold them. A lint of a test file stops with "file not in project".
     */
    ignores: ['src/verbs/**/*.test.ts'],
  },
  {
    files: ['src/verbs/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: HERE,
      },
    },
    plugins: {
      envelopes: { rules: { 'no-handler-throw': noHandlerThrow } },
    },
    rules: {
      'envelopes/no-handler-throw': 'error',
    },
  },
);
