/**
 * Init schema — minimal type definitions for the enhanced init subsystem.
 *
 * TODO: When the init foundation (T20-T23) lands, reconcile with the
 * canonical schema. This file provides just enough surface for the
 * config writers (T24-T26) to compile and test against.
 */

/** Result returned by each runtime config writer. */
export interface ConfigWriteResult {
  /** Which runtime this result pertains to. */
  readonly runtime: string;
  /** Overall status: 'written' when files were modified, 'skipped' when
   *  no action was needed, 'stub' for not-yet-implemented runtimes. */
  readonly status: 'written' | 'skipped' | 'stub';
  /** List of logical components that were written (e.g. 'mcp-config'). */
  readonly componentsWritten: readonly string[];
  /** Non-fatal warnings surfaced to the caller. */
  readonly warnings?: readonly string[];
}

/** Interface that all runtime config writers implement. */
export interface ConfigWriter {
  readonly runtime: string;
  write(projectRoot: string): Promise<ConfigWriteResult>;
}
