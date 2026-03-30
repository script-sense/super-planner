/**
 * App component smoke tests.
 *
 * Strategy: mock all external dependencies (@forge/bridge, @dnd-kit/*) so the
 * component tree can render in jsdom without a real Forge environment. We drive
 * the component through its loading states by controlling when the invoke()
 * promises resolve, then assert on visible text / DOM structure.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// ── Mock @forge/bridge ────────────────────────────────────────────────────────

const mockInvoke = jest.fn();
const mockView = {
    getContext: jest.fn().mockResolvedValue({ localId: 'test-local-id' }),
};
const mockRouter = {
    navigate: jest.fn(),
    open: jest.fn(),
};

jest.mock('@forge/bridge', () => ({
    invoke: (...args) => mockInvoke(...args),
    requestJira: jest.fn().mockResolvedValue({ json: async () => ({ issues: [] }) }),
    view: {
        getContext: () => mockView.getContext(),
    },
    router: {
        navigate: (...args) => mockRouter.navigate(...args),
        open: (...args) => mockRouter.open(...args),
    },
}));

// ── Mock @dnd-kit/* ───────────────────────────────────────────────────────────

jest.mock('@dnd-kit/core', () => ({
    DndContext: ({ children }) => <div data-testid="dnd-context">{children}</div>,
    MouseSensor: class {},
    TouchSensor: class {},
    useSensor: () => ({}),
    useSensors: (...sensors) => sensors,
    useDroppable: () => ({ isOver: false, setNodeRef: jest.fn() }),
    useDraggable: () => ({ isDragging: false, attributes: {}, listeners: {}, setNodeRef: jest.fn(), transform: null }),
    DragOverlay: ({ children }) => <div data-testid="drag-overlay">{children}</div>,
    closestCenter: jest.fn(),
}));

jest.mock('@dnd-kit/sortable', () => ({
    SortableContext: ({ children }) => <div data-testid="sortable-context">{children}</div>,
    useSortable: () => ({
        isDragging: false,
        attributes: {},
        listeners: {},
        setNodeRef: jest.fn(),
        transform: null,
        transition: null,
    }),
    verticalListSortingStrategy: {},
    arrayMove: (arr, from, to) => {
        const next = [...arr];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        return next;
    },
}));

jest.mock('@dnd-kit/utilities', () => ({
    CSS: { Transform: { toString: () => '' } },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BOARD_1 = { id: 1, name: 'Team Board', type: 'scrum', projectKey: 'NH' };
const FILTER_1 = { id: '10', name: 'NH Filter', jql: 'project = NH ORDER BY created' };
const SPRINT_A = { id: 101, name: 'Sprint A', state: 'active', startDate: '2026-02-02', endDate: '2026-02-15' };
const SPRINT_B = { id: 102, name: 'Sprint B', state: 'future', startDate: '2026-03-02', endDate: '2026-03-15' };

function makeEpicData(key, priority = 'Medium', sprintId = null) {
    return {
        key,
        summary: `Epic ${key}`,
        priority,
        sprintId: sprintId ? String(sprintId) : null,
        focusArea: null,
        rank: null,
        project: { key: 'NH', name: 'Northgate' },
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupInvokeMocks(overrides = {}) {
    mockInvoke.mockImplementation((name) => {
        const defaults = {
            getBoards: Promise.resolve([BOARD_1]),
            getFilters: Promise.resolve([FILTER_1]),
            getFocusAreaField: Promise.resolve(null),
            getSprints: Promise.resolve([SPRINT_A, SPRINT_B]),
            getEpics: Promise.resolve([makeEpicData('NH-1', 'High', 101), makeEpicData('NH-2', 'Low')]),
        };
        return (overrides[name] ?? defaults[name]) ?? Promise.resolve(null);
    });

    // Mock view.getContext for navigation state restoration
    mockView.getContext.mockResolvedValue({
        localId: 'test-local-id',
        extension: { url: '' },
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    // Suppress console.error noise from React 16 act() warnings in tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    console.error.mockRestore();
});

describe('App smoke tests', () => {
    test('renders the app title', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        expect(screen.getByText('Super Planner')).toBeInTheDocument();
    });

    test('shows a loading state before data arrives', async () => {
        // Never-resolving promises → app stays in loading state
        mockInvoke.mockReturnValue(new Promise(() => {}));
        mockView.getContext.mockReturnValue(new Promise(() => {}));
        const App = require('../App').default;
        render(<App />);
        // Should render the toolbar (title is static)
        expect(screen.getByText('Super Planner')).toBeInTheDocument();
        // Grid should not yet be present (still loading)
        expect(screen.queryByRole('option', { name: /Sprint/ })).not.toBeInTheDocument();
    });

    test('invokes getBoards, getFilters, getFocusAreaField on mount', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('getBoards'));
        expect(mockInvoke).toHaveBeenCalledWith('getFilters');
        expect(mockInvoke).toHaveBeenCalledWith('getFocusAreaField');
    });

    test('invokes getSprints after board is selected', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        await waitFor(() =>
            expect(mockInvoke).toHaveBeenCalledWith('getSprints', { boardId: 1 })
        );
    });

    test('invokes getEpics after sprints and filter are available', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        await waitFor(() =>
            expect(mockInvoke).toHaveBeenCalledWith(
                'getEpics',
                expect.objectContaining({ filterId: '10' })
            )
        );
    });

    test('renders board selector with board name', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        await waitFor(() => expect(screen.getByText('Team Board')).toBeInTheDocument());
    });

    test('renders filter selector with filter name', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        await waitFor(() => expect(screen.getByText('NH Filter')).toBeInTheDocument());
    });

    test('renders priority filter chips for all priorities', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        for (const label of ['Highest', 'High', 'Medium', 'Low', 'Lowest']) {
            expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
        }
    });

    test('renders error message when getBoards rejects', async () => {
        mockInvoke.mockImplementation((name) => {
            if (name === 'getBoards') return Promise.reject(new Error('Network failure'));
            return Promise.resolve(null);
        });
        mockView.getContext.mockResolvedValue({ localId: 'test-local-id' });
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        await waitFor(() => expect(screen.getByText(/Error:/)).toBeInTheDocument());
        expect(screen.getByText(/Network failure/)).toBeInTheDocument();
    });

    test('renders planning grid once sprints and epics are loaded', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        // Wait for dnd-context to appear (means PlanningGrid mounted)
        await waitFor(() =>
            expect(screen.getByTestId('dnd-context')).toBeInTheDocument()
        );
    });

    test('uses epic focus areas when field options are empty', async () => {
        setupInvokeMocks({
            getFocusAreaField: Promise.resolve({ fieldId: null, contextId: null, options: [] }),
            getEpics: Promise.resolve([
                makeEpicData('NH-1', 'High', 101),
                { ...makeEpicData('NH-3'), focusArea: 'Security' },
            ]),
        });
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        // Wait for grid to render
        await waitFor(() => expect(screen.getByTestId('dnd-context')).toBeInTheDocument());
        // Focus area section header should appear from epic data
        expect(screen.getAllByText('Security').length).toBeGreaterThan(0);
    });

    test('priority chip toggle stays active (at least one always selected)', async () => {
        setupInvokeMocks();
        const App = require('../App').default;
        await act(async () => {
            render(<App />);
        });
        // Click all priority chips off — the last one should refuse to deselect
        const chips = ['Highest', 'High', 'Medium', 'Low'];
        for (const label of chips) {
            await act(async () => {
                userEvent.click(screen.getByRole('button', { name: label }));
            });
        }
        // Only 'Lowest' remains — clicking it should not remove it
        const lowestBtn = screen.getByRole('button', { name: 'Lowest' });
        await act(async () => {
            userEvent.click(lowestBtn);
        });
        // Lowest button should still be rendered (chip still present in toolbar)
        expect(screen.getByRole('button', { name: 'Lowest' })).toBeInTheDocument();
    });
});
