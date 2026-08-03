// ─── Generated reachability graph — public API (P05-05) ──────────────────────
//
// PROGRAM-05, the closure capstone (CTR-013). The single import site for the
// reachability graph + closure gate. It assembles every public action's path —
// authored ActionId → schema → route → handler → [effect owner] → output →
// artifact → packaged fixture — from the upstream authorities and GATES on
// complete closure (exactly one path per action; a break or ambiguity at any hop
// fails closed, naming the action and the hop).
// ────────────────────────────────────────────────────────────────────────────

export * from './graph.js';
export * from './providers.js';
export * from './collect.js';
export * from './generate.js';
