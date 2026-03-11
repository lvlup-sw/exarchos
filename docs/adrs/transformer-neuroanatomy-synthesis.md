# Transformer Neuroanatomy: Identity Collapse, Emergent Circuits, and Latent Reasoning

> **Research synthesis** — Three converging lines of evidence revealing the internal functional
> structure of large language models, the pathology of deep-layer identity collapse, and the
> implications for next-generation architecture design.
>
> *Compiled: March 2026*

---

## Sources

| # | Source | Authors / Origin | Key Contribution |
|---|--------|-----------------|------------------|
| 1 | [LLM Neuroanatomy: How I Topped the AI Leaderboard Without Changing a Single Weight](https://dnhkng.github.io/posts/rys/) | dnhkng (blog, 2024–2026) | Empirical discovery of functional anatomy via layer-duplication scanning |
| 2 | [The Curse of Depth in Large Language Models](https://arxiv.org/abs/2502.05795) | Sun et al. (NeurIPS 2025) | Mathematical proof that Pre-LN causes deep layers to converge toward identity |
| 3 | [Scaling Up Test-Time Compute with Latent Reasoning](https://arxiv.org/abs/2502.05171) | Geiping et al. (2025) — "Huginn" | Recurrent latent-space iteration as an alternative to chain-of-thought scaling |

---

## 1. Executive Summary

Three independent research threads — one empirical/hobbyist, one theoretical, one architectural —
converge on the same deep insight about transformer-based large language models:

1. **Deep layers in current LLMs are largely inert.** Pre-Layer Normalization causes output variance
   to grow exponentially with depth, which forces the Jacobian of deep transformer blocks toward the
   identity matrix. Those layers effectively pass their input through unchanged.

2. **The layers that *do* work are organized into discrete functional circuits.** Training
   spontaneously creates an anatomy: early layers encode input into a universal latent
   representation, middle layers contain indivisible multi-layer reasoning circuits, and late layers
   decode back to token space.

3. **Reasoning can be scaled by iterating circuits, not just stacking parameters.** Both
   RYS-style layer duplication and Huginn-style recurrent blocks demonstrate that running reasoning
   circuits multiple times — in latent space, without producing extra tokens — dramatically improves
   performance.

The combined implication: current transformer architectures waste significant capacity on near-
identity layers, while under-investing in the iterative reasoning that the model's own internal
structure seems designed for.

---

## 2. The Curse of Depth — Why Deep Layers Become Identity Functions

### The Problem

Sun et al. (2025) study the widespread observation that removing or pruning deep layers from
production LLMs (Llama, Mistral, DeepSeek, Qwen) causes surprisingly little performance
degradation. They coin the term **"Curse of Depth"** and provide a mathematical explanation.

### Root Cause: Pre-Layer Normalization (Pre-LN)

Nearly all modern LLMs use **Pre-LN** (applying LayerNorm *before* the attention/FFN sub-blocks
rather than after). Pre-LN stabilizes training and enables deeper models, but it has a hidden cost:

- Each transformer block's contribution is normalized by a factor that grows with depth.
- The **output variance grows exponentially** with the number of layers.
- This causes the **derivative (Jacobian) of deep blocks to approach the identity matrix**:

  > As depth increases, ∂output/∂input → I (the identity matrix)

- In practical terms: a deep layer's forward pass becomes approximately `output ≈ input + ε`,
  where ε is vanishingly small. The layer is *technically* doing something, but its contribution
  is negligible.

### Scale of the Problem

The paper confirms this across major model families. Roughly **half the layers** in many production
LLMs contribute far less than expected. This is not a failure of those specific models — it is a
structural consequence of Pre-LN applied to deep stacks.

### Proposed Fix: LayerNorm Scaling (LNS)

The paper proposes scaling the variance of each LayerNorm's output inversely by the square root of
its depth:

> LNS scales the normalization factor as `1 / √depth`

Tested across model sizes from 130M to 7B parameters, LNS consistently outperforms prior
normalization techniques, and the improvement carries through to supervised fine-tuning. The gains
come specifically from making deep layers contribute meaningfully again.

---

## 3. LLM Neuroanatomy — Empirical Discovery of Functional Structure

### Background & Motivation

In late 2023, independent researcher dnhkng made two observations that motivated a systematic
investigation:

**Observation 1: Base64 Reasoning.** Sufficiently capable LLMs can accept questions encoded in
Base64, *understand* them, reason about them, and return answers *also encoded in Base64*. This
works despite Base64 producing completely different tokenization patterns. The implication: the model
must be translating arbitrary input formats into a **universal internal representation**, reasoning
in that space, and then translating back. If so, the early and late layers act as format
translators, and the middle layers do something format-agnostic.

**Observation 2: The Goliath Merge.** HuggingFace user Alpindale created Goliath-120B by
interleaving layers from two different fine-tuned Llama-2-70B models — including feeding the output
of *later* layers into the input of *earlier* layers from a different model. This should have
produced garbage (each layer is trained to expect the statistical distribution of its predecessor).
The fact that it *worked at all* suggested that the internal representations across layers are far
more homogeneous than expected — consistent with many layers being near-identity.

### The Method: Exhaustive Layer-Duplication Scanning

For a model with N layers, dnhkng defined configuration (i, j): run layers 0 through j−1 normally,
then loop back and re-run layers i through j−1 a second time, then continue to layer N−1. No
weights are modified. The model simply traverses some of its own layers twice.

For Qwen2-72B (80 layers), this produces 3,241 configurations. Each was evaluated on two
deliberately orthogonal probes:

| Probe | What it tests | Why it was chosen |
|-------|--------------|-------------------|
| **Hard math** (intuitive, no chain-of-thought) | Abstract numerical reasoning | Tiny output (just a number), objectively scorable |
| **EQ-Bench** (emotional state prediction) | Theory of mind, social inference | Tiny output (a few numbers), objectively scorable, maximally different from math |

The key constraint: if a configuration improves *both* tasks simultaneously, the benefit is
**structural** (more reasoning depth) rather than **task-specific** (an artifact of the probe).

### Results: The Brain Scan Heatmaps

The heatmaps produced by this exhaustive sweep function as **functional MRIs of the transformer**:

#### What the heatmaps reveal

- **Early layers (≈ first 10–15%):** Duplicating these degrades performance. They are input
  encoders — running them twice corrupts the encoding.

- **Late layers (≈ last 20–25%):** Duplicating these has **almost no effect**. This is the
  identity-collapse region predicted by the Curse of Depth paper. These layers are already doing
  approximately nothing.

- **Middle layers (≈ 55–70% of the stack):** Complex, structured patterns. Some regions show
  strong improvement; others show strong degradation. The boundaries are sharp.

#### The Optimal Configuration for Qwen2-72B

The best configuration was **(45, 52)**: layers 45 through 51 execute twice, adding seven extra
layers in the execution path (no new weights). Applied to a fine-tune of Qwen2-72B, this produced
**RYS-XLarge** — which reached **#1 on the HuggingFace Open LLM Leaderboard**:

| Benchmark | Improvement over base |
|-----------|----------------------|
| MuSR (0-shot) | **+17.72%** |
| MATH Lvl 5 (4-shot) | **+8.16%** |
| BBH (3-shot) | +2.51% |
| GPQA (0-shot) | +2.58% |
| MMLU-PRO (5-shot) | +0.31% |
| IFEval (0-shot) | −2.05% |
| **Average** | **+2.61%** |

Critically: the probes used during development (math guesstimates + EQ-Bench) were **completely
different** from the leaderboard benchmarks. The leaderboard was pure out-of-sample validation.
The structural improvement generalized.

As of early 2026, the **top four models** on the Open LLM Leaderboard are all RYS-XLarge
descendants (further fine-tuned by others).

### Key Finding: Circuits, Not Individual Layers

The most important structural finding:

> **Duplicating a single layer almost never helps.** But duplicating a *complete block* of
> consecutive layers (typically 5–8 layers) can dramatically help — if and only if the block
> boundaries align with the model's internal circuit boundaries.

This rules out the hypothesis that middle layers perform independent iterative refinement (where
any one layer could be beneficially repeated). Instead, middle layers are organized into
**functional circuits**: coherent multi-layer units that perform complete cognitive operations.

Think of layers 46–52 not as seven workers doing the same job, but as seven steps in a recipe:

- Layer 46: decomposes a representation into subcomponents
- Layer 47: identifies relationships between subcomponents
- Layer 48: step three of the operation
- ...
- Layer 52: produces the final result

Duplicating one step of the recipe doesn't help. Duplicating the *entire recipe* gives the model a
second pass — a chance to refine its abstractions.

Including even one layer from a *neighboring* circuit collapses the benefit. The boundaries are
sharp. Pre-training carves these structures out, and they only work whole.

### Cross-Model Generality

Heatmap scans across different model families (Llama-3-70B, Phi-3-medium, GPT-OSS-120B,
Qwen3-30B-A3B, GLM-4.7) show:

- The **general three-zone anatomy** (encode → reason → decode) appears consistently
- The **specific circuit boundaries** differ across architectures
- **Larger models** have cleaner separation between functional regions
- **Smaller models** show more entanglement — reasoning is spread across the stack

---

## 4. Huginn — Scaling Reasoning via Latent-Space Iteration

### The Architecture

Geiping et al. (2025) take the "reasoning circuits can be iterated" insight and build an
architecture explicitly designed for it. Huginn uses a **recurrent block** that can be unrolled to
arbitrary depth at test time:

- A fixed set of layers constitutes the recurrent block
- At inference, the block iterates N times (configurable)
- All reasoning happens **in latent space** — no extra tokens are produced
- The model learns when additional iterations are beneficial

### Key Differences from Chain-of-Thought

| Property | Chain-of-Thought | Huginn (Latent Reasoning) |
|----------|-----------------|--------------------------|
| Where reasoning happens | Token space (visible output) | Latent space (hidden states) |
| Requires specialized training data | Yes (reasoning traces) | No |
| Context window consumption | Grows with reasoning length | Constant |
| Types of reasoning captured | Must be expressible in words | Can capture non-verbal patterns |
| Scaling mechanism | Produce more tokens | Iterate the recurrent block |

### Results

A 3.5B-parameter Huginn model, trained on 800B tokens, improves performance on reasoning
benchmarks — sometimes dramatically — up to a computation load equivalent to a **50B-parameter
model**. The model achieves this purely by iterating its recurrent block more times, with no
architectural changes or additional parameters.

---

## 5. Synthesis: The Converging Picture

These three sources tell a unified story about transformer internal organization:

### 5.1 The Three-Zone Anatomy

```
┌─────────────────────────────────────────────────────────────────────┐
│                     TRANSFORMER LAYER STACK                        │
│                                                                     │
│  ┌──────────────┐                                                   │
│  │  ENCODER      │  Early layers (~10-15%)                          │
│  │  ZONE         │  • Translate any input format into universal      │
│  │               │    latent representation                         │
│  │               │  • Format-agnostic (handles English, Base64,     │
│  │               │    code, etc.)                                   │
│  │               │  • Duplication degrades performance              │
│  ├──────────────┤                                                   │
│  │  REASONING    │  Middle layers (~55-70%)                         │
│  │  CORTEX       │  • Contains discrete functional circuits         │
│  │               │  • Each circuit is 5-8 layers, indivisible       │
│  │               │  • Operates in universal latent space            │
│  │               │  • Duplication of complete circuits improves     │
│  │               │    performance                                   │
│  │               │  • Boundaries are sharp — partial circuits       │
│  │               │    degrade performance                           │
│  ├──────────────┤                                                   │
│  │  IDENTITY     │  Deep layers (~20-25%)                           │
│  │  COLLAPSE     │  • Near-identity due to Pre-LN Curse of Depth   │
│  │  ZONE         │  • Jacobian ≈ Identity matrix                   │
│  │               │  • Duplication has negligible effect             │
│  │               │  • Pruning causes minimal degradation            │
│  ├──────────────┤                                                   │
│  │  DECODER      │  Final layers (~5-10%)                           │
│  │  ZONE         │  • Translate latent representation back to       │
│  │               │    token space                                   │
│  └──────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 Emergent System Properties

These properties arise from training alone — they are not designed into the architecture:

| Property | Evidence | Implication |
|----------|----------|-------------|
| **Self-organizing functional anatomy** | Heatmap scans show consistent encode/reason/decode zones across model families | Training spontaneously creates brain-like regional specialization |
| **Circuit formation** | Single-layer duplication fails; block duplication succeeds only at circuit boundaries | Reasoning self-organizes into indivisible multi-layer units |
| **Identity layer collapse** | Mathematical proof (Curse of Depth) + empirical confirmation (late-layer duplication has no effect) | ~25% of parameters in current LLMs are near-inert |
| **Universal latent space** | Base64 reasoning works; cross-model layer shuffling works (Goliath); circuit duplication generalizes across benchmarks | Middle layers operate in a format- and task-agnostic representation |
| **Iterative refinement compatibility** | RYS duplication improves performance; Huginn recurrence scales reasoning | The latent representations are naturally stable under re-entry into the same circuit |

### 5.3 Why These Findings Reinforce Each Other

The three sources form a tight explanatory loop:

1. **Curse of Depth explains *why* layer shuffling and duplication are even possible.** If deep
   layers are near-identity, their outputs are statistically similar to their inputs. This makes
   the model robust to architectural rearrangement — you're shuffling layers that barely change
   anything.

2. **RYS scanning reveals *where* the actual computation happens.** The middle-layer circuits that
   survive identity collapse are where all the real reasoning lives. The heatmaps are essentially
   mapping the boundary between "live" and "dead" layers.

3. **Huginn shows *how to exploit this* architecturally.** If reasoning circuits can be profitably
   iterated (as RYS proved), designing explicit iteration into the architecture captures this
   benefit without relying on post-hoc layer duplication.

---

## 6. Implications

### For Architecture Design

- **Embrace recurrence in the reasoning core.** The transformer's strictly feed-forward design
  fights against the iterative nature of the reasoning circuits it develops. Huginn demonstrates
  that explicit recurrence in latent space is viable and powerful.

- **Fix or replace Pre-LN.** LayerNorm Scaling (LNS) is a minimal fix. More radical approaches
  might rethink normalization entirely to prevent identity collapse.

- **Design variable-depth inference.** Allow models to iterate their reasoning circuits a problem-
  appropriate number of times, rather than using a fixed number of layers for every token.

### For Efficiency

- **Current LLMs waste ~25% of their parameters.** The identity-collapse zone represents
  significant compute and memory spent on near-no-ops. Pruning these layers or replacing them
  with iterative reasoning could dramatically improve efficiency.

- **RYS-style duplication is nearly free in memory.** Duplicated layers can be implemented as
  pointers to the same weights. The only cost is additional compute and KV-cache — a small price
  for measurable quality improvements.

### For Scaling

- **Reasoning scales with iteration, not just parameters.** Huginn achieves 50B-equivalent
  performance with 3.5B parameters by iterating. RYS achieves leaderboard-topping results by
  adding zero new parameters. The scaling paradigm should shift from "more layers" to "more
  passes through the right layers."

- **Test-time compute scaling without token overhead.** Unlike chain-of-thought (which consumes
  context window), latent-space iteration adds zero tokens. This is critical for context-limited
  applications.

### For Interpretability

- **Circuit boundary mapping is a new interpretability tool.** RYS-style heatmap scanning provides
  a structural map of the model's functional organization — analogous to fMRI for neural networks.
  This could bootstrap more targeted mechanistic interpretability efforts.

- **The "emergence" debate gets more concrete.** These aren't mysterious capabilities appearing at
  scale. They're *structural properties* — self-organizing functional regions that become more
  differentiated as models grow. Larger models have cleaner circuit separation; smaller models show
  more entanglement.

### For Training

- **Pre-training is sculpting anatomy, not just learning facts.** The model isn't only learning
  *what* to represent — it's learning *how to organize its own computational pipeline*. This
  reframes what pre-training accomplishes.

- **Fine-tuning may primarily fix junction points.** dnhkng hypothesizes that fine-tuning on
  RYS models mainly repairs the disjuncture where a duplicated block re-enters the original
  layer sequence. If true, minimal targeted fine-tuning at junction layers could be sufficient.

---

## 7. Open Questions

1. **Are the circuit boundaries consistent across training runs?** If two models of the same
   architecture are trained with different seeds, do they develop circuits at the same layer
   positions?

2. **Can circuit boundaries be predicted from training dynamics?** Is there a signal during
   training that indicates when and where circuits are forming?

3. **What is the optimal number of iterations?** Both RYS (2 passes) and Huginn (variable)
   show benefits. Is there a diminishing-returns curve? Does it vary per problem difficulty?

4. **Do circuits correspond to identifiable cognitive functions?** Can specific circuits be mapped
   to specific capabilities (math, language understanding, social reasoning, code generation)?

5. **How do Mixture-of-Experts models interact with this picture?** MoE models route tokens
   through different experts — does this interact with or replace the circuit structure?

6. **Can LayerNorm Scaling and iterative reasoning be combined?** If LNS rescues deep layers from
   identity collapse, and iteration leverages middle-layer circuits, combining both could yield
   compounding benefits.

---

## 8. Key Takeaways

> **The deepest insight across all three sources:** Transformers don't just learn *what* to think —
> they learn *how to organize their own thinking apparatus*. That organization converges on a
> recognizable anatomy across model families, with distinct encoding, reasoning, and decoding
> regions. The reasoning region contains discrete, indivisible circuits. And due to a normalization
> pathology, a large fraction of the deepest layers collapse into identity functions that contribute
> almost nothing.
>
> The practical upshot: we can make models dramatically smarter by giving them **more time to think**
> (iterating their reasoning circuits) rather than **more things to think with** (adding parameters).
> This is the difference between giving someone a bigger library and giving someone more time to
> read.

---

*References and further reading:*

- RYS-XLarge model: [huggingface.co/dnhkng/RYS-XLarge](https://huggingface.co/dnhkng/RYS-XLarge)
- LayerNorm Scaling code: [github.com/lmsdss/LayerNorm-Scaling](https://github.com/lmsdss/LayerNorm-Scaling)
- Huginn model: [huggingface.co/tomg-group-umd/huginn-0125](https://huggingface.co/tomg-group-umd/huginn-0125)
- Huginn code: [github.com/seal-rg/recurrent-pretraining](https://github.com/seal-rg/recurrent-pretraining)
