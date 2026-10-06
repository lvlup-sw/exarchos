/**
 * The design version of a workflow stream. The design of a workflow starts at version 1, and each
 * `design.revised` row moves it to the version that the row names.
 *
 * This module owns the name of the revision event, the fold that reads the version, and the format
 * of a version id. `settle` writes the row, and it numbers a revision with this fold inside its
 * write transaction. Thus the writer and each reader count the same rows in the same way.
 *
 * The version is a counter on the stream. It is not the digest of a design reference.
 */

import { DesignRevisedData, type EventType } from '../../events/schemas.js';

/** The event that records one design revision. `settle` is its one writer. */
export const DESIGN_REVISED_TYPE = 'design.revised' satisfies EventType;

/** The design version of a stream that holds no revision row. */
const FIRST_DESIGN_VERSION = 1;

/** The start of each design version id. The version number follows it. */
const DESIGN_VERSION_ID_PREFIX = 'design-v';

/**
 * The design version of a stream: the next version of its latest revision row, or 1 with no row.
 * `events` is the stream in commit order, so the latest row is the last one.
 *
 * The function throws on a revision row that the row schema refuses. A skipped row lets the next
 * revision take a version that the stream already holds.
 */
export function designVersionOf(
  events: readonly { readonly type: string; readonly data?: unknown }[],
): number {
  let version = FIRST_DESIGN_VERSION;
  for (const event of events) {
    if (event.type !== DESIGN_REVISED_TYPE) continue;
    version = DesignRevisedData.parse(event.data).nextDesignVersion;
  }
  return version;
}

/** The id of a design version: the prefix, then the number. */
export function designVersionId(version: number): string {
  return `${DESIGN_VERSION_ID_PREFIX}${version}`;
}
