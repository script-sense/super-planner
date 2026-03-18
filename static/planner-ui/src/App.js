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

function getPriorityRow(priority) {
    if (priority && VALID_PRIORITY_KEYS.has(priority)) return priority;
    return 'Lowest';
}

// Build the grid lookup. Priority order for position:
// 1. Local drag-and-drop override (positions map) — most recent user action
// 2. Stored Jira issue property (epic.position) — persisted from previous sessions
// 3. Default: Backlog column, priority row from Jira field
function buildGridData(epics, columns, positions) {
    const grid = {};
    for (const row of ROWS) {
        grid[row.key] = {};
        for (const col of columns) {
            grid[row.key][col.id] = [];
        }
    }
    for (const epic of epics) {
        const local   = positions[epic.key];
        const stored  = epic.position;
        const rowKey  = local?.rowKey  ?? stored?.rowKey  ?? getPriorityRow(epic.priority);
        const colId   = local?.colId   ?? (stored ? String(stored.sprintId) : null) ?? BACKLOG_COLUMN.id;
        // Guard against stale positions referencing a sprint column that no longer exists
        const validCol = grid[rowKey]?.[colId] !== undefined ? colId : BACKLOG_COLUMN.id;
        grid[rowKey][validCol].push(epic);
    }
    return grid;
}

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

const gridStyle = (colCount) => ({
    display: 'grid',
    gridTemplateColumns: `120px repeat(${colCount}, minmax(140px, 1fr))`,
    border: '1px solid #ccc',
    borderRadius: 4,
    overflowX: 'auto',
});

const headerCellStyle = (isActive) => ({
    padding: '8px 12px',
    fontWeight: 'bold',
    background: isActive ? '#e6f0ff' : '#f4f5f7',
    borderBottom: '1px solid #ccc',
    borderRight: '1px solid #eee',
    textAlign: 'center',
    fontSize: 13,
    whiteSpace: 'nowrap',
});

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

// --- Components ---

// A droppable grid cell — highlights when an epic is dragged over it.
// Shows a subtle empty indicator when there are no epics.
function DroppableCell({ id, children }) {
    const { setNodeRef, isOver } = useDroppable({ id });
    const isEmpty = React.Children.count(children) === 0;
    return (
        <div ref={setNodeRef} style={cellStyle(isOver)}>
            {isEmpty
                ? <div style={emptyCellStyle}>·</div>
                : children
            }
        </div>
    );
}

// Skeleton grid shown while sprints/epics are loading
function GridSkeleton() {
    return (
        <>
            <style>{`
                @keyframes shimmer {
                    0% { background-position: 200% 0; }
                    100% { background-position: -200% 0; }
                }
            `}</style>
            <div style={{ ...gridStyle(4), opacity: 0.6 }}>
                <div style={headerCellStyle(false)} />
                {[1,2,3,4].map(i => (
                    <div key={i} style={headerCellStyle(false)}>
                        <div style={{ height: 14, background: '#e0e0e0', borderRadius: 3, margin: '0 20px' }} />
                    </div>
                ))}
                {ROWS.map(row => (
                    <React.Fragment key={row.key}>
                        <div style={rowLabelStyle(row)}>{row.label}</div>
                        {[1,2,3,4].map(i => (
                            <div key={i} style={cellStyle(false)}>
                                {i === 1 && <div style={skeletonStyle} />}
                            </div>
                        ))}
                    </React.Fragment>
                ))}
            </div>
        </>
    );
}

// A draggable epic card. Uses a distance activation constraint so that small
// movements (e.g. clicking to expand) don't accidentally start a drag.
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
        // Don't expand/collapse while dragging
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

function PlanningGrid({ epics, sprints }) {
    const columns = [...sprints, BACKLOG_COLUMN];

    // positions stores drag-and-drop overrides: { [epicKey]: { rowKey, colId } }
    const [positions, setPositions] = useState({});
    const [activeEpic, setActiveEpic] = useState(null);

    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
        useSensor(TouchSensor, { activationConstraint: { distance: 5 } }),
    );

    const gridData = buildGridData(epics, columns, positions);

    function handleDragStart({ active }) {
        setActiveEpic(epics.find(e => e.key === active.id) ?? null);
    }

    function handleDragEnd({ active, over }) {
        setActiveEpic(null);
        if (!over) return;
        const [rowKey, colId] = over.id.split('|');

        // Update local state immediately so the UI responds without waiting
        setPositions(prev => ({ ...prev, [active.id]: { rowKey, colId } }));

        // Persist to Jira issue property — find sprint name from colId
        const sprint = sprints.find(s => String(s.id) === colId);
        invoke('setEpicPosition', {
            epicKey: active.id,
            sprintId: colId === BACKLOG_COLUMN.id ? null : sprint?.id ?? null,
            sprintName: colId === BACKLOG_COLUMN.id ? null : sprint?.name ?? null,
            rowKey,
        }).catch(err => console.error('Failed to save position:', err));
    }

    return (
        <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
        >
            <div style={gridStyle(columns.length)}>
                <div style={headerCellStyle(false)} />
                {columns.map(col => (
                    <div key={col.id} style={headerCellStyle(col.state === 'active')}>
                        {col.name}
                        {col.state === 'active' && (
                            <span style={{ display: 'block', fontSize: 10, color: '#0052cc', fontWeight: 'normal' }}>
                                active
                            </span>
                        )}
                    </div>
                ))}

                {ROWS.map(row => (
                    <React.Fragment key={row.key}>
                        <div style={rowLabelStyle(row)}>{row.label}</div>
                        {columns.map(col => (
                            <DroppableCell key={col.id} id={`${row.key}|${col.id}`}>
                                {gridData[row.key][col.id].map(epic => (
                                    <EpicCard key={epic.key} epic={epic} row={row} />
                                ))}
                            </DroppableCell>
                        ))}
                    </React.Fragment>
                ))}
            </div>

            {/* DragOverlay renders a clean copy of the card while dragging */}
            <DragOverlay>
                {activeEpic && (
                    <EpicCard epic={activeEpic} isDragOverlay />
                )}
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

// Cache the context — used for both reading the current board ID and navigating.
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
