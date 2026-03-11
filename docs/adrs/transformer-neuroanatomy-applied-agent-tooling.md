# Applied Transformer Neuroanatomy: Agent Tooling Patterns for Frontier Model APIs

> **Addendum to:** [Transformer Neuroanatomy: Identity Collapse, Emergent Circuits, and Latent
> Reasoning](./transformer-neuroanatomy-synthesis.md)
>
> This document translates the theoretical findings from the synthesis document into **actionable
> patterns for agent tooling** built on frontier model APIs (Claude, GPT, etc.) — where you cannot
> modify model internals but can design orchestration that works *with* the model's internal
> cognitive structure. It then applies these patterns to a concrete **AI-assisted feature
> development workflow** (brainstorming → design → planning → parallel implementation → review).
>
> *Compiled: March 2026*

---

## Premise

The synthesis document establishes three key findings about transformer internals:

1. **Deep layers collapse toward identity** — ~25% of parameters are near-inert (Curse of Depth)
2. **Middle layers self-organize into indivisible reasoning circuits** — complete multi-layer units
   that perform discrete cognitive operations (RYS / LLM Neuroanatomy)
3. **Reasoning scales by iterating circuits, not stacking parameters** — running reasoning circuits
   multiple times on their own output improves quality (RYS, Huginn)

You cannot access any of this directly through an API. But you *can* design agent orchestration
that exploits the same structural principles at the application layer. The model's internal anatomy
doesn't change just because you're calling it through an API — understanding that anatomy lets you
work with it instead of against it.

---

## Pattern 1: Strategic Thinking Budget Allocation

### The Research Basis

RYS demonstrated that duplicating a *complete* reasoning circuit dramatically improves performance,
while partial duplication provides no benefit or even degrades it. The benefit function is
non-linear: you need the full circuit pass, or the extra compute is wasted.

### The Application-Layer Analog

Claude's extended thinking and similar features are the API-accessible equivalent of "iterate the
reasoning circuits more." The non-linear finding translates directly: **don't set arbitrary small
thinking budgets. Either allocate enough for a full reasoning pass, or skip extended thinking
entirely.**

### Implementation Guidance

| Task Complexity | Thinking Budget | Rationale |
|---|---|---|
| Routing, classification, parameter extraction | None / minimal | These are encoding-layer tasks; extra reasoning iterations add latency without benefit |
| Single-step analysis (summarize, explain, translate) | Low–moderate | One full reasoning pass is sufficient |
| Multi-step reasoning (debugging, planning, code review) | High | These tasks benefit from the model's reasoning circuits firing multiple times |
| Novel / ambiguous problems (architecture decisions, edge-case analysis) | Maximum | Incomplete reasoning passes on hard problems produce unreliable results — budget for the full pass or decompose the problem instead |

### Anti-Pattern

Setting a moderate thinking budget on a hard problem. The circuit model predicts this is **worse
than either extreme** — you've spent tokens on a partial reasoning pass that doesn't complete.
Either commit to deep thinking or restructure the problem to be simpler.

---

## Pattern 2: Multi-Pass Refinement as Orchestration-Layer Circuit Duplication

### The Research Basis

RYS layer duplication runs the model's reasoning circuits twice on progressively refined
representations. The second pass operates on the output of the first, catching what was missed and
refining abstractions. This is why *block* duplication works but *single-layer* duplication doesn't
— the second pass needs to be a complete reasoning cycle.

### The Application-Layer Analog

You cannot duplicate internal layers, but you can **run the model over the same problem multiple
times with refined context**. Each API call gives the model's reasoning circuits a fresh, complete
pass. The key is that the second call operates on *the model's own refined output from the first
call* — exactly matching the RYS mechanism.

### Implementation Guidance

#### Basic Two-Pass Pattern

```
Pass 1 (Generate):
  "Analyze this code for potential bugs."
  → Raw findings (broad, may include false positives)

Pass 2 (Refine):
  "Here are potential bugs found in this code: [Pass 1 output].
   For each, assess whether it's a real bug or a false positive.
   Return only confirmed issues with confidence scores."
  → Filtered, high-confidence results
```

