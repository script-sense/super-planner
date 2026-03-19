import {
    ROWS, BACKLOG_COLUMN, UNASSIGNED_KEY,
    startOfDay,
    computeCalendarDays,
    sprintDaySpan,
    computeMonthGroups,
    computeQuarterGroups,
    getPriorityRow,
    buildGridData,
    findMatchingFilter,
} from '../utils';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SPRINT_JAN = { id: 1, name: 'Jan Sprint', state: 'closed', startDate: '2026-01-05', endDate: '2026-01-18' };
const SPRINT_FEB = { id: 2, name: 'Feb Sprint', state: 'active', startDate: '2026-02-02', endDate: '2026-02-15' };
const SPRINT_MAR = { id: 3, name: 'Mar Sprint', state: 'future', startDate: '2026-03-02', endDate: '2026-03-15' };

function makeEpic(key, opts = {}) {
    return {
        key,
        summary: `Epic ${key}`,
        priority: opts.priority ?? 'Medium',
        sprintId: opts.sprintId ?? null,
        focusArea: opts.focusArea ?? null,
        rank: opts.rank ?? null,
        ...(opts.extra ?? {}),
    };
}

const ALL_SECTIONS = [{ key: UNASSIGNED_KEY, label: '' }];

// ── startOfDay ────────────────────────────────────────────────────────────────

describe('startOfDay', () => {
    test('zeroes out time components', () => {
        const d = startOfDay(new Date('2026-03-15T14:30:00Z'));
        expect(d.getHours()).toBe(0);
        expect(d.getMinutes()).toBe(0);
        expect(d.getSeconds()).toBe(0);
        expect(d.getMilliseconds()).toBe(0);
    });

    test('preserves the date', () => {
        const d = startOfDay(new Date('2026-06-10T23:59:59'));
        expect(d.getFullYear()).toBe(2026);
        expect(d.getMonth()).toBe(5); // June = 5
        expect(d.getDate()).toBe(10);
    });
});

// ── computeCalendarDays ───────────────────────────────────────────────────────

describe('computeCalendarDays', () => {
    test('returns empty array for empty sprint list', () => {
        expect(computeCalendarDays([])).toEqual([]);
    });

    test('returns empty array when no sprints have dates', () => {
        expect(computeCalendarDays([{ id: 1, name: 'S', state: 'future' }])).toEqual([]);
    });

    test('starts on the 1st of the earliest sprint month', () => {
        const days = computeCalendarDays([SPRINT_JAN]);
        expect(days[0].getDate()).toBe(1);
        expect(days[0].getMonth()).toBe(0); // January
        expect(days[0].getFullYear()).toBe(2026);
    });

    test('ends on the last day of the latest sprint month', () => {
        const days = computeCalendarDays([SPRINT_JAN]);
        const last = days[days.length - 1];
        expect(last.getMonth()).toBe(0); // still January
        expect(last.getDate()).toBe(31);
    });

    test('spans multiple months when sprints cross months', () => {
        const days = computeCalendarDays([SPRINT_JAN, SPRINT_FEB]);
        const first = days[0];
        const last  = days[days.length - 1];
        expect(first.getMonth()).toBe(0);  // January
        expect(last.getMonth()).toBe(1);   // February
        expect(last.getDate()).toBe(28);   // Feb 2026 has 28 days
    });

    test('produces consecutive days with no gaps', () => {
        const days = computeCalendarDays([SPRINT_JAN, SPRINT_FEB]);
        for (let i = 1; i < days.length; i++) {
            const diff = (days[i] - days[i - 1]) / (24 * 60 * 60 * 1000);
            expect(diff).toBe(1);
        }
    });

    test('ignores sprints without dates', () => {
        const sprints = [SPRINT_JAN, { id: 99, name: 'No dates', state: 'future' }];
        const days = computeCalendarDays(sprints);
        // Should only span January (only SPRINT_JAN has dates)
        expect(days[0].getMonth()).toBe(0);
        expect(days[days.length - 1].getMonth()).toBe(0);
    });
});

// ── sprintDaySpan ─────────────────────────────────────────────────────────────

describe('sprintDaySpan', () => {
    const days = computeCalendarDays([SPRINT_JAN]); // Jan 1–31

    test('returns null for sprint without dates', () => {
        expect(sprintDaySpan({ id: 1, state: 'future' }, days)).toBeNull();
    });

    test('returns null for empty days array', () => {
        expect(sprintDaySpan(SPRINT_JAN, [])).toBeNull();
    });

    test('returns correct startIdx and span', () => {
        // SPRINT_JAN: Jan 5–18 in a Jan 1-origin array
        const span = sprintDaySpan(SPRINT_JAN, days);
        expect(span).not.toBeNull();
        expect(span.startIdx).toBe(4); // Jan 5 is index 4 (0-based)
        expect(span.span).toBe(14);    // 5th to 18th inclusive = 14 days
    });

    test('returns null when sprint starts before the days array', () => {
        // Create days starting Feb 1; sprint is in January → before origin
        const febDays = computeCalendarDays([SPRINT_FEB]);
        expect(sprintDaySpan(SPRINT_JAN, febDays)).toBeNull();
    });
});

