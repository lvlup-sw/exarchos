# Design: Distributed Agentic SDLC — Tiered Orchestration with Unified Event Stream

## Problem Statement

We have two complementary systems for agent-assisted software development:

1. **Exarchos** (local) — Claude Code agent teams coordinated by a bridge MCP server, operating on the developer's machine with git worktrees for isolation and local workflow-state for persistence.
2. **Agentic Coder** (remote) — Autonomous coding agents running in containerized environments on the Basileus backend, with Wolverine sagas for durable state and Marten event sourcing for audit trails.

Today these are separate designs. Combined, they unlock a distributed agentic SDLC pipeline where multiple features progress concurrently through design, implementation, review, and delivery — with minimal human checkpoints. The developer's role shifts from writing code to steering a fleet of agents.

### Target Outcome

- Multiple features in flight simultaneously, each progressing through the full SDLC pipeline
- Developer-led mode: Exarchos coordinates local agent teams, delegates heavy tasks to Basileus
- Autonomous mode: CI events trigger Basileus directly for bug fixes, dependency updates, and routine tasks
- Unified observability: one event stream, one set of views, regardless of where work executes
- Human checkpoints only at plan approval and merge confirmation

## Chosen Approach

**Tiered Orchestration with Unified Event Stream** — two coordination layers, each optimized for its execution environment, connected by a shared Marten event stream.

- **Local tier (Exarchos):** Choreography. Claude Code teammates react to events autonomously. Fast, interactive, context-rich. Optimized for the developer-in-the-loop.
- **Remote tier (Basileus):** Orchestration. Wolverine sagas manage Agentic Coder container lifecycle. Durable, recoverable, auditable. Optimized for autonomous execution.
- **Unified tier (Marten):** Shared event stream. Both tiers emit events to the same stream. CQRS materialized views present a single picture regardless of where work executes.

### Rationale

Per Microsoft's [Saga pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga): *choreography for simple local flows, orchestration for complex cross-service flows*. Per Microsoft's [AI Agent Orchestration patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns): *Magentic orchestration for complex generalist multi-agent collaboration*.

The event stream is the unifying abstraction — not a shared coordination model. Teammates and containers are both event producers/consumers. CQRS views make local and remote work indistinguishable to the consumer.

## Technical Design

### Architecture Overview

```
+=========================================================================+
|  DEVELOPER WORKSTATION                                                   |
|                                                                          |
|  +---------------------+     +---------------------------------------+  |
|  | Claude Code Lead    |     | Exarchos MCP Server                   |  |
|  | (Orchestrator)      |---->| (Local Choreography)                  |  |
|  |                     |     |                                       |  |
|  | - /ideate, /plan    |     | Team Coordinator:                     |  |
|  | - /delegate         |     |   spawn/message/shutdown teammates    |  |
|  | - /integrate        |     |                                       |  |
|  | - /review           |     | Event Store:                          |  |
|  | - /synthesize       |     |   local JSONL + outbox for sync       |  |
|  +---------------------+     |                                       |  |
|         |                    | Task Router:                           |  |
|         v                    |   local vs. remote dispatch decisions  |  |
|  +------+------+------+     |                                       |  |
|  | TM 1  | TM 2 | TM N |     | View Materializer:                    |  |
|  | Impl  | Impl | Revw |     |   merged local+remote CQRS views      |  |
|  +------+------+------+     +------------------+--------------------+  |
|                                                 |                       |
+=================================================|=======================+
                                                  | HTTPS (events, commands)
                                                  |
+=================================================|=======================+
|  BASILEUS BACKEND                               |                       |
|                                                  v                       |
|  +-----------------------------------------------+--------------------+ |
|  | AgentHost (Remote Orchestration)                                    | |
|  |                                                                      | |
|  | Workflow Registry:                                                   | |
|  |   tracks all active workflows (local + remote)                      | |
|  |                                                                      | |
|  | Agentic Coder Sagas:                                                | |
|  |   CoderWorkflow (provision -> execute -> review -> PR)              | |
|  |   AutonomousCodingAgent (plan -> code -> test -> review loop)       | |
|  |                                                                      | |
|  | Cross-Session Coordinator:                                          | |
|  |   dependency resolution between workflows                           | |
|  |   resource allocation across concurrent features                    | |
|  +------+--------------------------------------------------------------+ |
|         |                                                                 |
|         v                                                                 |
|  +------+--------------------------------------------------------------+ |
|  | Marten Event Store (Unified Event Stream)                           | |
|  |                                                                      | |
|  | Stream per workflow:                                                 | |
|  |   local events (from Exarchos) + remote events (from Agentic Coder)| |
|  |                                                                      | |
|  | CQRS Projections:                                                   | |
|  |   WorkflowProgress, TaskStatus, TeamActivity, Artifacts            | |
|  +---------------------------------------------------------------------+ |
|                                                                           |
|  +---------------------------------------------------------------------+ |
|  | ControlPlane + Agentic Coder Containers                             | |
|  |                                                                      | |
|  | Container per coding task:                                          | |
|  |   cloned repo, dev tooling, MCP tools, resource limits              | |
|  |   plan -> code -> test -> review autonomous loop                    | |
|  |   emits CodingEvents to Marten stream                              | |
|  +---------------------------------------------------------------------+ |
+==========================================================================+
```