#### Three-Pass Pattern for Complex Tasks

```
Pass 1 (Explore):
  "What are the possible approaches to [problem]?"
  → Option space

Pass 2 (Analyze):
  "Given these approaches: [Pass 1 output].
   Evaluate trade-offs for our specific context: [constraints]."
  → Assessed options with rationale

Pass 3 (Commit):
  "Given this analysis: [Pass 2 output].
   Select the best approach and produce the implementation plan."
  → Decisive, well-reasoned output
```

### When to Use Multi-Pass vs. Single-Pass

| Signal | Recommendation |
|---|---|
| Task has a clear, well-defined answer | Single pass with adequate thinking budget |
| Task requires judgment under ambiguity | Two-pass: generate then refine |
| Task involves exploring a solution space | Three-pass: explore, analyze, commit |
| You're seeing intermittent failures on a task | Add a refinement pass — the task likely needs a second circuit iteration to converge reliably |

### Anti-Pattern

Using multi-pass as a substitute for clear problem specification. If the model is failing because
the prompt is ambiguous, a second pass will refine garbage into more confident garbage. Multi-pass
works because it gives reasoning circuits another iteration — it doesn't fix bad inputs.

---

## Pattern 3: Cognitive Function Isolation

### The Research Basis

Transformers develop a three-zone anatomy: **encoding** (parse input into latent representation),
**reasoning** (process in latent space), and **decoding** (translate back to output format). These
are distinct computational functions handled by different regions of the model.

### The Application-Layer Analog

When a single prompt demands all three functions simultaneously — "parse this complex input, reason
about it, and produce this specific output format" — you're forcing the model to interleave
cognitive functions that its architecture handles as a pipeline. **Isolating these into separate
calls lets each function run cleanly.**

### Implementation Guidance

#### The Decomposition

| Phase | Cognitive Function | Example Call |
|---|---|---|
| **Encode** | Parse complex/messy input into clean structured representation | "Parse this error log and extract: timestamp, error type, stack trace, affected component" |
| **Reason** | Analyze, infer, decide, plan from the structured representation | "Given this structured error data, determine the root cause and propose a fix" |
| **Decode** | Format the reasoning output into the required schema/format | "Format this fix proposal as a JSON patch operation matching this schema: ..." |

#### When Isolation Is Worth the Latency Cost

Not every call needs this decomposition. Guidelines:

- **Simple tasks:** Single call is fine. The model handles encode→reason→decode in one pass for
  straightforward problems.
- **Tasks that fail intermittently:** This is the strongest signal. If the same prompt sometimes
  produces great results and sometimes fails, the cognitive functions are likely interfering with
  each other. Isolate them.
- **Tasks with complex input *and* complex output format requirements:** These put the heaviest
  simultaneous load on encoding and decoding, squeezing the reasoning circuits. Decompose.
- **Tasks where input format differs dramatically from output format:** Translating between
  formats (e.g., reading logs → producing structured JSON) taxes encoding and decoding heavily.

### Anti-Pattern

Over-decomposing simple tasks. The three-call pattern adds ~2x latency and token cost. For
straightforward tasks where the model reliably succeeds in one call, the overhead is pure waste.
Reserve decomposition for your hardest, least reliable agent operations.

---

## Pattern 4: Self-Consistency as a Convergence Signal

### The Research Basis

In latent-space iteration models (Huginn), representations converge as the recurrent block iterates
— the reasoning "settles" on a stable answer. The rate of convergence is a natural confidence
signal: fast convergence means the reasoning circuits agree; slow or non-convergent iterations mean
the problem is ambiguous or underspecified.

### The Application-Layer Analog

You cannot observe latent convergence through an API. But you can approximate it by running the
same decision **multiple times** and measuring agreement. If the model's reasoning circuits converge
reliably, independent calls will produce the same answer. If they don't, the reasoning is
unstable.

### Implementation Guidance

