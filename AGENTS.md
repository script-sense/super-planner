# Agent Guide — Super Planner

Everything an AI agent needs to work on this codebase correctly without making typical Forge mistakes.

---

## What this app is

A Jira full-page app built on **Atlassian Forge** using the **Custom UI** approach. It renders a sprint-based planning grid for Jira epics with drag-and-drop, priority rows, Focus Area tabs, and an epic detail modal.

**Installed at:** `https://scriptsense.atlassian.net`
**App ID:** `ari:cloud:ecosystem::app/fa84de8d-c339-4d3c-9823-50ccb2c19426`

---

## Critical: Custom UI ≠ UI Kit

This app uses **Custom UI** — a standard React app served inside an iframe. This means:

- ✅ Use normal React (`react`, `react-dom`), `<div>`, `<span>`, inline styles, etc.
- ✅ Import from `@forge/bridge` for Jira integration (`invoke`, `requestJira`, `router`, `view`)
- ✅ Use any npm package (currently uses `@dnd-kit/core`, `@dnd-kit/sortable`)
- ❌ Do NOT import from `@forge/react` or `@forge/ui` — those are for UI Kit, a completely different approach
- ❌ Do NOT use UI Kit components (`Box`, `Stack`, `Button`, etc.) — they will not work here

---

## Project structure

```
src/index.js                  # Forge backend — all resolver functions
static/planner-ui/src/App.js  # React frontend — entire UI in one file
manifest.yml                  # Forge app manifest (modules, scopes, runtime)
package.json                  # Root — @forge/api, @forge/resolver dependencies
static/planner-ui/package.json # Frontend — React, @dnd-kit, @forge/bridge
.github/workflows/deploy.yml  # CI — auto-deploy to production on push to main
```

---

## Architecture

### Backend (`src/index.js`)
- Uses `@forge/resolver` to define named resolver functions
- Calls Jira REST APIs via `api.asUser().requestJira(route\`...\`)`
- Always use `api.asUser()` (not `asApp()`) so Jira enforces the user's own permissions
- Export: `export const handler = resolver.getDefinitions();`

### Frontend (`static/planner-ui/src/App.js`)
- Standard React app, all in one file (components, styles, helpers)
- Calls backend resolvers via `invoke('resolverName', payload)` from `@forge/bridge`
- Can also call Jira REST APIs directly via `requestJira(path, options)` from `@forge/bridge` — used for child issue fetching
- Navigation/links: use `router.open(url)` from `@forge/bridge` (not `window.open`)
- Get app context (e.g. URL params): `view.getContext()` from `@forge/bridge`

### Communication pattern
```
React (invoke) → Forge resolver → Jira REST API → resolver returns data → React state
```

---

## Key Jira concepts used

| Field | Jira ID | Notes |
|---|---|---|
| Sprint | `customfield_10020` | Array; pick `state=active` or last element |
| LexoRank | `customfield_10019` | Lexicographic sort for within-cell ordering |
| Focus Area | discovered at runtime | Custom Select field; fetched by name via `GET /rest/api/3/field` |
| Epic children | JQL: `issueType != Epic AND parent = "KEY"` | |
| Rank API | `PUT /rest/agile/1.0/issue/rank` | Requires `write:issue:jira-software` scope |

### Sprint states: `active`, `future`, `closed`
### Priority row keys (match Jira priority names exactly): `Highest`, `High`, `Medium`, `Low`, `Lowest`

---

## Jira API pagination

`/rest/api/3/search/jql` caps at **100 results per page**. Always paginate:

```javascript
let allIssues = [], nextPageToken;
do {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    allIssues = allIssues.concat(data.issues ?? []);
    nextPageToken = data.nextPageToken ?? null;
} while (nextPageToken);
```

---

## Manifest and scopes

Current scopes in `manifest.yml`:
- `read:jira-user`, `read:jira-work`, `write:jira-work`
- `read:sprint:jira-software`, `write:sprint:jira-software`
- `read:board-scope:jira-software`, `write:board-scope:jira-software`
- `read:issue-details:jira`, `read:project:jira`
- `manage:jira-configuration` — required for Focus Area field context/option management
- `write:issue:jira-software` — required for LexoRank reorder API

**⚠️ Adding new scopes requires a major version bump AND `forge install --upgrade` on the site. Do not add scopes casually.**

---

## Deployment

### Automatic (CI)
Push to `main` → GitHub Actions builds frontend and runs `forge deploy -e production`.
Requires repository secrets: `FORGE_EMAIL`, `FORGE_API_TOKEN`.

### Manual
```bash
# Build frontend first
cd static/planner-ui && npm run build

# Deploy from repo root
cd ../..
forge settings set usage-analytics false
forge deploy -e production --non-interactive
```

### When to run `forge install --upgrade`
Only needed when scopes or permissions in `manifest.yml` change. Run manually:
```bash
forge install --upgrade --non-interactive --site scriptsense.atlassian.net --product jira --environment production
```

---

## Local development

```bash
npm install                          # root deps
cd static/planner-ui && npm install  # frontend deps
forge tunnel                         # hot-reload tunnel (no redeploy needed for code changes)
```

Redeploy + restart tunnel only if `manifest.yml` changes.

---

## Debugging

```bash
forge logs -e production --since 15m
```

---

## What NOT to do

- Don't use `forge deploy --no-verify`
- Don't use `window.open()` — use `router.open()` from `@forge/bridge`
- Don't use `/rest/api/3/search` (deprecated, returns 410) — use `/rest/api/3/search/jql`
- Don't set `maxResults > 100` on search/jql without also paginating — it gets silently capped
- Don't use `storage` from `@forge/api` without adding `storage:app` scope to manifest
- Don't use `asApp()` for Jira API calls — use `asUser()` so user permissions are enforced
- Don't add UI Kit components or import from `@forge/react`
- **Don't add `"type": "module"` to the root `package.json`.** It was added in
  b5598c7 as a speculative CI fix and took production down: with it, Forge's
  webpack parses `src/index.js` as strict ESM, where the CJS `@forge/resolver`
  default import resolves to the whole `module.exports` object instead of the
  class, so `new Resolver()` fails at invoke time with
  `_forge_resolver__WEBPACK_IMPORTED_MODULE_0__ is not a constructor`. Nothing
  needs the field — `babel-jest` transpiles the ESM syntax in tests either way.

---

## Dependency security overrides

`static/planner-ui/package.json` has an `overrides` block that force-upgrades
transitive dependencies of `react-scripts@5.0.1` (CRA is EOL, so its pinned
sub-dependencies never get patched upstream). Keep it — removing it
reintroduces ~50 Dependabot alerts.

Two notes for future work:

- **`svgo: ^2.8.3`** — `@svgr/plugin-svgo@5.5.0` declares `svgo@^1.2.2`, and
  svgo 2.x is a breaking API change. This is safe *only because the project has
  no `.svg` imports*, so the `@svgr` loader never runs. If you add an SVG
  import and the build fails inside `@svgr`/`svgo`, that override is why.
- **`webpack-dev-server` is deliberately NOT overridden.** Its remaining 2
  moderate advisories need v5, but react-scripts 5.0.1 passes the v4-only
  `onBeforeSetupMiddleware`/`onAfterSetupMiddleware` options, so forcing v5
  breaks `npm start` with "Invalid options object". These advisories affect the
  local dev server only — never the deployed app, which is a static build.
  The real fix is migrating off CRA (e.g. to Vite).
