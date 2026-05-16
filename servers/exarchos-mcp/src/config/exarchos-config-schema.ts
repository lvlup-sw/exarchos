import { z } from 'zod';

/**
 * Schema for `.exarchos.yml` (Stage 2 of the test-runtime resolver).
 *
 * Mirrors the SAFE_COMMAND_PATTERN allowlist used by
 * `orchestrate/detect-test-commands.ts` and `config/test-runtime-resolver.ts`.
 * Any field omitted from the file falls back to detection (Stage 3).
 */
// Intentionally allow plain space (` `) but reject control whitespace
// (`\n`, `\t`, `\r`, etc.) — newlines can split shell commands when a
// downstream consumer ever moves to a shell-aware execution path.
const SAFE_COMMAND_REGEX = /^[a-zA-Z0-9_\- :.=\/+,@"'\\]+$/;

const safeCommand = z
  .string()
  .trim()
  .min(1, 'must not be empty or whitespace-only')
  .regex(SAFE_COMMAND_REGEX, 'contains disallowed shell metacharacters');

// #1244 — markdown-aware handoff lint switch.
//
// `handleCheckpoint` runs a prose-lint over the dispatch handoff payload
// (DR-1244). By default the lint is advisory: findings surface as a
// soft warning on the response envelope and the checkpoint event is
// still appended. Setting `handoffLint.hardFail: true` flips the gate
// to a blocking rejection — `INVALID_INPUT` is returned BEFORE any
// event is appended, so retries don't duplicate.
//
// The opt-in default keeps backward compatibility for existing
// `.exarchos.yml` files: configs that don't declare `handoffLint`
// continue to soft-warn, which is the v2.10 default behaviour.
const HandoffLintConfigSchema = z
  .object({
    hardFail: z.boolean().optional(),
  })
  .strict();

export const ExarchosConfigSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
    handoffLint: HandoffLintConfigSchema.optional(),
  })
  .strict();

export type ExarchosConfig = z.infer<typeof ExarchosConfigSchema>;
