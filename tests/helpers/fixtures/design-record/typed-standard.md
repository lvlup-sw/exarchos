# Release plan

## Design & Rationale

### DR-1: Preserve authored identity

Keep exact task identifiers and source bytes, including café and 🧭.

````markdown
### DR-99: This is only an example
```exarchos-plan-v1
{"not":"a plan"}
```
````

### DR-2: Read once

A shared snapshot supplies all later validators.

## Tasks

~~~exarchos-plan-v1
{
  "version": 1,
  "requirements": ["DR-1", "DR-2"],
  "tasks": [
    {
      "id": "T-01",
      "title": "Preserve the source",
      "implements": ["DR-1"],
      "blockedBy": [],
      "files": ["docs/identity.md"],
      "testFiles": [],
      "riskTier": "low",
      "boundaryTouching": false,
      "acceptance": ["The source bytes remain exact."],
      "instructions": "Read the record.\nKeep its original bytes.",
      "parallelizable": false
    },
    {
      "id": "T-1",
      "title": "Share the snapshot",
      "implements": ["DR-2"],
      "blockedBy": ["T-01"],
      "files": ["src/read.ts"],
      "testFiles": ["tests/read.test.ts"],
      "riskTier": "high",
      "boundaryTouching": true,
      "testLayer": "acceptance",
      "acceptance": ["Consumers receive one immutable snapshot."],
      "instructions": "Read once and pass the snapshot to each consumer.",
      "parallelizable": false
    }
  ]
}
~~~

## Appendix

### DR-88: Not a requirement
