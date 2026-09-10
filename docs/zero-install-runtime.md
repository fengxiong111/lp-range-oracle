# Zero-install request invariant

Interactive LP Oracle requests execute committed prebundled `dist/*.mjs` artifacts directly. The request path must not run `npm install`, `npm ci`, `npx`, or TypeScript transpilation. Build/test workflows may regenerate dist after source changes.
