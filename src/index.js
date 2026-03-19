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

// Discover the Focus Area custom field by name, then fetch its context and all options.
// Returns { fieldId, contextId, options: [{ id, value }] } or null if not found.
resolver.define('getFocusAreaField', async () => {
    const fieldsRes = await api.asUser().requestJira(route`/rest/api/3/field`);
    if (!fieldsRes.ok) {
        const text = await fieldsRes.text();
        throw new Error(`Jira API error ${fieldsRes.status}: ${text}`);
    }
    const fields = await fieldsRes.json();
    const field = fields.find(f => f.name === FOCUS_AREA_FIELD_NAME && f.custom);
    if (!field) return null;

    const fieldId = field.id;

    const ctxRes = await api.asUser().requestJira(route`/rest/api/3/field/${fieldId}/context?maxResults=1`);
    if (!ctxRes.ok) {
        const text = await ctxRes.text();
        throw new Error(`Jira API error ${ctxRes.status}: ${text}`);
    }
    const ctxData = await ctxRes.json();
    const context = ctxData.values?.[0];
    if (!context) return { fieldId, contextId: null, options: [] };

    const contextId = context.id;

    const optRes = await api.asUser().requestJira(route`/rest/api/3/field/${fieldId}/context/${contextId}/option?maxResults=100`);
    if (!optRes.ok) {
        const text = await optRes.text();
        throw new Error(`Jira API error ${optRes.status}: ${text}`);
    }
    const optData = await optRes.json();
    return {
        fieldId,
        contextId,
        options: (optData.values ?? []).map(o => ({ id: o.id, value: o.value })),
    };
});

// Add a new option to the Focus Area field context.
// Returns the created option { id, value }.
resolver.define('addFocusAreaOption', async (req) => {
    const { fieldId, contextId, value } = req.payload;

    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/field/${fieldId}/context/${contextId}/option`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ options: [{ value }] }),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const created = data.options?.[0];
    return { id: created.id, value: created.value };
});

// Move a Focus Area option to a new position within its context.
// position: 'First' | 'Last' | 'Before' | 'After'
// afterId: required when position is 'Before' or 'After' — the reference option ID.
resolver.define('reorderFocusAreaOption', async (req) => {
    const { fieldId, contextId, optionId, position, afterId } = req.payload;

    const body = { customFieldOptionIds: [optionId], position };
    if (afterId) body.after = { id: afterId };

    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/field/${fieldId}/context/${contextId}/option/move`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
});

// Delete an option from the Focus Area field context.
resolver.define('deleteFocusAreaOption', async (req) => {
    const { fieldId, contextId, optionId } = req.payload;

    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/field/${fieldId}/context/${contextId}/option/${optionId}`, {
            method: 'DELETE',
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
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
// Pass boardSprintIds (array of sprint IDs from the selected board) to restrict sprint
// placement to only sprints on that board — epics can appear in sprints across multiple
// boards and we must ignore sprints that don't belong to the selected board.
resolver.define('getEpics', async (req) => {
    const { filterId, focusAreaFieldId, boardSprintIds } = req.payload;

    // customfield_10019 = Jira rank (LexoRank) — used to sort epics within a cell
    const fields = ['summary', 'priority', 'assignee', 'customfield_10020', 'customfield_10019', 'project'];
    if (focusAreaFieldId) fields.push(focusAreaFieldId);

    const jql = `filter = ${filterId} AND issuetype = Epic AND statusCategory != Done ORDER BY created DESC`;

    // /rest/api/3/search/jql caps at 100 per page — paginate with nextPageToken.
    let allIssues = [];
    let nextPageToken = undefined;
    do {
        const body = { jql, fields, maxResults: 100 };
        if (nextPageToken) body.nextPageToken = nextPageToken;

        const response = await api
            .asUser()
            .requestJira(route`/rest/api/3/search/jql`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Jira API error ${response.status}: ${text}`);
        }

        const data = await response.json();
        allIssues = allIssues.concat(data.issues ?? []);
        nextPageToken = data.nextPageToken ?? null;
    } while (nextPageToken);

    const data = { issues: allIssues };

    // Build a set of sprint IDs belonging to the selected board for fast lookup.
    const boardSprintIdSet = boardSprintIds?.length
        ? new Set(boardSprintIds.map(String))
        : null;

    return data.issues.map(issue => {
        // customfield_10020 is the sprint field — returned as an array.
        // Filter to only sprints from the selected board, then pick active or last.
        const allSprints = issue.fields.customfield_10020 ?? [];
        const sprints = boardSprintIdSet
            ? allSprints.filter(s => boardSprintIdSet.has(String(s.id)))
            : allSprints;
        const activeSprint = sprints.find(s => s.state === 'active') ?? sprints[sprints.length - 1] ?? null;
        const focusArea = focusAreaFieldId
            ? (issue.fields[focusAreaFieldId]?.value ?? null)
            : null;
        return {
            key: issue.key,
            summary: issue.fields.summary,
            priority: issue.fields.priority?.name ?? null,
            assignee: issue.fields.assignee
                ? { displayName: issue.fields.assignee.displayName, avatarUrl: issue.fields.assignee.avatarUrls?.['24x24'] ?? null }
                : null,
            // sprintId is null when the epic has no sprint on this board → goes to backlog
            sprintId: activeSprint ? String(activeSprint.id) : null,
            focusArea,
            rank: issue.fields.customfield_10019 ?? null,
            project: issue.fields.project
                ? { key: issue.fields.project.key, name: issue.fields.project.name, avatarUrl: issue.fields.project.avatarUrls?.['16x16'] ?? null }
                : null,
        };
    });
});


