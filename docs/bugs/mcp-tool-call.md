```bash
● plugin:exarchos:exarchos - exarchos_workflow (MCP)(action: "set", featureId: "hardening-validation-eval-closure", phase: "delegate", updates:
                                                    {"planReview":{"approved":true,"gapsFound":false,"gaps":[]},"tasks":[{"id":"1.1","title":"Add parameterized backend contract test
                                                    suite","status":"pending","branch":null},{"id":"1.2","title":"Add WAL mode validation tests","status":"pending","branch":null},{"id":"1.3","title":"Add schema migration
                                                    V1→V2 tests","status":"pending","branch":null},{"id":"1.4","title":"Add E2E round-trip test","status":"pending","branch":null},{"id":"1.5","title":"Add crash recovery
                                                    tests","status":"pending","branch":null},{"id":"1.6","title":"Add lifecycle tests with SqliteBackend","status":"pending","branch":null},{"id":"1.7","title":"Add
                                                    property-based tests for hydration round-trip","status":"pending","branch":null},{"id":"1.8","title":"Document outbox retry behavioral
                                                    divergence","status":"pending","branch":null},{"id":"2.1","title":"Add layer field to EvalCase and filter in
                                                    harness","status":"pending","branch":null},{"id":"2.2","title":"Implement layer-aware exit codes in eval-run
                                                    CLI","status":"pending","branch":null},{"id":"2.3","title":"Update eval-gate.yml for two-step runs","status":"pending","branch":null},{"id":"2.4","title":"Implement
                                                    regression detection in harness","status":"pending","branch":null},{"id":"2.5","title":"Add eval-capture CLI
                                                    command","status":"pending","branch":null},{"id":"2.6","title":"Add eval-compare CLI command","status":"pending","branch":null},{"id":"2.7","title":"Create reliability eval
                                                    suite","status":"pending","branch":null},{"id":"3.1","title":"Remove stale @planned from quality.hint.generated","status":"pending","branch":null},{"id":"3.2","title":"Build
                                                     review comment parser + wire review events","status":"pending","branch":null},{"id":"3.3","title":"Extract quality regression
                                                    detector","status":"pending","branch":null},{"id":"3.4","title":"Add team-disbanded-emitted workflow guard","status":"pending","branch":null},{"id":"3.5","title":"Add tests
                                                    for query.ts and next-action.ts","status":"pending","branch":null},{"id":"3.6","title":"Add tests for
                                                    sync/composite.ts","status":"pending","branch":null},{"id":"3.7","title":"Fix verify-plan-coverage.sh subsection matching","status":"pending","branch":null}]})
  ⎿  Error: {"success":false,"error":{"code":"INVALID_INPUT","message":"INVALID_INPUT: Write-time validation failed: [\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n
     \"path\": [\n      \"tasks\",\n      0,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\":
     \"null\",\n    \"path\": [\n      \"tasks\",\n      1,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n
     \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      2,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\":
     \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      3,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n
     \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      4,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\":
     \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      5,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n
     \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      6,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n
      {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      7,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received
     null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      8,\n      \"branch\"\n    ],\n    \"message\": \"Expected string,
     received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      9,\n      \"branch\"\n    ],\n    \"message\": \"Expected
     string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      10,\n      \"branch\"\n    ],\n    \"message\":
     \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      11,\n      \"branch\"\n    ],\n
     \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      12,\n      \"branch\"\n
      ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      13,\n
     \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n
     14,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n
     \"tasks\",\n      15,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\":
     [\n      \"tasks\",\n      16,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n
     \"path\": [\n      \"tasks\",\n      17,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\":
     \"null\",\n    \"path\": [\n      \"tasks\",\n      18,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n
     \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      19,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n    \"expected\":
     \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      20,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n  },\n  {\n    \"code\": \"invalid_type\",\n
     \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [\n      \"tasks\",\n      21,\n      \"branch\"\n    ],\n    \"message\": \"Expected string, received null\"\n
     }\n]"},"_perf":{"ms":9,"bytes":5139,"tokens":1285}}

● Branch field needs to be a string, not null. Let me use empty string instead:

● plugin:exarchos:exarchos - exarchos_workflow (MCP)(action: "set", featureId: "hardening-validation-eval-closure", phase: "delegate", updates:
                                                    {"planReview":{"approved":true,"gapsFound":false,"gaps":[]},"tasks":[{"id":"1.1","title":"Add parameterized backend contract test
                                                    suite","status":"pending","branch":""},{"id":"1.2","title":"Add WAL mode validation tests","status":"pending","branch":""},{"id":"1.3","title":"Add schema migration V1-V2
                                                    tests","status":"pending","branch":""},{"id":"1.4","title":"Add E2E round-trip test","status":"pending","branch":""},{"id":"1.5","title":"Add crash recovery
                                                    tests","status":"pending","branch":""},{"id":"1.6","title":"Add lifecycle tests with SqliteBackend","status":"pending","branch":""},{"id":"1.7","title":"Add property-based
                                                    tests for hydration round-trip","status":"pending","branch":""},{"id":"1.8","title":"Document outbox retry behavioral
                                                    divergence","status":"pending","branch":""},{"id":"2.1","title":"Add layer field to EvalCase and filter in
                                                    harness","status":"pending","branch":""},{"id":"2.2","title":"Implement layer-aware exit codes in eval-run CLI","status":"pending","branch":""},{"id":"2.3","title":"Update
                                                    eval-gate.yml for two-step runs","status":"pending","branch":""},{"id":"2.4","title":"Implement regression detection in
                                                    harness","status":"pending","branch":""},{"id":"2.5","title":"Add eval-capture CLI command","status":"pending","branch":""},{"id":"2.6","title":"Add eval-compare CLI
                                                    command","status":"pending","branch":""},{"id":"2.7","title":"Create reliability eval suite","status":"pending","branch":""},{"id":"3.1","title":"Remove stale @planned from
                                                    quality.hint.generated","status":"pending","branch":""},{"id":"3.2","title":"Build review comment parser + wire review
                                                    events","status":"pending","branch":""},{"id":"3.3","title":"Extract quality regression detector","status":"pending","branch":""},{"id":"3.4","title":"Add
                                                    team-disbanded-emitted workflow guard","status":"pending","branch":""},{"id":"3.5","title":"Add tests for query.ts and
                                                    next-action.ts","status":"pending","branch":""},{"id":"3.6","title":"Add tests for sync/composite.ts","status":"pending","branch":""},{"id":"3.7","title":"Fix
                                                    verify-plan-coverage.sh subsection matching","status":"pending","branch":""}]})
  ⎿  {
       "success": true,
       "data": {
     … +12 lines (ctrl+o to expand)
```

