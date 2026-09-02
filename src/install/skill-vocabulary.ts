// Skill-source vocabulary: the placeholder tokens a skill may reference, and
// the classification derived from them.
//
// Extracted from `build-skills.ts` to break a runtime import cycle with
// `placeholder-lint.ts`. The lint must see PRECISELY the tokens the renderer
// would substitute, so the two cannot each own a copy — but the renderer also
// calls the lint, which made the shared ownership circular. One module owns
// the vocabulary; the renderer and the lint both depend on it, and neither
// depends on the other for it.
import type { RuntimeTokenName } from './runtimes/types.js';
import { RuntimeTokenKey } from './runtimes/types.js';

/**
 * Matches `{{TOKEN}}` and `{{TOKEN arg1="..." arg2="..."}}` placeholder
 * tokens. Capture groups:
 *   1. token name (identifier)
 *   2. raw arg string (optional, may be undefined)
 *
 * The token identifier is `\w+` so `{{FOO_BAR}}`, `{{CHAIN}}`, `{{abc123}}`
 * all match. The arg body is `[^}]*` — it intentionally forbids `}` so that
 * a stray `}}` cannot land inside an arg string and confuse the matcher.
 *
 * Exported so `src/placeholder-lint.ts` can use the exact same pattern
 * the renderer uses — the lint must see precisely the tokens the
 * renderer would otherwise substitute, and duplicating the regex in
 * two files would let them drift.
 *
 * WARNING: this is a stateful `/g` instance. Callers MUST either use a
 * local `.matchAll()` iterator or reset `lastIndex = 0` before and
 * after an `.exec()` loop so state does not leak into later call
 * sites.
 */
export const PLACEHOLDER_REGEX = /\{\{(\w+)(?:\s+([^}]*))?\}\}/g;

/**
 * Matches `{{CALL tool action {json}}}` macro tokens in skill source bodies.
 *
 * Capture group 1: full content after `CALL ` — i.e. `tool action {json}`.
 * The captured string is what `parseCallMacro()` expects as its `raw` input.
 *
 * The inner `.+` is greedy (not `.+?`) so that JSON args containing `}`
 * are captured correctly. E.g. `{{CALL tool act {"k":"v"}}}` — with a
 * non-greedy match the first `}}` inside the JSON would terminate the
 * capture prematurely. The greedy variant backtracks to let `\}\}` anchor
 * at the true closing delimiter. One CALL macro per line is the expected
 * usage; multiple CALL macros on the same line should be placed on
 * separate lines instead.
 *
 * Exported so:
 *   - The placeholder lint (task 010) can detect CALL macros without
 *     duplicating the pattern.
 *   - The render pipeline (tasks 007/008) can locate macros for expansion.
 *
 * WARNING: this is a stateful `/g` instance — same caveats as
 * `PLACEHOLDER_REGEX`. Use `.matchAll()` or reset `lastIndex` manually.
 */
export const CALL_MACRO_REGEX = /\{\{CALL\s+(.+)\}\}/g;

export const REQUIRES_OPEN_REGEX = /<!--\s*requires:(native:)?([a-z0-9:-]+)\s*-->/g;

export type SkillClass = 'procedural' | 'orchestration';

/**
 * Prefix tokens — declared by every runtime YAML. They differ per harness
 * only in the leading MCP/command-prefix string, so a source that references
 * *only* these still renders identically-shaped prose on every runtime and
 * stays procedural. Prefix tokens are explicitly NOT orchestration tokens.
 */
export const PREFIX_TOKENS: ReadonlySet<RuntimeTokenName> = new Set<RuntimeTokenName>([
  'MCP_PREFIX',
  'COMMAND_PREFIX',
]);

