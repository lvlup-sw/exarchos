/**
 * Comments this policy must NOT reject.
 *
 * A rule is only as good as what it leaves alone. Half of these are drawn from
 * the adjudicated false positives of patterns that failed the precision floor,
 * so if a later narrowing turns one of those patterns on, these exact phrasings
 * are the regression corpus it has to stay silent about.
 */

// The ordinal-stripped rewrite of servers/exarchos-mcp/src/utils/atomic-write.ts:313.
// This is the target shape for remediation: the identifier is gone and every
// word of the reasoning survives.
// the bytes are fsync'd before the rename; the NAME is durable only once the
// parent directory is fsync'd too. Strictly after the rename — fsync'ing the
// directory first would prove nothing about an entry that does not exist yet,
// and a publish that never renamed must not claim a durable entry at all.
export const durableRenameRewritten = true;

// A durable external reference: resolvable by any reader, outside this
// repository's planning cycle, and permitted even though its fragment looks
// like an ordinal.
// background: https://github.com/lvlup-sw/exarchos/blob/main/docs/x.md#DR-7
export const urlCitation = true;

// A fully-qualified issue reference names a durable record in a system that
// keeps it, which is the remedy for an unqualified epic citation.
// fixed upstream in lvlup-sw/exarchos#1755
export const issueCitation = true;

// mitigates CVE-2026-11111
export const cveCitation = true;

// per RFC 9110 section 9.3.1
export const rfcCitation = true;

// Product vocabulary, not a citation: the workflow machine and the append path
// both have numbered phases. Treating these as ordinals produced 45 false
// positives on the measured tree.
// the append is locked during phase 1
export const phaseVocabulary = true;

// Type parameters, template tags and timing notation — the collision class that
// a bare `T<n>` pattern would have caught and the shipped shapes do not.
// returns Map<T1, T2> for the caller, measured from T0 to first byte
export const typeParameters = true;

// Adjudicated false positives of `passive-change-verb`, which ships disabled at
// 84%. Each describes a CONDITION rather than this code's history.
// If `@proof` were renamed, or the tag moved, the assertion goes stale
export const hypotheticalRename = true;

// nothing was renamed — only the place the name is DECLARED moved
export const negatedRename = true;

// a `consumedBy` naming a reducer that was deleted still boots
export const conditionalDeletion = true;

// Adjudicated false positives of `no longer`, which ships disabled at ~50%.
// allowlist entries knip no longer flags — a non-failing hygiene warning
export const presentTenseNoLonger = true;

// A bare `previously` describing present behavior, which the narrowed
// narration pattern deliberately leaves alone.
// previously computed values are reused when the hash matches
export const barePreviously = true;

// An ordinary comment that states its constraint in words — the shape the whole
// policy is trying to produce.
// the retry budget is fixed at three attempts because the downstream lease
// expires after four, so a fourth attempt could outlive the lease it holds
export const statedConstraint = true;
