import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, requestJira, view, router } from '@forge/bridge';
import {
    ROWS, VALID_PRIORITY_KEYS, BACKLOG_COLUMN, UNASSIGNED_KEY, MS_PER_DAY,
    startOfDay, computeCalendarDays, sprintDaySpan,
    computeMonthGroups, computeQuarterGroups,
    getPriorityRow, buildGridData, findMatchingFilter,
} from './utils';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    useDroppable,
    useDraggable,
    DragOverlay,
    closestCenter,
} from '@dnd-kit/core';
import {
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
    arrayMove,
} from '@dnd-kit/sortable';
import { CSS as DNDCSS } from '@dnd-kit/utilities';

// --- Calendar helpers + grid data: imported from ./utils ---

// --- Jira fetch ---

async function fetchChildIssues(epicKey) {
    const res = await requestJira('/rest/api/3/search/jql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            // Include Done issues — modal shows all tickets and uses them for the progress bar
            jql: `issueType != Epic AND parent = "${epicKey}" ORDER BY created DESC`,
            fields: ['summary', 'status', 'assignee', 'customfield_10020'],
            maxResults: 100,
        }),
    });
    const data = await res.json();
    return (data.issues ?? []).map(issue => {
        const sprintList = issue.fields.customfield_10020 ?? [];
        const sprint = sprintList.find(s => s.state === 'active') ?? sprintList[sprintList.length - 1] ?? null;
        return {
            key: issue.key,
            summary: issue.fields.summary,
            statusName: issue.fields.status?.name ?? null,
            statusCategoryKey: issue.fields.status?.statusCategory?.key ?? null,
            statusCategory: issue.fields.status?.statusCategory?.name ?? null,
            assignee: issue.fields.assignee
                ? { accountId: issue.fields.assignee.accountId, displayName: issue.fields.assignee.displayName, avatarUrl: issue.fields.assignee.avatarUrls?.['24x24'] ?? null }
                : null,
            sprintId: sprint ? String(sprint.id) : null,
            sprintName: sprint?.name ?? null,
        };
    });
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
    position: 'sticky',
    left: 0,
    zIndex: 1,
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

const STATUS_COLORS = {
    'To Do':       { bg: '#e4e5e7', color: '#44546f' },
    'In Progress': { bg: '#cce0ff', color: '#0055cc' },
    'Done':        { bg: '#baf3db', color: '#216e4e' },
};

function statusBadgeStyle(category) {
    const c = STATUS_COLORS[category] ?? { bg: '#e4e5e7', color: '#44546f' };
    return {
        display: 'inline-block',
        fontSize: 10,
        fontWeight: 'bold',
        padding: '1px 5px',
        borderRadius: 3,
        background: c.bg,
        color: c.color,
        marginLeft: 6,
        verticalAlign: 'middle',
    };
}

const childItemStyle = {
    fontSize: 12,
    padding: '3px 0',
    color: '#333',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 5,
};

const childKeyStyle = {
    fontWeight: 'bold',
    color: '#555',
    whiteSpace: 'nowrap',
    flexShrink: 0,
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
    position: 'sticky',
    top: 0,
    left: 0,
    zIndex: 3, // above both sticky header row cells (z:2) and sticky row labels (z:1)
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
            <div style={{ display: 'grid', gridTemplateColumns: `120px repeat(${N}, ${DAY_COL_WIDTH}px)`, border: '1px solid #ccc', borderRadius: 4, overflowX: 'auto', opacity: 0.6 }}>
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
        </>
    );
}