// ── computeMonthGroups ────────────────────────────────────────────────────────

describe('computeMonthGroups', () => {
    test('returns empty array for empty days', () => {
        expect(computeMonthGroups([])).toEqual([]);
    });

    test('single month: one group spanning all days', () => {
        const days = computeCalendarDays([SPRINT_JAN]); // Jan: 31 days
        const groups = computeMonthGroups(days);
        expect(groups).toHaveLength(1);
        expect(groups[0].startIdx).toBe(0);
        expect(groups[0].span).toBe(31);
        expect(typeof groups[0].label).toBe('string');
        expect(groups[0].label).toBeTruthy();
    });

    test('two months: two groups with correct spans', () => {
        const days = computeCalendarDays([SPRINT_JAN, SPRINT_FEB]);
        const groups = computeMonthGroups(days);
        expect(groups).toHaveLength(2);
        expect(groups[0].startIdx).toBe(0);
        expect(groups[0].span).toBe(31); // January: 31 days
        expect(groups[1].startIdx).toBe(31);
        expect(groups[1].span).toBe(28); // February 2026: 28 days
    });

    test('group spans sum to total number of days', () => {
        const days = computeCalendarDays([SPRINT_JAN, SPRINT_FEB, SPRINT_MAR]);
        const groups = computeMonthGroups(days);
        const total = groups.reduce((n, g) => n + g.span, 0);
        expect(total).toBe(days.length);
    });
});

// ── computeQuarterGroups ──────────────────────────────────────────────────────

describe('computeQuarterGroups', () => {
    test('returns empty array for empty days', () => {
        expect(computeQuarterGroups([])).toEqual([]);
    });

    test('single quarter: one group', () => {
        // Jan–Mar = Q1
        const days = computeCalendarDays([SPRINT_JAN, SPRINT_MAR]);
        const groups = computeQuarterGroups(days);
        expect(groups).toHaveLength(1);
        expect(groups[0].label).toBe('Q1 2026');
        expect(groups[0].startIdx).toBe(0);
    });

    test('labels include year', () => {
        const days = computeCalendarDays([SPRINT_JAN]);
        const [g] = computeQuarterGroups(days);
        expect(g.label).toMatch(/2026/);
    });

    test('group spans sum to total days', () => {
        const days = computeCalendarDays([SPRINT_JAN, SPRINT_FEB, SPRINT_MAR]);
        const groups = computeQuarterGroups(days);
        expect(groups.reduce((n, g) => n + g.span, 0)).toBe(days.length);
    });
});

// ── getPriorityRow ────────────────────────────────────────────────────────────

describe('getPriorityRow', () => {
    test.each(ROWS.map(r => r.key))('returns %s for valid priority', priority => {
        expect(getPriorityRow(priority)).toBe(priority);
    });

    test('returns Lowest for null priority', () => {
        expect(getPriorityRow(null)).toBe('Lowest');
    });

    test('returns Lowest for undefined priority', () => {
        expect(getPriorityRow(undefined)).toBe('Lowest');
    });

    test('returns Lowest for unknown priority string', () => {
        expect(getPriorityRow('Critical')).toBe('Lowest');
    });
});

// ── buildGridData ─────────────────────────────────────────────────────────────

