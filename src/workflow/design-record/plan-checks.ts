/**
 * Source checks share the typed snapshot and its exact implements relation.
 */
import { checkExplorationDepth } from './exploration-depth.js';
import { testPathWellFormednessError } from './test-path.js';
import type { VerificationProfile } from '../verification/profile.js';
import type { DesignRecordSnapshot } from './schema.js';
import { validateDesignRecord } from './validate.js';
import { hasGwtCriteria } from './gwt.js';
import { assessDecompositionPlausibility, countBehaviors } from './decomposition-plausibility.js';

/** Render only authored edges. Neither titles nor other prose can add an edge. */
function implementsEdges(snapshot: DesignRecordSnapshot) {
  return snapshot.tasks.flatMap((task) => task.implements.map((requirementId) => ({ taskId: task.id, requirementId })))
    .sort((a, b) => a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1
      : a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
}

/** Decode the same captured bytes that produced the typed record. */
function textOf(snapshot: DesignRecordSnapshot): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(snapshot.rawBytes));
}

/** Requirement coverage is exact. Missing acceptance-layer coverage is advisory. */
export function evaluatePlanCoverage(snapshot: DesignRecordSnapshot) {
  const validation = validateDesignRecord(snapshot);
  const edges = implementsEdges(snapshot);
  const text = textOf(snapshot);
  const advisories = snapshot.definitions.filter((definition) =>
    hasGwtCriteria(text.slice(definition.bodySpan.start, definition.bodySpan.end))
    && !snapshot.tasks.some((task) => task.testLayer === 'acceptance' && task.implements.includes(definition.id)))
    .map((definition) => `${definition.id} has Given/When/Then acceptance criteria but no plan task with **Test Layer:** acceptance implements it`);
  return { ...validation, edges, advisories };
}

/** Traceability shows the same exact relation that coverage validates. */
export function evaluatePlanTraceability(snapshot: DesignRecordSnapshot) {
  const validation = validateDesignRecord(snapshot);
  const edges = implementsEdges(snapshot);
  const report = ['| Requirement | Task |', '|---|---|', ...snapshot.tasks.flatMap((task) => edges.filter((edge) => edge.taskId === task.id).map((edge) => `| ${edge.requirementId} | ${edge.taskId} |`))].join('\n');
  return { ...validation, edges, report };
}

/** The verdict and evidence identity come from the same immutable read. */
export function evaluatePlanProvenance(snapshot: DesignRecordSnapshot) {
  return { ...validateDesignRecord(snapshot), edges: implementsEdges(snapshot), reference: snapshot.reference, digest: snapshot.digest };
}

/** Typed structure and graph checks block. Semantic plausibility challenges remain advisory. */
export function evaluatePlanDecomposition(snapshot: DesignRecordSnapshot) {
  const validation = validateDesignRecord(snapshot);
  const plausibility = assessDecompositionPlausibility(snapshot.tasks.map((task) => ({
    id: task.id, files: task.files, riskTier: task.riskTier, boundaryTouching: task.boundaryTouching,
    behaviorCount: countBehaviors([task.title, task.instructions, ...task.acceptance].join('\n')),
  })));
  return { ...validation, plausibility };
}

/** Check typed forward declarations with the resolved profile. */
export function evaluatePlanTestPaths(snapshot: DesignRecordSnapshot, profile: VerificationProfile) {
  const globs = profile.tests.globs;
  if (globs.state === 'unresolved') return { passed: false, reason: globs.reason };
  const testFiles = new Set(snapshot.tasks.flatMap((task) => task.testFiles));
  if (testFiles.size === 0) return { passed: false, reason: 'No test files declared in the typed plan.' };
  for (const file of testFiles) {
    const problem = testPathWellFormednessError(file, globs.globs);
    if (problem !== null) return { passed: false, reason: `${file}: ${problem}` };
  }
  return { passed: true };
}

/** Check the exploration citations in the approved bytes. */
export function evaluatePlanExploration(snapshot: DesignRecordSnapshot) {
  return checkExplorationDepth(textOf(snapshot));
}