function EpicDetailModal({ epic, sprints, onClose, onEpicDone }) {
    const [children, setChildren] = useState(null);
    const [loading, setLoading] = useState(true);
    const [childError, setChildError] = useState(null);
    const [assignableUsers, setAssignableUsers] = useState([]);
    const [transitioning, setTransitioning] = useState(false);
    const [transitionError, setTransitionError] = useState(null);
    const [transitions, setTransitions] = useState(null); // null = loading, [{id,name,categoryKey}]
    const [epicStatus, setEpicStatus] = useState(epic.status ?? null); // { name, categoryKey }
    const [statusOpen, setStatusOpen] = useState(false);
    const [childStatusOpen, setChildStatusOpen] = useState(null); // issueKey of open popover
    const [childTransitions, setChildTransitions] = useState({}); // { [issueKey]: [{id,name,categoryKey}] }
    // { key: issueKey, field: 'sprint' | 'assignee' } — which chip is being edited
    const [editing, setEditing] = useState(null);

    useEffect(() => {
        Promise.all([
            fetchChildIssues(epic.key),
            invoke('getAssignableUsers', { issueKey: epic.key }),
            invoke('getTransitions', { epicKey: epic.key }),
        ])
            .then(([issues, users, trans]) => {
                setChildren(issues);
                setAssignableUsers((users ?? []).sort((a, b) => a.displayName.localeCompare(b.displayName)));
                setTransitions(trans ?? []);
                setLoading(false);
            })
            .catch(err => { setChildError(err.message ?? 'Failed to load'); setLoading(false); });
    }, [epic.key]);

    useEffect(() => {
        function onKey(e) { if (e.key === 'Escape') onClose(); }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const total = children?.length ?? 0;
    const doneCount = children?.filter(c => c.statusCategory === 'Done').length ?? 0;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

    // Only show active + future sprints in pickers
    const activeSprints = sprints.filter(s => s.state !== 'closed');

    function updateChildSprint(childKey, sprintId) {
        const id = sprintId || null;
        setEditing(null);
        invoke('assignEpicToSprint', { epicKey: childKey, sprintId: id })
            .then(() => {
                const sprint = activeSprints.find(s => String(s.id) === String(sprintId));
                setChildren(prev => prev.map(c =>
                    c.key === childKey ? { ...c, sprintId: id, sprintName: sprint?.name ?? null } : c
                ));
            })
            .catch(err => console.error('[SuperPlanner] Sprint update failed:', err));
    }

    function updateChildAssignee(childKey, accountId) {
        const id = accountId || null;
        setEditing(null);
        invoke('updateIssueAssignee', { issueKey: childKey, accountId: id })
            .then(() => {
                const user = assignableUsers.find(u => u.accountId === accountId);
                setChildren(prev => prev.map(c =>
                    c.key === childKey ? { ...c, assignee: user ? { accountId: user.accountId, displayName: user.displayName, avatarUrl: user.avatarUrl } : null } : c
                ));
            })
            .catch(err => console.error('[SuperPlanner] Assignee update failed:', err));
    }

    function openChildStatus(issueKey) {
        setChildStatusOpen(issueKey);
        if (!childTransitions[issueKey]) {
            invoke('getTransitions', { epicKey: issueKey })
                .then(trans => setChildTransitions(prev => ({ ...prev, [issueKey]: (trans ?? []).sort((a, b) => {
                    const order = { new: 0, indeterminate: 1, done: 2 };
                    const ao = order[a.categoryKey] ?? 3, bo = order[b.categoryKey] ?? 3;
                    return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
                }) })))
                .catch(() => {});
        }
    }

    function handleChildTransition(issueKey, transition) {
        setChildStatusOpen(null);
        invoke('transitionEpicDone', { epicKey: issueKey, transitionId: transition.id })
            .then(() => setChildren(prev => prev.map(c =>
                c.key === issueKey ? { ...c, statusName: transition.name, statusCategoryKey: transition.categoryKey, statusCategory: transition.name } : c
            )))
            .catch(err => console.error('[SuperPlanner] Child transition failed:', err));
    }

    function handleTransition(transition) {
        setStatusOpen(false);
        setTransitioning(true);
        setTransitionError(null);
        invoke('transitionEpicDone', { epicKey: epic.key, transitionId: transition.id })
            .then(() => {
                setEpicStatus({ name: transition.name, categoryKey: transition.categoryKey });
                if (transition.categoryKey === 'done') onEpicDone(epic.key);
            })
            .catch(err => setTransitionError(err.message ?? 'Transition failed'))
            .finally(() => setTransitioning(false));
    }

    const STATUS_CATEGORY_STYLES = {
        new:           { bg: '#DFE1E6', color: '#42526E', hoverBg: '#C1C7D0' },
        indeterminate: { bg: '#CCE0FF', color: '#0052CC', hoverBg: '#B3D4FF' },
        done:          { bg: '#BAF3DB', color: '#216E4E', hoverBg: '#A3E9CA' },
    };
    function statusStyle(categoryKey) {
        return STATUS_CATEGORY_STYLES[categoryKey] ?? STATUS_CATEGORY_STYLES.new;
    }

    const chipBase = {
        fontSize: 11, padding: '2px 7px', borderRadius: 10,
        cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 3,
        border: '1px solid transparent',
    };
    const chipFilled = { ...chipBase, background: '#F4F5F7', color: '#172B4D', borderColor: '#DFE1E6' };
    const chipEmpty  = { ...chipBase, background: 'none', color: '#97A0AF', borderColor: '#DFE1E6', borderStyle: 'dashed' };
    const inlineSelect = {
        fontSize: 11, padding: '2px 4px', border: '1px solid #4c9aff',
        borderRadius: 3, color: '#172B4D', background: '#fff', cursor: 'pointer', outline: 'none',
    };

    function renderChildIssue(issue) {
        const isEditingSprint   = editing?.key === issue.key && editing?.field === 'sprint';
        const isEditingAssignee = editing?.key === issue.key && editing?.field === 'assignee';

        return (
            <div key={issue.key} style={{ padding: '10px 0', borderBottom: '1px solid #F4F5F7' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    {/* Avatar — click to edit assignee */}
                    <div
                        title={issue.assignee ? issue.assignee.displayName : 'Unassigned — click to assign'}
                        onClick={() => setEditing({ key: issue.key, field: 'assignee' })}
                        style={{ cursor: 'pointer', flexShrink: 0, marginTop: 1 }}
                    >
                        {issue.assignee
                            ? <img src={issue.assignee.avatarUrl} style={{ width: 22, height: 22, borderRadius: '50%', display: 'block' }} alt={issue.assignee.displayName} />
                            : <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#DFE1E6', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#97A0AF' }}>?</span>
                        }
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                        {/* Key + status */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                            <span
                                style={{ fontWeight: 700, fontSize: 11, color: '#0052cc', cursor: 'pointer', textDecoration: 'underline' }}
                                onClick={() => router.open(`/browse/${issue.key}`)}
                            >
                                {issue.key}
                            </span>
                            {issue.statusName && (() => {
                                const st = statusStyle(issue.statusCategoryKey);
                                const isOpen = childStatusOpen === issue.key;
                                const trans = childTransitions[issue.key];
                                return (
                                    <div style={{ position: 'relative', display: 'inline-block' }}>
                                        <button
                                            onClick={() => isOpen ? setChildStatusOpen(null) : openChildStatus(issue.key)}
                                            style={{
                                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                                padding: '2px 7px', borderRadius: 3, border: 'none',
                                                background: st.bg, color: st.color,
                                                fontSize: 11, fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase',
                                                cursor: 'pointer', whiteSpace: 'nowrap',
                                            }}
                                        >
                                            {issue.statusName}
                                            <span style={{ fontSize: 8, opacity: 0.7 }}>▼</span>
                                        </button>
                                        {isOpen && (
                                            <>
                                                <div onClick={() => setChildStatusOpen(null)} style={{ position: 'fixed', inset: 0, zIndex: 299 }} />
                                                <div style={{
                                                    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                                                    background: '#fff', borderRadius: 4,
                                                    boxShadow: '0 4px 16px rgba(9,30,66,0.2)',
                                                    minWidth: 160, zIndex: 300,
                                                    overflow: 'hidden', border: '1px solid #DFE1E6',
                                                }}>
                                                    {!trans
                                                        ? <div style={{ padding: '8px 12px', fontSize: 12, color: '#6B778C' }}>Loading…</div>
                                                        : trans.map(t => {
                                                            const ts = statusStyle(t.categoryKey);
                                                            return (
                                                                <div
                                                                    key={t.id}
                                                                    onClick={() => handleChildTransition(issue.key, t)}
                                                                    style={{ display: 'flex', alignItems: 'center', padding: '7px 10px', cursor: 'pointer', transition: 'background 0.1s' }}
                                                                    onMouseEnter={e => e.currentTarget.style.background = '#F4F5F7'}
                                                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                                >
                                                                    <span style={{
                                                                        padding: '2px 7px', borderRadius: 3,
                                                                        background: ts.bg, color: ts.color,
                                                                        fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em',
                                                                        whiteSpace: 'nowrap',
                                                                    }}>{t.name}</span>
                                                                </div>
                                                            );
                                                        })
                                                    }
                                                </div>
                                            </>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>

                        {/* Summary */}
                        <div style={{ fontSize: 13, color: '#172B4D', lineHeight: 1.4, marginBottom: 5 }}>{issue.summary}</div>

                        {/* Sprint chip | Assignee chip */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            {/* Sprint */}
                            {isEditingSprint ? (
                                <select
                                    autoFocus
                                    value={issue.sprintId ?? ''}
                                    onChange={e => updateChildSprint(issue.key, e.target.value)}
                                    onBlur={() => setEditing(null)}
                                    style={inlineSelect}
                                >
                                    <option value="">No sprint</option>
                                    {activeSprints.map(s => (
                                        <option key={s.id} value={String(s.id)}>{s.name}</option>
                                    ))}
                                </select>
                            ) : (
                                <span
                                    style={issue.sprintName ? chipFilled : chipEmpty}
                                    onClick={() => setEditing({ key: issue.key, field: 'sprint' })}
                                    title="Click to change sprint"
                                >
                                    🗓 {issue.sprintName ?? 'No sprint'}
                                </span>
                            )}

                            {/* Assignee */}
                            {isEditingAssignee ? (
                                <select
                                    autoFocus
                                    value={issue.assignee?.accountId ?? ''}
                                    onChange={e => updateChildAssignee(issue.key, e.target.value)}
                                    onBlur={() => setEditing(null)}
                                    style={inlineSelect}
                                >
                                    <option value="">Unassigned</option>
                                    {assignableUsers.map(u => (
                                        <option key={u.accountId} value={u.accountId}>{u.displayName}</option>
                                    ))}
                                </select>
                            ) : (
                                <span
                                    style={issue.assignee ? chipFilled : chipEmpty}
                                    onClick={() => setEditing({ key: issue.key, field: 'assignee' })}
                                    title="Click to change assignee"
                                >
                                    👤 {issue.assignee?.displayName ?? 'Unassigned'}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const openIssues = children?.filter(c => c.statusCategory !== 'Done') ?? [];
    const doneIssues = children?.filter(c => c.statusCategory === 'Done') ?? [];

    return (
        <>
            {/* Backdrop */}
            <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(9,30,66,0.4)', zIndex: 200 }} />

            {/* Modal — position:fixed escapes grid overflow */}
            <div style={{
                position: 'fixed', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 680, maxHeight: '80vh',
                background: '#fff', borderRadius: 8,
                boxShadow: '0 8px 32px rgba(9,30,66,0.25)',
                zIndex: 201, display: 'flex', flexDirection: 'column',
                overflow: 'hidden',
            }}>
                {/* Header */}
                <div style={{ padding: '16px 20px 14px', borderBottom: '1px solid #EBECF0', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            {epic.project && (
                                epic.project.avatarUrl
                                    ? <img src={epic.project.avatarUrl} title={epic.project.name} style={{ width: 16, height: 16, borderRadius: 2 }} alt={epic.project.name} />
                                    : <span title={epic.project.name} style={{ width: 16, height: 16, borderRadius: 2, background: '#0052cc', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: '#fff', fontWeight: 'bold' }}>{epic.project.key[0]}</span>
                            )}
                            <span
                                style={{ fontSize: 12, fontWeight: 700, color: '#0052cc', cursor: 'pointer', textDecoration: 'underline' }}
                                onClick={() => router.open(`/browse/${epic.key}`)}
                            >
                                {epic.key}
                            </span>
                            {epic.project && (
                                <span style={{ fontSize: 12, color: '#6B778C' }}>{epic.project.name}</span>
                            )}
                        </div>
                        <div style={{ fontSize: 18, fontWeight: 600, color: '#172B4D', lineHeight: 1.3 }}>{epic.summary}</div>
                        {epic.assignee && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                                <img src={epic.assignee.avatarUrl} title={epic.assignee.displayName} style={{ width: 20, height: 20, borderRadius: '50%' }} alt={epic.assignee.displayName} />
                                <span style={{ fontSize: 12, color: '#42526E' }}>{epic.assignee.displayName}</span>
                            </div>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                        {/* Status chip + popover — matches Jira's native look */}
                        {transitions !== null && (() => {
                            const st = statusStyle(epicStatus?.categoryKey);
                            return (
                                <div style={{ position: 'relative' }}>
                                    <button
                                        onClick={() => !transitioning && setStatusOpen(o => !o)}
                                        disabled={transitioning}
                                        title="Change status"
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 5,
                                            padding: '4px 10px 4px 10px',
                                            background: st.bg, color: st.color,
                                            border: 'none', borderRadius: 3,
                                            fontSize: 12, fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase',
                                            cursor: transitioning ? 'default' : 'pointer',
                                            opacity: transitioning ? 0.7 : 1,
                                            whiteSpace: 'nowrap',
                                            transition: 'background 0.1s',
                                        }}
                                    >
                                        {transitioning ? 'Updating…' : (epicStatus?.name ?? 'Unknown')}
                                        {!transitioning && <span style={{ fontSize: 9, marginLeft: 2, opacity: 0.7 }}>▼</span>}
                                    </button>
                                    {statusOpen && transitions.length > 0 && (
                                        <>
                                            {/* click-away backdrop */}
                                            <div onClick={() => setStatusOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 299 }} />
                                            <div style={{
                                                position: 'absolute', top: 'calc(100% + 4px)', right: 0,
                                                background: '#fff', borderRadius: 4,
                                                boxShadow: '0 4px 16px rgba(9,30,66,0.2)',
                                                minWidth: 180, zIndex: 300,
                                                overflow: 'hidden',
                                                border: '1px solid #DFE1E6',
                                            }}>
                                                {[...transitions].sort((a, b) => {
                                                    const order = { new: 0, indeterminate: 1, done: 2 };
                                                    const ao = order[a.categoryKey] ?? 3;
                                                    const bo = order[b.categoryKey] ?? 3;
                                                    return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
                                                }).map(t => {
                                                    const ts = statusStyle(t.categoryKey);
                                                    return (
                                                        <div
                                                            key={t.id}
                                                            onClick={() => handleTransition(t)}
                                                            style={{
                                                                display: 'flex', alignItems: 'center', gap: 10,
                                                                padding: '8px 12px',
                                                                cursor: 'pointer',
                                                                fontSize: 13, color: '#172B4D',
                                                                transition: 'background 0.1s',
                                                            }}
                                                            onMouseEnter={e => e.currentTarget.style.background = '#F4F5F7'}
                                                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                        >
                                                            <span style={{
                                                                display: 'inline-block',
                                                                padding: '2px 8px', borderRadius: 3,
                                                                background: ts.bg, color: ts.color,
                                                                fontSize: 11, fontWeight: 700,
                                                                textTransform: 'uppercase', letterSpacing: '0.02em',
                                                                whiteSpace: 'nowrap',
                                                            }}>{t.name}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })()}
                        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6B778C', padding: '0 2px', lineHeight: 1 }}>✕</button>
                    </div>
                </div>

                {/* Body */}
                <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>
                    {transitionError && <div style={{ fontSize: 12, color: '#c9372c', marginBottom: 10 }}>{transitionError}</div>}

                    {/* Progress bar */}
                    {!loading && children && total > 0 && (
                        <div style={{ marginBottom: 16 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#42526E', marginBottom: 4 }}>
                                <span>Progress</span>
                                <span>{doneCount} / {total} done — {pct}%</span>
                            </div>
                            <div style={{ height: 6, background: '#DFE1E6', borderRadius: 3, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? '#216e4e' : '#0052cc', borderRadius: 3, transition: 'width 0.3s' }} />
                            </div>
                        </div>
                    )}

                    <div style={{ fontWeight: 700, fontSize: 13, color: '#172B4D', marginBottom: 10 }}>Child Issues</div>
                    {loading && <div style={{ fontSize: 13, color: '#888' }}>Loading…</div>}
                    {childError && <div style={{ fontSize: 13, color: '#c9372c' }}>{childError}</div>}
                    {children && children.length === 0 && (
                        <div style={{ fontSize: 13, color: '#888' }}>No child issues.</div>
                    )}
                    {children && (
                        <>
                            {openIssues.map(renderChildIssue)}
                            {doneIssues.length > 0 && (
                                <>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 4px' }}>
                                        <div style={{ flex: 1, height: 1, background: '#DFE1E6' }} />
                                        <span style={{ fontSize: 11, color: '#97A0AF', whiteSpace: 'nowrap' }}>Done ({doneIssues.length})</span>
                                        <div style={{ flex: 1, height: 1, background: '#DFE1E6' }} />
                                    </div>
                                    {doneIssues.map(renderChildIssue)}
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>
        </>
    );
}

function EpicCard({ epic, isDragOverlay, row, cellId, onExpand }) {
    const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
        id: epic.key,
        data: { epic, cellId },
    });

    const { setNodeRef: setDropRef, isOver: isDropOver } = useDroppable({
        id: isDragOverlay ? `card-overlay:${epic.key}` : `card:${epic.key}`,
        data: { cellId },
        disabled: isDragOverlay,
    });

    const setRef = (el) => { setDragRef(el); setDropRef(el); };

    return (
        <div
            ref={setRef}
            style={{
                ...cardStyle(isDragging && !isDragOverlay, row),
                borderTop: isDropOver && !isDragging ? '2px solid #4c8cf5' : undefined,
            }}
            {...listeners}
            {...attributes}
        >
            <div style={cardHeaderStyle}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {epic.project && (
                        epic.project.avatarUrl
                            ? <img src={epic.project.avatarUrl} title={epic.project.name} style={{ width: 14, height: 14, borderRadius: 2, flexShrink: 0 }} alt={epic.project.name} />
                            : <span title={epic.project.name} style={{ width: 14, height: 14, borderRadius: 2, background: '#0052cc', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: '#fff', fontWeight: 'bold', flexShrink: 0 }}>{epic.project.key[0]}</span>
                    )}
                    <span
                        style={{ ...cardKeyStyle, cursor: 'pointer', textDecoration: 'underline' }}
                        onClick={e => { e.stopPropagation(); router.open(`/browse/${epic.key}`); }}
                    >
                        {epic.key}
                    </span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!isDragOverlay && (
                        epic.assignee
                            ? <img src={epic.assignee.avatarUrl} title={epic.assignee.displayName} style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0 }} alt={epic.assignee.displayName} />
                            : <span title="Unassigned" style={{ width: 20, height: 20, borderRadius: '50%', background: '#ddd', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#999', flexShrink: 0 }}>?</span>
                    )}
                    {!isDragOverlay && onExpand && (
                        <span
                            title="Open detail"
                            onClick={e => { e.stopPropagation(); onExpand(epic); }}
                            style={{ fontSize: 12, color: '#97A0AF', cursor: 'pointer', lineHeight: 1, padding: '0 1px', userSelect: 'none' }}
                        >
                            ⤢
                        </span>
                    )}
                </span>
            </div>
            <div style={{ fontSize: 13, marginTop: 2 }}>{epic.summary}</div>
        </div>
    );
}

const DAY_COL_WIDTH = 30; // px per day column
const COLLAPSED_SPRINT_WIDTH = 36;

// Explicit heights for the 4 calendar header rows — used for gridTemplateRows and sticky top values.
const HDR_Q = 24; // quarter
const HDR_M = 22; // month
const HDR_D = 22; // day ticks
const HDR_S = 28; // sprint name
const HDR_TOP_M = HDR_Q;
const HDR_TOP_D = HDR_Q + HDR_M;
const HDR_TOP_S = HDR_Q + HDR_M + HDR_D;

const backlogPanelStyle = {
    width: 220,
    flexShrink: 0,
    borderLeft: '2px solid #ccc',
    display: 'flex',
    flexDirection: 'column',
    background: '#fafafa',
};

const backlogHeaderStyle = {
    padding: '6px 10px',
    fontWeight: 'bold',
    fontSize: 13,
    background: '#f4f5f7',
    borderBottom: '1px solid #ccc',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
};

const toggleButtonStyle = {
    background: '#fff',
    border: '1px solid #ccc',
    borderRadius: 3,
    padding: '3px 8px',
    fontSize: 12,
    cursor: 'pointer',
    color: '#333',
};

function computeColumnLayout(sprints, sprintSpans, numDays, collapsedSprints) {
    // dayIndex → sprintId
    const dayToSprintId = {};
    for (const s of sprints) {
        const sp = sprintSpans[s.id];
        if (!sp) continue;
        for (let i = sp.startIdx; i < sp.startIdx + sp.span; i++) dayToSprintId[i] = s.id;
    }
    const widths = [];
    const dayToCol = {}; // dayIndex → 1-based col index within widths
    const collapsedSeen = new Set();
    let col = 1;
    for (let i = 0; i < numDays; i++) {
        const sid = dayToSprintId[i];
        if (sid && collapsedSprints.has(sid)) {
            if (!collapsedSeen.has(sid)) {
                widths.push(`${COLLAPSED_SPRINT_WIDTH}px`);
                dayToCol[i] = col++;
                collapsedSeen.add(sid);
            }
            // non-first days of collapsed sprint: no column, not added to dayToCol
        } else {
            widths.push(`${DAY_COL_WIDTH}px`);
            dayToCol[i] = col++;
        }
    }
    // derive grid position for each sprint
    const sprintGridPos = {};
    for (const s of sprints) {
        const sp = sprintSpans[s.id];
        if (!sp) continue;
        if (collapsedSprints.has(s.id)) {
            const c = dayToCol[sp.startIdx];
            if (c != null) sprintGridPos[s.id] = { col: c, span: 1 };
        } else {
            let minCol = Infinity, maxCol = -Infinity;
            for (let i = sp.startIdx; i < sp.startIdx + sp.span; i++) {
                const c = dayToCol[i];
                if (c != null) { minCol = Math.min(minCol, c); maxCol = Math.max(maxCol, c); }
            }
            if (minCol !== Infinity) sprintGridPos[s.id] = { col: minCol, span: maxCol - minCol + 1 };
        }
    }
    return {
        templateCols: `120px ${widths.join(' ')}`,
        dayToCol,
        sprintGridPos,
        totalCols: col - 1,
    };
}

function groupToGridPos(group, dayToCol) {
    let minCol = Infinity, maxCol = -Infinity;
    for (let i = group.startIdx; i < group.startIdx + group.span; i++) {
        const c = dayToCol[i];
        if (c != null) { minCol = Math.min(minCol, c); maxCol = Math.max(maxCol, c); }
    }
    if (minCol === Infinity) return null;
    return { col: minCol, span: maxCol - minCol + 1 };
}

function PlanningGrid({ epics, sprints, selectedPriorities, focusAreaField, focusAreaOptions, onFocusAreaChange, onEpicDone }) {
    const visibleRows = ROWS.filter(r => selectedPriorities.has(r.key));
    const [positions, setPositions] = useState({});
    const [activeEpic, setActiveEpic] = useState(null);
    const [showBacklog, setShowBacklog] = useState(true);
    const [collapsedSections, setCollapsedSections] = useState(new Set());
    const [localCellOrders, setLocalCellOrders] = useState({});
    const [expandedEpic, setExpandedEpic] = useState(null);
    const [collapsedSprints, setCollapsedSprints] = useState(new Set());
    const [showHistory, setShowHistory] = useState(false);
    const canEditFocusAreas = !!focusAreaField?.fieldId;
    const focusAreaIdByValue = useMemo(() => {
        const map = new Map();
        if (Array.isArray(focusAreaField?.options)) {
            focusAreaField.options.forEach(opt => map.set(opt.value, opt.id));
        }
        epics.forEach(epic => {
            if (epic.focusArea && epic.focusAreaId) map.set(epic.focusArea, epic.focusAreaId);
        });
        return map;
    }, [focusAreaField, epics]);

    const pastSprints = sprints.filter(s => s.state === 'closed');
    const gridSprints = showHistory ? sprints : sprints.filter(s => s.state !== 'closed');

    const scrollRef = useRef(null);

    function toggleSprintCollapse(id) {
        setCollapsedSprints(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }

    function toggleSection(key) {
        setCollapsedSections(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    }

    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
        useSensor(TouchSensor, { activationConstraint: { distance: 5 } }),
    );

    const days          = computeCalendarDays(gridSprints);
    const numDays       = days.length;
    const quarterGroups = computeQuarterGroups(days);
    const monthGroups   = computeMonthGroups(days);

    const sprintSpans = {};
    for (const s of gridSprints) sprintSpans[s.id] = sprintDaySpan(s, days);

    // One section per focus area option + unassigned at end.
    // If no focus area field, a single unnamed section shows everything.
    const hasSections = focusAreaField && focusAreaOptions.length > 0;
    const sections = hasSections
        ? [...focusAreaOptions.map(v => ({ key: v, label: v })), { key: UNASSIGNED_KEY, label: 'No Focus Area' }]
        : [{ key: UNASSIGNED_KEY, label: null }];

    const gridData = buildGridData(epics, gridSprints, positions, sections, localCellOrders);

    const HEADER_ROWS = 4;
    const rowsPerSection = visibleRows.length + (hasSections ? 1 : 0); // section header row + priority rows

    const colLayout = computeColumnLayout(gridSprints, sprintSpans, numDays, collapsedSprints);

    // Scroll to active sprint on first render
    useEffect(() => {
        if (!scrollRef.current || !days.length) return;
        const active = sprints.find(s => s.state === 'active');
        if (!active) return;
        const pos = colLayout.sprintGridPos[active.id];
        if (!pos) return;
        scrollRef.current.scrollLeft = Math.max(0, (pos.col - 1) * DAY_COL_WIDTH - 20);
    }, [sprints, days.length]);

    function handleDragStart({ active }) {
        setActiveEpic(epics.find(e => e.key === active.id) ?? null);
    }

    function handleCrossCellDrop(activeId, sectionKey, rowKey, colId) {
        setPositions(prev => ({ ...prev, [activeId]: { rowKey, colId } }));

        const sprintId = colId === BACKLOG_COLUMN.id ? null : Number(colId);
        invoke('assignEpicToSprint', { epicKey: activeId, sprintId })
            .catch(err => console.error('Failed to assign sprint:', err));
        invoke('updateEpicPriority', { epicKey: activeId, priority: rowKey })
            .catch(err => console.error('Failed to update priority:', err));

        const epic = epics.find(e => e.key === activeId);
        const currentKey = epic?.focusArea ?? UNASSIGNED_KEY;
        if (focusAreaField && canEditFocusAreas && sectionKey !== currentKey) {
            const newFocusArea = sectionKey === UNASSIGNED_KEY ? null : sectionKey;
            const optionId = newFocusArea ? focusAreaIdByValue.get(newFocusArea) ?? null : null;
            onFocusAreaChange(activeId, newFocusArea, optionId);
            invoke('updateEpicFocusArea', {
                epicKey: activeId,
                fieldId: focusAreaField.fieldId,
                optionId,
                value: newFocusArea,
            }).catch(err => console.error('Failed to update focus area:', err));
        }
    }

    function handleDragEnd({ active, over }) {
        setActiveEpic(null);
        if (!over) return;

        // Card-level drop: within-cell reorder or cross-cell via card target
        if (over.id.startsWith('card:')) {
            const targetKey = over.id.slice(5);
            const sourceCellId = active.data.current?.cellId;
            const targetCellId = over.data.current?.cellId;

            if (!sourceCellId || !targetCellId) return;

            if (sourceCellId === targetCellId) {
                // Same cell — reorder using Jira rank
                const [secKey, rowKey, colId] = sourceCellId.split('|');
                const cellEpics = gridData[secKey]?.[rowKey]?.[colId] ?? [];
                const keys = cellEpics.map(e => e.key);
                const oldIdx = keys.indexOf(active.id);
                const newIdx = keys.indexOf(targetKey);
                if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
                const reordered = arrayMove(keys, oldIdx, newIdx);
                // Optimistic local update for immediate feedback
                setLocalCellOrders(prev => ({ ...prev, [sourceCellId]: reordered }));
                // Persist via Jira rank API — same as Timeline view ranking
                const rankPayload = { epicKey: active.id };
                if (newIdx === 0) {
                    rankPayload.rankBeforeIssue = reordered[1];
                } else {
                    rankPayload.rankAfterIssue = reordered[newIdx - 1];
                }
                invoke('rankEpic', rankPayload)
                    .catch(err => console.error('Failed to rank epic:', err));
            } else {
                // Different cell — treat as a cross-cell move into targetCellId
                const [sectionKey, rowKey, colId] = targetCellId.split('|');
                handleCrossCellDrop(active.id, sectionKey, rowKey, colId);
            }
            return;
        }

        // Cell-level drop (empty cell or cell background)
        const [sectionKey, rowKey, colId] = over.id.split('|');
        handleCrossCellDrop(active.id, sectionKey, rowKey, colId);
    }

    const gridTemplateColumns = colLayout.templateCols;
    const backlogCount = sections.reduce(
        (n, sec) => n + visibleRows.reduce((m, row) => m + (gridData[sec.key]?.[row.key]?.backlog.length ?? 0), 0), 0
    );

    function renderSection(section, si) {
        const baseRow      = HEADER_ROWS + 1 + si * rowsPerSection;
        const dataStartRow = baseRow + (hasSections ? 1 : 0);
        const collapsed    = collapsedSections.has(section.key);
        const epicCount    = visibleRows.reduce((n, row) =>
            n + Object.values(gridData[section.key]?.[row.key] ?? {}).reduce((m, arr) => m + arr.length, 0), 0);
        return (
            <React.Fragment key={section.key}>
                {/* Section header row */}
                {hasSections && (
                    <>
                        <div
                            onClick={() => toggleSection(section.key)}
                            style={{
                                gridRow: baseRow, gridColumn: 1,
                                background: '#e8eaf0',
                                borderTop: si > 0 ? '2px solid #bbb' : 'none',
                                borderBottom: '1px solid #ccc',
                                borderRight: '1px solid #ccc',
                                padding: '5px 12px',
                                fontWeight: 'bold', fontSize: 13, color: '#333',
                                position: 'sticky', left: 0, zIndex: 1,
                                cursor: 'pointer', userSelect: 'none',
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}
                        >
                            <span style={{ fontSize: 10 }}>{collapsed ? '▶' : '▼'}</span>
                            {section.label}
                            {collapsed && epicCount > 0 && (
                                <span style={{ fontSize: 11, fontWeight: 'normal', color: '#666' }}>({epicCount})</span>
                            )}
                        </div>
                        <div
                            onClick={() => toggleSection(section.key)}
                            style={{
                                gridRow: baseRow, gridColumn: `2 / span ${colLayout.totalCols}`,
                                background: '#e8eaf0',
                                borderTop: si > 0 ? '2px solid #bbb' : 'none',
                                borderBottom: '1px solid #ccc',
                                cursor: 'pointer',
                            }}
                        />
                    </>
                )}

                {/* Priority rows — not rendered when collapsed; empty auto rows collapse to 0 height */}
                {!collapsed && visibleRows.map((row, ri) => {
                    const dataRow = dataStartRow + ri;
                    return (
                        <React.Fragment key={row.key}>
                            <div style={{ ...rowLabelStyle(row), gridRow: dataRow, gridColumn: 1 }}>
                                {row.label}
                            </div>
                            {gridSprints.map(s => {
                                const pos = colLayout.sprintGridPos[s.id];
                                const gridCol = pos ? `${pos.col + 1} / span ${pos.span}` : '2';
                                const isCollapsed = collapsedSprints.has(s.id);
                                if (isCollapsed) {
                                    const count = (gridData[section.key]?.[row.key]?.[s.id] ?? []).length;
                                    return (
                                        <div key={s.id} style={{
                                            gridRow: dataRow, gridColumn: pos ? `${pos.col + 1}` : '2',
                                            borderBottom: '1px solid #eee', borderRight: '1px solid #eee',
                                            background: '#fafafa',
                                            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                                            paddingTop: 6, minHeight: 80,
                                        }}>
                                            {count > 0 && <span style={{ fontSize: 9, fontWeight: 600, color: '#bbb' }}>{count}</span>}
                                        </div>
                                    );
                                }
                                return (
                                    <DroppableCell
                                        key={s.id}
                                        id={`${section.key}|${row.key}|${s.id}`}
                                        gridRow={dataRow}
                                        gridColumn={gridCol}
                                    >
                                        {(gridData[section.key]?.[row.key]?.[s.id] ?? []).map(epic => (
                                            <EpicCard key={epic.key} epic={epic} row={row}
                                                cellId={`${section.key}|${row.key}|${s.id}`}
                                                onExpand={setExpandedEpic} />
                                        ))}
                                    </DroppableCell>
                                );
                            })}
                        </React.Fragment>
                    );
                })}
            </React.Fragment>
        );
    }

    return (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <style>{`
                @keyframes shimmer {
                    0% { background-position: 200% 0; }
                    100% { background-position: -200% 0; }
                }
            `}</style>

            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, height: '100%' }}>
                {/* Single scroll container for both axes — alignContent:start means auto rows size to
                    content (not compressed to fill height), so cells expand as cards are added.
                    Sticky top headers and sticky left labels both work relative to this container. */}
                <div
                    ref={scrollRef}
                    style={{
                        flex: 1, minWidth: 0, height: '100%',
                        display: 'grid',
                        gridTemplateColumns,
                        gridTemplateRows: `${HDR_Q}px ${HDR_M}px ${HDR_D}px ${HDR_S}px`,
                        gridAutoRows: 'max-content',
                        alignContent: 'start',
                        overflowX: 'auto', overflowY: 'auto',
                        border: '1px solid #ccc', borderRadius: 4,
                    }}
                >
                    <div style={cornerStyle} />

                    {pastSprints.length > 0 && (
                        <div
                            onClick={() => setShowHistory(h => !h)}
                            title={showHistory ? 'Hide past sprints' : `Show ${pastSprints.length} past sprint${pastSprints.length !== 1 ? 's' : ''}`}
                            style={{
                                gridRow: 4, gridColumn: 1,
                                position: 'sticky', top: HDR_TOP_S, left: 0, zIndex: 3,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: showHistory ? '#e8eaf0' : '#f0f1f4',
                                borderTop: '1px solid #ccc',
                                borderRight: '1px solid #ccc',
                                cursor: 'pointer',
                                fontSize: 11,
                                color: '#42526E',
                                fontWeight: 600,
                                gap: 4,
                                userSelect: 'none',
                            }}
                        >
                            {showHistory ? '‹ Hide' : `${pastSprints.length} past ›`}
                        </div>
                    )}

                    {/* Row 1 — Quarters (sticky top) */}
                    {quarterGroups.map((q, i) => {
                        const pos = groupToGridPos(q, colLayout.dayToCol);
                        if (!pos) return null;
                        return (
                            <div key={i} style={quarterCellStyle({
                                gridRow: 1, gridColumn: `${pos.col + 1} / span ${pos.span}`,
                                position: 'sticky', top: 0, zIndex: 2,
                            })}>
                                {q.label}
                            </div>
                        );
                    })}

                    {/* Row 2 — Months (sticky top) */}
                    {monthGroups.map((m, i) => {
                        const pos = groupToGridPos(m, colLayout.dayToCol);
                        if (!pos) return null;
                        return (
                            <div key={i} style={monthCellStyle({
                                gridRow: 2, gridColumn: `${pos.col + 1} / span ${pos.span}`,
                                position: 'sticky', top: HDR_TOP_M, zIndex: 2,
                            })}>
                                {m.label}
                            </div>
                        );
                    })}

                    {/* Row 3 — Day ticks (sticky top) */}
                    {days.map((d, i) => {
                        const col = colLayout.dayToCol[i];
                        if (col == null) return null; // collapsed sprint interior day
                        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                        return (
                            <div key={i} style={{
                                ...dayCellStyle, gridRow: 3, gridColumn: col + 1,
                                background: isWeekend ? '#e8e9ec' : '#f4f5f7',
                                color: isWeekend ? '#aaa' : '#888',
                                position: 'sticky', top: HDR_TOP_D, zIndex: 2,
                            }}>
                                {d.getDate()}
                            </div>
                        );
                    })}

                    {/* Row 4 — Sprint names (sticky top) */}
                    {gridSprints.map(s => {
                        const pos = colLayout.sprintGridPos[s.id];
                        const isCollapsed = collapsedSprints.has(s.id);
                        const gridCol = pos ? `${pos.col + 1} / span ${pos.span}` : '2';
                        return (
                            <div
                                key={s.id}
                                onClick={() => toggleSprintCollapse(s.id)}
                                title={isCollapsed ? `${s.name} (collapsed — click to expand)` : 'Click to collapse'}
                                style={sprintCellStyle(s.state === 'active', {
                                    gridRow: 4, gridColumn: gridCol,
                                    position: 'sticky', top: HDR_TOP_S, zIndex: 2,
                                    cursor: 'pointer',
                                    display: 'flex', alignItems: 'center',
                                    overflow: 'hidden',
                                    justifyContent: isCollapsed ? 'center' : undefined,
                                })}
                            >
                                {isCollapsed
                                    ? <span style={{ fontSize: 9, color: '#888', writingMode: 'vertical-rl', textOrientation: 'mixed', transform: 'rotate(180deg)', whiteSpace: 'nowrap', overflow: 'hidden', maxHeight: 60 }}>▶ {s.name}</span>
                                    : <>
                                        {s.name}
                                        {s.state === 'active' && <span style={{ fontSize: 10, fontWeight: 'normal', marginLeft: 4 }}>· active</span>}
                                        <span style={{ fontSize: 9, marginLeft: 'auto', opacity: 0.4, flexShrink: 0 }}>‹</span>
                                      </>
                                }
                            </div>
                        );
                    })}

                    {/* Focus area sections */}
                    {sections.map((section, si) => renderSection(section, si))}
                </div>

                {/* Backlog toggle */}
                {!showBacklog && (
                    <button style={{ ...toggleButtonStyle, alignSelf: 'flex-start', marginTop: 4 }} onClick={() => setShowBacklog(true)}>
                        Backlog {backlogCount > 0 && `(${backlogCount})`} ▶
                    </button>
                )}

                {/* Collapsible backlog panel — sectioned to match the grid */}
                {showBacklog && (
                    <div style={{ ...backlogPanelStyle, border: '1px solid #ccc', borderRadius: 4, alignSelf: 'stretch', overflowY: 'auto' }}>
                        <div style={backlogHeaderStyle}>
                            <span>Backlog {backlogCount > 0 && `(${backlogCount})`}</span>
                            <button style={toggleButtonStyle} onClick={() => setShowBacklog(false)}>✕ Hide</button>
                        </div>
                        {sections.map((section, si) => {
                            const collapsed = collapsedSections.has(section.key);
                            const backlogCount = visibleRows.reduce((n, row) => n + (gridData[section.key]?.[row.key]?.backlog.length ?? 0), 0);
                            return (
                                <div key={section.key}>
                                    {hasSections && (
                                        <div
                                            onClick={() => toggleSection(section.key)}
                                            style={{
                                                padding: '4px 10px', fontSize: 12, fontWeight: 'bold',
                                                background: '#e8eaf0',
                                                borderTop: si > 0 ? '1px solid #ccc' : 'none',
                                                borderBottom: '1px solid #ccc', color: '#333',
                                                cursor: 'pointer', userSelect: 'none',
                                                display: 'flex', alignItems: 'center', gap: 5,
                                            }}
                                        >
                                            <span style={{ fontSize: 10 }}>{collapsed ? '▶' : '▼'}</span>
                                            {section.label}
                                            {collapsed && backlogCount > 0 && (
                                                <span style={{ fontWeight: 'normal', color: '#666' }}>({backlogCount})</span>
                                            )}
                                        </div>
                                    )}
                                    {!collapsed && visibleRows.map(row => (
                                        <div key={row.key}>
                                            <div style={{ ...rowLabelStyle(row), borderRight: 'none', borderBottom: 'none', paddingTop: 8, paddingBottom: 4 }}>
                                                {row.label}
                                            </div>
                                            <DroppableCell id={`${section.key}|${row.key}|backlog`}>
                                                {(gridData[section.key]?.[row.key]?.backlog ?? []).map(epic => (
                                                    <EpicCard key={epic.key} epic={epic} row={row}
                                                        cellId={`${section.key}|${row.key}|backlog`}
                                                        onExpand={setExpandedEpic} />
                                                ))}
                                            </DroppableCell>
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            <DragOverlay>
                {activeEpic && <EpicCard epic={activeEpic} isDragOverlay />}
            </DragOverlay>

            {expandedEpic && (
                <EpicDetailModal
                    epic={expandedEpic}
                    sprints={sprints}
                    onClose={() => setExpandedEpic(null)}
                    onEpicDone={(key) => { setExpandedEpic(null); onEpicDone?.(key); }}
                />
            )}
        </DndContext>
    );
}


let appContext = null;
async function getContext() {
    if (!appContext) appContext = await view.getContext();
    return appContext;
}

// Read boardId, filterId, and projectKey from URL query params.
async function getParamsFromLocation() {
    const context = await getContext();
    const location = context?.extension?.location ?? '';
    const qIdx = location.indexOf('?');
    if (qIdx === -1) return { boardId: null, filterId: null, projectKey: null };
    const params = new URLSearchParams(location.slice(qIdx));
    return {
        boardId: params.get('boardId') ? Number(params.get('boardId')) : null,
        filterId: params.get('filterId') ?? null,
        projectKey: params.get('projectKey') ?? null,
    };
}

// Update the URL query params without reloading — persists board + filter + project selection.
async function navigateWithParams(boardId, filterId, projectKey) {
    const context = await getContext();
    const location = context?.extension?.location ?? '';
    const basePath = location.split('?')[0];
    const params = new URLSearchParams();
    if (boardId != null) params.set('boardId', String(boardId));
    if (filterId != null) params.set('filterId', String(filterId));
    if (projectKey != null) params.set('projectKey', String(projectKey));
    router.navigate(`${basePath}?${params.toString()}`);
}

const settingsPanelStyle = {
    background: '#fff',
    border: '1px solid #DFE1E6',
    borderRadius: 4,
    padding: '10px 14px',
    marginTop: 4,
    minWidth: 260,
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    position: 'absolute',
    right: 0,
    zIndex: 10,
};

const settingsOptionRowStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 0',
    borderBottom: '1px solid #f0f0f0',
    fontSize: 13,
};

function SortableOptionRow({ opt, epics, deletingId, onDelete }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: opt.id });
    const inUse = (epics ?? []).filter(e => e.focusArea === opt.value).length;
    return (
        <div
            ref={setNodeRef}
            style={{
                ...settingsOptionRowStyle,
                transform: DNDCSS.Transform.toString(transform),
                transition,
                opacity: isDragging ? 0.4 : 1,
                background: isDragging ? '#f4f5f7' : undefined,
            }}
        >
            <span
                {...listeners}
                {...attributes}
                title="Drag to reorder"
                style={{ cursor: 'grab', color: '#aaa', fontSize: 14, padding: '0 4px 0 0', lineHeight: 1 }}
            >
                ⠿
            </span>
            <span style={{ flex: 1 }}>
                {opt.value}
                {inUse > 0 && <span style={{ marginLeft: 6, fontSize: 11, color: '#888' }}>({inUse})</span>}
            </span>
            <button
                onClick={() => onDelete(opt)}
                disabled={!!deletingId}
                style={{ background: 'none', border: 'none', color: '#c9372c', cursor: 'pointer', fontSize: 13, padding: '0 4px' }}
                title="Delete option"
            >
                {deletingId === opt.id ? '…' : '✕'}
            </button>
        </div>
    );
}

function FocusAreaSettings({ focusAreaField, epics, onFieldChange }) {
    if (!Array.isArray(focusAreaField?.options)) return null;
    const [open, setOpen] = useState(false);
    const [newValue, setNewValue] = useState('');
    const [adding, setAdding] = useState(false);
    const [deletingId, setDeletingId] = useState(null);
    const [localError, setLocalError] = useState(null);
    const wrapperRef = useRef(null);
    const opts = focusAreaField.options;

    const sortSensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
        useSensor(TouchSensor, { activationConstraint: { distance: 5 } }),
    );

    // Close panel on outside click
    useEffect(() => {
        if (!open) return;
        function handleClick(e) {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    function handleSortEnd({ active, over }) {
        if (!over || active.id === over.id) return;
        const oldIndex = opts.findIndex(o => o.id === active.id);
        const newIndex = opts.findIndex(o => o.id === over.id);
        const reordered = arrayMove(opts, oldIndex, newIndex);

        // Optimistic update
        onFieldChange(prev => ({ ...prev, options: reordered }));

        // Determine Jira position args (First / After <id>)
        let position, afterId;
        if (newIndex === 0) {
            position = 'First'; afterId = null;
        } else {
            position = 'After';
            afterId  = reordered[newIndex - 1].id;
        }

        invoke('reorderFocusAreaOption', {
            fieldId: focusAreaField.fieldId,
            contextId: focusAreaField.contextId,
            optionId: active.id,
            position,
            afterId,
        }).catch(err => {
            onFieldChange(prev => ({ ...prev, options: opts })); // roll back
            setLocalError(err.message ?? 'Failed to reorder option');
        });
    }

    function handleAdd() {
        const value = newValue.trim();
        if (!value) return;
        setAdding(true);
        setLocalError(null);
        invoke('addFocusAreaOption', {
            fieldId: focusAreaField.fieldId,
            contextId: focusAreaField.contextId,
            value,
        })
            .then(created => {
                onFieldChange(prev => ({ ...prev, options: [...prev.options, created] }));
                setNewValue('');
            })
            .catch(err => setLocalError(err.message ?? 'Failed to add option'))
            .finally(() => setAdding(false));
    }

    function handleDelete(opt) {
        const inUse = (epics ?? []).filter(e => e.focusArea === opt.value).length;
        if (inUse > 0 && !window.confirm(`"${opt.value}" is used by ${inUse} epic${inUse > 1 ? 's' : ''}. Delete anyway?`)) return;
        setDeletingId(opt.id);
        setLocalError(null);
        invoke('deleteFocusAreaOption', {
            fieldId: focusAreaField.fieldId,
            contextId: focusAreaField.contextId,
            optionId: opt.id,
        })
            .then(() => onFieldChange(prev => ({ ...prev, options: prev.options.filter(o => o.id !== opt.id) })))
            .catch(err => setLocalError(err.message ?? 'Failed to delete option'))
            .finally(() => setDeletingId(null));
    }

    return (
        <div ref={wrapperRef} style={{ position: 'relative', alignSelf: 'center' }}>
            <button
                onClick={() => setOpen(o => !o)}
                title="Manage Focus Area options"
                style={{
                    fontSize: 12, fontWeight: 600, color: open ? '#0052cc' : '#42526E',
                    background: open ? '#DEEBFF' : '#F4F5F7',
                    border: `1px solid ${open ? '#4C9AFF' : '#DFE1E6'}`,
                    borderRadius: 4, padding: '4px 10px',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
                    whiteSpace: 'nowrap',
                }}
            >
                <span style={{ fontSize: 13 }}>⚙</span> Focus Areas
            </button>
            {open && (
                <div style={settingsPanelStyle}>
                    <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 8 }}>Focus Area Options</div>
                    {opts.length === 0 && (
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>No options yet.</div>
                    )}
                    <DndContext sensors={sortSensors} collisionDetection={closestCenter} onDragEnd={handleSortEnd}>
                        <SortableContext items={opts.map(o => o.id)} strategy={verticalListSortingStrategy}>
                            {opts.map(opt => (
                                <SortableOptionRow
                                    key={opt.id}
                                    opt={opt}
                                    epics={epics}
                                    deletingId={deletingId}
                                    onDelete={handleDelete}
                                />
                            ))}
                        </SortableContext>
                    </DndContext>
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                        <input
                            type="text"
                            value={newValue}
                            onChange={e => setNewValue(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAdd()}
                            placeholder="New option…"
                            style={{ flex: 1, fontSize: 13, padding: '3px 6px', border: '1px solid #ccc', borderRadius: 3 }}
                        />
                        <button
                            onClick={handleAdd}
                            disabled={adding || !newValue.trim()}
                            style={{ ...toggleButtonStyle, padding: '3px 10px' }}
                        >
                            {adding ? '…' : 'Add'}
                        </button>
                    </div>
                    {localError && <div style={{ marginTop: 6, fontSize: 12, color: '#c9372c' }}>{localError}</div>}
                </div>
            )}
        </div>
    );
}


function ToolbarSelect({ id, label, value, onChange, disabled, children }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <label htmlFor={id} style={{ fontSize: 11, fontWeight: 600, color: '#6b778c', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                {label}
            </label>
            <select
                id={id}
                value={value}
                onChange={onChange}
                disabled={disabled}
                style={{
                    fontSize: 13, fontWeight: 500, color: '#172B4D',
                    background: '#F4F5F7', border: '1px solid #DFE1E6',
                    borderRadius: 4, padding: '3px 24px 3px 8px',
                    cursor: 'pointer', outline: 'none',
                    appearance: 'none', WebkitAppearance: 'none',
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%236b778c' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E")`,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 7px center',
                    maxWidth: 200,
                    opacity: disabled ? 0.6 : 1,
                }}
            >
                {children}
            </select>
        </div>
    );
}

function App() {
    const [boards, setBoards] = useState(null);
    const [selectedBoard, setSelectedBoard] = useState(null);
    const [filters, setFilters] = useState(null);
    const [selectedFilter, setSelectedFilter] = useState(null);
    const [selectedProject, setSelectedProject] = useState(null); // null = All Projects
    const [selectedPriorities, setSelectedPriorities] = useState(() => new Set(ROWS.map(r => r.key)));
    const [sprints, setSprints] = useState(null);
    const [epics, setEpics] = useState(null);
    const [focusAreaField, setFocusAreaField] = useState(undefined); // undefined = loading, null = not found
    const [error, setError] = useState(null);
    const [epicRefreshKey, setEpicRefreshKey] = useState(0);

    function togglePriority(key) {
        setSelectedPriorities(prev => {
            const next = new Set(prev);
            if (next.has(key)) { if (next.size > 1) next.delete(key); } // keep at least one
            else next.add(key);
            return next;
        });
    }

    // On mount: load reference data and restore board + filter + project from query params.
    useEffect(() => {
        Promise.all([invoke('getBoards'), invoke('getFilters'), invoke('getFocusAreaField'), getParamsFromLocation()])
            .then(([boardData, filterData, focusField, { boardId: paramBoardId, filterId: paramFilterId, projectKey: paramProjectKey }]) => {
                setBoards(boardData);
                setFilters(filterData);
                setFocusAreaField(focusField ?? null);
                const board = (paramBoardId && boardData.find(b => b.id === paramBoardId))
                    ?? boardData[0]
                    ?? null;
                const boardId = board?.id ?? null;
                setSelectedBoard(boardId);
                // Honour URL filter param; otherwise auto-match to the board.
                const filterId = paramFilterId ?? findMatchingFilter(filterData, board);
                setSelectedFilter(filterId);
                setSelectedProject(paramProjectKey ?? null);
            })
            .catch(err => setError(err.message ?? 'Failed to load data'));
    }, []);

    useEffect(() => {
        if (!selectedBoard) return;
        setSprints(null);
        invoke('getSprints', { boardId: selectedBoard })
            .then(setSprints)
            .catch(err => setError(err.message ?? 'Failed to load sprints'));
    }, [selectedBoard]);

    // Re-fetch epics when the filter, field ID, or board sprints change.
    // Sprints are passed so the resolver can ignore sprint assignments from other boards.
    const focusAreaFieldId = focusAreaField?.fieldId ?? null;
    useEffect(() => {
        if (!selectedFilter || focusAreaField === undefined || !sprints) return;
        setEpics(null);
        const boardSprintIds = sprints.map(s => s.id);
        invoke('getEpics', { filterId: selectedFilter, focusAreaFieldId, boardSprintIds })
            .then(data => setEpics(data))
            .catch(err => setError(err.message ?? 'Failed to load epics'));
    }, [selectedFilter, focusAreaFieldId, sprints, epicRefreshKey]);

    function handleBoardChange(boardId) {
        const board = boards?.find(b => String(b.id) === String(boardId));
        const filterId = findMatchingFilter(filters, board);
        setSelectedBoard(boardId);
        setSelectedFilter(filterId);
        navigateWithParams(boardId, filterId, selectedProject);
    }

    function handleFilterChange(filterId) {
        setSelectedFilter(filterId);
        navigateWithParams(selectedBoard, filterId, selectedProject);
    }

    function handleProjectChange(projectKey) {
        const key = projectKey === '' ? null : projectKey;
        setSelectedProject(key);
        navigateWithParams(selectedBoard, selectedFilter, key);
    }

    if (error) return <div>Error: {error}</div>;

    // Use authoritative options from the field definition; fall back to values in epics.
    const focusAreaOptions = focusAreaField?.options?.length
        ? focusAreaField.options.map(o => o.value)
        : (epics ? [...new Set(epics.map(e => e.focusArea).filter(Boolean))].sort() : []);
    const canManageFocusAreas = !!(focusAreaField
        && !focusAreaField.readOnly
        && Array.isArray(focusAreaField.options)
        && focusAreaField.contextId);

    // Derive sorted project list from loaded epics — no extra resolver needed.
    const projects = epics
        ? [...new Map(epics.filter(e => e.project).map(e => [e.project.key, e.project])).values()]
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];

    // Apply project filter client-side.
    const visibleEpics = selectedProject && epics
        ? epics.filter(e => e.project?.key === selectedProject)
        : epics;

    return (
        <div style={{ fontFamily: 'sans-serif', height: '100vh', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>

            {/* ── Toolbar ── */}
            <div style={{
                flexShrink: 0,
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '0 14px',
                height: 48,
                background: '#fff',
                borderBottom: '2px solid #e4e6ea',
                boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            }}>
                {/* App title */}
                <span style={{ fontWeight: 700, fontSize: 15, color: '#172B4D', letterSpacing: '-0.2px', whiteSpace: 'nowrap', marginRight: 6 }}>
                    Super Planner
                </span>

                <div style={{ width: 1, height: 22, background: '#ddd', flexShrink: 0 }} />

                {/* Board selector */}
                <ToolbarSelect
                    id="board-select"
                    label="Board"
                    value={selectedBoard ?? ''}
                    onChange={e => handleBoardChange(e.target.value)}
                    disabled={!boards}
                >
                    {boards
                        ? boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)
                        : <option>Loading…</option>}
                </ToolbarSelect>

                <div style={{ width: 1, height: 22, background: '#ddd', flexShrink: 0 }} />

                {/* Filter selector */}
                <ToolbarSelect
                    id="filter-select"
                    label="Filter"
                    value={selectedFilter ?? ''}
                    onChange={e => handleFilterChange(e.target.value)}
                    disabled={!filters}
                >
                    {filters
                        ? filters.map(f => <option key={f.id} value={f.id}>{f.name}</option>)
                        : <option>Loading…</option>}
                </ToolbarSelect>

                <div style={{ width: 1, height: 22, background: '#ddd', flexShrink: 0 }} />

                {/* Project filter */}
                <ToolbarSelect
                    id="project-select"
                    label="Project"
                    value={selectedProject ?? ''}
                    onChange={e => handleProjectChange(e.target.value)}
                    disabled={!epics}
                >
                    <option value="">All Projects</option>
                    {projects.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                </ToolbarSelect>

                <div style={{ width: 1, height: 22, background: '#ddd', flexShrink: 0 }} />

                {/* Priority filter chips */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#6b778c', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap', marginRight: 2 }}>Priority</span>
                    {ROWS.map(row => {
                        const on = selectedPriorities.has(row.key);
                        return (
                            <button
                                key={row.key}
                                onClick={() => togglePriority(row.key)}
                                title={row.label}
                                style={{
                                    fontSize: 11, fontWeight: 600,
                                    padding: '2px 8px', borderRadius: 10,
                                    border: `1px solid ${on ? row.cardBorder : '#DFE1E6'}`,
                                    background: on ? row.cardBg : '#F4F5F7',
                                    color: on ? row.color : '#97A0AF',
                                    cursor: 'pointer',
                                    opacity: on ? 1 : 0.55,
                                    transition: 'all 0.1s',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {row.label}
                            </button>
                        );
                    })}
                </div>

                {/* Right-side actions */}
                <div style={{ flex: 1 }} />
                {focusAreaField?.readOnly && (
                    <span style={{
                        fontSize: 12,
                        color: '#6b778c',
                        background: '#F4F5F7',
                        border: '1px solid #DFE1E6',
                        borderRadius: 4,
                        padding: '4px 8px',
                        whiteSpace: 'nowrap',
                    }}>
                        Focus Area options can't be managed with your permissions
                    </span>
                )}
                {canManageFocusAreas && (
                    <FocusAreaSettings
                        focusAreaField={focusAreaField}
                        epics={epics}
                        onFieldChange={setFocusAreaField}
                    />
                )}
                <button
                    onClick={() => setEpicRefreshKey(k => k + 1)}
                    disabled={!sprints || !epics}
                    title="Refresh epics"
                    style={{
                        background: 'none', border: '1px solid #DFE1E6', borderRadius: 4,
                        padding: '4px 8px', cursor: (!sprints || !epics) ? 'default' : 'pointer',
                        fontSize: 14, color: '#42526E', lineHeight: 1,
                        opacity: (!sprints || !epics) ? 0.5 : 1,
                    }}
                >
                    ↻
                </button>
            </div>

            {/* Grid area — overflow:hidden lets the grid div inside be the sole scroll container */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {!sprints || !epics
                    ? <GridSkeleton />
                    : <PlanningGrid
                        epics={visibleEpics}
                        sprints={sprints}
                        selectedPriorities={selectedPriorities}
                        focusAreaField={focusAreaField}
                        focusAreaOptions={focusAreaOptions}
                        onFocusAreaChange={(epicKey, value, optionId) => {
                            setEpics(prev => prev.map(e =>
                                e.key === epicKey ? { ...e, focusArea: value, focusAreaId: optionId ?? null } : e
                            ));
                        }}
                        onEpicDone={(epicKey) => {
                            setEpics(prev => prev.filter(e => e.key !== epicKey));
                        }}
                    />
                }
            </div>
        </div>
    );
}

export default App;
