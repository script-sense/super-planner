/**
 * Resolver unit tests
 *
 * jest.mock() calls are hoisted by babel-jest before any require/var statements.
 * We use `var` (not const/let) for shared mocks so they are var-hoisted and
 * available as bindings when the mock factories close over them.
 *
 * Execution order after babel-jest transformation:
 *   1. jest.mock factories registered
 *   2. var declarations hoisted (undefined)
 *   3. resolverDefs = {} initialised
 *   4. require('../index') loads the module:
 *        → triggers @forge/resolver factory → define() mutations populate resolverDefs
 *        → triggers @forge/api factory → mockRequestJira is assigned
 *   5. Tests run — resolverDefs and mockRequestJira are fully populated
 */

// Shared state mutated by mock factories
var resolverDefs = {};
var mockRequestJira;

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('@forge/resolver', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        define: (name, fn) => { resolverDefs[name] = fn; },
        getDefinitions: () => resolverDefs,
    })),
}));

jest.mock('@forge/api', () => {
    const fn = jest.fn();
    mockRequestJira = fn;
    return {
        __esModule: true,
        default: { asUser: () => ({ requestJira: fn }) },
        // Simulate tagged template literal by joining strings + interpolated values
        route: (strings, ...vals) =>
            Array.isArray(strings)
                ? strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), '')
                : String(strings),
    };
});

// Load the module under test — populates resolverDefs via resolver.define()
require('../index');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal successful or failed mock response */
function makeRes(ok, data, errorText = 'API error') {
    return {
        ok,
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(errorText),
    };
}

/** Build a minimal Jira issue object for getEpics */
function makeIssue(key, opts = {}) {
    return {
        key,
        fields: {
            summary: opts.summary ?? `Summary ${key}`,
            priority: opts.priority ? { name: opts.priority } : null,
            assignee: opts.assignee
                ? { displayName: opts.assignee, avatarUrls: { '24x24': `http://a/${opts.assignee}` } }
                : null,
            customfield_10020: opts.sprints ?? [],
            customfield_10019: opts.rank ?? null,
            project: opts.project
                ? { key: opts.project, name: `${opts.project} Project`, avatarUrls: { '16x16': 'http://p/img' } }
                : null,
            ...(opts.extraFields ?? {}),
        },
    };
}

/** Invoke a resolver by name with an optional payload */
function call(name, payload = {}) {
    if (!resolverDefs[name]) throw new Error(`Resolver "${name}" not defined`);
    return resolverDefs[name]({ payload });
}

beforeEach(() => {
    mockRequestJira.mockReset();
});

// ── getBoards ─────────────────────────────────────────────────────────────────

describe('getBoards', () => {
    test('returns only scrum boards with id, name, projectKey', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {
            values: [
                { id: 1, name: 'Scrum A', type: 'scrum', location: { projectKey: 'NH' } },
                { id: 2, name: 'Kanban B', type: 'kanban', location: { projectKey: 'MM' } },
                { id: 3, name: 'Scrum C', type: 'scrum', location: null },
            ],
        }));
        const result = await call('getBoards');
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ id: 1, name: 'Scrum A', projectKey: 'NH' });
        expect(result[1]).toEqual({ id: 3, name: 'Scrum C', projectKey: null });
    });

    test('returns empty array when no scrum boards', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {
            values: [{ id: 1, name: 'Kanban', type: 'kanban', location: {} }],
        }));
        expect(await call('getBoards')).toEqual([]);
    });

    test('handles missing values array gracefully', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        expect(await call('getBoards')).toEqual([]);
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'Not found'));
        await expect(call('getBoards')).rejects.toThrow('Jira API error');
    });
});

// ── getSprints ────────────────────────────────────────────────────────────────

