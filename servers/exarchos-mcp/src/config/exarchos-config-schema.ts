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

export const ExarchosConfigSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
  })
  .strict();

export type ExarchosConfig = z.infer<typeof ExarchosConfigSchema>;
