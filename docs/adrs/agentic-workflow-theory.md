# Agentic Workflow Theory: A Formal Framework

> In a deterministic workflow, your code executes a set of instructions. In a **probabilistic workflow**, your code **orchestrates a search for a valid outcome**. This requires "State Engineering" - designing the system so the only possible valid outputs are the ones you want.

## 1. Introduction: Probabilistic vs Deterministic Workflows

In traditional software engineering, a function $f(x)$ yields a deterministic output $y$.

In agentic engineering, an agent $A(x)$ yields a **distribution of likely outputs** $P(y|x)$.

The goal of system design is to **constrain the variance** of that distribution until the probability of a "correct" result approaches 1.0. This is achieved through:

- **Iterative Refinement** (sequential loops with feedback)
- **Ensemble Sampling** (parallel exploration with aggregation)
- **Action Space Constraint** (limiting valid transitions)

---

## 2. The Constrained MDP Framework

### 2.1 Why Not "Wave Function Collapse"?

The quantum mechanics metaphor is evocative but imprecise. Wavefunction collapse is:
- **Instantaneous** (measurement-induced)
- **Observer-dependent** (the act of measurement determines outcome)
- **Non-deterministic** (fundamentally random)

What we actually implement is a **Constrained Markov Decision Process (CMDP)** - a well-studied framework from reinforcement learning and control theory.

### 2.2 Formal CMDP Definition

The orchestration system is defined as a **reward-maximizing** CMDP with **budget constraints**:

$$\max_{\pi} \mathbb{E}\left[\sum_{t=0}^{T} \gamma^t R(s_t, a_t)\right] \quad \text{subject to} \quad \mathbb{E}\left[\sum_{t=0}^{T} \gamma^t C_i(s_t, a_t)\right] \leq d_i \quad \forall i$$