```
Run 1: "Should this PR be approved? Explain your decision."  → Approve (minor issues)
Run 2: "Should this PR be approved? Explain your decision."  → Approve (minor issues)
Run 3: "Should this PR be approved? Explain your decision."  → Reject (security concern)

Consensus: 2/3 Approve — but the dissent raised a security concern.
Action:  Flag for human review with the security concern highlighted.
```

#### Decision Matrix

| Consistency | Confidence | Action |
|---|---|---|
| 3/3 agree | High | Act autonomously |
| 2/3 agree, dissent is minor | Moderate | Act on majority, log the dissent |
| 2/3 agree, dissent raises new concern | Low | Escalate to user with the divergent reasoning |
| No majority | Very low | Decompose the problem further, add context, or escalate |

#### When to Use Consistency Checks

- **Before irreversible actions:** git commits, API mutations, sending messages, updating work
  items. The cost of 2–3 extra calls is trivial compared to the cost of undoing a mistake.
- **For classification/routing decisions** that affect downstream workflows. A mis-routed task
  compounds errors through the rest of the pipeline.
- **Not needed for:** idempotent operations, exploratory analysis, draft generation, or any task
  where the user will review the output before it takes effect.

### Anti-Pattern

Using self-consistency as a substitute for better context. If all three runs produce different
answers, the problem isn't model randomness — it's that the input is genuinely ambiguous. Adding
more runs won't help. Add more context or ask the user to clarify.

---

## Pattern 5: Context Window as Scarce Cognitive Resource

### The Research Basis

Latent-space reasoning (Huginn) consumes zero context window — it operates entirely within the
model's hidden states. Chain-of-thought reasoning, by contrast, consumes context tokens that
compete with actual data for the model's attention. The context window is not just a size limit —
it's a **cognitive bandwidth limit**.

### The Application-Layer Analog

In agent workflows with multiple steps, naively carrying forward full outputs from every previous
step is the application-layer equivalent of consuming context window with reasoning traces.
**Reserve context for data; let extended thinking handle reasoning; summarize aggressively between
steps.**

### Implementation Guidance

#### The Summarization Discipline

For multi-step agent workflows:

```
Step 1: Analyze codebase structure
  → Full output: 2,000 tokens of file listings and analysis
  → Carry forward: 200-token summary of key findings

Step 2: Identify affected files for the change
  → Input: 200-token summary + original user request
  → Full output: 1,500 tokens of file-by-file analysis
  → Carry forward: 300-token summary of affected files and why

Step 3: Generate the implementation
  → Input: 300-token summary + relevant file contents (actual data)
  → Full context budget available for the files that matter
```

Without summarization, Step 3 would have 3,500 tokens of prior analysis competing with file
contents for attention. With summarization, that drops to 500 tokens, leaving room for the data
the model actually needs.

#### Extended Thinking as Free Reasoning

When using Claude or similar models with thinking/reasoning features:

- **Put data in the prompt** — file contents, tool outputs, structured context
- **Put reasoning demands in the instruction** — "analyze," "determine," "plan"
- **Let extended thinking do the heavy lifting** — it doesn't consume your output context or
  pollute the conversation history

This means: don't ask the model to "think step by step" in its visible output if extended thinking
is available. You're paying context-window tax for reasoning that could happen for free in latent
space.

### Anti-Pattern

Carrying raw tool outputs through multi-step workflows. A `grep` result with 50 matches, a full
file listing, or a complete API response should be **consumed and summarized in the step that
requested it**, not forwarded verbatim to every downstream step.

---

## Pattern 6: Model Tiering Aligned with Cognitive Function

### The Research Basis

The three-zone anatomy means different tasks engage different parts of the model. Encoding and
decoding are handled by shallow, early/late layers. Reasoning is handled by deep middle-layer
circuits. A model's "tier" (Haiku vs. Sonnet vs. Opus) roughly corresponds to the depth and
sophistication of its reasoning circuits.

### The Application-Layer Analog

Match model tier to cognitive demand. Most agent infrastructure tasks are encoding or decoding —
they don't need deep reasoning circuits.

### Implementation Guidance

