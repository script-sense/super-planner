import React, { useEffect, useRef, useState } from 'react';
import { invoke, requestJira, view, router } from '@forge/bridge';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    useDroppable,
    useDraggable,
    DragOverlay,
} from '@dnd-kit/core';

const ROWS = [
    { key: 'Highest', label: 'Highest', color: '#c9372c', bg: '#ffecea', cardBg: '#ffd5d2', cardBorder: '#f5a19b' },
    { key: 'High',    label: 'High',    color: '#a54800', bg: '#fff3e0', cardBg: '#ffe0b2', cardBorder: '#ffb74d' },
    { key: 'Medium',  label: 'Medium',  color: '#7f6b00', bg: '#fffbe0', cardBg: '#fff59d', cardBorder: '#f9d900' },
    { key: 'Low',     label: 'Low',     color: '#0055cc', bg: '#e9f2ff', cardBg: '#cce0ff', cardBorder: '#85b8ff' },
    { key: 'Lowest',  label: 'Lowest',  color: '#44546f', bg: '#f1f2f4', cardBg: '#e4e5e7', cardBorder: '#b0b4be' },
];

const VALID_PRIORITY_KEYS = new Set(ROWS.map(r => r.key));
const BACKLOG_COLUMN = { id: 'backlog', name: 'Backlog', state: 'backlog' };
const THIS_YEAR = new Date().getFullYear();

// --- Calendar helpers ---

function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

