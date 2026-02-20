---
description: Rebuild exarchos plugin and update marketplace installation
---

# Rebuild

Build the project and update the marketplace plugin cache to consume latest changes.

## Process

Run from the exarchos repo root:

```bash
npm run build
```

Then update the installed plugin:

```
/plugin update exarchos@lvlup-sw
```

If the companion also needs updating:

```bash
# Publish new version
cd companion && npm run build && npm publish --access public

# Install from npm (MUST run from outside the exarchos repo to avoid local resolution)
cd /tmp && npx --yes @lvlup-sw/exarchos-dev@latest
```

For local dev (no publish needed):

```bash
node companion/dist/install.js
```

Report the result to the user.
