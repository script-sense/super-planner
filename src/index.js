import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

// Fetch all boards the current user has access to.
resolver.define('getBoards', async () => {
    const response = await api
        .asUser()
        .requestJira(route`/rest/agile/1.0/board?maxResults=50`);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    // Only scrum boards have sprints — kanban boards do not.
    // Include the project key from location so the frontend can auto-match a filter.
    return (data.values ?? [])
        .filter(b => b.type === 'scrum')
        .map(b => ({
            id: b.id,
            name: b.name,
            projectKey: b.location?.projectKey ?? null,
        }));
});

// Fetch active and future sprints from the selected board, in chronological order.
resolver.define('getSprints', async (req) => {
    const { boardId } = req.payload;

    const response = await api
        .asUser()
        .requestJira(route`/rest/agile/1.0/board/${boardId}/sprint?state=active,future`);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    const sprints = (data.values ?? []).sort((a, b) =>
        new Date(a.startDate ?? 0) - new Date(b.startDate ?? 0)
    );

    return sprints.map(s => ({
        id: s.id,
        name: s.name,
        state: s.state,
    }));
});

// Fetch all saved filters the current user has access to.
resolver.define('getFilters', async () => {
    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/filter/search?orderBy=name&maxResults=100`);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    // Include jql so the frontend can match a filter to a board by project key
    return (data.values ?? []).map(f => ({
        id: f.id,
        name: f.name,
        jql: f.jql ?? '',
    }));
});

// Fetch all non-Done epics matching the given saved filter.
// Also fetches the `super-planner` issue property so stored grid positions are included.
resolver.define('getEpics', async (req) => {
    const { filterId } = req.payload;

    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/search/jql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jql: `filter = ${filterId} AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC`,
                fields: ['summary', 'priority', 'status'],
                properties: ['super-planner'],
                maxResults: 200,
            }),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    return data.issues.map(issue => {
        // Issue properties are returned as an object keyed by property name
        const position = issue.properties?.['super-planner'] ?? null;
        return {
            key: issue.key,
            summary: issue.fields.summary,
            priority: issue.fields.priority?.name ?? null,
            // position is null if the epic has never been placed in the grid
            position,
        };
    });
});

// Write the grid position for an epic as a Jira issue property.
// This is called after every drag-and-drop so the position persists across refreshes.
resolver.define('setEpicPosition', async (req) => {
    const { epicKey, sprintId, sprintName, rowKey } = req.payload;

    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/issue/${epicKey}/properties/super-planner`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sprintId, sprintName, rowKey }),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
});

export const handler = resolver.getDefinitions();