| Task Type | Cognitive Function | Recommended Tier | Why |
|---|---|---|---|
| Tool call routing / classification | Encoding | Fast / cheap (Haiku) | Pattern matching, no deep reasoning needed |
| Input parsing / extraction | Encoding | Fast / cheap (Haiku) | Structural, not analytical |
| Code analysis / bug detection | Reasoning | Standard (Sonnet) | Requires multi-step logical analysis |
| Architecture decisions / design | Reasoning (deep) | Premium (Opus) | Requires complex trade-off evaluation |
| JSON/format generation from clear spec | Decoding | Fast / cheap (Haiku) | Mechanical translation, minimal reasoning |
| Summarization of prior steps | Encoding + light reasoning | Fast / cheap (Haiku) | Compression, not novel analysis |
| Code generation from clear plan | Decoding + moderate reasoning | Standard (Sonnet) | Needs some reasoning but plan provides the thinking |

#### Cost Implication

In a typical multi-step agent workflow, **60–70% of calls are encoding or decoding tasks** that
can run on the cheapest tier. Only 30–40% require genuine reasoning. Tiering these properly can
cut API costs by 50%+ with no quality loss on the reasoning-heavy steps.

### Anti-Pattern

Using the most capable model for every call "just to be safe." The research tells us *why* this is
wasteful: encoding and decoding tasks don't exercise the reasoning circuits that distinguish
premium models. You're paying for circuits that aren't firing.

---

## Pattern 7: Prompt Structure Aligned with Layer Anatomy

### The Research Basis

The model processes input sequentially through its layers: encoding → reasoning → decoding. The
order and structure of your prompt influences how cleanly these functions activate.

### The Application-Layer Analog

Structure prompts so that the information the model needs to **encode** comes first, the
**reasoning request** comes in the middle, and the **output specification** comes last. This
aligns your prompt with the model's internal processing pipeline.

### Implementation Guidance

#### Recommended Prompt Structure

```
┌─────────────────────────────────────────────────┐
│  1. CONTEXT & DATA  (activates encoding)        │
│     - System prompt with role and constraints    │
│     - Relevant file contents / tool outputs      │
│     - Structured data the model needs to process │
├─────────────────────────────────────────────────┤
│  2. REASONING REQUEST  (activates reasoning)     │
│     - The actual question or task                │
│     - Criteria for evaluation                    │
│     - Constraints on the decision                │
├─────────────────────────────────────────────────┤
│  3. OUTPUT SPECIFICATION  (activates decoding)   │
│     - Required format (JSON schema, markdown)    │
│     - Response length constraints                │
│     - Examples of desired output                 │
└─────────────────────────────────────────────────┘
```

#### Common Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Output format specified first, data dumped last | Decoding specification gets "buried" by subsequent encoding load | Move format spec to the end |
| Question asked before context is provided | Model must hold the question in working memory while encoding context | Provide context first, ask the question after |
| Data, questions, and format specs interleaved | Forces context-switching between cognitive functions | Group by function: all data → all questions → all format specs |

---

## Applied Example: AI-Assisted Feature Development Workflow

The seven patterns above are general-purpose. This section applies them concretely to a specific
multi-phase workflow: **AI-assisted feature development** with brainstorming, design, planning,
parallel implementation, and two-stage review.

### Workflow Overview

```
 ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
 │ Brainstorming │──→│ Design Doc   │──→│ Plan Decomp  │──→│ Parallel     │──→│ Two-Stage    │
 │ (interactive) │   │ (generation) │   │ (TDD tasks)  │   │ Impl (agents)│   │ Review       │
 └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
         │                   │                   │                   │                   │
    Pattern 1           Pattern 3           Pattern 2           Patterns           Patterns
    (budgets)          (isolation)         (multi-pass)         1, 5, 6             2, 4
                                                              (budget,           (refinement,
                                                              context,           convergence)
                                                              tiering)
```

### Cross-Cutting Refinement: Phase Transitions Are Compression Points

Before discussing each phase, the single highest-impact structural change applies to **every
transition between phases**:

```
Brainstorming ──→ [SUMMARIZE] ──→ Design
Design        ──→ [SUMMARIZE] ──→ Planning
Planning      ──→ [SCOPE]     ──→ Each Subagent
Implementation──→ [SUMMARIZE] ──→ Review
```