// Build a list of every calendar day covering all sprints' date ranges.
function computeCalendarDays(sprints) {
    const dated = sprints.filter(s => s.startDate && s.endDate);
    if (!dated.length) return [];
    const earliest = startOfDay(new Date(Math.min(...dated.map(s => new Date(s.startDate)))));
    const latest   = startOfDay(new Date(Math.max(...dated.map(s => new Date(s.endDate)))));
    const days = [];
    const cur = new Date(earliest);
    while (cur <= latest) {
        days.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// For a sprint, compute its column span directly from its start/end dates.
// startIdx = days between days[0] and sprint.startDate
// span     = days between sprint.startDate and sprint.endDate (inclusive)
function sprintDaySpan(sprint, days) {
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

// Group consecutive days by month → [{ label, startIdx, span }]
function computeMonthGroups(days) {
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

function monthLabel(d) {
    const opts = { month: 'long' };
    if (d.getFullYear() !== THIS_YEAR) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
}

// Group consecutive days by quarter → [{ label, startIdx, span }]
function computeQuarterGroups(days) {
    if (!days.length) return [];
    const groups = [];
    let cur = null, startIdx = 0;
    for (let i = 0; i < days.length; i++) {
        const q = Math.floor(days[i].getMonth() / 3);
        const key = `${days[i].getFullYear()}-${q}`;
        if (key !== cur) {
            if (cur !== null) groups.push({ label: `Q${Number(cur.split('-')[1]) + 1}`, startIdx, span: i - startIdx });
            cur = key; startIdx = i;
        }
    }
    if (cur !== null) groups.push({ label: `Q${Number(cur.split('-')[1]) + 1}`, startIdx, span: days.length - startIdx });
    return groups;
}

// --- Grid data ---

function getPriorityRow(priority) {
    if (priority && VALID_PRIORITY_KEYS.has(priority)) return priority;
    return 'Lowest';
}

function buildGridData(epics, sprints, positions) {
    const grid = {};
    for (const row of ROWS) {
        grid[row.key] = { backlog: [] };
        for (const s of sprints) grid[row.key][s.id] = [];
    }
    for (const epic of epics) {
        const local  = positions[epic.key];
        const rowKey = local?.rowKey ?? getPriorityRow(epic.priority);
        const colId  = local?.colId  ?? epic.sprintId ?? BACKLOG_COLUMN.id;
        const row    = grid[rowKey] ?? grid['Lowest'];
        // Guard against stale sprint IDs
        if (colId === BACKLOG_COLUMN.id || row[colId] !== undefined) {
            (row[colId] ?? row.backlog).push(epic);
        } else {
            row.backlog.push(epic);
        }
    }
    return grid;
}

// --- Jira fetch ---

async function fetchChildIssues(epicKey) {
    const jql = encodeURIComponent(
        `"Epic Link" = ${epicKey} AND statusCategory != Done ORDER BY created DESC`
    );
    const res = await requestJira(
        `/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=50`
    );
    const data = await res.json();
    return (data.issues ?? []).map(issue => ({
        key: issue.key,
        summary: issue.fields.summary,
    }));
}

// --- Styles ---

const rowLabelStyle = (row) => ({
    padding: '8px 12px',
    fontWeight: 'bold',
    background: row.bg,
    color: row.color,
    borderBottom: '1px solid #eee',
    borderRight: '1px solid #ccc',
    display: 'flex',
    alignItems: 'flex-start',
    paddingTop: 10,
    fontSize: 13,
});

const cellStyle = (isOver) => ({
    padding: 8,
    borderBottom: '1px solid #eee',
    borderRight: '1px solid #eee',
    minHeight: 80,
    background: isOver ? '#f0f4ff' : '#fff',
    transition: 'background 0.1s',
});

const emptyCellStyle = {
    fontSize: 11,
    color: '#ccc',
    textAlign: 'center',
    paddingTop: 24,
    userSelect: 'none',
};

const skeletonStyle = {
    background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
    backgroundSize: '200% 100%',
    animation: 'shimmer 1.2s infinite',
    borderRadius: 3,
    height: 48,
    marginBottom: 4,
};

const cardStyle = (isDragging, row) => ({
    background: isDragging ? '#d0e4ff' : (row?.cardBg ?? '#e8f0fe'),
    border: `1px solid ${isDragging ? '#4c8cf5' : (row?.cardBorder ?? '#b3c6f7')}`,
    borderRadius: 3,
    padding: '4px 8px',
    marginBottom: 4,
    fontSize: 13,
    opacity: isDragging ? 0.5 : 1,
    cursor: 'grab',
});

const cardHeaderStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
};

const cardKeyStyle = {
    fontWeight: 'bold',
    fontSize: 11,
    color: '#555',
};

const childIssueStyle = {
    marginTop: 6,
    paddingTop: 6,
    borderTop: '1px solid #b3c6f7',
};

const childItemStyle = {
    fontSize: 12,
    padding: '2px 0',
    color: '#333',
};

const childKeyStyle = {
    fontWeight: 'bold',
    color: '#555',
    marginRight: 4,
};

// Shared base for all calendar header cells
const calBase = {
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    borderRight: '1px solid #e0e0e0',
};

const quarterCellStyle = (extra) => ({
    ...calBase,
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 'bold',
    color: '#444',
    background: '#ecedf0',
    borderBottom: '1px solid #d0d0d0',
    ...extra,
});

const monthCellStyle = (extra) => ({
    ...calBase,
    padding: '3px 8px',
    fontSize: 12,
    fontWeight: 'bold',
    color: '#333',
    background: '#f0f1f4',
    borderBottom: '1px solid #d8d8d8',
    ...extra,
});

const dayCellStyle = {
    ...calBase,
    padding: '3px 0',
    fontSize: 12,
    color: '#888',
    background: '#f4f5f7',
    borderBottom: '1px solid #ccc',
};

const sprintCellStyle = (isActive, extra) => ({
    ...calBase,
    padding: '5px 8px',
    fontSize: 12,
    fontWeight: 'bold',
    color: isActive ? '#0052cc' : '#333',
    background: isActive ? '#e6f0ff' : '#f8f8fb',
    borderBottom: '2px solid #ccc',
    borderRight: '1px solid #ccc',
    ...extra,
});

const cornerStyle = {
    gridRow: '1 / span 4',
    gridColumn: 1,
    background: '#ecedf0',
    borderRight: '1px solid #ccc',
    borderBottom: '2px solid #ccc',
};

// --- Components ---

function DroppableCell({ id, children, gridRow, gridColumn }) {
    const { setNodeRef, isOver } = useDroppable({ id });
    const isEmpty = React.Children.count(children) === 0;
    return (
        <div ref={setNodeRef} style={{ ...cellStyle(isOver), gridRow, gridColumn }}>
            {isEmpty
                ? <div style={emptyCellStyle}>·</div>
                : children
            }
        </div>
    );
}

function GridSkeleton() {
    const N = 28; // ~4 weeks of placeholder columns
    return (
        <>
            <style>{`
                @keyframes shimmer {
                    0% { background-position: 200% 0; }
                    100% { background-position: -200% 0; }
                }
            `}</style>
            <div style={{ display: 'flex', border: '1px solid #ccc', borderRadius: 4, opacity: 0.6 }}>
                <div style={{ overflowX: 'auto', flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: `120px repeat(${N}, ${DAY_COL_WIDTH}px)` }}>
                        <div style={cornerStyle} />
                        <div style={{ ...quarterCellStyle(), gridColumn: `2 / span ${N}` }} />
                        <div style={{ ...monthCellStyle(), gridColumn: `2 / span ${N}` }}>
                            <div style={{ height: 12, background: '#d8d8d8', borderRadius: 3, margin: '2px 20px' }} />
                        </div>
                        {Array.from({ length: N }, (_, i) => (
                            <div key={i} style={{ ...dayCellStyle, gridColumn: i + 2 }} />
                        ))}
                        <div style={{ ...sprintCellStyle(false), gridColumn: `2 / span ${N}` }}>
                            <div style={{ height: 13, background: '#d8d8d8', borderRadius: 3, margin: '2px 30px' }} />
                        </div>
                        {ROWS.map((row, ri) => (
                            <React.Fragment key={row.key}>
                                <div style={{ ...rowLabelStyle(row), gridRow: ri + 5, gridColumn: 1 }}>{row.label}</div>
                                <div style={{ ...cellStyle(false), gridRow: ri + 5, gridColumn: `2 / span ${N}` }}>
                                    {ri === 0 && <div style={skeletonStyle} />}
                                </div>
                            </React.Fragment>
                        ))}
                    </div>
                </div>
                <div style={{ width: 180, flexShrink: 0, borderLeft: '2px solid #ccc' }}>
                    <div style={sprintCellStyle(false, { borderRight: 'none' })}>Backlog</div>
                    {ROWS.map(row => (
                        <div key={row.key} style={{ ...cellStyle(false), minHeight: 80 }} />
                    ))}
                </div>
            </div>
        </>
    );
}

function EpicCard({ epic, isDragOverlay, row }) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: epic.key,
        data: { epic },
    });

    const [expanded, setExpanded] = useState(false);
    const [children, setChildren] = useState(null);
    const [loading, setLoading] = useState(false);
    const [childError, setChildError] = useState(null);

    function toggle(e) {
        if (isDragging) return;
        e.stopPropagation();
        if (!expanded && children === null) {
            setLoading(true);
            fetchChildIssues(epic.key)
                .then(issues => { setChildren(issues); setLoading(false); })
                .catch(err => { setChildError(err.message ?? 'Failed to load'); setLoading(false); });
        }
        setExpanded(prev => !prev);
    }

    return (
        <div
            ref={setNodeRef}
            style={cardStyle(isDragging && !isDragOverlay, row)}
            {...listeners}
            {...attributes}
        >
            <div style={cardHeaderStyle} onClick={toggle}>
                <span style={cardKeyStyle}>{epic.key}</span>
                <span style={{ fontSize: 11, color: '#555' }}>{expanded ? '▲' : '▼'}</span>
            </div>
            <div style={{ fontSize: 13, marginTop: 2 }}>{epic.summary}</div>

            {expanded && !isDragging && (
                <div style={childIssueStyle}>
                    {loading && <div style={{ fontSize: 12, color: '#888' }}>Loading...</div>}
                    {childError && <div style={{ fontSize: 12, color: 'red' }}>{childError}</div>}
                    {children && children.length === 0 && (
                        <div style={{ fontSize: 12, color: '#888' }}>No open issues</div>
                    )}
                    {children && children.map(issue => (
                        <div key={issue.key} style={childItemStyle}>
                            <span style={childKeyStyle}>{issue.key}</span>
                            {issue.summary}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

const DAY_COL_WIDTH = 24; // px per day column

function PlanningGrid({ epics, sprints }) {
    const [positions, setPositions] = useState({});
    const [activeEpic, setActiveEpic] = useState(null);
    const scrollRef = useRef(null);

    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
        useSensor(TouchSensor, { activationConstraint: { distance: 5 } }),
    );

    const days          = computeCalendarDays(sprints);
    const numDays       = days.length;
    const quarterGroups = computeQuarterGroups(days);
    const monthGroups   = computeMonthGroups(days);

    const sprintSpans = {};
    for (const s of sprints) sprintSpans[s.id] = sprintDaySpan(s, days);

    const gridData = buildGridData(epics, sprints, positions);

    // Scroll to active sprint on first render
    useEffect(() => {
        if (!scrollRef.current || !days.length) return;
        const active = sprints.find(s => s.state === 'active');
        if (!active) return;
        const sp = sprintSpans[active.id];
        if (!sp) return;
        // 120px row label + days before active sprint
        const offset = 120 + sp.startIdx * DAY_COL_WIDTH - 40;
        scrollRef.current.scrollLeft = Math.max(0, offset);
    }, [sprints, days.length]);

    function handleDragStart({ active }) {
        setActiveEpic(epics.find(e => e.key === active.id) ?? null);
    }

    function handleDragEnd({ active, over }) {
        setActiveEpic(null);
        if (!over) return;
        const [rowKey, colId] = over.id.split('|');

        setPositions(prev => ({ ...prev, [active.id]: { rowKey, colId } }));

        const isBacklog = colId === BACKLOG_COLUMN.id;
        const sprintId  = isBacklog ? null : Number(colId);

        invoke('assignEpicToSprint', { epicKey: active.id, sprintId })
            .catch(err => console.error('Failed to assign sprint:', err));

        invoke('updateEpicPriority', { epicKey: active.id, priority: rowKey })
            .catch(err => console.error('Failed to update priority:', err));
    }

    const gridTemplateColumns = `120px repeat(${numDays}, ${DAY_COL_WIDTH}px)`;

    return (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <style>{`
                @keyframes shimmer {
                    0% { background-position: 200% 0; }
                    100% { background-position: -200% 0; }
                }
            `}</style>
            <div style={{ display: 'flex', border: '1px solid #ccc', borderRadius: 4 }}>
                {/* Scrollable calendar grid */}
                <div ref={scrollRef} style={{ overflowX: 'auto', flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'grid', gridTemplateColumns }}>
                        {/* Corner: spans all 4 header rows */}
                        <div style={cornerStyle} />

                        {/* Row 1 — Quarters */}
                        {quarterGroups.map((q, i) => (
                            <div key={i} style={quarterCellStyle({
                                gridRow: 1,
                                gridColumn: `${q.startIdx + 2} / span ${q.span}`,
                            })}>
                                {q.label}
                            </div>
                        ))}

                        {/* Row 2 — Months */}
                        {monthGroups.map((m, i) => (
                            <div key={i} style={monthCellStyle({
                                gridRow: 2,
                                gridColumn: `${m.startIdx + 2} / span ${m.span}`,
                            })}>
                                {m.label}
                            </div>
                        ))}

                        {/* Row 3 — Day ticks */}
                        {days.map((d, i) => {
                            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                            return (
                                <div key={i} style={{
                                    ...dayCellStyle,
                                    gridRow: 3,
                                    gridColumn: i + 2,
                                    background: isWeekend ? '#e8e9ec' : '#f4f5f7',
                                    color: isWeekend ? '#aaa' : '#888',
                                }}>
                                    {d.getDate()}
                                </div>
                            );
                        })}

                        {/* Row 4 — Sprint names */}
                        {sprints.map(s => {
                            const sp = sprintSpans[s.id];
                            return (
                                <div key={s.id} style={sprintCellStyle(s.state === 'active', {
                                    gridRow: 4,
                                    gridColumn: sp ? `${sp.startIdx + 2} / span ${sp.span}` : '2',
                                })}>
                                    {s.name}
                                    {s.state === 'active' && (
                                        <span style={{ fontSize: 10, fontWeight: 'normal', marginLeft: 4 }}>· active</span>
                                    )}
                                </div>
                            );
                        })}

                        {/* Data rows */}
                        {ROWS.map((row, ri) => {
                            const dataRow = ri + 5;
                            return (
                                <React.Fragment key={row.key}>
                                    <div style={{ ...rowLabelStyle(row), gridRow: dataRow, gridColumn: 1 }}>
                                        {row.label}
                                    </div>
                                    {sprints.map(s => {
                                        const sp = sprintSpans[s.id];
                                        return (
                                            <DroppableCell
                                                key={s.id}
                                                id={`${row.key}|${s.id}`}
                                                gridRow={dataRow}
                                                gridColumn={sp ? `${sp.startIdx + 2} / span ${sp.span}` : '2'}
                                            >
                                                {(gridData[row.key][s.id] ?? []).map(epic => (
                                                    <EpicCard key={epic.key} epic={epic} row={row} />
                                                ))}
                                            </DroppableCell>
                                        );
                                    })}
                                </React.Fragment>
                            );
                        })}
                    </div>
                </div>

                {/* Fixed backlog panel */}
                <div style={{
                    width: 180,
                    flexShrink: 0,
                    borderLeft: '2px solid #ccc',
                    display: 'grid',
                    gridTemplateRows: 'auto auto auto auto' + ROWS.map(() => ' auto').join(''),
                }}>
                    <div style={quarterCellStyle({ borderRight: 'none' })} />
                    <div style={monthCellStyle({ borderRight: 'none' })} />
                    <div style={{ ...dayCellStyle, borderRight: 'none' }} />
                    <div style={sprintCellStyle(false, { borderRight: 'none' })}>Backlog</div>
                    {ROWS.map((row, ri) => (
                        <DroppableCell
                            key={row.key}
                            id={`${row.key}|backlog`}
                            gridRow={ri + 5}
                            gridColumn='1'
                        >
                            {gridData[row.key].backlog.map(epic => (
                                <EpicCard key={epic.key} epic={epic} row={row} />
                            ))}
                        </DroppableCell>
                    ))}
                </div>
            </div>

            <DragOverlay>
                {activeEpic && <EpicCard epic={activeEpic} isDragOverlay />}
            </DragOverlay>
        </DndContext>
    );
}

// Try to find the best matching filter for a board by looking for the board's
// project key in each filter's JQL. Falls back to the first filter if no match.
function findMatchingFilter(filters, board) {
    if (!board?.projectKey || !filters?.length) return filters?.[0]?.id ?? null;
    const key = board.projectKey.toLowerCase();
    const match = filters.find(f => f.jql.toLowerCase().includes(key));
    return match ? match.id : filters[0].id;
}

let appContext = null;
async function getContext() {
    if (!appContext) appContext = await view.getContext();
    return appContext;
}

async function getBoardIdFromPath() {
    const context = await getContext();
    const location = context?.extension?.location ?? '';
    const match = location.match(/\/super-planner\/(\d+)/);
    return match ? Number(match[1]) : null;
}

async function navigateToBoard(boardId) {
    const context = await getContext();
    const location = context?.extension?.location ?? '';
    const base = location.replace(/\/super-planner(\/\d+)?$/, '/super-planner');
    router.navigate(`${base}/${boardId}`);
}

function App() {
    const [boards, setBoards] = useState(null);
    const [selectedBoard, setSelectedBoard] = useState(null);
    const [filters, setFilters] = useState(null);
    const [selectedFilter, setSelectedFilter] = useState(null);
    const [sprints, setSprints] = useState(null);
    const [epics, setEpics] = useState(null);
    const [error, setError] = useState(null);
    const isInitialBoardSelection = useRef(true);

    useEffect(() => {
        Promise.all([invoke('getBoards'), invoke('getFilters'), getBoardIdFromPath()])
            .then(([boardData, filterData, pathBoardId]) => {
                setBoards(boardData);
                setFilters(filterData);
                const board = (pathBoardId && boardData.find(b => b.id === pathBoardId))
                    ?? boardData[0]
                    ?? null;
                if (board) setSelectedBoard(board.id);
                setSelectedFilter(findMatchingFilter(filterData, board));
            })
            .catch(err => setError(err.message ?? 'Failed to load data'));
    }, []);

    useEffect(() => {
        if (!selectedBoard || !boards) return;
        if (isInitialBoardSelection.current) {
            isInitialBoardSelection.current = false;
        } else {
            navigateToBoard(selectedBoard);
        }
        setSprints(null);
        invoke('getSprints', { boardId: selectedBoard })
            .then(setSprints)
            .catch(err => setError(err.message ?? 'Failed to load sprints'));
        const board = boards.find(b => b.id === selectedBoard || b.id === Number(selectedBoard));
        setSelectedFilter(findMatchingFilter(filters, board));
    }, [selectedBoard]);

    useEffect(() => {
        if (!selectedFilter) return;
        setEpics(null);
        invoke('getEpics', { filterId: selectedFilter })
            .then(setEpics)
            .catch(err => setError(err.message ?? 'Failed to load epics'));
    }, [selectedFilter]);

    if (error) return <div>Error: {error}</div>;

    return (
        <div style={{ padding: 16, fontFamily: 'sans-serif' }}>
            <div style={{ marginBottom: 16 }}>
                <label htmlFor="board-select">Board: </label>
                <select
                    id="board-select"
                    value={selectedBoard ?? ''}
                    onChange={e => setSelectedBoard(e.target.value)}
                    disabled={!boards}
                >
                    {boards
                        ? boards.map(b => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                          ))
                        : <option>Loading...</option>
                    }
                </select>
            </div>

            {!sprints || !epics
                ? <GridSkeleton />
                : <PlanningGrid epics={epics} sprints={sprints} />
            }
        </div>
    );
}

export default App;