### Two Invocation Paths

#### Path A: Developer-Led (Exarchos-First)

The developer runs Claude Code locally. Exarchos coordinates the SDLC pipeline. Some tasks execute locally (Claude Code teammates), others are delegated to Basileus (Agentic Coder containers).

```
Developer: /ideate "user authentication feature"
  |
  v
Exarchos: Initialize workflow, register with Basileus
  |
  v
/plan: Create implementation plan (5 tasks)
  |
  v
[HUMAN CHECKPOINT: approve plan]
  |
  v
/delegate: Exarchos Task Router evaluates each task:
  |
  +-- Task 1 (JWT middleware): Complex, needs codebase context -> LOCAL teammate
  +-- Task 2 (DB migrations): Mechanical, well-defined -> REMOTE Agentic Coder
  +-- Task 3 (API endpoints): Complex, needs codebase context -> LOCAL teammate
  +-- Task 4 (Unit tests): Mechanical, well-defined -> REMOTE Agentic Coder
  +-- Task 5 (Integration tests): Needs running services -> REMOTE Agentic Coder
  |
  v
All 5 tasks execute concurrently:
  - 2 local Claude Code teammates (Tasks 1, 3)
  - 3 Agentic Coder containers (Tasks 2, 4, 5)
  - All emit events to same Marten stream
  - Exarchos views show unified progress
  |
  v
/integrate: Merge all branches (local worktrees + remote branches)
  |
  v
/review: Spec compliance + code quality (can use reviewer teammate)
  |
  v
/synthesize: Create PR
  |
  v
[HUMAN CHECKPOINT: approve merge]
```

#### Path B: Fully Autonomous (Basileus-First)

A CI event (GitHub issue, scheduled task, Renovate PR) triggers Basileus directly. No developer session needed. Basileus runs the full pipeline using Agentic Coder containers.

```
CI Event: "Dependency update: bump lodash to 4.18.0"
  |
  v
Basileus: Create workflow, provision Agentic Coder container
  |
  v
Agentic Coder: Autonomous loop
  - Update dependency
  - Run tests
  - Fix any breaking changes
  - All events emitted to Marten stream
  |
  v
Basileus: Create PR automatically
  |
  v
[HUMAN CHECKPOINT: approve merge (or auto-merge if configured)]
```

Both paths produce the same event types to the same Marten stream. CQRS views are identical regardless of invocation path.

### Task Router

The Task Router in Exarchos decides whether a task executes locally or remotely. This is the key intelligence that makes the tiered model transparent to the developer.

**Routing criteria:**

| Factor | Favors Local | Favors Remote |
|--------|-------------|---------------|
| Codebase context needed | High (teammate has full repo) | Low (mechanical change) |
| Task complexity | High (needs reasoning) | Low (well-defined steps) |
| Execution environment | Standard (CLI tools suffice) | Special (needs services, DBs) |
| Security sensitivity | High (credentials, secrets) | Low (public dependencies) |
| Developer interaction | Likely (questions, decisions) | Unlikely (autonomous) |
| Cost sensitivity | Lower priority | Higher priority (container cost) |

**Decision function:**