Each arrow should be a **deliberate compression step** (Pattern 5) where the output of the
previous phase is distilled into the minimum context the next phase needs.

The anti-pattern is carrying full transcripts/outputs forward through every phase. By the review
stage, accumulating raw brainstorming notes + full design doc + complete plan + all implementation
output creates a context window packed with irrelevant noise. The reviewer needs: the spec, the
code, and a summary of key design decisions. Nothing else.

**Rule of thumb:** If a downstream phase would receive more than ~30% of its context budget from
upstream artifacts, you need a compression step.

---

### Phase 1: Brainstorming — Asymmetric Thinking Budgets

**Current state:** Interactive back-and-forth where the model asks clarifying questions and the
user refines the problem definition.

**What's already right:** The back-and-forth is naturally a multi-pass refinement (Pattern 2).
Each Q&A round is an application-layer circuit iteration that deepens the model's understanding.
This phase is well-designed by default.

**Refinement: Budget asymmetrically across turns.**

The model choosing *which question to ask* is the hardest reasoning task in this phase — it must
identify gaps, ambiguities, unstated assumptions, and contradictions across everything discussed
so far. Parsing the user's answers is comparatively cheap encoding work.

| Turn | Cognitive Load | Thinking Budget |
|---|---|---|
| Model asks clarifying questions | High (reasoning: what's missing? what's ambiguous?) | **High** |
| Model processes user's answer | Low-moderate (encoding: parse and integrate new information) | **Low–moderate** |

This is not about making every model turn expensive. It's about recognizing that question
*selection* is where the reasoning circuits do their heaviest work in this phase.

---

### Phase 2: Design Document — Separate Designing from Documenting

**Current state:** After brainstorming, the model produces a design document — typically in a
single generation step.

**The problem:** This conflates two distinct cognitive functions. **Designing** (reasoning about
architecture, trade-offs, scope boundaries) and **documenting** (producing a well-structured
document following a template) are handled by different parts of the model's cognitive pipeline
(Pattern 3). When forced to do both simultaneously, the formatting demands compete with the
reasoning — producing documents that are either well-formatted but superficial, or thorough but
poorly organized.

**Refinement: Two-call decomposition.**

```
Call 1 — Design Reasoning (high thinking budget):
  Input:  Compressed brainstorming summary
  Prompt: "Given this problem definition, determine:
           - The core architectural approach and alternatives considered
           - Key trade-offs and why this path was chosen
           - Risks, open questions, and mitigation strategies
           - Scope boundaries (what's in, what's explicitly out)"
  Output: Raw design decisions (unformatted, reasoning-dense)

Call 2 — Document Generation (moderate thinking budget):
  Input:  Raw design decisions from Call 1 + document template
  Prompt: "Produce a design document from these decisions,
           following this template: [template]"
  Output: Clean, structured design document
```

The first call is pure reasoning — no formatting overhead. The second call is primarily decoding
— translating structured decisions into a document. Each call gets to focus on its cognitive
function without interference.

---

### Phase 3: Plan Decomposition — Add an Intermediate Abstraction Layer

**Current state:** The design document is decomposed directly into concrete TDD tasks.

**The problem:** Going from abstract design to concrete test-driven tasks in a single step is a
large cognitive leap. The model must simultaneously: understand the design holistically, identify
natural work boundaries, determine dependencies, decompose into testable units, and write
concrete task specs. The circuit model (Pattern 2) predicts this benefits from at least one
intermediate pass.

**Refinement: Three-stage decomposition.**

```
Pass 1 — Logical Decomposition (reasoning-heavy):
  Input:  Design document
  Prompt: "Identify the logical work units in this design.
           What are the natural boundaries between components?
           What depends on what? What can be developed independently?"
  Output: Abstract work units with dependency graph

Pass 2 — Concrete Task Generation (reasoning + decoding):
  Input:  Work units from Pass 1 + design doc (for reference)
  Prompt: "Decompose each work unit into concrete TDD tasks.
           Each task needs: test specification, implementation scope,
           acceptance criteria, estimated complexity."
  Output: Concrete task list with TDD specs

Pass 3 — Parallelization Planning (reasoning + encoding):
  Input:  Task list from Pass 2 + dependency graph from Pass 1
  Prompt: "Which tasks can run in parallel? What's the critical path?
           What specific context does each subagent need from the
           design doc? (Quote the relevant sections, don't say
           'see the design doc.')"
  Output: Execution plan with subagent context packages
```

