/**
 * Builds the idempotency key for each plain `append` that `merge_orchestrate` makes.
 * The key is `${streamId}:merge_orchestrate:${taskId}:${eventType}`, without the task segment when no task id is in scope.
 * A crash replay of the same event dedups on the unique index of the key.
 * The trailing event type keeps the appends of one merge attempt apart.
 * Concurrent calls with the same inputs share a key, so the store dedups them and no false `STATE_CONFLICT` occurs.
 */

export function buildMergeOrchestrateIdempotencyKey(
  streamId: string,
  taskId: string | undefined,
  eventType: string,
): string {
  return taskId !== undefined
    ? `${streamId}:merge_orchestrate:${taskId}:${eventType}`
    : `${streamId}:merge_orchestrate:${eventType}`;
}
