Here is a capture of the core concepts and the new strategic framing we developed for Exarchos.

The fundamental shift was moving away from positioning Exarchos as a generic "AI wrapper" or "process manager," and instead marketing it as a strict architectural solution to the inherent unreliability of LLMs.

### The Core Paradigm: Durable Execution for Agentic Workflows

The foundational message is that engineers shouldn't have to manage non-deterministic AI through fragile chat sessions. Exarchos brings the discipline of **infrastructure-as-code and durable state machines** to AI coding. It enforces a deterministic SDLC on non-deterministic agents.

### The 3 Core Pillars (Pain vs. Solution)

**1. Context Shedding & Hydration (Solving Context Exhaustion)**

- **The Problem:** LLM context windows get bloated with diffs and conversational noise, leading to hallucinations and forgotten instructions.
- **The Exarchos Solution:** Stateful checkpointing. You can `/checkpoint` the exact workflow state, nuke the bloated chat session, and `/rehydrate` the pristine, structured state back into a new agent window using only ~3k tokens. It cleanly decouples workflow state from conversational memory.

**2. Deterministic State Machines (Solving Inconsistent Runs)**

- **The Problem:** Asking an agent to build a feature three times yields three different architectural outcomes.
- **The Exarchos Solution:** Typed convergence gates. Agents are forced through a strict pipeline (Ideate → Plan → Implement → Review). They don't advance just because the code compiles; they advance because they pass discrete gates (e.g., Spec Compliance and Code Quality). The workflow converges on *your* architecture, not the LLM's current whim.

**3. Machine-Readable Runbooks (Solving Fragile Prompts)**

- **The Problem:** Copy-pasting massive Markdown files of system rules is brittle and often ignored by the agent by turn three.
- **The Exarchos Solution:** Zod-validated Runbooks via MCP. Instead of begging the LLM to follow rules, Exarchos feeds the agent ordered, schema-validated tool calls specific to its current phase. It treats the agent as a pipeline worker executing discrete steps.

### Framing the v3.0 Roadmap: CLI Maturity & Automation

We positioned the upcoming open issues as the bridge from a "local IDE companion" to an "enterprise-grade developer toolchain."

- **Infrastructure-Grade Observability:** Features like `exarchos ps`, `describe`, and `export` treat AI tasks like running backend processes. You can query, view, and share the exact state of parallel agent teams directly from the terminal.
- **Event-Driven CI/CD:** NDJSON streaming and `wait` gates make Exarchos headless-ready, allowing automated pipelines (like GitHub Actions) to trigger or block based on the agent's semantic state transitions.