// Set (or clear) the Focus Area custom field on an epic.
// Pass optionId = null to clear it. Using ID is more reliable than value name.
resolver.define('updateEpicFocusArea', async (req) => {
    const { epicKey, fieldId, optionId } = req.payload;

    const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/issue/${epicKey}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: { [fieldId]: optionId ? { id: optionId } : null },
            }),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
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

// Rank an epic relative to another using the Jira Agile rank API.
// Pass rankBeforeIssue to place epicKey immediately before that issue,
// or rankAfterIssue to place it immediately after.
resolver.define('rankEpic', async (req) => {
    const { epicKey, rankBeforeIssue, rankAfterIssue } = req.payload;

    const body = { issues: [epicKey] };
    if (rankBeforeIssue) body.rankBeforeIssue = rankBeforeIssue;
    else if (rankAfterIssue) body.rankAfterIssue = rankAfterIssue;

    const response = await api
        .asUser()
        .requestJira(route`/rest/agile/1.0/issue/rank`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
});

// Fetch users assignable to an issue — used to populate the assignee picker in the modal.
resolver.define('getAssignableUsers', async (req) => {
    const { issueKey } = req.payload;
    const response = await api.asUser().requestJira(
        route`/rest/api/3/user/assignable/search?issueKey=${issueKey}&maxResults=50`
    );
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
    const users = await response.json();
    return (users ?? []).map(u => ({
        accountId: u.accountId,
        displayName: u.displayName,
        avatarUrl: u.avatarUrls?.['24x24'] ?? null,
    }));
});

// Set the assignee on any issue. Pass accountId = null to unassign.
resolver.define('updateIssueAssignee', async (req) => {
    const { issueKey, accountId } = req.payload;
    const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { assignee: accountId ? { accountId } : null } }),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jira API error ${response.status}: ${text}`);
    }
});

// Transition an epic to Done. Fetches available transitions, finds the one that moves
// to the Done status category, then executes it.
resolver.define('getTransitions', async (req) => {
    const { epicKey } = req.payload;
    const transRes = await api.asUser().requestJira(route`/rest/api/3/issue/${epicKey}/transitions`);
    if (!transRes.ok) {
        const text = await transRes.text();
        throw new Error(`Jira API error ${transRes.status}: ${text}`);
    }
    const { transitions } = await transRes.json();
    return transitions.map(t => ({ id: t.id, name: t.name }));
});

resolver.define('transitionEpicDone', async (req) => {
    const { epicKey, transitionId } = req.payload;
    const execRes = await api.asUser().requestJira(route`/rest/api/3/issue/${epicKey}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (!execRes.ok) {
        const text = await execRes.text();
        throw new Error(`Jira API error ${execRes.status}: ${text}`);
    }
});

export const handler = resolver.getDefinitions();