describe('buildGridData', () => {
    const sprints = [SPRINT_JAN, SPRINT_FEB];

    test('places epic in its sprint column and priority row', () => {
        const epics = [makeEpic('NH-1', { priority: 'High', sprintId: '1' })];
        const grid = buildGridData(epics, sprints, {}, ALL_SECTIONS, {});
        expect(grid[UNASSIGNED_KEY]['High'][1]).toHaveLength(1);
        expect(grid[UNASSIGNED_KEY]['High'][1][0].key).toBe('NH-1');
    });

    test('places epic in backlog when sprintId is null', () => {
        const epics = [makeEpic('NH-1', { priority: 'Medium', sprintId: null })];
        const grid = buildGridData(epics, sprints, {}, ALL_SECTIONS, {});
        expect(grid[UNASSIGNED_KEY]['Medium'].backlog).toHaveLength(1);
    });

    test('places epic in backlog when sprint does not belong to grid', () => {
        const epics = [makeEpic('NH-1', { sprintId: '999' })]; // sprint 999 not in sprints array
        const grid = buildGridData(epics, sprints, {}, ALL_SECTIONS, {});
        expect(grid[UNASSIGNED_KEY]['Medium'].backlog).toHaveLength(1);
    });

    test('falls back to Lowest row for unknown priority', () => {
        const epics = [makeEpic('NH-1', { priority: 'Critical', sprintId: '1' })];
        const grid = buildGridData(epics, sprints, {}, ALL_SECTIONS, {});
        expect(grid[UNASSIGNED_KEY]['Lowest'][1]).toHaveLength(1);
    });

    test('positions override epic sprint and priority', () => {
        const epics = [makeEpic('NH-1', { priority: 'High', sprintId: '1' })];
        const positions = { 'NH-1': { rowKey: 'Low', colId: '2' } };
        const grid = buildGridData(epics, sprints, positions, ALL_SECTIONS, {});
        expect(grid[UNASSIGNED_KEY]['Low'][2]).toHaveLength(1);
        expect(grid[UNASSIGNED_KEY]['High'][1]).toHaveLength(0);
    });

    test('groups epics by focus area section', () => {
        const sections = [
            { key: 'Backend', label: 'Backend' },
            { key: UNASSIGNED_KEY, label: '' },
        ];
        const epics = [
            makeEpic('NH-1', { focusArea: 'Backend', sprintId: '1' }),
            makeEpic('NH-2', { focusArea: null, sprintId: '1' }),
        ];
        const grid = buildGridData(epics, sprints, {}, sections, {});
        expect(grid['Backend']['Medium'][1]).toHaveLength(1);
        expect(grid[UNASSIGNED_KEY]['Medium'][1]).toHaveLength(1);
    });

    test('epics with focus area not in sections go to unassigned', () => {
        const sections = [{ key: 'Backend', label: 'Backend' }, { key: UNASSIGNED_KEY, label: '' }];
        const epics = [makeEpic('NH-1', { focusArea: 'Frontend', sprintId: '1' })];
        const grid = buildGridData(epics, sprints, {}, sections, {});
        expect(grid[UNASSIGNED_KEY]['Medium'][1]).toHaveLength(1);
    });

    test('sorts by rank when no local order', () => {
        const epics = [
            makeEpic('NH-2', { rank: 'bbb', sprintId: '1' }),
            makeEpic('NH-1', { rank: 'aaa', sprintId: '1' }),
        ];
        const grid = buildGridData(epics, sprints, {}, ALL_SECTIONS, {});
        const cell = grid[UNASSIGNED_KEY]['Medium'][1];
        expect(cell[0].key).toBe('NH-1');
        expect(cell[1].key).toBe('NH-2');
    });

    test('applies local cell order override', () => {
        const epics = [
            makeEpic('NH-1', { rank: 'aaa', sprintId: '1' }),
            makeEpic('NH-2', { rank: 'bbb', sprintId: '1' }),
        ];
        const cellId = `${UNASSIGNED_KEY}|Medium|1`;
        const localCellOrders = { [cellId]: ['NH-2', 'NH-1'] };
        const grid = buildGridData(epics, sprints, {}, ALL_SECTIONS, localCellOrders);
        const cell = grid[UNASSIGNED_KEY]['Medium'][1];
        expect(cell[0].key).toBe('NH-2');
        expect(cell[1].key).toBe('NH-1');
    });

    test('epics with no rank sort to end', () => {
        const epics = [
            makeEpic('NH-1', { rank: null, sprintId: '1' }),
            makeEpic('NH-2', { rank: 'aaa', sprintId: '1' }),
        ];
        const grid = buildGridData(epics, sprints, {}, ALL_SECTIONS, {});
        const cell = grid[UNASSIGNED_KEY]['Medium'][1];
        expect(cell[0].key).toBe('NH-2');
        expect(cell[1].key).toBe('NH-1');
    });
});

// ── findMatchingFilter ────────────────────────────────────────────────────────

describe('findMatchingFilter', () => {
    const filters = [
        { id: '1', name: 'NH Filter', jql: 'project = NH ORDER BY created' },
        { id: '2', name: 'All Filter', jql: 'project in (NH, PAYMENTS)' },
    ];

    test('finds filter whose JQL contains the board project key', () => {
        const board = { projectKey: 'NH' };
        expect(findMatchingFilter(filters, board)).toBe('1');
    });

    test('is case-insensitive', () => {
        const board = { projectKey: 'nh' };
        expect(findMatchingFilter(filters, board)).toBe('1');
    });

    test('falls back to first filter when no JQL match', () => {
        const board = { projectKey: 'COMMS' };
        expect(findMatchingFilter(filters, board)).toBe('1');
    });

    test('falls back to first filter when board has no projectKey', () => {
        expect(findMatchingFilter(filters, {})).toBe('1');
        expect(findMatchingFilter(filters, null)).toBe('1');
    });

    test('returns null when filters list is empty', () => {
        expect(findMatchingFilter([], { projectKey: 'NH' })).toBeNull();
    });

    test('returns null when filters is null/undefined', () => {
        expect(findMatchingFilter(null, { projectKey: 'NH' })).toBeNull();
        expect(findMatchingFilter(undefined, { projectKey: 'NH' })).toBeNull();
    });
});