Where:
- $\pi: S \rightarrow A$ is the **policy** (the Orchestrator's decision function)
- $s_t \in S$ is the **state** at time $t$ (derived from Ledgers)
- $a_t \in A$ is the **action** taken (delegate to specialist, update ledger, etc.)
- $R(s_t, a_t)$ is the **reward function** (task progress, completion probability)
- $C_i(s_t, a_t)$ is the **i-th cost function** (tokens, latency, compute)
- $d_i$ is the **budget limit** for the i-th resource
- $\gamma \in [0,1]$ is the **discount factor** (urgency weighting)

**Why reward maximization over cost minimization?**

The previous formulation (minimizing cost) doesn't explicitly include task completion. A policy could trivially minimize cost by doing nothing. The reformulation makes the objective explicit:
- **Maximize:** Task completion probability (reward)
- **Subject to:** Resource budgets (constraints)

This aligns with standard CMDP literature (Altman, 1999) and recent work on multi-agent constrained planning (IEEE CDC, 2024).

### 2.3 Action Space Constraint

The key insight is that **variance reduction comes from constraining $A(s_t)$**, not from "collapsing" probability distributions.

At each state $s_t$, we define a **transition guard** $G(s_t)$ that restricts which actions are valid:

$$A(s_t) = \{a \in A : G(s_t, a) = \text{true}\}$$

For the Agentic Control Plane:
- From state `SELECTING`, valid actions are `{delegate_to_websurfer, delegate_to_analyst, delegate_to_coder}`
- From state `REVIEWING`, valid actions are `{update_progress, detect_loop, terminate}`
- Invalid transitions (e.g., `SELECTING → COMPLETE`) are **impossible by construction**

### 2.4 Discriminative vs Generative Selection

**Generative Selection** (high entropy):
- Orchestrator generates free-form text: "I think WebSurfer should handle this..."
- Infinite action space → high variance → unreliable

**Discriminative Selection** (low entropy):
- Orchestrator classifies from fixed set: `{WEBSURFER, ANALYST, CODER}`
- Constrained action space → low variance → reliable

Implementation via **logit bias** or **structured outputs**:

```python
def select_specialist(task_ledger, progress_ledger, capabilities):
    """Discriminative specialist selection (not generative)."""
    pending = [t for t in task_ledger.tasks if t.status == 'pending']
    next_task = argmax(pending, key=lambda t: priority_score(t))

    # Categorize task → constrained enum output via logit bias
    required_caps = categorize_task(next_task)

    # Match capabilities (deterministic selection)
    candidates = [
        (spec, len(required_caps & capabilities[spec]) / len(required_caps))
        for spec in SPECIALISTS
        if required_caps & capabilities[spec]
    ]

    return max(candidates, key=lambda x: x[1])[0]
```

### 2.5 Partial Observability Acknowledgment

The CMDP formulation above assumes **full observability**—the Orchestrator directly observes the true state $s_t$. In practice, the system exhibits **partial observability** characteristics of a POMDP:

- **Hidden State:** The true "task completion state" is not directly observable
- **Noisy Observations:** Specialist signals (SUCCESS, FAILURE, HELP_NEEDED) are imperfect observations $o_t$ of the underlying state
- **Belief Approximation:** The Progress Ledger serves as a **sufficient statistic** approximating a belief state $b_t$

**Why Not Full POMDP Formalism?**

While a complete POMDP formulation with explicit belief filtering (Kaelbling et al., 1998) would be theoretically precise, the MDP approximation remains tractable for practical implementation. The key insight is that the Progress Ledger's append-only structure naturally accumulates evidence that constrains the posterior over task completion states:

$$P(s_t | o_{1:t}) \approx f(\text{ProgressLedger}_t)$$

**Practical Implication:** Loop detection confidence scores (see §6.3 in the Architecture Document) should be interpreted as **uncertainty estimates** over the belief state, not deterministic state observations. A confidence score of 0.7 indicates 70% belief that the system is stuck, not a binary determination.

**References:**
- Kaelbling, L.P., Littman, M.L., Cassandra, A.R. (1998). "Planning and Acting in Partially Observable Stochastic Domains." Artificial Intelligence, 101(1-2), 99-134.
- Lim et al. (2023). "Particle Belief MDP: Adapting MDP Solvers to POMDPs."

### 2.6 Exploration-Exploitation in Specialist Selection

While discriminative selection constrains the action space, the Orchestrator still faces the **exploration-exploitation tradeoff**:
- **Exploitation:** Always select the specialist with highest historical success rate
- **Exploration:** Try specialists on novel task types to learn their capabilities

We recommend **Thompson Sampling** for this problem because:
1. **Small action space**: Fixed set of specialists (3-5) makes exploration tractable
2. **Non-stationary capabilities**: Specialist performance varies by task type
3. **Interpretable**: Explicit probability beliefs can be inspected and explained

#### Thompson Sampling with Capability Priors

Maintain a **Beta distribution** for each (specialist, task_type) pair:

$$\theta_{s,t} \sim Beta(\alpha_{s,t}, \beta_{s,t})$$

Where:
- $\theta_{s,t}$ = success probability of specialist $s$ on task type $t$
- $\alpha_{s,t}$ = successes observed (initialized from capability priors)
- $\beta_{s,t}$ = failures observed

**Prior Initialization (Hierarchical Bayes Recommended):**

The choice of prior significantly impacts early-stage behavior. Two approaches:

**Approach 1: Informative Priors (Domain Knowledge)**
```python
# Encodes human assumptions - may be miscalibrated for novel domains
# Beta(10, 1) implies 91% expected success rate before any observation
priors = {
    (WebSurfer, 'search'): Beta(10, 1),     # Strong prior for search
    (WebSurfer, 'analysis'): Beta(1, 5),    # Weak prior for analysis
    (Analyst, 'search'): Beta(1, 5),         # Weak prior for search
    (Analyst, 'analysis'): Beta(10, 1),     # Strong prior for analysis
    (Coder, 'implementation'): Beta(10, 1), # Strong prior for coding
}
```

**Approach 2: Hierarchical Bayes (Recommended)**

Use conservative global hyperpriors that adapt based on historical data:

```python
class HierarchicalThompsonSampler:
    """
    Thompson Sampling with hierarchical priors.
    Balances domain knowledge with data-driven adaptation.
    """
    def __init__(self):
        # Conservative global hyperprior (symmetric uncertainty)
        self.global_alpha = 2.0
        self.global_beta = 2.0

    def initialize_prior(self, specialist, task_type, historical_data=None):
        """
        Initialize prior for a (specialist, task_type) pair.

        Args:
            historical_data: Optional list of success/failure outcomes from logs
        """
        if historical_data and len(historical_data) >= 5:
            # Empirical Bayes: fit to historical success rates
            successes = sum(historical_data)
            total = len(historical_data)
            return Beta(
                self.global_alpha + successes,
                self.global_beta + total - successes
            )
        else:
            # Uninformative prior for novel/rare task types
            return Beta(self.global_alpha, self.global_beta)
```

**Why Hierarchical Bayes?**
- Informative priors like Beta(10, 1) encode strong assumptions that may not hold in new domains
- Hierarchical priors start conservative (50% expected success) and adapt to observed data
- Thompson Sampling Tutorial (Russo et al., 2018) recommends uninformative priors unless domain knowledge is validated
- This approach naturally handles novel task types without miscalibration

**Selection Algorithm:**
```python
def select_specialist_thompson(task_type: str, belief_state: Dict) -> Specialist:
    """
    Thompson Sampling specialist selection.

    Sample from posterior beliefs and select the specialist
    with highest sampled success probability.
    """
    samples = {}
    for specialist in SPECIALISTS:
        alpha = belief_state[specialist, task_type].alpha
        beta = belief_state[specialist, task_type].beta
        # Sample from posterior
        samples[specialist] = np.random.beta(alpha, beta)

    return max(samples, key=samples.get)
```

**Update Rule:**
```python
def update_belief(specialist: Specialist, task_type: str, success: bool, belief_state: Dict):
    """Update posterior belief after observing delegation outcome."""
    if success:
        belief_state[specialist, task_type].alpha += 1
    else:
        belief_state[specialist, task_type].beta += 1
```

**Cost-Adjusted Variant:**

For performance optimization, adjust sampling by specialist cost:

$$score(s) = \frac{\theta_s}{cost(s)}$$

Where $cost(s)$ includes expected token usage, execution time, and retry rate. This maximizes **value per resource unit**, not just success probability.

**Regret Bound:**

Thompson Sampling achieves logarithmic regret:

$$\mathbb{E}[R_T] = O\left(\sum_{s: \Delta_s > 0} \frac{\ln T}{\Delta_s}\right)$$

Where $\Delta_s = \theta^* - \theta_s$ is the suboptimality gap. This means exploration cost grows slowly while exploitation benefit grows linearly.

**Regret Bound Caveats:**

The logarithmic regret bound assumes:
1. **Stationary rewards:** Specialist capabilities don't change over time
2. **Independent arms:** Task types are independent (no structured dependencies)
3. **Known reward distributions:** Beta is the correct distributional family

In practice, these assumptions may not hold:
- Specialist capabilities may improve with context accumulation
- Task types have structured dependencies (search → analysis → synthesis)
- True reward distributions are unknown

**Extension: Contextual Bandits**

For systems where task features influence specialist performance, consider **contextual Thompson Sampling** with linear reward models:

```python
class ContextualThompsonSampler:
    """
    Thompson Sampling with task context features.
    Handles non-stationary, correlated task types.
    """
    def __init__(self, d: int, specialists: List[Specialist]):
        self.d = d  # Context feature dimension
        # Linear reward model per specialist: E[reward] = context @ theta
        self.theta = {s: np.zeros(d) for s in specialists}
        # Posterior covariance (tracks uncertainty)
        self.B = {s: np.eye(d) for s in specialists}

    def select_specialist(self, context: np.ndarray) -> Specialist:
        """Select specialist using Thompson Sampling with context."""
        samples = {}
        for s in self.specialists:
            mu = self.theta[s]
            Sigma = np.linalg.inv(self.B[s])
            # Sample from posterior
            theta_sample = np.random.multivariate_normal(mu, Sigma)
            samples[s] = context @ theta_sample

        return max(samples, key=samples.get)

    def update(self, specialist, context, reward):
        """Bayesian linear regression update."""
        self.B[specialist] += np.outer(context, context)
        self.theta[specialist] = np.linalg.solve(
            self.B[specialist],
            self.B[specialist] @ self.theta[specialist] + reward * context
        )
```

This extension enables the system to learn that, for example, "WebSurfer performs better on tasks with high web-search-relevance features" without manually encoding this as prior knowledge.

### 2.7 Iterative Variance Reduction

Each iteration through the Orchestrator loop **reduces expected uncertainty**:

$$\mathbb{E}[H(Y | X, s_T)] < H(Y | X, s_0)$$

Where $H(Y | X, s_t)$ is the conditional entropy of the output given input $X$ and accumulated state $s_t$.

**Important Qualification:** The entropy path may be **non-monotonic**. During exploration phases, discovering new information can temporarily **increase** entropy before it decreases.

*Example:* If an agent discovers that a problem is harder than expected (e.g., a web search reveals multiple conflicting sources), uncertainty may increase before the agent synthesizes a resolution.

The correct statement is that **expected terminal entropy** is lower than initial entropy, but individual paths may exhibit temporary entropy increases:

$$H(Y | X, s_0) \not> H(Y | X, s_1) \not> ... \not> H(Y | X, s_T)$$

However, the Progress Ledger accumulates observations that, on expectation, constrain future possibilities.

### 2.8 Budget Signaling to Specialists

Specialists should adapt their behavior based on remaining budget. This connects to recent research on Token-Budget-Aware LLM Reasoning (arXiv:2412.18547), which shows that explicit budget constraints in prompts can reduce token usage by 60-70% while maintaining accuracy.

**Budget Signaling Protocol:**

```python
def construct_specialist_prompt(
    task: Task,
    context: Context,
    budget: Budget
) -> str:
    """
    Construct specialist prompt with budget awareness.

    The scarcity level adapts specialist behavior:
    - Abundant: Explore freely, verbose explanations
    - Normal: Balanced approach
    - Scarce: Concise, essential work only
    - Critical: Minimal viable output
    """
    scarcity = scarcity_level(budget)

    budget_instruction = {
        Scarcity.ABUNDANT: "You have ample resources. Be thorough.",
        Scarcity.NORMAL: "Budget is moderate. Balance thoroughness with efficiency.",
        Scarcity.SCARCE: f"Budget is limited ({budget.remaining_tokens} tokens). Be concise.",
        Scarcity.CRITICAL: "CRITICAL: Minimal tokens remaining. Output only essentials.",
    }[scarcity]

    return f"""
{budget_instruction}

Task: {task.description}
Context: {context.summary}
Remaining tokens: {budget.remaining_tokens}
"""
```

This budget signaling creates a feedback loop where specialists self-regulate their output verbosity based on system-wide resource constraints.

**Dynamic Token Budget Estimation (TALE Framework)**

Static scarcity thresholds may over-allocate tokens for simple tasks or under-allocate for complex ones. Recent work on Token-Budget-Aware LLM Reasoning (Huang et al., 2024) demonstrates that **dynamic per-task budget estimation** reduces costs by 67% with minimal accuracy loss.

```python
class DynamicBudgetEstimator:
    """
    Estimate token budget based on task complexity.
    Based on TALE framework (arXiv:2412.18547).
    """
    def __init__(self, budget_model_path: str):
        # Small classifier trained on (task_features, optimal_tokens) pairs
        self.estimator = load_model(budget_model_path)

    def estimate_budget(self, task: Task, specialist: Specialist) -> int:
        """
        Predict tokens needed for this specific task.

        Returns estimated token budget with safety margin.
        """
        features = self.extract_features(task, specialist)
        estimated_tokens = self.estimator.predict(features)

        # Apply safety margin (1.2x) for complex reasoning
        return int(estimated_tokens * 1.2)

    def extract_features(self, task: Task, specialist: Specialist) -> Dict:
        """Extract features predictive of token requirements."""
        return {
            'task_length': len(task.description),
            'task_complexity': self.estimate_complexity(task),
            'specialist_type': specialist.type.value,
            'required_tools': len(task.required_capabilities),
            'historical_avg_tokens': self.get_historical_avg(specialist, task.category),
            'subtask_count': len(task.subtasks) if task.subtasks else 1,
        }

    def estimate_complexity(self, task: Task) -> float:
        """Heuristic complexity estimate based on task structure."""
        factors = [
            1.0 if 'search' in task.description.lower() else 0,
            1.5 if 'analyze' in task.description.lower() else 0,
            2.0 if 'synthesize' in task.description.lower() else 0,
            0.5 * len(task.required_capabilities),
        ]
        return sum(factors) / len(factors)
```

**Benefits of Dynamic Estimation:**
- Avoids over-allocation on simple tasks (token savings)
- Prevents under-allocation on complex tasks (quality preservation)
- Adapts to specialist-specific token usage patterns
- Enables per-task cost prediction for budgeting

---

## 3. Hierarchical State Machine (HSM) Formalism

### 3.1 HSM Definition

The orchestration system is a 7-tuple Hierarchical State Machine:

$$M = (S, S_0, A, \delta, G, I, L)$$

Where:
- $S$ = Hierarchical state space (nested states)
- $S_0 \in S$ = Initial state (`IDLE`)
- $A$ = Action alphabet
- $\delta: S \times A \times G \rightarrow S$ = Guarded transition function
- $G$ = Guard predicates over system context
- $I$ = Invariants (safety conditions)
- $L: S \rightarrow (\text{TaskLedger} \times \text{ProgressLedger})$ = State observation function

### 3.2 State Space Partitioning

The state space is hierarchically partitioned:

$$S = S_{\text{orchestrator}} \cup S_{\text{specialist}} \cup S_{\text{terminal}}$$

**Orchestrator States** (meta-level):
```
S_orchestrator = {IDLE, PLANNING, SELECTING, DELEGATING, REVIEWING, RESETTING, COMPLETE, FAILED}
```

**Specialist States** (nested sub-HSMs):
```
S_specialist = {RECEIVING, REASONING, GENERATING, EXECUTING, WAITING, INTERPRETING, SIGNALING}
```

Each specialist type (WebSurfer, Analyst, Coder) has its own sub-HSM with internal states.

### 3.3 Transition Function with Guards

The guarded transition function:

$$\delta(s, a, g) = s' \quad \text{iff} \quad g(\text{Context}) = \text{true}$$

Where Context = (TaskLedger, ProgressLedger, Budget, SpecialistCapabilities)

**Example Transitions**:

| Current State | Action | Guard Condition | Next State |
|---------------|--------|-----------------|------------|
| `IDLE` | `receive_input` | `true` | `PLANNING` |
| `PLANNING` | `update_task_ledger` | `\|tasks\| > 0` | `SELECTING` |
| `SELECTING` | `select_specialist` | `∃ capable specialist` | `DELEGATING` |
| `DELEGATING` | `delegate_task` | `budget.remaining > 0` | `REVIEWING` |
| `REVIEWING` | `update_progress` | `progress_made ∧ ¬complete` | `SELECTING` |
| `REVIEWING` | `detect_loop` | `no_progress_count ≥ threshold` | `RESETTING` |
| `REVIEWING` | `terminate` | `is_complete(TaskLedger)` | `COMPLETE` |

### 3.4 Invariants (Safety Conditions)

The system maintains these invariants at all times:

$$I = \{I_{\text{budget}}, I_{\text{progress}}, I_{\text{security}}, I_{\text{termination}}, I_{\text{loop}}\}$$

- **Budget Invariant**: $\forall t: \text{steps\_consumed}(t) \leq \text{STEP\_BUDGET}$
- **Progress Invariant**: Each specialist turn produces observable change or requests help
- **Security Invariant**: All tool calls route through ControlPlane
- **Termination Invariant**: All execution paths reach a terminal state
- **Loop Invariant**: Consecutive no-progress bounded by threshold

### 3.5 Ledger-State Relationship

The observation function $L$ maps HSM states to observable history:

$$L: S \rightarrow (\text{TaskLedger} \times \text{ProgressLedger})$$

**Task Ledger** (immutable, append-only):
- Goal: Original user request
- Tasks: Decomposed subtasks with status, dependencies, priority
- Constraints: Time, budget, resource limits

**Progress Ledger** (accumulating observations):
- Entries: Chronological record of specialist actions
- Artifacts: Named outputs with filesystem paths
- Metrics: Token consumption, duration, success rates

---

## 4. Budget Algebra and Scarcity

### 4.1 Resource Types

The system tracks multiple resource dimensions:

$$\text{Resources} = \{\text{steps}, \text{tokens}, \text{executions}, \text{tool\_calls}, \text{wall\_time}\}$$

### 4.2 Budget Lifecycle

$$\text{Budget} = (\text{allocated}, \text{consumed}, \text{reserved}, \text{remaining})$$

Operations:
- **allocate**: Initialize budget for task
- **reserve**: Pre-commit resources for in-flight operations
- **commit**: Convert reserved to consumed on completion
- **release**: Return unused reserved resources

### 4.3 Scarcity-Aware Decision Making

Define scarcity level as:

$$\text{scarcity}(B) = \begin{cases}
\text{Abundant} & \text{if } \frac{B.\text{remaining}}{B.\text{allocated}} > 0.7 \\
\text{Normal} & \text{if } 0.3 < \frac{B.\text{remaining}}{B.\text{allocated}} \leq 0.7 \\
\text{Scarce} & \text{if } 0.1 < \frac{B.\text{remaining}}{B.\text{allocated}} \leq 0.3 \\
\text{Critical} & \text{if } \frac{B.\text{remaining}}{B.\text{allocated}} \leq 0.1
\end{cases}$$

**Scarcity-aware action scoring**:

$$\text{score}(a) = \frac{\mathbb{E}[\text{value}(a)]}{\text{cost}(a) \times \text{scarcity\_multiplier} \times (1 - \text{importance} \times 0.5) + 1}$$

| Scarcity Level | Multiplier | Strategy |
|----------------|------------|----------|
| Abundant | 1.0 | Normal operation |
| Normal | 1.5 | Prioritize high-value tasks |
| Scarce | 3.0 | Reduce scope to essentials |
| Critical | 10.0 | Early termination or graceful failure |

### 4.4 Critic Persona (Adversarial Governance)

The Critic is a **game-theoretic adversary** in a two-player evaluation:

- **Orchestrator** proposes actions
- **Critic** evaluates value/cost ratio with **failure-biased heuristics**

Critic system prompt:
> "You are a skeptical reviewer. You MUST identify at least one concern for every proposal. You are biased toward rejection - only approve actions with clear justification."

**Approval threshold**: Action proceeds only if $\text{critic\_score} \geq 0.7$

This creates an **adversarial equilibrium** where:
- Orchestrator must justify resource expenditure
- Low-value actions are blocked
- Budget is preserved for high-impact work

---

## 5. System Optimization Matrix

| Layer | Control Concept | Probabilistic State | Deterministic State | Implementation |
|:------|:----------------|:--------------------|:--------------------|:---------------|
| **Input Context** | Interface Abstraction | Agents read `.py` proxies, wasting tokens | Agents see `.pyi` typed interfaces only | **Trust Boundary**: ControlPlane filters filesystem queries |
| **Orchestration** | Constrained MDP | Generative "Who's next?" (infinite $A$) | Discriminative classification ($\|A(s)\| \leq k$) | **Logit Bias / Enums**: Force valid transition tokens |
| **Code Bridge** | Static Analysis | Runtime feedback (slow loop) | Pre-flight verification | **AST Parsing**: Reject syntax/import errors before transmission |
| **Memory / State** | Variable Binding | Implicit inference (hallucination risk) | Explicit payload transfer | **Artifact Manifests**: Structured JSON paths between states |
| **Governance** | Objective Optimization | Latent goal alignment | Adversarial equilibrium | **Critic Personas**: Failure-biased reviewers with step budgets |
| **Prompting** | Exemplar Retrieval | Pure ReAct reasoning (fragile) | Retrieval-augmented prompts | **Vector Search**: Similar task exemplars injected into specialist prompts |

**Note on Exemplar Retrieval:** Research (arXiv:2405.13966) demonstrates that ReAct-style prompting benefits derive primarily from exemplar-query similarity rather than inherent reasoning capabilities. Retrieval-augmented prompting provides more reliable performance by including 2-3 successful task exemplars in specialist prompts.

---

## 6. The "Header-First" Workflow

This workflow implements the **Trust Boundary** model for tool visibility.

### 6.1 Workflow Steps

1. **Discovery**: Agent runs `ls servers/web`
2. **Filtering**: ControlPlane applies filter: `files.Where(f => f.EndsWith(".pyi"))`
3. **Observation**: Agent sees `search.pyi` (type stub only)
4. **Generation**: Agent writes `import servers.web.search`, trusting signature `(query: str) -> List`
5. **Verification**: AgentHost runs AST parsing to validate syntax and imports
6. **Execution**: Sandbox imports actual `search.py` and executes `call_mcp_tool` logic

### 6.2 Trust Boundary Model

Security comes from **mediation**, not hiding:

- Agents cannot directly access the Sandbox filesystem
- All file operations are mediated by ControlPlane
- ControlPlane can selectively filter responses
- Agent sees **Logical View**; Runtime sees **Physical View**

```python
def list_files(path: str) -> List[str]:
    files = os.listdir(path)
    if AGENT_CONTEXT:
        # Expose only type stubs to agents
        return [f for f in files if f.endswith('.pyi')]
    return files
```

This architecture creates a clean separation between:
- **Logical View**: What the Agent perceives (constrained, typed interfaces)
- **Physical View**: What the Runtime executes (full implementation)

---

## 7. Architectural Implications

When moving to probabilistic workflows, architecture must adapt:

| Aspect | Traditional App | Agentic App |
|:-------|:----------------|:------------|
| **Latency** | Milliseconds (DB queries) | Seconds/Minutes (reasoning loops) |
| **UX Pattern** | Request/Response (blocking) | Async/Streaming (SSE, WebSockets) |
| **State** | ACID database | Conversation state (Ledgers) |
| **Testing** | Unit tests (`assert x == y`) | Evals (`assert similarity(x, y) > 0.9`) |
| **Failure Mode** | Exceptions | Result types with error channels |
| **Resource Model** | Unbounded compute | Budget-constrained with scarcity |

---

## 8. Summary

The Agentic Control Plane achieves reliability through:

1. **Constrained MDP**: Formal framework with reward maximization subject to budget constraints
2. **Hierarchical State Machine**: Nested states with guarded transitions
3. **Discriminative Selection**: Classification over fixed sets, not generative reasoning
4. **Thompson Sampling**: Bayesian exploration-exploitation for specialist selection
5. **Budget Algebra**: Resource tracking with scarcity-aware decision making
6. **Budget Signaling**: Explicit budget communication to specialists for self-regulation
7. **Adversarial Governance**: Critic personas enforce justification for resource expenditure
8. **Trust Boundary**: Security through mediation, not obscurity

The goal is **variance reduction**: each design pattern constrains the action space $A(s_t)$ until the probability of correct output approaches 1.0.

---

## 9. References

### Foundational Theory

1. **Constrained MDPs**: Altman, E. "Constrained Markov Decision Processes." Chapman & Hall/CRC, 1999.

2. **Multi-Agent CMDPs**: "Compositional Planning for Logically Constrained Multi-Agent Markov Decision Processes." IEEE CDC, 2024. [arXiv:2410.04004](https://arxiv.org/html/2410.04004)

3. **Hierarchical CMDPs**: "Planning using Hierarchical Constrained Markov Decision Processes." Autonomous Robots, 2017.

4. **Thompson Sampling**: Russo, D. et al. "A Tutorial on Thompson Sampling." Foundations and Trends in Machine Learning, 2018.

### LLM Agent Systems

5. **Magentic-One**: Microsoft Research. "Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks." arXiv:2411.04468, 2024.

6. **ReAct Framework**: Yao, S. et al. "ReAct: Synergizing Reasoning and Acting in Language Models." ICLR, 2023.

7. **ReAct Fragility**: "On the Brittle Foundations of ReAct Prompting for Agentic Large Language Models." arXiv:2405.13966, 2024.

### Resource Management

8. **Token-Budget-Aware Reasoning**: "Token-Budget-Aware LLM Reasoning." arXiv:2412.18547, 2024.

9. **Reasoning in Token Economies**: Wang et al. "Reasoning in Token Economies: Budget-Aware Evaluation of LLM Reasoning Strategies." EMNLP, 2024.

### State Machine Theory

10. **Hierarchical State Machines**: Yannakakis, M. "Hierarchical State Machines." Bell Laboratories.