describe('getSprints', () => {
    const activeSprint = { id: 10, name: 'S10', state: 'active', startDate: '2026-03-01', endDate: '2026-03-14' };
    const closedSprint = { id: 9,  name: 'S9',  state: 'closed', startDate: '2026-02-01', endDate: '2026-02-14' };
    const futureSprint = { id: 11, name: 'S11', state: 'future', startDate: '2026-03-15', endDate: '2026-03-28' };

    test('merges active/future and closed sprints sorted by startDate', async () => {
        mockRequestJira
            .mockResolvedValueOnce(makeRes(true, { values: [activeSprint, futureSprint] }))
            .mockResolvedValueOnce(makeRes(true, { values: [closedSprint] }));
        const result = await call('getSprints', { boardId: 37 });
        expect(result).toHaveLength(3);
        expect(result.map(s => s.id)).toEqual([9, 10, 11]); // sorted chronologically
    });

    test('maps sprint fields correctly', async () => {
        mockRequestJira
            .mockResolvedValueOnce(makeRes(true, { values: [activeSprint] }))
            .mockResolvedValueOnce(makeRes(true, { values: [] }));
        const [s] = await call('getSprints', { boardId: 37 });
        expect(s).toEqual({ id: 10, name: 'S10', state: 'active', startDate: '2026-03-01', endDate: '2026-03-14' });
    });

    test('handles sprints with no dates (sorts them stably)', async () => {
        mockRequestJira
            .mockResolvedValueOnce(makeRes(true, { values: [{ id: 1, name: 'S1', state: 'future' }] }))
            .mockResolvedValueOnce(makeRes(true, { values: [] }));
        const result = await call('getSprints', { boardId: 37 });
        expect(result).toHaveLength(1);
        expect(result[0].startDate).toBeNull();
    });

    test('throws when active/future request fails', async () => {
        mockRequestJira
            .mockResolvedValueOnce(makeRes(false, {}, 'error'))
            .mockResolvedValueOnce(makeRes(true, { values: [] }));
        await expect(call('getSprints', { boardId: 37 })).rejects.toThrow('Jira API error');
    });

    test('throws when closed request fails', async () => {
        mockRequestJira
            .mockResolvedValueOnce(makeRes(true, { values: [] }))
            .mockResolvedValueOnce(makeRes(false, {}, 'error'));
        await expect(call('getSprints', { boardId: 37 })).rejects.toThrow('Jira API error');
    });
});

// ── getFilters ────────────────────────────────────────────────────────────────

describe('getFilters', () => {
    test('returns mapped filter data', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {
            values: [
                { id: '10001', name: 'NH Filter', jql: 'project = NH' },
                { id: '10002', name: 'All Filter', jql: '' },
            ],
        }));
        const result = await call('getFilters');
        expect(result).toEqual([
            { id: '10001', name: 'NH Filter', jql: 'project = NH' },
            { id: '10002', name: 'All Filter', jql: '' },
        ]);
    });

    test('handles missing jql field', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {
            values: [{ id: '1', name: 'F' }],
        }));
        const [f] = await call('getFilters');
        expect(f.jql).toBe('');
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'forbidden'));
        await expect(call('getFilters')).rejects.toThrow('Jira API error');
    });
});

// ── getFocusAreaField ─────────────────────────────────────────────────────────

describe('getFocusAreaField', () => {
    test('returns null when Focus Area field is not found', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, [
            { id: 'cf_1', name: 'Other Field', custom: true },
        ]));
        expect(await call('getFocusAreaField')).toBeNull();
    });

    test('returns { fieldId, contextId: null, options: [] } when no context exists', async () => {
        mockRequestJira
            .mockResolvedValueOnce(makeRes(true, [{ id: 'cf_10', name: 'Focus Area', custom: true }]))
            .mockResolvedValueOnce(makeRes(true, { values: [] })); // no context
        const result = await call('getFocusAreaField');
        expect(result).toEqual({ fieldId: 'cf_10', contextId: null, options: [] });
    });

    test('returns field, context and options', async () => {
        mockRequestJira
            .mockResolvedValueOnce(makeRes(true, [{ id: 'cf_10', name: 'Focus Area', custom: true }]))
            .mockResolvedValueOnce(makeRes(true, { values: [{ id: 'ctx_5' }] }))
            .mockResolvedValueOnce(makeRes(true, {
                values: [
                    { id: 'opt_1', value: 'Backend' },
                    { id: 'opt_2', value: 'Frontend' },
                ],
            }));
        const result = await call('getFocusAreaField');
        expect(result).toEqual({
            fieldId: 'cf_10',
            contextId: 'ctx_5',
            options: [{ id: 'opt_1', value: 'Backend' }, { id: 'opt_2', value: 'Frontend' }],
        });
    });

    test('throws on fields API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, null, 'error'));
        await expect(call('getFocusAreaField')).rejects.toThrow('Jira API error');
    });
});

// ── addFocusAreaOption ────────────────────────────────────────────────────────

