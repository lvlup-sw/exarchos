// @ts-check
/**
 * @fileoverview The comment blocks of a file in scope, with the syntax tree of a JavaScript file.
 *
 * The parser is the one that the ESLint rules use. So the gate, the baseline tools and the precision
 * sampler see the same blocks and the same placements as the rules. Shell, YAML and PowerShell
 * files come from `comment-sources.mjs`, and they have no syntax tree.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { groupBlocks } from './comment-baseline.mjs';
import { sourceBlocks, sourceLanguage } from './comment-sources.mjs';
import { LINT_EXTENSIONS, isInLintScope } from './lint-scope.mjs';

const require = createRequire(import.meta.url);

/** Raised when a file in scope does not parse. A caller that skips the file under-reports. */
export class CommentParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CommentParseError';
  }
}

/**
 * The comment blocks of one file, and its syntax tree when it is JavaScript or TypeScript.
 *
 * @param {string} relPath POSIX, repository-relative.
 * @param {string} text
 * @param {string} repoRoot
 * @returns {{ blocks: import('./comment-baseline.mjs').CommentBlock[], syntax?: import('./comment-analysis.mjs').FileSyntax }}
 */
export function parseCommentFile(relPath, text, repoRoot) {
  if (sourceLanguage(relPath) !== undefined) return { blocks: sourceBlocks(relPath, text) };
  if (!isInLintScope(relPath)) return { blocks: [] };
  const { Linter } = require('eslint');
  const { parser } = require('typescript-eslint');
  const linter = new Linter({ configType: 'flat', cwd: repoRoot });
  /** @type {import('eslint').Linter.Config} */
  const config = {
    files: [`**/*.{${LINT_EXTENSIONS.join(',')}}`],
    languageOptions: { parser },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  };
  const messages = linter.verify(text, [config], { filename: path.join(repoRoot, relPath) });
  const fatal = messages.find((m) => m.fatal === true || m.message.startsWith('No matching configuration'));
  if (fatal !== undefined) throw new CommentParseError(`${relPath} did not parse: ${fatal.message}`);
  const sourceCode = linter.getSourceCode();
  if (sourceCode === null) throw new CommentParseError(`${relPath}: ESLint produced no source code.`);
  const comments = sourceCode.getAllComments().map((c) => ({
    type: String(c.type),
    value: c.value,
    range: /** @type {[number, number]} */ (c.range ?? [0, 0]),
  }));
  const ast = /** @type {import('./comment-placement.mjs').EsNode} */ (/** @type {unknown} */ (sourceCode.ast));
  return { blocks: groupBlocks(comments, sourceCode.text), syntax: { ast, comments, text: sourceCode.text } };
}
