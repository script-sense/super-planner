# Jira Planner — Build Tasks

Work through these tasks in order. Find the first unchecked task and implement it. Each task description contains enough detail to proceed without asking for clarification.

---

- [ ] **Step 1 — Project scaffold**
  - Run `forge create` to scaffold a new Forge app named `jira-planner` using the `custom-ui` template
  - Set up the Custom UI (`/static/ui`) with React + TypeScript + Tailwind CSS
  - Confirm `forge tunnel` starts without errors
  - Update devcontainer.json with relevant VS Code extensions (ESLint, Tailwind IntelliSense)

- [ ] **Step 2 — Jira data fetching**
  - In `/src`, write Forge resolvers using `@forge/api` to fetch: projects, epics (issue type = Epic), and issues (with fields: summary, priority, fixVersions, epic link, assignee)
  - Expose via `invoke()` so the frontend can request data by project key
  - Add required Jira scopes to `manifest.yml` (`read:jira-work`, `read:jira-user`)

- [ ] **Step 3 — Quarter × Priority grid layout**
  - Static React component: columns = Q1–Q4 of the current year (plus a "Backlog" column for unscheduled), rows = Jira priority tiers (Highest, High, Medium, Low, Lowest)
  - No data yet — just the visual shell with correct labels and CSS grid structure

- [ ] **Step 4 — Render epics and tickets in the grid**
  - Call the Step 2 resolvers from the frontend
  - Map each issue to a cell: quarter derived from `fixVersions` date (fall back to "Backlog"), row from `priority`
  - Render epic cards; each epic is expandable to show its child tickets
  - Custom positions from Forge Storage (Step 6) override Jira-derived positions when present

- [ ] **Step 5 — Drag and drop**
  - Install and use `@dnd-kit/core` for drag-and-drop
  - Dragging an epic or ticket to a new cell updates its quarter and priority in local React state immediately
  - No persistence yet — that is Step 6

- [ ] **Step 6 — Persist custom positions**
  - Add a Forge resolver that reads/writes to Forge Storage: key = `positions`, value = `{ [issueKey]: { quarter: string, priority: string } }`
  - On drop (Step 5), call the write resolver to save the new position
  - On app load, fetch saved positions and merge over Jira-derived positions before rendering

- [ ] **Step 7 — Project/filter selector**
  - Dropdown at the top of the UI to switch between available Jira projects (fetched via resolver)
  - Optional filter chips: assignee, label
  - Switching project reloads the grid

- [ ] **Step 8 — Polish**
  - Loading skeletons while data fetches
  - Empty state for cells with no tickets
  - Priority colour coding (e.g. Highest = red, High = orange, Medium = yellow, Low = blue, Lowest = grey)
  - Responsive layout for narrower screens
