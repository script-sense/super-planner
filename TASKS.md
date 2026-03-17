# Jira Planner — Build Tasks

Work through these tasks in order. Find the first unchecked task and implement it. Each task description contains enough detail to proceed without asking for clarification.

---

- [x] **Step 1 — Project scaffold**
  - Run `forge create` to scaffold a new Forge app named `jira-planner` using the `custom-ui` template
  - Set up the Custom UI (`/static/ui`) with React + TypeScript + Tailwind CSS
  - Confirm `forge tunnel` starts without errors
  - Update devcontainer.json with relevant VS Code extensions (ESLint, Tailwind IntelliSense)

- [x] **Step 2 — Deploy and verify end-to-end**
  - Register the app with Atlassian: run `forge register` to assign a real app ID, then update `manifest.yml` with the returned ID
  - Build the frontend (`npm run build` in `/static/ui`) and deploy: `forge deploy`
  - Install the app on the target Jira site: `forge install` (select the site and `jira:projectPage` module)
  - Open the installed page in Jira and confirm the "Jira Planner / Loading planning grid…" placeholder renders without errors
  - Confirm `forge logs` shows no runtime errors after the page load

- [ ] **Step 3 — Jira data fetching**
  - In `/src`, write Forge resolvers using `@forge/api` to fetch: projects, epics (issue type = Epic), and issues (with fields: summary, priority, fixVersions, epic link, assignee)
  - Expose via `invoke()` so the frontend can request data by project key
  - Add required Jira scopes to `manifest.yml` (`read:jira-work`, `read:jira-user`)

- [ ] **Step 4 — Quarter × Priority grid layout**
  - Static React component: columns = Q1–Q4 of the current year (plus a "Backlog" column for unscheduled), rows = Jira priority tiers (Highest, High, Medium, Low, Lowest)
  - No data yet — just the visual shell with correct labels and CSS grid structure

- [ ] **Step 5 — Render epics and tickets in the grid**
  - Call the Step 3 resolvers from the frontend
  - Map each issue to a cell: quarter derived from `fixVersions` date (fall back to "Backlog"), row from `priority`
  - Render epic cards; each epic is expandable to show its child tickets
  - Custom positions from Forge Storage (Step 7) override Jira-derived positions when present

- [ ] **Step 6 — Drag and drop**
  - Install and use `@dnd-kit/core` for drag-and-drop
  - Dragging an epic or ticket to a new cell updates its quarter and priority in local React state immediately
  - No persistence yet — that is Step 7

- [ ] **Step 7 — Persist custom positions**
  - Add a Forge resolver that reads/writes to Forge Storage: key = `positions`, value = `{ [issueKey]: { quarter: string, priority: string } }`
  - On drop (Step 6), call the write resolver to save the new position
  - On app load, fetch saved positions and merge over Jira-derived positions before rendering

- [ ] **Step 8 — Project/filter selector**
  - Dropdown at the top of the UI to switch between available Jira projects (fetched via resolver)
  - Optional filter chips: assignee, label
  - Switching project reloads the grid

- [ ] **Step 9 — Polish**
  - Loading skeletons while data fetches
  - Empty state for cells with no tickets
  - Priority colour coding (e.g. Highest = red, High = orange, Medium = yellow, Low = blue, Lowest = grey)
  - Responsive layout for narrower screens
