---
description: Rebuild and reinstall exarchos from source
---

# Rebuild

Build the project and reinstall to `~/.claude/` to consume latest changes.

## Process

Run from the exarchos repo root:

```bash
npm run build && node dist/install.js --yes
```

Report the result to the user.
