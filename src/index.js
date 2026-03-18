import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const FOCUS_AREA_FIELD_NAME = 'Focus Area';

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

// Fetch sprints from the selected board: last 4 closed + all active + all future.
resolver.define('getSprints', async (req) => {
    const { boardId } = req.payload;

    const [activeRes, closedRes] = await Promise.all([
        api.asUser().requestJira(route`/rest/agile/1.0/board/${boardId}/sprint?state=active,future&maxResults=50`),
        api.asUser().requestJira(route`/rest/agile/1.0/board/${boardId}/sprint?state=closed&maxResults=4`),
    ]);

    if (!activeRes.ok) {
        const text = await activeRes.text();
        throw new Error(`Jira API error ${activeRes.status}: ${text}`);
    }
    if (!closedRes.ok) {
        const text = await closedRes.text();
        throw new Error(`Jira API error ${closedRes.status}: ${text}`);
    }

    const activeData = await activeRes.json();
    const closedData = await closedRes.json();

    const all = [...(closedData.values ?? []), ...(activeData.values ?? [])];

    const sprints = all.sort((a, b) =>
        new Date(a.startDate ?? 0) - new Date(b.startDate ?? 0)
    );

    return sprints.map(s => ({
        id: s.id,
        name: s.name,
        state: s.state,
        startDate: s.startDate ?? null,
        endDate: s.endDate ?? null,
    }));
});

// Discover the Focus Area custom field by name.
// Returns { fieldId } or null if the field doesn't exist.
// Options are derived client-side from the values present in epics (avoids manage:jira-configuration scope).
resolver.define('getFocusAreaField', async () => {
    const fieldsRes = await api.asUser().requestJira(route`/rest/api/3/field`);
    if (!fieldsRes.ok) {
        const text = await fieldsRes.text();
        throw new Error(`Jira API error ${fieldsRes.status}: ${text}`);
    }
    const fields = await fieldsRes.json();
    const field = fields.find(f => f.name === FOCUS_AREA_FIELD_NAME && f.custom);
    if (!field) return null;
    return { fieldId: field.id };
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
// Column placement comes from the Jira sprint field; row from the Jira priority field.
// Pass focusAreaFieldId to also return each epic's Focus Area value.
resolver.define('getEpics', async (req) => {
    const { filterId, focusAreaFieldId } = req.payload;

    const fields = ['summary', 'priority', 'status', 'customfield_10020'];
    if (focusAreaFieldId) fields.push(focusAreaFieldId);

    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/search/jql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jql: `filter = ${filterId} AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC`,
                fields,
                maxResults: 200,
            }),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }

    const data = await response.json();

    return data.issues.map(issue => {
        // customfield_10020 is the sprint field — returned as an array; pick the active sprint
        // or fall back to the last one if none is active.
        const sprints = issue.fields.customfield_10020 ?? [];
        const activeSprint = sprints.find(s => s.state === 'active') ?? sprints[sprints.length - 1] ?? null;
        const focusArea = focusAreaFieldId
            ? (issue.fields[focusAreaFieldId]?.value ?? null)
            : null;
        return {
            key: issue.key,
            summary: issue.fields.summary,
            priority: issue.fields.priority?.name ?? null,
            // sprintId from the actual Jira sprint field — source of truth for column placement
            sprintId: activeSprint ? String(activeSprint.id) : null,
            focusArea,
        };
    });
});

// Update the priority field on an epic in Jira.
// rowKey matches Jira priority names exactly (Highest, High, Medium, Low, Lowest).
resolver.define('updateEpicPriority', async (req) => {
    const { epicKey, priority } = req.payload;

    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/issue/${epicKey}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { priority: { name: priority } } }),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
});

// Assign an epic to a sprint using the Agile API.
// Pass sprintId = null to move the epic to the backlog.
resolver.define('assignEpicToSprint', async (req) => {
    const { epicKey, sprintId } = req.payload;

    if (sprintId === null) {
        // Move to backlog
        const response = await api
            .asUser()
            .requestJira(route`/rest/agile/1.0/backlog/issue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ issues: [epicKey] }),
            });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Jira API error ${response.status}: ${text}`);
        }
        return;
    }

    const response = await api
        .asUser()
        .requestJira(route`/rest/agile/1.0/sprint/${sprintId}/issue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ issues: [epicKey] }),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
});

export const handler = resolver.getDefinitions();
