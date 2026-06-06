You are entirely right to be skeptical of agent-authored integration tests. You are hitting on a profound limitation of LLM-generated verification: agents are notoriously prone to tautology, often writing vacuous tests that simply calcify their own flawed logic into tech debt. As your research notes, test-writing volume only weakly correlates with actual success.

Shifting from "procedural assertions written by an LLM" to "structural constraints enforced by the environment" is the exact right evolution for your pipeline. We can formalize this by extending the "Type-driven development" and "Acceptance north-star" concepts from your discovery report directly into the integration layer.

Here is a formalized set of principles and practical applications for structural integration verification.

---

## 1. Principles of Structural Integration

**Principle A: The Schema is the Immutable Contract**
Never ask a model to write a test verifying that it mapped a payload correctly. Communication between systems must be governed by a shared, machine-readable contract (OpenAPI, Protobuf, GraphQL). Code generation is the verifier; if the systems drift, the build breaks, costing zero LLM tokens and providing immediate feedback.

**Principle B: Parse, Don't Validate at the Boundary**
Extend the type-driven development methodology to your IO layer. Any data crossing an integration boundary must immediately be parsed into an exhaustive, branded type (e.g., via Zod or a similar runtime validation library). The type-checker becomes your first-line integration test, guaranteeing that illegal states are unrepresentable.

**Principle C: Ban Agent-Authored Mocks**
Mocks are dangerous because an LLM will mock its own *assumption* of how a third-party API behaves—which is exactly where integration bugs live. For external dependencies, rely entirely on hermetic environments (like Testcontainers) or contract-verified simulators.

**Principle D: Coarse-Grained, Refactor-Durable E2E Oracles**
Instead of granular, agent-written integration tests, enforce a single "north star" acceptance test per integration pathway. This test must treat the integration as a black box, asserting only the final state or output. Because full integration/E2E tests have the highest token cost, they should be strictly reserved for the integration boundary.

---

## 2. Practical Applications for the Pipeline

To make this actionable within the Exarchos architecture, you can implement the following mechanical gates:

* **The Codegen Prerequisite Gate:** If an implementation task involves an external integration (detected via `riskTier` or task classification), the orchestrator blocks the agent from writing business logic until a schema is resolved and the client stubs are auto-generated.
* **The Parsing-Boundary Static Analysis:** Introduce a linting rule or static analysis gate that flags any raw IO data (like a generic `JSON.parse` or raw HTTP response body) that is passed into the domain core without first crossing a registered schema-parsing function.
* **Model-Based State Fuzzing:** For stateful integrations, apply the property-based testing (PBT) strategy. Instead of asking the agent to script sequential scenarios, have it define a reference model of the external state. A fuzzer then hammers the integration, asserting that the real system transitions match the reference model.
* **Infrastructure-as-Code (IaC) as Verification:** If the integration relies on cloud resources (queues, buckets, event bridges), use the IaC definitions (Terraform/Pulumi) to structurally provision a temporary namespace. Run the single E2E oracle against the real infrastructure, then tear it down.

---

To help me tailor how we weave this into the `.exarchos.yml` verification policy, what specific types of integrations (e.g., REST APIs, event-driven message queues, databases) are currently generating the most test-related tech debt in your codebase?