describe('addFocusAreaOption', () => {
    test('returns the created option', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {
            options: [{ id: 'opt_99', value: 'Mobile' }],
        }));
        const result = await call('addFocusAreaOption', { fieldId: 'cf_10', contextId: 'ctx_5', value: 'Mobile' });
        expect(result).toEqual({ id: 'opt_99', value: 'Mobile' });
    });

    test('sends a POST with correct body', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { options: [{ id: 'opt_1', value: 'X' }] }));
        await call('addFocusAreaOption', { fieldId: 'cf_10', contextId: 'ctx_5', value: 'X' });
        const [, opts] = mockRequestJira.mock.calls[0];
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body)).toEqual({ options: [{ value: 'X' }] });
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'bad'));
        await expect(call('addFocusAreaOption', { fieldId: 'f', contextId: 'c', value: 'X' })).rejects.toThrow('Jira API error');
    });
});

// ── deleteFocusAreaOption ─────────────────────────────────────────────────────

describe('deleteFocusAreaOption', () => {
    test('sends a DELETE request', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('deleteFocusAreaOption', { fieldId: 'cf_10', contextId: 'ctx_5', optionId: 'opt_1' });
        expect(mockRequestJira.mock.calls[0][1].method).toBe('DELETE');
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'not found'));
        await expect(call('deleteFocusAreaOption', { fieldId: 'f', contextId: 'c', optionId: 'o' })).rejects.toThrow('Jira API error');
    });
});

// ── reorderFocusAreaOption ────────────────────────────────────────────────────

describe('reorderFocusAreaOption', () => {
    test('sends PUT with position body', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('reorderFocusAreaOption', { fieldId: 'f', contextId: 'c', optionId: 'o1', position: 'First' });
        const [, opts] = mockRequestJira.mock.calls[0];
        expect(opts.method).toBe('PUT');
        const body = JSON.parse(opts.body);
        expect(body).toEqual({ customFieldOptionIds: ['o1'], position: 'First' });
    });

    test('includes after.id when afterId is provided', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('reorderFocusAreaOption', { fieldId: 'f', contextId: 'c', optionId: 'o1', position: 'After', afterId: 'o2' });
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.after).toEqual({ id: 'o2' });
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'error'));
        await expect(call('reorderFocusAreaOption', { fieldId: 'f', contextId: 'c', optionId: 'o', position: 'Last' })).rejects.toThrow('Jira API error');
    });
});

// ── getEpics ──────────────────────────────────────────────────────────────────

