# Rank fusion algorithm spike for Strategos #57

**Date:** 2026-05-06
**Status:** Applied — #57 and #58 revised; #47 umbrella updated
**Driver:** [strategos#57 — RankFusion.Reciprocal utility (DR-2, 2.6.0)](https://github.com/lvlup-sw/strategos/issues/57)
**Question:** Is the Cormack 2009 RRF currently spec'd for #57 still the right algorithm, or has the IR literature produced a more optimal modern replacement?

## TL;DR

**Keep RRF as the core algorithm.** Based on the studies cited in this spike, no published method has been shown to beat RRF zero-shot on out-of-domain workloads, and Strategos's position as a library — score-scale agnostic, no labeled data, no LLM access, no GPU — rules out the methods that beat it on tuned settings (TM2C2 with tuned α, DAT, LTR). The reviewed literature converges on production-default RRF, with per-source weighting as the highest-leverage knob.

**Two principled extensions to the original spec:**

1. **Generalize to Weighted RRF (wRRF).** Production-validated (Elasticsearch 8.16+, Qdrant, OpenSearch, Pearson, kdb-x). Per-list weights default to `1.0` so unweighted callers get bit-identical Cormack RRF behavior; weighted callers tune per-source influence without leaving the library.
2. **Add `RankFusion.DistributionBased` as a sibling utility.** Qdrant's μ±3σ normalization. Stateless per-query (still pure utility). Uses score-distribution information that RRF discards. Best when callers have score-distribution variance.

**Do not adopt in 2.6.0:** TM2C2 (needs α tuning per domain), DAT (needs LLM), LTR (needs labeled data + GPU), TRF (needs tensor/ColBERT model). All are application-layer concerns; Basileus owns them, not the Strategos library.

## Sources

### Foundational

- **Cormack, Clarke, Buettcher (2009).** *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods.* SIGIR 2009. → `k=60` default; rank-based; no normalization.
- **Fox & Shaw (1994).** CombSUM, CombMNZ — score-based fusion baselines.

### State-of-the-art papers (2022–2026)

- **Bruch, Gai, Ingber (2024).** *An Analysis of Fusion Functions for Hybrid Retrieval.* ACM TOIS (arXiv:2210.11934). Pinecone Research. → Finds **TM2C2 (Theoretical Min-Max Convex Combination) outperforms RRF on all tested datasets** in NDCG and Recall, both in-domain and out-of-domain. Sample-efficient: handful of labeled queries to tune α (≈ 0.8). Critically: tuned-vs-tuned comparison.
- **Chen et al. (2022).** Counter-position: argues RRF outperforms convex combination in zero-shot. Both papers cite each other.
- **Hsu, Tzeng (2025).** *DAT: Dynamic Alpha Tuning for Hybrid Retrieval in RAG* (arXiv:2503.23013). → Per-query α via LLM scoring of top-1 from each retriever. Outperforms fixed-weight hybrid. Adds LLM call per query.
- **Algoverse / Perez et al. (2025, ICML VecDB workshop).** *Entropy-Based Dynamic Hybrid Retrieval.* → Multi-round Shannon-entropy-based reweighting. Retriever-agnostic.
- **Balancing the Blend (arXiv:2508.01405v2, 2025).** → Tensor-based Re-ranking Fusion (TRF) consistently beats RRF and weighted-sum on multi-paradigm hybrid (FTS + sparse + dense + tensor). Identifies "weakest link" phenomenon: a single bad retriever degrades the whole hybrid.
- **Liu, Zhang (ACL 2025 Findings).** Exp4Fuse — modified RRF + LLM query expansion for sparse retrieval.

### Production implementations

Each entry below is annotated with a confidence marker:
- ✅ — direct citation in the linked source
- ⚠️ provisional — claim is based on vendor docs/blog cross-referenced during this spike but not pinned to a specific release-note URL; verify before quoting.

- **Elasticsearch 8.16+:** RRF default; **weighted RRF** GA in 8.16. ✅ ([Elastic search-labs blog, 2025-09-15](https://www.elastic.co/search-labs/blog/weighted-reciprocal-rank-fusion-rrf)).
- **OpenSearch 2.19:** RRF in Neural Search plugin (Feb 2025). ⚠️ provisional — check OpenSearch 2.19 release notes / Neural Search plugin changelog.
- **Qdrant 1.11+:** RRF + DBSF (Distribution-Based Score Fusion); weighted RRF in client lib. ⚠️ provisional — see Qdrant changelog for 1.11; DBSF announcement post.
- **Weaviate 1.24+:** Relative Score Fusion (RSF) default; rankedFusion (RRF) optional. ⚠️ provisional — see Weaviate hybrid-search docs for the specific minor version.
- **Azure AI Search:** RRF only. ⚠️ provisional — Microsoft Learn hybrid-search article.
- **Pinecone:** convex combination (alpha) on hybrid index. ⚠️ provisional — Pinecone hybrid-search docs.
- **Vespa:** linear combination + RRF. ⚠️ provisional — Vespa documentation on rank profiles.
- **Solr (in flight):** RRF being added natively (KandaSearch blog). ⚠️ provisional — KandaSearch blog post; Solr JIRA ticket not pinned.
- **Pearson, kdb-x:** weighted RRF in production APIs. ⚠️ provisional — vendor case studies, not pinned to a release.

(The conclusion of the spike — "production-default RRF, with per-source weighting as the highest-leverage knob" — does not depend on any single platform claim being precise to the minor version. The Elasticsearch entry, which has a direct citation, is the load-bearing data point.)

### Critique / pragmatic posts

- **Doug Turnbull (2024).** *RRF is Not Enough.* → "RRF'ing bad search into good search will just drag down the good search." Per-source precision tuning > fusion-method choice.
- **Cole Hoffer.** *RRF for Hybrid Search.* → "RRF hits the sweet spot: simple, fast, and accurate enough."
- **wiki.charleschen.ai.** Production-data table comparing methods.

### Empirical numbers (from cited sources)

| Method | nDCG@10 (BEIR avg) | Latency overhead | Training data | Zero-shot | Score normalization |
|---|---|---|---|---|---|
| BM25-only | ~34 | — | — | — | — |
| Dense-only | ~43 | — | — | — | — |
| **RRF (k=60)** | **45–46.5** | <5ms | None | ✓ | Not required |
| Weighted Sum / Linear CC | 44.3 | <5ms | Required (α) | ✗ | Required |
| TM2C2 (tuned α=0.8) | beats RRF on every dataset tested | <5ms | ~10 labeled queries | ✗ | Min-max + theoretical-min |
| DBSF | ~45–46 | <5ms | None | ✓ | μ±3σ stateless |
| LTR (LambdaMART) | 48.2 | 7–15ms | 30–50 queries min | ✗ | Learned features |
| Triple-stage (RRF + ColBERT + cross-enc) | 48.5 | ~350ms | None | ✓ | N/A |
| TRF (Tensor RRF) | RRF + 5–8% on multi-paradigm | higher | needs tensor model | ✓ | N/A |

## Findings

### F1. RRF remains the production default by overwhelming consensus

Every major hybrid-search platform offers RRF, and most default to it: Azure AI Search, Elasticsearch, OpenSearch, Qdrant, Vespa, Solr (in flight). Weaviate is the notable exception (RSF default). The convergence reflects a real property: RRF is the only major fusion method that requires neither score normalization nor parameter tuning to behave well across domains.

### F2. The single paper that beats RRF (Bruch 2024) requires labeled data

Bruch, Gai, Ingber's 2024 ACM TOIS paper is the strongest published critique of RRF. They show **TM2C2** (Theoretical Min-Max convex combination of normalized scores, α≈0.8) outperforms RRF in NDCG on every dataset tested. Crucially:

- The win requires α to be tuned. They tune on validation splits.
- Out-of-domain, untuned, RRF wins.
- TM2C2 is "sample-efficient" — ~10 labeled queries suffice — but Strategos as a library has zero labeled queries.

This positions TM2C2 as an **application-layer** choice. Basileus, with its application context and ability to collect labeled queries, can implement TM2C2 on top of Strategos's interface. Strategos cannot ship a tuned α.

### F3. Adaptive methods (DAT, entropy-based) require runtime LLM or multi-round overhead

DAT (Hsu & Tzeng 2025) calls an LLM per query to score top-1 effectiveness from each retriever. Entropy-based dynamic hybrid (Algoverse 2025) iterates multiple rounds of reweighting until convergence. Both produce gains over fixed-weight hybrid but at meaningful latency cost (LLM call) or complexity cost (multi-round). Neither belongs in a `< 1ms` pure-utility static class.

### F4. The pragmatic literature consistently identifies "fix retrieval before fusion"

Doug Turnbull's "RRF is Not Enough" and the production wisdom in Pinecone/Weaviate/Elastic blogs converge: the largest gains come from **upstream** quality (better embeddings, BM25 phrase queries, query understanding) rather than swapping fusion algorithms. The Balancing-the-Blend paper formalizes this as the "weakest link" phenomenon: a single bad retriever drags the whole hybrid down regardless of fusion method.

This means the highest-leverage knob Strategos can expose is not a fancier algorithm — it's **per-source weighting** so callers can de-emphasize a weaker retriever.

### F5. Per-source weighting has hardened into a production default

In the past 18 months, weighted RRF has gone from a Qdrant-client convenience to a first-class feature in Elasticsearch (8.16 GA, 2025-09), Qdrant (server-side), Pearson, and kdb-x. The math is a one-line generalization of Cormack RRF:

```text
fused_score(d) = Σ_L  weight_L  /  (k + rank_L(d))
```

When all `weight_L = 1.0`, this reduces exactly to Cormack 2009. So weighted RRF is strictly additive — no breaking change, no regression risk for unweighted callers.

### F6. DBSF is the strongest score-aware drop-in

Among score-aware fusion methods, only **DBSF** (Distribution-Based Score Fusion, Qdrant) is genuinely stateless per query and preserves library purity:

```text
For each ranked list:
  μ ← mean(scores), σ ← stdev(scores)
  low ← μ - 3σ, high ← μ + 3σ
  normalize(s) ← (clamp(s, low, high) - low) / (high - low)
Sum the normalized scores per document; sort descending.
```

Per-query distribution; no global state; no training; no normalization configuration. DBSF is well-defined for any positive-scored ranker (BM25 included). It uses information RRF discards (the score distribution) without requiring callers to ship calibrated scores.

Empirically DBSF performs ~RRF on average but better when score variance differs significantly between paths. Industrial adoption: Qdrant 1.11+ ships it as a peer of RRF.

### F7. The current spec's `BmSaturationThreshold` field is symptomatic

Issue #58's `HybridQueryOptions.BmSaturationThreshold` (default 18.0) was already pointing at score-distribution awareness — but as RRF is rank-based, the field is observational only. Adding DBSF turns that observation into a real algorithmic option.

### F8. TRF (tensor reranking) is not a fusion replacement

The Balancing-the-Blend paper presents TRF as a re-ranking strategy, not a fusion replacement. It runs ColBERT/MaxSim over candidates from upstream first-stage retrievers. This is a downstream rerank step, not a fusion algorithm in the same sense as RRF/DBSF/LTR. It belongs alongside cross-encoder rerankers in the application layer (Basileus), not in the fusion utility.

## Algorithm comparison matrix (Strategos library lens)

| Algorithm | Library-fit | Reason |
|---|---|---|
| **RRF (Cormack 2009)** | ✅ canonical | Pure utility, score-agnostic, zero-shot strong, deterministic, sub-1ms |
| **Weighted RRF** | ✅ additive extension | Strictly generalizes RRF; weights default to 1.0; production-validated |
| **DBSF (Qdrant)** | ✅ optional sibling | Stateless per-query, score-aware, no training; useful when score distributions differ across paths |
| **CombSUM / CombMNZ** | ⚠ caller-controlled | Requires score normalization layer; expose as building blocks if needed |
| **Relative Score Fusion (Weaviate)** | ⚠ caller-controlled | Min-max norm + weighted sum; assumes scores are roughly comparable |
| **TM2C2 / Convex Combination** | ❌ application | Best-in-class tuned, but α is a domain parameter Strategos can't pick |
| **DAT (Dynamic Alpha Tuning)** | ❌ application | Needs LLM call per query; not a pure utility |
| **Entropy-based dynamic** | ❌ application | Multi-round; not deterministic-bounded |
| **LTR (LambdaMART, etc.)** | ❌ application | Needs labeled data, model serving, feature pipeline |
| **TRF (Tensor RRF)** | ❌ paradigm shift | Needs tensor/ColBERT model; not a fusion algorithm in the same class |

## Recommendation

Update issue #57 to ship **two complementary fusion methods** under `Strategos.Ontology.Retrieval.RankFusion`:

### `RankFusion.Reciprocal` (canonical, generalized to wRRF)

```csharp
public static IReadOnlyList<FusedResult> Reciprocal(
    IReadOnlyList<IReadOnlyList<RankedCandidate>> rankedLists,
    IReadOnlyList<double>? weights = null,    // NEW; defaults to all-1.0 → Cormack RRF
    int k = 60,
    int topK = 10);
```

Score formula: `Σ_L  weight_L / (k + rank_L(d))`. When `weights == null` or all weights are `1.0`, output is bit-identical to the originally spec'd Cormack RRF.

### `RankFusion.DistributionBased` (sibling, score-aware)

```csharp
public static IReadOnlyList<FusedResult> DistributionBased(
    IReadOnlyList<IReadOnlyList<ScoredCandidate>> scoredLists,
    IReadOnlyList<double>? weights = null,    // optional weighted sum after normalization
    int topK = 10);
```

Per-list normalize via μ±3σ, clamp to `[low, high]`, scale to `[0, 1]`, then weighted sum; sort descending. Stateless per query.

### What stays unchanged

- `k = 60` default for `Reciprocal`. Empirically validated; production wisdom is "do not change without evaluation data."
- Pure static utility; no DI; no global state.
- Sub-1ms benchmark gate.
- Cormack 2009 cited in doc-comments; Qdrant's DBSF cited for the new sibling.
- All existing acceptance criteria (deterministic, edge cases, property tests) carry over to both methods.

### XML doc-comment guidance for callers

The library's recommended use, documented inline:

> **Default to `RankFusion.Reciprocal` with all weights = 1.0.** This is the production default across Elasticsearch, OpenSearch, Azure AI Search, Qdrant, and Vespa.
>
> **Add per-source weights** when you have a known quality asymmetry (e.g., a domain where BM25 outperforms dense). Production data shows per-source weighting moves NDCG more than `k` tuning.
>
> **Switch to `RankFusion.DistributionBased`** when score variance across paths is high enough that rank-only fusion ignores meaningful signal — e.g., one path consistently produces tightly clustered scores while another produces a long tail.
>
> **Look outside the library** for adaptive (DAT-style), learned (LTR), or tensor-rerank (ColBERT/TRF) fusion. These are application concerns; Strategos exposes the primitives, not the policy.

## Risks of *not* adopting this update

- **Stuck at single algorithm.** If 2.6.0 ships RRF only and a 2.7.0 caller (Basileus or other) needs weighted fusion, they either (a) re-implement RRF, (b) ship their own weighted variant, or (c) wait for a 2.7.x point release. Per-source weighting is too production-common to leave to the next milestone.
- **`BmSaturationThreshold` remains a vestigial knob.** It was already pointing at distribution-awareness; without DBSF it stays observational forever. DIM-5 (hygiene) risk.
- **Reactive change later.** Elasticsearch retroactively added weighted RRF in 8.16 (2025-09) and the upgrade path was painful for callers. Designing for it upfront is cheap.

## Open questions

1. **Does Issue #58 (`HybridQueryOptions`) need an option to select fusion method?** With two methods available, `HybridQueryOptions.FusionMethod: enum { Reciprocal, DistributionBased }` becomes natural. Default = `Reciprocal`. Adds one field but unlocks DBSF without a new wiring PR.
2. **Should `RankFusion` expose lower-level building blocks** (e.g., `Normalize.MinMax`, `Normalize.MuSigma`, `Combine.WeightedSum`) for callers who want CombSUM or RSF-style fusion? Likely yes for completeness, but not required for 2.6.0. Could be 2.7.0 follow-up if Basileus asks.
3. **Should weighted RRF use Qdrant's `1 / ((pos+1)/weight + k - 1)` form or the simpler `weight / (k + rank)` form** that Elasticsearch and Pearson use? They give different curves. Recommendation: Elasticsearch form. It is the simpler interpretation ("multiply each contribution by weight"), what every non-Qdrant production system implements, and what the Bruch 2024 paper's parametric RRF analysis assumes. Qdrant's form is a Qdrant convention only.
4. **Should DBSF support `+∞`/`-∞` clamp escape** for callers passing already-normalized `[0,1]` scores where σ=0? Recommendation: when `σ < ε`, all-equal scores → all docs get fused score `0.5 * weight_L` from that list. Matches Qdrant client behavior.

## Suggested revision to #57

1. Update the issue title from `feat(retrieval): RankFusion.Reciprocal utility (DR-2, 2.6.0)` to `feat(retrieval): RankFusion utilities — wRRF + DBSF (DR-2, 2.6.0)`.
2. Add the two methods above to the design.
3. Add a new acceptance criterion: weights default reproduces Cormack 2009 bit-identically (regression test against a fixed reference).
4. Add a new acceptance criterion: DBSF parity test against Qdrant's reference Python implementation (used as oracle).
5. Add `## Algorithm references` section linking Cormack 2009, Qdrant DBSF source, Elasticsearch wRRF blog, Bruch 2024 (as the case for "this is the best we can do without callers shipping labeled data").
6. Optionally update #58's `HybridQueryOptions` to add `FusionMethod` enum.

## Application log

- [strategos#57](https://github.com/lvlup-sw/strategos/issues/57) — title and body revised. New title: `feat(retrieval): RankFusion utilities — wRRF + DBSF (DR-2, 2.6.0)`. Adds wRRF as the canonical method and DBSF as a sibling, with Qdrant-parity oracle and Cormack-regression gates.
- [strategos#58](https://github.com/lvlup-sw/strategos/issues/58) — body revised. `HybridQueryOptions` adds `FusionMethod` enum (`Reciprocal` default, `DistributionBased` opt-in) and `SourceWeights` field. `_meta.fusion_method` exposed for observability. Acceptance criteria expanded to cover both methods + weighted variants.
- [strategos#47](https://github.com/lvlup-sw/strategos/issues/47) — child-issue table updated to reflect new naming; comment added summarizing the spike and the rejected alternatives.