The middle pass is where the biggest quality gain lies. Going abstract → concrete in one step
commonly produces tasks that are either too vague (the model didn't finish reasoning about
boundaries) or over-granular (the model over-decomposed to compensate for lacking a clear
intermediate structure).

---

### Phase 4: Parallel Implementation — Tier, Budget, and Scope Each Subagent

**Current state:** Tasks are delegated to parallelized subagent workstreams.

**Refinement 1: Classify tasks and assign model tier + thinking budget (Patterns 1, 6).**

Not all implementation tasks exercise reasoning circuits equally. Assigning the same model and
budget to every subagent wastes resources on simple tasks and under-serves complex ones.

| Task Type | Model Tier | Thinking Budget | Example |
|---|---|---|---|
| Test scaffolding / boilerplate | Fast (Haiku) | Low | "Create test file with these cases stubbed out" |
| Interface / type definitions | Fast (Haiku) | Low | "Define TypeScript interfaces from this spec" |
| Core logic implementation | Standard (Sonnet) | High | "Implement the algorithm described in this task" |
| Integration / wiring | Standard (Sonnet) | Moderate | "Connect module A to module B per this contract" |
| Edge case / error handling | Standard+ (Sonnet/Opus) | High | "Handle these failure modes with proper recovery" |

**Refinement 2: Scoped context per subagent (Pattern 5).**

Each subagent should receive only:

- Its specific task description and acceptance criteria
- The relevant *slice* of the design document (extracted in Pass 3 above)
- Interface contracts for adjacent tasks it depends on or feeds into

Each subagent should **not** receive:

- The brainstorming transcript
- The full design document
- Other subagents' task descriptions
- The complete dependency graph

The temptation is to give every subagent maximum context "just in case." The research predicts
this is counterproductive — irrelevant context competes with relevant context for the model's
attention within the context window. A subagent implementing a database module doesn't benefit
from knowing the UI component's acceptance criteria — it's noise that dilutes the signal.

---

### Phase 5: Two-Stage Review — Refine Each Stage and Check Convergence

**Current state:** Two sequential reviews: spec conformance, then code quality.

**What's already right:** Separating spec conformance from code quality is textbook cognitive
function isolation (Pattern 3). Each review focuses on a different type of analysis, letting the
model's reasoning circuits specialize.

**Refinement 1: Make each review stage two-pass (Pattern 2).**

```
Spec Conformance:
  Pass 1 (High-recall): "Compare this implementation against the design spec.
                          Flag every potential deviation, even uncertain ones."
                          → Raw findings (will include false positives)

  Pass 2 (High-precision): "Review these findings against the spec.
                             For each, classify as: real violation,
                             acceptable implementation choice, or false positive.
                             Drop false positives."
                             → Filtered, assessed findings

Code Quality:
  Pass 1 (High-recall): "Review this code for bugs, security issues,
                          performance problems, and maintainability concerns."
                          → Raw issues list

  Pass 2 (High-precision): "Rate each issue by severity and confidence.
                             Drop anything below [confidence threshold].
                             Prioritize the remainder."
                             → Ranked, high-confidence issues
```

The first pass is designed for **recall** (catch everything, accept false positives). The second
pass is designed for **precision** (filter to what matters). This directly mirrors RYS circuit
duplication — the second pass refines the first pass's output through a complete reasoning cycle.

**Refinement 2: Self-consistency check on the spec conformance verdict (Pattern 4).**

Run the spec conformance review 2–3 times independently. Assess agreement:

