import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION_DASHBOARD_TAB, buildMissionHubSections } from './AgentView';
import { SessionState, type SessionContext, type SessionUiState } from '../../services/state-machine/sessionStateMachine';
import { deriveMissionRuntime } from '../../utils/missionRuntime';
import { missionWidgetButtonClass } from '../chat/MissionWidget';

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
    return {
        sessionId: 'test-session',
        missionStatus: 'running',
        parentTurnStatus: 'running',
        sawApiReqStarted: true,
        sawSessionCreated: true,
        logs: [],
        workers: {},
        activeToolCalls: {},
        ...overrides,
    };
}

describe('AgentView mission hub', () => {
    it('opens mission dashboard on the task board tab by default', () => {
        expect(DEFAULT_MISSION_DASHBOARD_TAB).toBe('tasks');
    });

    it('returns empty hub sections when no mission resources exist', () => {
        const sections = buildMissionHubSections(makeContext());

        expect(sections.map(section => section.title)).toEqual(['Pending', 'Workers', 'Active tools', 'Recent activity']);
        expect(sections.every(section => section.items.length === 0)).toBe(true);
    });

    it('renders worker and active tool resources instead of an empty hub', () => {
        const sections = buildMissionHubSections(makeContext({
            workers: {
                'agent-a': {
                    id: 'agent-a',
                    name: 'Project auditor',
                    status: 'running',
                    isActive: true,
                    progress: 'Scanning architecture docs',
                },
            },
            activeToolCalls: {
                'tool-1': {
                    id: 'tool-1',
                    name: 'list_dir',
                    args: { path: '/Users/igoryan_dao/Polybot/src' },
                    status: 'running',
                    updatedAt: 100,
                },
            },
        }));

        expect(sections.find(section => section.id === 'workers')?.items[0]).toMatchObject({
            title: 'Project auditor',
            status: 'Running',
        });
        expect(sections.find(section => section.id === 'tools')?.items[0]).toMatchObject({
            title: 'Explore folder',
            subtitle: '/Users/igoryan_dao/Polybot/src',
            status: 'Running',
        });
    });

    it('uses recent mission activity as hub content when no workers are spawned', () => {
        const sections = buildMissionHubSections(makeContext({
            logs: [{
                id: 'read-1',
                timestamp: 100,
                type: 'tool_started',
                content: 'Reading /Users/igoryan_dao/Polybot/README.md',
                metadata: { name: 'read_file', args: { path: '/Users/igoryan_dao/Polybot/README.md' } },
            }],
        }));

        expect(sections.find(section => section.id === 'activity')?.items[0]).toMatchObject({
            title: 'Read file',
            subtitle: '/Users/igoryan_dao/Polybot/README.md',
            status: 'Tool',
        });
    });
});

describe('Mission runtime status', () => {
    const activeUi: SessionUiState = { showSpinner: true, showCancelButton: true, isActive: true };
    const idleUi: SessionUiState = { showSpinner: false, showCancelButton: false, isActive: false };

    it('does not show a Working mission pill for plain streaming without mission resources', () => {
        const runtime = deriveMissionRuntime(makeContext({
            missionStatus: 'running',
            parentTurnStatus: 'running',
            missionTitle: 'regular chat turn',
        }), SessionState.streaming, activeUi);

        expect(runtime.shouldShowPill).toBe(false);
        expect(runtime.pillLabel).not.toBe('Working');
    });

    it('renders approval and worker labels for real mission resources', () => {
        const approval = deriveMissionRuntime(makeContext({
            pendingChoice: { id: 'choice-1', question: 'Approve?', choices: ['yes', 'no'] },
        }), SessionState.waiting_input, activeUi);
        expect(approval.shouldShowPill).toBe(true);
        expect(approval.pillLabel).toBe('Approval');

        const workers = deriveMissionRuntime(makeContext({
            workers: {
                'agent-a': { id: 'agent-a', name: 'Audit', status: 'running', isActive: true },
                'agent-b': { id: 'agent-b', name: 'Verify', status: 'queued', isActive: false },
            },
        }), SessionState.streaming, activeUi);
        expect(workers.pillLabel).toBe('2 workers');
        expect(workers.canAbort).toBe(true);
    });

    it('treats parent-only completion as complete, not running or abortable', () => {
        const runtime = deriveMissionRuntime(makeContext({
            missionStatus: 'running',
            parentTurnStatus: 'completed',
            workers: {},
            activeToolCalls: {},
        }), SessionState.streaming, activeUi);

        expect(runtime.isParentOnlyComplete).toBe(true);
        expect(runtime.displayStatus).toBe('Ready');
        expect(runtime.detail).toBe('Parent turn complete');
        expect(runtime.canAbort).toBe(false);
    });

    it('keeps worker completion visible as Done and keeps the mission button borderless', () => {
        const runtime = deriveMissionRuntime(makeContext({
            missionStatus: 'completed',
            parentTurnStatus: 'completed',
            logs: [{
                id: 'done',
                timestamp: 1,
                type: 'mission_completed',
                content: 'Done',
            }],
        }), SessionState.completed, idleUi);

        expect(runtime.shouldShowPill).toBe(true);
        expect(runtime.pillLabel).toBe('Done');
        expect(missionWidgetButtonClass.split(/\s+/)).not.toContain('border');
    });
});
