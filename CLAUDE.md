# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**jira-planner** — a custom Jira Cloud app built on Atlassian Forge that visualises epics and tickets in a quarter × priority planning grid. Users can drag tickets between cells; custom positions are persisted via the Forge Storage API.

Owner: Rijul Gupta (neblar) — `git@github.com:neblar/jira-planner.git`

## Architecture Decisions

- **Atlassian Forge** with Custom UI — the app runs inside Jira, so no standalone hosting, OAuth, or backend server is needed
- **Forge handles auth automatically** — no OAuth flow required
- **Forge Storage API** replaces a database — used to persist custom ticket positions (quarter + priority overrides)
- **React + TypeScript + Tailwind** for the Custom UI frontend
- **Forge resolvers** expose Jira data (projects, epics, issues) to the frontend via `invoke()`

## Development Environment

Docker-based dev container (Ubuntu 24.04). The container has `git`, `curl`, Node.js 22, `@forge/cli`, and Claude CLI pre-installed.

```bash
docker compose up -d   # start the dev container
```

The workspace is mounted at `/home/workspace`. SSH keys and git config are volume-mounted from the host.

## Forge App Structure (once scaffolded)

```
/src          # Forge backend — resolvers that call Jira API via @forge/api
/static/ui    # Custom UI — React + TypeScript + Tailwind frontend
manifest.yml  # Forge app manifest — defines modules, permissions, scopes
```

## Key Commands (once scaffolded)

```bash
# In /static/ui
npm run build   # build the frontend

# In project root
forge deploy    # deploy app to Atlassian cloud
forge tunnel    # local dev tunnel (live reload against real Jira)
forge install   # install app on a Jira site (first time)
forge logs      # tail runtime logs
```

## Current Status

Working through the build tasks in TASKS.md step by step. Check TASKS.md for the next incomplete task and continue from there.