```typescript
function routeTask(task: PlanTask, context: WorkflowContext): "local" | "remote" {
  // Always remote if no local capacity
  if (context.localTeammateCount >= context.maxLocalTeammates) return "remote";

  // Always local if Basileus is unavailable
  if (!context.basileusConnected) return "local";

  // Score-based routing
  const localScore =
    (task.requiresCodebaseContext ? 3 : 0) +
    (task.complexity === "high" ? 2 : 0) +
    (task.likelyNeedsHumanInput ? 2 : 0) +
    (task.securitySensitive ? 3 : 0);

  const remoteScore =
    (task.mechanical ? 3 : 0) +
    (task.needsSpecialEnvironment ? 3 : 0) +
    (task.wellDefined ? 2 : 0) +
    (task.independentOfOtherTasks ? 1 : 0);

  return localScore >= remoteScore ? "local" : "remote";
}
```

The developer can override routing via task annotations in the plan: `[local]` or `[remote]`.

### Unified Event Stream

All participants — local teammates, remote containers, Exarchos, Basileus — emit events to the same Marten stream per workflow. Events carry a `source` field indicating origin.

**Extended event types (additions to Exarchos and Agentic Coder events):**

```typescript
// Routing events (Exarchos emits)
type TaskRouted = WorkflowEvent & {
  type: "TaskRouted";
  taskId: string;
  destination: "local" | "remote";
  reason: string;        // human-readable routing rationale
  scores: { local: number; remote: number };
};

// Remote execution events (Basileus emits)
type ContainerProvisioned = WorkflowEvent & {
  type: "ContainerProvisioned";
  taskId: string;
  containerId: string;
  image: string;
  resourceLimits: { cpu: string; memory: string };
};

type CodingAttemptStarted = WorkflowEvent & {
  type: "CodingAttemptStarted";
  taskId: string;
  attemptNumber: number;
  containerId: string;
};

type CodingAttemptCompleted = WorkflowEvent & {
  type: "CodingAttemptCompleted";
  taskId: string;
  attemptNumber: number;
  outcome: "success" | "tests_failed" | "budget_exhausted" | "loop_detected";
  testResults?: { passed: number; failed: number; coverage: number };
  commitSha?: string;
};

type ContainerDestroyed = WorkflowEvent & {
  type: "ContainerDestroyed";
  taskId: string;
  containerId: string;
  totalDuration: number;
  totalTokens: number;
};

// Cross-tier coordination events
type DependencyBlocked = WorkflowEvent & {
  type: "DependencyBlocked";
  taskId: string;
  blockedBy: string;       // task ID in another workflow
  blockedByWorkflow: string;
};

type DependencyResolved = WorkflowEvent & {
  type: "DependencyResolved";
  taskId: string;
  resolvedBy: string;
  resolvedByWorkflow: string;
};
```

### CQRS Views (Merged)

Views merge local and remote activity into a single picture. The consumer cannot tell (and does not need to know) whether a task executed locally or remotely.

**PipelineView** — the primary developer dashboard:

```typescript
interface PipelineView {
  // Active workflows
  workflows: Array<{
    featureId: string;
    phase: string;
    invocationPath: "developer-led" | "autonomous";
    tasksTotal: number;
    tasksCompleted: number;
    localTasks: number;
    remoteTasks: number;
    estimatedCompletion?: string;
  }>;

  // Resource utilization
  resources: {
    localTeammates: { active: number; max: number };
    remoteContainers: { active: number; max: number };
    tokenBudget: { used: number; allocated: number };
  };

  // Recent activity (cross-workflow)
  recentEvents: WorkflowEvent[];
}
```

**UnifiedTaskView** — per-task view that abstracts execution backend:

```typescript
interface UnifiedTaskView {
  taskId: string;
  workflowId: string;
  title: string;
  status: "pending" | "routed" | "in_progress" | "completed" | "failed";
  execution: {
    backend: "local" | "remote";
    assignee: string;            // teammate name or container ID
    worktree?: string;           // local only
    containerId?: string;        // remote only
    branch: string;
    attempts: number;
    tddPhase?: "red" | "green" | "refactor";
  };
  testResults?: { passed: number; failed: number; coverage: number };
  artifacts: string[];
  events: WorkflowEvent[];       // task-scoped event history
}
```

### Concurrent Feature Pipeline

The ultimate goal: multiple features progressing simultaneously through the SDLC pipeline.

