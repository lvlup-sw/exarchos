// Reserved stream ids for event streams that belong to no feature workflow.
// View and listing handlers use them to tell feature streams from infrastructure streams.

export const INIT_STREAM_ID = 'exarchos-init';
export const DOCTOR_STREAM_ID = 'exarchos-doctor';
export const TELEMETRY_STREAM = 'telemetry';

/**
 * The stream for the `onboard` verb's `onboard.requested` and `onboard.executed` events.
 * Onboarding belongs to no feature workflow, so its audit trail stays apart from feature streams.
 */
export const ONBOARD_STREAM_ID = 'exarchos-onboard';

/**
 * The stream for admission facts about the whole store, such as the `cutover_decide` decisions
 * and `admission.cutover-ready`. These facts describe no single feature workflow.
 */
export const ADMISSION_STREAM_ID = 'exarchos-admission';

/**
 * The stream for the intent and result records of the mutating VCS handlers.
 * A pull request is a fact about the repository, and some callers carry no featureId.
 * The reserved id lets post-dispatch observation find this stream from the action declaration.
 */
export const VCS_STREAM_ID = 'vcs';

export const INFRA_STREAM_IDS: ReadonlySet<string> = new Set([
  INIT_STREAM_ID,
  DOCTOR_STREAM_ID,
  TELEMETRY_STREAM,
  ONBOARD_STREAM_ID,
  ADMISSION_STREAM_ID,
  VCS_STREAM_ID,
  /** The feedback stream that `workflow/feedback.ts` owns. */
  'meta/feedback',
]);

export function isFeatureStream(streamId: string): boolean {
  return !INFRA_STREAM_IDS.has(streamId);
}