| Consistency | Confidence | Action |
|---|---|---|
| All runs agree: implementation conforms | High | Proceed to code quality review |
| All runs agree: spec violation exists | High | Flag for remediation |
| Runs disagree on a specific area | Variable | **The disagreement is the signal** — it identifies exactly where the spec is ambiguous or the implementation is on the boundary. Escalate that specific area for human review. |

The disagreement case is the most valuable. Rather than producing a definitive (but potentially
wrong) verdict, the consistency check surfaces the *genuinely hard judgment calls* for human
attention — which is exactly where human review time is best spent.

---

### Summary of Workflow Refinements

| Phase | Current | Refinement | Patterns Applied |
|---|---|---|---|
| Brainstorming | Back-and-forth Q&A | Asymmetric thinking budgets (high on model question turns) | 1 |
| Design Document | Single generation step | Split reasoning from document generation into two calls | 3 |
| Plan Decomposition | Design → concrete TDD tasks | Three-stage: logical units → concrete tasks → parallelization plan | 2 |
| Parallel Implementation | Uniform subagents | Tier model + budget by task type; scope context per subagent | 1, 5, 6 |
| Spec Conformance Review | Single pass | Two-pass (high-recall then high-precision) + consistency check | 2, 4 |
| Code Quality Review | Single pass | Two-pass (raw issues then prioritized/filtered) | 2 |
| All phase transitions | Carry forward full output | Deliberate summarization/compression at each boundary | 5 |

---

## Synthesis: The Orchestration Mindset

These patterns and their applied workflow share a unifying principle:

> **Design agent orchestration as if you're managing the model's cognitive resources — not just
> generating prompts.**

The traditional approach to agent design treats the model as a stateless text-to-text function:
put prompt in, get response out, repeat. The transformer neuroanatomy research reveals that
there's a structured cognitive pipeline behind that function, with distinct encoding, reasoning,
and decoding phases, and that reasoning benefits from iteration.

Designing with this knowledge means:

1. **Right-size thinking budgets** — full reasoning passes or none (Pattern 1)
2. **Give hard problems multiple passes** — each pass is an application-layer circuit iteration
   (Pattern 2)
3. **Isolate cognitive functions** for your least reliable tasks (Pattern 3)
4. **Measure convergence** before irreversible actions (Pattern 4)
5. **Protect context window** for data, not reasoning traces (Pattern 5)
6. **Match model tier to cognitive demand** — cheap models for encoding/decoding, expensive models
   for reasoning (Pattern 6)
7. **Structure prompts to match the pipeline** — context first, question second, format last
   (Pattern 7)

The applied workflow section above demonstrates how these seven patterns compose into a complete
multi-phase development process — with specific refinements at each phase boundary. The patterns
are general-purpose; the workflow shows how they stack.

None of these patterns require access to model internals. All of them are informed by understanding
what's happening inside.

---

## Quick Reference: Decision Flowchart

```
                        ┌─────────────────────┐
                        │  Agent receives task │
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │ Is it encoding or    │──── Yes ──→  Use fast/cheap model
                        │ decoding only?       │              No extended thinking
                        └──────────┬──────────┘
                                   │ No
                        ┌──────────▼──────────┐
                        │ Does it fail         │──── Yes ──→  Isolate cognitive functions
                        │ intermittently?      │              (Pattern 3)
                        └──────────┬──────────┘
                                   │ No
                        ┌──────────▼──────────┐
                        │ Is it a hard         │──── Yes ──→  Multi-pass refinement
                        │ reasoning problem?   │              High thinking budget
                        └──────────┬──────────┘              (Patterns 1 + 2)
                                   │ No
                        ┌──────────▼──────────┐
                        │ Is the action        │──── Yes ──→  Self-consistency check
                        │ irreversible?        │              before acting
                        └──────────┬──────────┘              (Pattern 4)
                                   │ No
                        ┌──────────▼──────────┐
                        │ Single pass,         │
                        │ standard model,      │
                        │ moderate thinking    │
                        └─────────────────────┘
```

---

*See also: [Transformer Neuroanatomy: Identity Collapse, Emergent Circuits, and Latent
Reasoning](./transformer-neuroanatomy-synthesis.md) for the underlying research synthesis.*