/**
 * Orchestration tokens — the agent-spawning primitives whose values genuinely
 * fork per harness: `TASK_TOOL`, `CHAIN`, `SPAWN_AGENT_CALL`, and the
 * `SUBAGENT_*` family (`SUBAGENT_COMPLETION_HOOK`, `SUBAGENT_RESULT_API`).
 * Derived as `RuntimeTokenKey` minus `PREFIX_TOKENS` so a new canonical token
 * added to the vocabulary is classified as orchestration automatically unless
 * it is also declared a prefix token — the classification never drifts from
 * the canonical vocabulary in `src/runtimes/types.ts`.
 */
export const ORCHESTRATION_TOKENS: ReadonlySet<RuntimeTokenName> =
  new Set<RuntimeTokenName>(
    RuntimeTokenKey.filter((token) => !PREFIX_TOKENS.has(token)),
  );

/** O(1) membership set of the canonical `RuntimeTokenKey` names. */
const RUNTIME_TOKEN_SET: ReadonlySet<string> = new Set<string>(RuntimeTokenKey);

/** Narrow an arbitrary `{{...}}` identifier to a canonical `RuntimeTokenName`. */
function isRuntimeToken(name: string): name is RuntimeTokenName {
  return RUNTIME_TOKEN_SET.has(name);
}

/** True when `body` contains any `<!-- requires:* -->` capability guard. */
function hasRequiresGuard(body: string): boolean {
  // Fresh instance — REQUIRES_OPEN_REGEX is a stateful /g singleton.
  return new RegExp(REQUIRES_OPEN_REGEX.source).test(body);
}

/**
 * The renderer's per-skill model. Surfaces the token-derived classification
 * plus the evidence behind it (which canonical tokens the source references,
 * which of those are orchestration tokens, and whether the source carries a
 * capability guard) so the build-time assertion and future consumers can act
 * on the exact surface a source declares without re-scanning it.
 */
export interface SkillModel {
  /** Canonical `RuntimeTokenKey` tokens the source references. */
  readonly tokensUsed: ReadonlySet<RuntimeTokenName>;
  /** Subset of `tokensUsed` that are orchestration tokens. */
  readonly orchestrationTokensUsed: ReadonlySet<RuntimeTokenName>;
  /** Whether the source contains any `<!-- requires:* -->` capability guard. */
  readonly hasCapabilityGuard: boolean;
  /** Derived class: `orchestration` iff any orchestration token is referenced. */
  readonly skillClass: SkillClass;
}

/**
 * Classify a skill source body by the placeholder tokens it references.
 *
 * A source that references only prefix tokens (or no canonical tokens at all)
 * is `procedural`; a source that references any orchestration token is
 * `orchestration`. Only canonical `RuntimeTokenKey` identifiers participate —
 * CALL-macro args, handlebar template literals (e.g. `{{next}}`,
 * `{{#each hints}}`), and unknown `{{...}}` identifiers are ignored because
 * they are not part of the per-harness forking surface.
 *
 * The returned model also records whether the source carries a
 * `<!-- requires:* -->` capability guard. Guards are an orchestration-only
 * construct that the build-time assertion (`assertProceduralSkill`) rejects in
 * procedural sources, but they are not placeholder tokens and therefore do not
 * themselves drive classification (which is derived from token usage only).
 *
 * @param body - Raw skill source body (SKILL.md or a Markdown reference).
 * @returns The derived `SkillModel`.
 */
export function classifySkill(body: string): SkillModel {
  const tokensUsed = new Set<RuntimeTokenName>();
  const orchestrationTokensUsed = new Set<RuntimeTokenName>();

  // Fresh instance — PLACEHOLDER_REGEX is a stateful /g singleton.
  const regex = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const name = match[1];
    if (name === undefined || !isRuntimeToken(name)) continue;
    tokensUsed.add(name);
    if (ORCHESTRATION_TOKENS.has(name)) orchestrationTokensUsed.add(name);
  }

  const skillClass: SkillClass =
    orchestrationTokensUsed.size > 0 ? 'orchestration' : 'procedural';

  return {
    tokensUsed,
    orchestrationTokensUsed,
    hasCapabilityGuard: hasRequiresGuard(body),
    skillClass,
  };
}