```
Time -->

Feature A:  [ideate] [plan] [APPROVE] [delegate -------- tasks --------] [integrate] [review] [synth] [MERGE]
Feature B:         [ideate] [plan] [APPROVE] [delegate --- tasks ---] [integrate] [review] [synth] [MERGE]
Feature C:                         [CI trigger] [auto-code] [auto-PR] [MERGE]
Feature D:                                [ideate] [plan] [APPROVE] [delegate -- tasks --] ...

Shared Marten Event Stream:
  |A:start|B:start|A:task1|B:task1|C:start|A:task2|B:task2|C:done|A:integrate|D:start|...

CQRS PipelineView:
  Shows all 4 features, their phases, tasks in flight, resource utilization
```

The developer monitors progress through Exarchos views and intervenes only at human checkpoints. Each feature's event stream is independent but visible through the shared PipelineView.

### Cross-Workflow Coordination

When Feature A depends on Feature B (e.g., A needs an API that B is building):

1. A's teammate emits `DependencyBlocked { blockedBy: "B:task-3" }`
2. Basileus Cross-Session Coordinator detects the dependency
3. Basileus elevates B:task-3 priority
4. When B:task-3 completes, Basileus emits `DependencyResolved`
5. A's teammate resumes

This coordination happens through the event stream — no direct communication between Exarchos instances. Basileus acts as the mediator.

## Integration Points

### With Exarchos (existing design)

This design extends Exarchos with:
- **Task Router** — new component that evaluates routing criteria
- **Remote task dispatch** — `POST /api/workflows/{id}/tasks/{taskId}/execute` to Basileus
- **Merged views** — existing Exarchos views gain `backend: "local" | "remote"` field
- **New MCP tool** — `exarchos_task_route` to inspect/override routing decisions

### With Agentic Coder (existing design)

This design extends Agentic Coder with:
- **Workflow registration** — containers are linked to a workflow stream via `streamId`
- **Event emission** — `CodingEvent` types are mapped to `WorkflowEvent` types in the shared stream
- **Remote task acceptance** — new API endpoint receives task assignments from Exarchos

### With Basileus AgentHost

New API endpoints:
- `POST /api/workflows/{id}/tasks/{taskId}/execute` — dispatch a task to Agentic Coder
- `GET /api/pipeline` — aggregate PipelineView across all active workflows
- `POST /api/coordination/dependencies` — register cross-workflow dependencies

### With CI/CD

- GitHub Actions workflow dispatches to Basileus for autonomous path
- PR events can trigger review workflows
- Merge events update PipelineView

## Testing Strategy

### Unit Tests
- Task Router scoring and decision logic
- Event schema mapping between Exarchos and Agentic Coder event types
- View materialization with mixed local+remote events
- Cross-workflow dependency detection

### Integration Tests
- End-to-end developer-led flow: Exarchos -> task routing -> mixed local/remote execution -> merge
- End-to-end autonomous flow: CI event -> Basileus -> Agentic Coder -> PR
- Offline resilience: local tasks continue when Basileus is unreachable
- Cross-workflow coordination: dependency blocked -> resolved -> resumed

### Smoke Tests
- 2-feature concurrent pipeline with mixed local/remote tasks
- Verify PipelineView shows both features accurately
- Verify event stream contains interleaved events from both backends

## Open Questions

1. **Resource allocation** — When multiple features compete for remote containers, how does Basileus prioritize? Options: FIFO queue, priority based on feature urgency, token budget per developer.

2. **Task Router learning** — Should routing decisions improve over time? Collect task completion data (success rate, duration, cost by backend) and use it to refine routing heuristics.

3. **Partial remote failure** — If a remote container fails mid-task, should Exarchos retry locally? Or should Basileus retry with a new container? Recommendation: Basileus retries remotely up to 2 times, then falls back to local if Exarchos is available.

4. **Token cost visibility** — Should PipelineView show per-task token costs broken down by local vs. remote? This would help developers optimize routing decisions.

5. **Multi-developer coordination** — When two developers' Exarchos instances work on related features, how do they discover each other? Through the shared Marten event stream + Basileus Cross-Session Coordinator.

## Related Documents

| Document | Relationship |
|----------|-------------|
| [Exarchos Design](./2026-02-05-exarchos.md) | Local agent governance and bridge service |
| [Agentic Coder Design](../../agentic-engine/docs/designs/2026-01-18-agentic-coder.md) | Remote autonomous coding agent |
| [System Architecture](../../agentic-engine/docs/adrs/system-architecture.md) | Basileus three-tier architecture |
| [Workflow State MCP](./2026-02-04-workflow-state-mcp.md) | Local HSM state management |
