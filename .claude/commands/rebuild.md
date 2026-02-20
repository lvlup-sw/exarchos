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
cd companion && npm run build && npm publish --access public
npx @lvlup-sw/exarchos-dev
```

Report the result to the user.
