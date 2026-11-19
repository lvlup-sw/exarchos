// These tests check the pin of a full definition. The pin keeps the `exarchos` extension, and its digest covers it.
// The five built-in digests are literals in this file. A change of a definition file or of the pin moves them,
// and the process pins of the compiler change with them.
//
// @oracle-sources: ../../../../src/verbs/prepare/pin-definition.ts, hand-pinned digest literals

import { describe, expect, it } from 'vitest';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { baseValidCapsule } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { lowerBuiltInDefinition, lowerDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { pinDefinition } from '../../../../src/verbs/prepare/pin-definition.js';
import { decodePreparedBundle, encodePreparedBundle } from '../../../../src/verbs/prepare/prepared-record.js';
import {
  BUILT_IN_WORKFLOW_TYPES,
  builtInDefinition,
} from '../../../../src/workflow/definitions/built-in.js';
import { checkDefinitionDocument, type ExarchosDefinition } from '../../../../src/workflow/definitions/extension.js';
import { releaseCheckDefinition } from '../../../helpers/definitions/user-definition.js';

/**
 * The pinned digest of each built-in definition with its extension.
 * The process pins of the feature and refactor digests name these literals.
 */
const PINNED_DIGESTS: Readonly<Record<string, string>> = {
  feature: '2da84c593518cde93da6282a08f504e343215b008289389e8f97661bf1a7f6eb',
  debug: '6a4436937d5070c2a8835a9125786c11c33e8878299592cfe347f8d9db45c6fb',
  refactor: '82b8309111effc171d24c8bb7f90e12e962236596b29d980eb18ae69e9e66535',
  oneshot: '1c2d901122a08c393f60f750d22bcd4d77f2481172b864741deb7043ae449bd5',
  discovery: '964beffda2a3f0f4ab784a10918983f804a84e5e67602ca916fa2b8367398c7f',
};

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** Checks one raw user document with no own rules, or throws with its findings. */
function checked(raw: unknown): ExarchosDefinition {
  const result = checkDefinitionDocument(raw, () => []);
  if (!result.ok) throw new Error(`the user definition fails its checks: ${JSON.stringify(result.findings)}`);
  return result.definition;
}

describe('the pin of a full definition', () => {
  /** Each built-in gives its pinned literal, and each pinned digest differs from the kernel digest of its type. */
  it('PinDefinition_TheFiveBuiltIns_GiveThePinnedDigests', () => {
    expect(Object.keys(PINNED_DIGESTS).sort()).toStrictEqual([...BUILT_IN_WORKFLOW_TYPES].sort());
    for (const type of BUILT_IN_WORKFLOW_TYPES) {
      const pinned = pinDefinition(type, builtInDefinition(type));
      expect(pinned.definitionVersion, type).toBe(PINNED_DIGESTS[type]);
      expect(pinned.definitionVersion, type).not.toBe(lowerBuiltInDefinition(type)?.definitionVersion);
    }
  });

  /** An edit of the extension alone moves the pinned digest. The kernel digest of the same two documents stays. */
  it('PinDefinition_AUserExtensionEdit_MovesTheDefinitionVersion', () => {
    const original = releaseCheckDefinition();
    const edited = releaseCheckDefinition();
    const edges = recordAt(recordAt(edited.exarchos, 'exarchos').edges, 'edges');
    recordAt(recordAt(edges['build->verify'], 'build->verify').obligation, 'obligation').gateId = 'release-gate';

    const before = pinDefinition('release-check', checked(original));
    const after = pinDefinition('release-check', checked(edited));
    expect(after.definitionVersion).not.toBe(before.definitionVersion);
    expect(lowerDefinition('release-check', checked(edited)).definitionVersion).toBe(
      lowerDefinition('release-check', checked(original)).definitionVersion,
    );
  });

  /** The result names the type, holds the definition with its extension, and digests that definition. */
  it('PinDefinition_ReturnsALoweredDefinition', () => {
    const definition = builtInDefinition('feature');
    const pinned = pinDefinition('feature', definition);
    expect(Object.keys(pinned).sort()).toStrictEqual(['definition', 'definitionVersion', 'workflowType']);
    expect(pinned.workflowType).toBe('feature');
    expect(pinned.definition.exarchos).toStrictEqual(definition.exarchos);
    expect(pinned.definition.name).toBe(definition.name);
    expect(pinned.definitionVersion).toBe(contentDigest(pinned.definition));
  });

  /** A bundle that holds a pinned definition decodes with the extension, and the decoded definition keeps the pinned digest. */
  it('PreparedBundle_ASixBundle_DecodesWithItsExtension', () => {
    const pinned = pinDefinition('feature', builtInDefinition('feature'));
    const decoded = decodePreparedBundle(encodePreparedBundle({ capsule: baseValidCapsule(), definition: pinned.definition }));
    expect(decoded.definition).toStrictEqual(pinned.definition);
    expect(decoded.definition.exarchos).toStrictEqual(builtInDefinition('feature').exarchos);
    expect(contentDigest(decoded.definition)).toBe(PINNED_DIGESTS.feature);
  });
});
