/**
 * The call shape the canonical skills prescribe today, held still until the
 * protocol that changes it lands.
 *
 * A claim that a new protocol cuts the calls per workflow is only testable
 * against a shape recorded before the change. This guard keeps that record
 * honest in both directions: the live tree must reproduce the checked-in census
 * byte for byte, so a skill or runbook edit that moves the prescribed shape
 * fails here until the census is regenerated and its diff read; and the census
 * must count something for every named intent, so an extractor that quietly
 * found nothing cannot pass as a shape with no calls in it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CALL_SHAPE_BASELINE,
  CALL_SHAPE_REGENERATE,
  CALL_SHAPE_SUMMARY,
  measureLiveCallShape,
} from '../../tools/audit/core/call-shape/measure.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const NAMED_INTENTS = ['plan', 'delegation', 'task-completion', 'review', 'synthesis'];

const live = measureLiveCallShape(REPO_ROOT);

describe('static call-shape census', () => {
  it('CallShapeCensus_LiveTree_BuildsWithoutRefusal', () => {
    expect(live.errors, 'the census refused the live tree').toEqual([]);
  });

  it('CallShapeCensus_EveryNamedIntent_CountsAnExarchosCallOnItsNormalPath', () => {
    expect(live.census.intents.map((intent) => intent.id)).toEqual(NAMED_INTENTS);
    for (const intent of live.census.intents) {
      expect(intent.normal.counts.exarchos.atUnit, `${intent.id} counts no Exarchos call`).toBeGreaterThan(0);
      expect(intent.boundary.line, `${intent.id} boundary did not resolve`).not.toBeNull();
    }
  });

  it('CallShapeCensus_EverySource_YieldsLocatedCallsAndEveryRunbookIsRead', () => {
    const sources = Object.entries(live.census.sites);
    expect(sources.map(([file]) => file).sort()).toEqual([
      'content/delivery/skills/delegate/SKILL.md',
      'content/design/skills/plan/SKILL.md',
      'content/review/skills/review/SKILL.md',
      'content/synthesis/skills/synthesize/SKILL.md',
    ]);
    for (const [file, sites] of sources) {
      expect(sites.length, `${file} yielded no call sites`).toBeGreaterThan(0);
    }
    expect(live.census.runbooks.length, 'no runbooks were read').toBeGreaterThan(0);
  });

  it('CallShapeCensus_CheckedInCensus_IsByteIdenticalToTheLiveTree', () => {
    const recorded = fs.readFileSync(path.join(REPO_ROOT, CALL_SHAPE_BASELINE), 'utf8');
    const recordedPins: unknown = (JSON.parse(recorded) as { pins?: unknown }).pins;
    expect(recordedPins, `a pinned input changed; regenerate with ${CALL_SHAPE_REGENERATE} and read the diff`).toEqual(
      live.census.pins,
    );
    expect(recorded, `the prescribed call shape changed; regenerate with ${CALL_SHAPE_REGENERATE}`).toBe(live.json);
  });

  it('CallShapeCensus_CheckedInSummary_IsRenderedFromTheSameCensus', () => {
    const recorded = fs.readFileSync(path.join(REPO_ROOT, CALL_SHAPE_SUMMARY), 'utf8');
    expect(recorded, `the summary is stale; regenerate with ${CALL_SHAPE_REGENERATE}`).toBe(live.markdown);
  });
});
