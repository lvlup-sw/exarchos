import { z } from 'zod';

/**
 * Schema for `.exarchos.yml` (Stage 2 of the test-runtime resolver).
 *
 * Mirrors the SAFE_COMMAND_PATTERN allowlist used by
 * `orchestrate/detect-test-commands.ts` and `config/test-runtime-resolver.ts`.
 * Any field omitted from the file falls back to detection (Stage 3).
 */
const SAFE_COMMAND_REGEX = /^[a-zA-Z0-9_\-\s:.=\/+,@"'\\]+$/;

const safeCommand = z
  .string()
  .min(1)
  .regex(SAFE_COMMAND_REGEX, 'contains disallowed shell metacharacters');

export const ExarchosConfigSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
  })
  .strict();

export type ExarchosConfig = z.infer<typeof ExarchosConfigSchema>;