describe('getEpics', () => {
    test('returns mapped epic data', async () => {
        const issue = makeIssue('NH-1', {
            summary: 'My Epic',
            priority: 'High',
            assignee: 'Alice',
            rank: 'aaa',
            project: 'NH',
            sprints: [{ id: 55, state: 'active', name: 'Sprint 1' }],
        });
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [issue] }));
        const [epic] = await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [55] });
        expect(epic.key).toBe('NH-1');
        expect(epic.summary).toBe('My Epic');
        expect(epic.priority).toBe('High');
        expect(epic.assignee.displayName).toBe('Alice');
        expect(epic.sprintId).toBe('55');
        expect(epic.rank).toBe('aaa');
        expect(epic.project.key).toBe('NH');
    });

    test('paginates through multiple pages using nextPageToken', async () => {
        mockRequestJira
            .mockResolvedValueOnce(makeRes(true, { issues: [makeIssue('NH-1')], nextPageToken: 'tok2' }))
            .mockResolvedValueOnce(makeRes(true, { issues: [makeIssue('NH-2')], nextPageToken: 'tok3' }))
            .mockResolvedValueOnce(makeRes(true, { issues: [makeIssue('NH-3')] }));
        const result = await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [] });
        expect(result).toHaveLength(3);
        expect(mockRequestJira).toHaveBeenCalledTimes(3);
        // Verify nextPageToken is forwarded in page 2 and 3 requests
        expect(JSON.parse(mockRequestJira.mock.calls[1][1].body).nextPageToken).toBe('tok2');
        expect(JSON.parse(mockRequestJira.mock.calls[2][1].body).nextPageToken).toBe('tok3');
    });

    test('stops paginating when nextPageToken is absent', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [makeIssue('NH-1')] }));
        const result = await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [] });
        expect(result).toHaveLength(1);
        expect(mockRequestJira).toHaveBeenCalledTimes(1);
    });

    test('filters sprints to those belonging to the selected board', async () => {
        const issue = makeIssue('NH-1', {
            sprints: [
                { id: 100, state: 'closed', name: 'Other Board Sprint' },
                { id: 200, state: 'active', name: 'Board Sprint' },
            ],
        });
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [issue] }));
        const [epic] = await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [200] });
        expect(epic.sprintId).toBe('200');
    });

    test('sets sprintId to null when no board sprints match (→ backlog)', async () => {
        const issue = makeIssue('NH-1', {
            sprints: [{ id: 999, state: 'active', name: 'Other board sprint' }],
        });
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [issue] }));
        const [epic] = await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [100, 200] });
        expect(epic.sprintId).toBeNull();
    });

    test('prefers active sprint over closed when multiple board sprints match', async () => {
        const issue = makeIssue('NH-1', {
            sprints: [
                { id: 10, state: 'closed', name: 'Old Sprint' },
                { id: 20, state: 'active', name: 'Active Sprint' },
            ],
        });
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [issue] }));
        const [epic] = await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [10, 20] });
        expect(epic.sprintId).toBe('20');
    });

    test('includes focusArea when focusAreaFieldId is provided', async () => {
        const issue = makeIssue('NH-1', { extraFields: { 'customfield_fa': { value: 'Backend' } } });
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [issue] }));
        const [epic] = await call('getEpics', { filterId: '10001', focusAreaFieldId: 'customfield_fa', boardSprintIds: [] });
        expect(epic.focusArea).toBe('Backend');
    });

    test('focusArea is null when focusAreaFieldId is null', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [makeIssue('NH-1')] }));
        const [epic] = await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [] });
        expect(epic.focusArea).toBeNull();
    });

    test('handles unassigned epics (assignee null)', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [makeIssue('NH-1')] }));
        const [epic] = await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [] });
        expect(epic.assignee).toBeNull();
    });

    test('uses maxResults 100 per page', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, { issues: [] }));
        await call('getEpics', { filterId: '10001', focusAreaFieldId: null, boardSprintIds: [] });
        expect(JSON.parse(mockRequestJira.mock.calls[0][1].body).maxResults).toBe(100);
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'bad request'));
        await expect(call('getEpics', { filterId: 'x', focusAreaFieldId: null, boardSprintIds: [] })).rejects.toThrow('Jira API error');
    });
});

// ── updateEpicFocusArea ───────────────────────────────────────────────────────

describe('updateEpicFocusArea', () => {
    test('sends PUT with option id', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('updateEpicFocusArea', { epicKey: 'NH-1', fieldId: 'cf_10', optionId: 'opt_5' });
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.fields['cf_10']).toEqual({ id: 'opt_5' });
    });

    test('sends null to clear the focus area', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('updateEpicFocusArea', { epicKey: 'NH-1', fieldId: 'cf_10', optionId: null });
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.fields['cf_10']).toBeNull();
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'error'));
        await expect(call('updateEpicFocusArea', { epicKey: 'NH-1', fieldId: 'f', optionId: 'o' })).rejects.toThrow('Jira API error');
    });
});

// ── updateEpicPriority ────────────────────────────────────────────────────────

describe('updateEpicPriority', () => {
    test('sends PUT with priority name', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('updateEpicPriority', { epicKey: 'NH-1', priority: 'High' });
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.fields.priority).toEqual({ name: 'High' });
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'error'));
        await expect(call('updateEpicPriority', { epicKey: 'NH-1', priority: 'High' })).rejects.toThrow('Jira API error');
    });
});

// ── assignEpicToSprint ────────────────────────────────────────────────────────

describe('assignEpicToSprint', () => {
    test('calls backlog endpoint when sprintId is null', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('assignEpicToSprint', { epicKey: 'NH-1', sprintId: null });
        const [url, opts] = mockRequestJira.mock.calls[0];
        expect(url).toContain('backlog');
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body).issues).toContain('NH-1');
    });

    test('calls sprint endpoint with correct sprintId', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('assignEpicToSprint', { epicKey: 'NH-1', sprintId: 42 });
        const [url, opts] = mockRequestJira.mock.calls[0];
        expect(url).toContain('42');
        expect(url).toContain('sprint');
        expect(JSON.parse(opts.body).issues).toContain('NH-1');
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'error'));
        await expect(call('assignEpicToSprint', { epicKey: 'NH-1', sprintId: null })).rejects.toThrow('Jira API error');
    });
});

// ── rankEpic ──────────────────────────────────────────────────────────────────

