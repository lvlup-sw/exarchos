import type { CommandResult } from '../cli.js';

/**
 * Handle the `session-end` CLI command.
 *
 * Validates that `session_id` and `transcript_path` are present in stdin data.
 * Returns success when both are provided. The actual transcript extraction
 * logic will be wired in a later task — this is the infrastructure stub.
 */
export async function handleSessionEnd(
  stdinData: Record<string, unknown>,
  _stateDir: string,
): Promise<CommandResult> {
  const sessionId = stdinData.session_id;
  const transcriptPath = stdinData.transcript_path;

  if (!sessionId || typeof sessionId !== 'string') {
    return { error: { code: 'MISSING_SESSION_ID', message: 'session_id is required' } };
  }

  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { error: { code: 'MISSING_TRANSCRIPT_PATH', message: 'transcript_path is required' } };
  }

  // Stub: extraction will be wired in Task 010
  // For now, just validate inputs and return success
  return { continue: true };
}
