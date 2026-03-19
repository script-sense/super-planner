// Pure helper functions and shared constants extracted from App.js.
// These have no React or Forge dependencies and can be unit-tested in isolation.

export const ROWS = [
    { key: 'Highest', label: 'Highest', color: '#c9372c', bg: '#ffecea', cardBg: '#ffd5d2', cardBorder: '#f5a19b' },
    { key: 'High',    label: 'High',    color: '#a54800', bg: '#fff3e0', cardBg: '#ffe0b2', cardBorder: '#ffb74d' },
    { key: 'Medium',  label: 'Medium',  color: '#7f6b00', bg: '#fffbe0', cardBg: '#fff59d', cardBorder: '#f9d900' },
    { key: 'Low',     label: 'Low',     color: '#0055cc', bg: '#e9f2ff', cardBg: '#cce0ff', cardBorder: '#85b8ff' },
    { key: 'Lowest',  label: 'Lowest',  color: '#44546f', bg: '#f1f2f4', cardBg: '#e4e5e7', cardBorder: '#b0b4be' },
];

export const VALID_PRIORITY_KEYS = new Set(ROWS.map(r => r.key));
export const BACKLOG_COLUMN = { id: 'backlog', name: 'Backlog', state: 'backlog' };
export const UNASSIGNED_KEY = '__unassigned__';
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

// Build a list of every calendar day spanning full months.
// Starts on the 1st of the earliest sprint's month, ends on the last day of the latest sprint's month.
export function computeCalendarDays(sprints) {
    const dated = sprints.filter(s => s.startDate && s.endDate);
    if (!dated.length) return [];
    const minDate = new Date(Math.min(...dated.map(s => new Date(s.startDate))));
    const maxDate = new Date(Math.max(...dated.map(s => new Date(s.endDate))));
    const start = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    const end   = new Date(maxDate.getFullYear(), maxDate.getMonth() + 1, 0);
    const days = [];
    const cur = new Date(start);
    while (cur <= end) {
        days.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}

// For a sprint, compute its column span within the days array.
export function sprintDaySpan(sprint, days) {
    if (!sprint.startDate || !sprint.endDate || !days.length) return null;
    const s = startOfDay(new Date(sprint.startDate));
    const e = startOfDay(new Date(sprint.endDate));
    const origin = days[0];
    const startIdx = Math.round((s - origin) / MS_PER_DAY);
    const endIdx   = Math.round((e - origin) / MS_PER_DAY);
    if (startIdx < 0 || startIdx >= days.length) return null;
    const clampedEnd = Math.min(endIdx, days.length - 1);
    return { startIdx, span: clampedEnd - startIdx + 1 };
}

function monthLabel(d) {
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// Group consecutive days by month → [{ label, startIdx, span }]
export function computeMonthGroups(days) {
    if (!days.length) return [];
    const groups = [];
    let cur = null, startIdx = 0;
    for (let i = 0; i < days.length; i++) {
        const key = `${days[i].getFullYear()}-${days[i].getMonth()}`;
        if (key !== cur) {
            if (cur !== null) groups.push({ label: monthLabel(days[startIdx]), startIdx, span: i - startIdx });
            cur = key; startIdx = i;
        }
    }
    if (cur !== null) groups.push({ label: monthLabel(days[startIdx]), startIdx, span: days.length - startIdx });
    return groups;
}

// Group consecutive days by quarter → [{ label, startIdx, span }]
export function computeQuarterGroups(days) {
    if (!days.length) return [];
    const groups = [];
    let cur = null, startIdx = 0;
    for (let i = 0; i < days.length; i++) {
        const q = Math.floor(days[i].getMonth() / 3);
        const key = `${days[i].getFullYear()}-${q}`;
        if (key !== cur) {
            if (cur !== null) { const [y, q] = cur.split('-'); groups.push({ label: `Q${Number(q) + 1} ${y}`, startIdx, span: i - startIdx }); }
            cur = key; startIdx = i;
        }
    }
    if (cur !== null) { const [y, q] = cur.split('-'); groups.push({ label: `Q${Number(q) + 1} ${y}`, startIdx, span: days.length - startIdx }); }
    return groups;
}

// Map a Jira priority name to a ROWS key; unknown/missing → 'Lowest'
export function getPriorityRow(priority) {
    if (priority && VALID_PRIORITY_KEYS.has(priority)) return priority;
    return 'Lowest';
}

// Build the grid data structure:
//   grid[sectionKey][rowKey][colId] = [epics]
// localCellOrders: session-only override { [cellId]: [epicKey, ...] } for immediate feedback after drags
export function buildGridData(epics, sprints, positions, sections, localCellOrders) {
    const grid = {};
    for (const section of sections) {
        grid[section.key] = {};
        for (const row of ROWS) {
            grid[section.key][row.key] = { backlog: [] };
            for (const s of sprints) grid[section.key][row.key][s.id] = [];
        }
    }
    const sectionKeys = new Set(sections.map(s => s.key));
    for (const epic of epics) {
        const local   = positions[epic.key];
        const rowKey  = local?.rowKey ?? getPriorityRow(epic.priority);
        const colId   = local?.colId  ?? epic.sprintId ?? BACKLOG_COLUMN.id;
        const secKey  = sectionKeys.has(epic.focusArea) ? epic.focusArea : UNASSIGNED_KEY;
        const secGrid = grid[secKey] ?? grid[UNASSIGNED_KEY];
        const row     = secGrid[rowKey] ?? secGrid['Lowest'];
        if (colId === BACKLOG_COLUMN.id || row[colId] !== undefined) {
            (row[colId] ?? row.backlog).push(epic);
        } else {
            row.backlog.push(epic);
        }
    }
    // Sort each cell by Jira rank (LexoRank strings sort lexicographically)
    for (const secKey in grid) {
        for (const rowKey in grid[secKey]) {
            for (const colId in grid[secKey][rowKey]) {
                const cell = grid[secKey][rowKey][colId];
                const cellId = `${secKey}|${rowKey}|${colId}`;
                const localOrder = localCellOrders?.[cellId];
                if (localOrder?.length) {
                    const validKeys = new Set(cell.map(e => e.key));
                    const filtered = localOrder.filter(k => validKeys.has(k));
                    cell.sort((a, b) => {
                        const ai = filtered.indexOf(a.key);
                        const bi = filtered.indexOf(b.key);
                        if (ai === -1 && bi === -1) return 0;
                        if (ai === -1) return 1;
                        if (bi === -1) return -1;
                        return ai - bi;
                    });
                } else {
                    cell.sort((a, b) => {
                        if (!a.rank) return 1;
                        if (!b.rank) return -1;
                        return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
                    });
                }
            }
        }
    }
    return grid;
}

// Try to find the best matching filter for a board by looking for the board's
// project key in each filter's JQL. Falls back to the first filter if no match.
export function findMatchingFilter(filters, board) {
    if (!board?.projectKey || !filters?.length) return filters?.[0]?.id ?? null;
    const key = board.projectKey.toLowerCase();
    const match = filters.find(f => f.jql.toLowerCase().includes(key));
    return match ? match.id : filters[0].id;
}