describe('rankEpic', () => {
    test('sends rankBeforeIssue when provided', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('rankEpic', { epicKey: 'NH-2', rankBeforeIssue: 'NH-1' });
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.issues).toContain('NH-2');
        expect(body.rankBeforeIssue).toBe('NH-1');
        expect(body.rankAfterIssue).toBeUndefined();
    });

    test('sends rankAfterIssue when provided', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('rankEpic', { epicKey: 'NH-2', rankAfterIssue: 'NH-3' });
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.rankAfterIssue).toBe('NH-3');
        expect(body.rankBeforeIssue).toBeUndefined();
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'error'));
        await expect(call('rankEpic', { epicKey: 'NH-1' })).rejects.toThrow('Jira API error');
    });
});

// ── getAssignableUsers ────────────────────────────────────────────────────────

describe('getAssignableUsers', () => {
    test('returns mapped user data', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, [
            { accountId: 'acc1', displayName: 'Alice', avatarUrls: { '24x24': 'http://a/alice' } },
            { accountId: 'acc2', displayName: 'Bob',   avatarUrls: { '24x24': 'http://a/bob' } },
        ]));
        const result = await call('getAssignableUsers', { issueKey: 'NH-1' });
        expect(result).toEqual([
            { accountId: 'acc1', displayName: 'Alice', avatarUrl: 'http://a/alice' },
            { accountId: 'acc2', displayName: 'Bob',   avatarUrl: 'http://a/bob' },
        ]);
    });

    test('handles missing avatar gracefully', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, [
            { accountId: 'acc1', displayName: 'Alice', avatarUrls: {} },
        ]));
        const [u] = await call('getAssignableUsers', { issueKey: 'NH-1' });
        expect(u.avatarUrl).toBeNull();
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, [], 'forbidden'));
        await expect(call('getAssignableUsers', { issueKey: 'NH-1' })).rejects.toThrow('Jira API error');
    });
});

// ── updateIssueAssignee ───────────────────────────────────────────────────────

describe('updateIssueAssignee', () => {
    test('sends PUT with accountId', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('updateIssueAssignee', { issueKey: 'NH-1', accountId: 'acc1' });
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.fields.assignee).toEqual({ accountId: 'acc1' });
    });

    test('sends null to unassign', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('updateIssueAssignee', { issueKey: 'NH-1', accountId: null });
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.fields.assignee).toBeNull();
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'error'));
        await expect(call('updateIssueAssignee', { issueKey: 'NH-1', accountId: 'x' })).rejects.toThrow('Jira API error');
    });
});

// ── getDoneTransitions ────────────────────────────────────────────────────────

describe('getDoneTransitions', () => {
    test('returns all done-category transitions', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {
            transitions: [
                { id: '11', name: 'In Progress', to: { statusCategory: { key: 'indeterminate' } } },
                { id: '31', name: 'Done',         to: { statusCategory: { key: 'done' } } },
                { id: '32', name: 'Closed',       to: { statusCategory: { key: 'done' } } },
            ],
        }));
        const result = await call('getDoneTransitions', { epicKey: 'NH-1' });
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ id: '31', name: 'Done' });
        expect(result[1]).toEqual({ id: '32', name: 'Closed' });
    });

    test('returns empty array when no done transitions exist', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {
            transitions: [{ id: '11', name: 'Todo', to: { statusCategory: { key: 'new' } } }],
        }));
        const result = await call('getDoneTransitions', { epicKey: 'NH-1' });
        expect(result).toEqual([]);
    });

    test('throws on API error', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'not found'));
        await expect(call('getDoneTransitions', { epicKey: 'NH-1' })).rejects.toThrow('Jira API error');
    });
});

// ── transitionEpicDone ────────────────────────────────────────────────────────

describe('transitionEpicDone', () => {
    test('executes the supplied transitionId', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(true, {}));
        await call('transitionEpicDone', { epicKey: 'NH-1', transitionId: '31' });
        expect(mockRequestJira).toHaveBeenCalledTimes(1);
        const body = JSON.parse(mockRequestJira.mock.calls[0][1].body);
        expect(body.transition.id).toBe('31');
    });

    test('throws when transition execution fails', async () => {
        mockRequestJira.mockResolvedValueOnce(makeRes(false, {}, 'conflict'));
        await expect(call('transitionEpicDone', { epicKey: 'NH-1', transitionId: '31' })).rejects.toThrow('Jira API error');
    });
});
