import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_MISSION_DASHBOARD_TAB, buildMissionHubSections } from './AgentView';
import { SessionState, type SessionContext, type SessionUiState } from '../../services/state-machine/sessionStateMachine';
import { deriveMissionRuntime } from '../../utils/missionRuntime';
import { MissionWidget, missionWidgetButtonClass } from '../chat/MissionWidget';

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

        expect(sections.map(section => section.title)).toEqual(['Pending', 'Agents', 'Active tools', 'Recent activity']);
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
                    updatedAt: Date.now(),
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

    it('excludes stale running tools and uses chat logs as fallback activity', () => {
        const sections = buildMissionHubSections(makeContext({
            activeToolCalls: {
                'stale-tool': {
                    id: 'stale-tool',
                    name: 'read_file',
                    args: { path: 'README.md' },
                    status: 'running',
                    updatedAt: Date.now() - 10 * 60 * 1000,
                },
            },
            logs: [{
                id: 'answer-1',
                timestamp: 100,
                type: 'assistant_text',
                content: 'Project analysis completed.',
            }],
        }));

        expect(sections.find(section => section.id === 'tools')?.items).toEqual([]);
        expect(sections.find(section => section.id === 'activity')?.items[0]).toMatchObject({
            title: 'Project analysis completed.',
            status: 'Chat',
        });
    });
});

describe('Mission runtime status', () => {
    const activeUi: SessionUiState = { showSpinner: true, showCancelButton: true, isActive: true };
    const idleUi: SessionUiState = { showSpinner: false, showCancelButton: false, isActive: false };

    it('derives an idle Mission Dashboard entry without active work', () => {
        const runtime = deriveMissionRuntime(makeContext({
            missionStatus: 'idle',
            parentTurnStatus: 'idle',
            sawApiReqStarted: false,
            sawSessionCreated: false,
        }), SessionState.idle, idleUi);

        expect(runtime.pillLabel).toBe('Mission Dashboard');
        expect(runtime.detail).toBe('No active mission');
        expect(runtime.tone).toBe('idle');
        expect(runtime.hasActiveWork).toBe(false);
        expect(runtime.shouldShowPill).toBe(false);
        expect(runtime.canAbort).toBe(false);
    });

    it('does not show a Working mission pill for plain streaming without mission resources', () => {
        const runtime = deriveMissionRuntime(makeContext({
            missionStatus: 'running',
            parentTurnStatus: 'running',
            missionTitle: 'regular chat turn',
        }), SessionState.streaming, activeUi);

        expect(runtime.shouldShowPill).toBe(false);
        expect(runtime.pillLabel).not.toBe('Working');
    });

    it('renders approval and agent labels for real mission resources', () => {
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
        expect(workers.pillLabel).toBe('2 agents');
        expect(workers.canAbort).toBe(true);
    });

    it('shows parent completion while agents are still running', () => {
        const runtime = deriveMissionRuntime(makeContext({
            parentTurnStatus: 'completed',
            workers: {
                'agent-architecture': { id: 'agent-architecture', name: 'Architecture Mapper', status: 'completed', isActive: false },
                'agent-tests': { id: 'agent-tests', name: 'Test Runner', status: 'running', isActive: true },
                'agent-ui': { id: 'agent-ui', name: 'UI Reviewer', status: 'queued', isActive: true },
            },
        }), SessionState.streaming, activeUi);

        expect(runtime.displayStatus).toBe('Agents');
        expect(runtime.pillLabel).toBe('2 agents');
        expect(runtime.activeWorkerCount).toBe(2);
        expect(runtime.completedWorkerCount).toBe(1);
        expect(runtime.footerText).toBe('Parent turn complete · waiting for agents');
    });

    it('does not count stale or terminal active tools as running work', () => {
        const stale = deriveMissionRuntime(makeContext({
            activeToolCalls: {
                'old-tool': {
                    id: 'old-tool',
                    name: 'read_file',
                    args: { path: 'README.md' },
                    status: 'running',
                    updatedAt: Date.now() - 10 * 60 * 1000,
                },
            },
        }), SessionState.streaming, activeUi);
        expect(stale.activeToolCount).toBe(0);
        expect(stale.hasActiveWork).toBe(false);

        const completed = deriveMissionRuntime(makeContext({
            missionStatus: 'completed',
            parentTurnStatus: 'completed',
            activeToolCalls: {
                'old-tool': {
                    id: 'old-tool',
                    name: 'read_file',
                    args: { path: 'README.md' },
                    status: 'running',
                    updatedAt: Date.now(),
                },
            },
        }), SessionState.completed, idleUi);
        expect(completed.activeToolCount).toBe(0);
        expect(completed.pillLabel).toBe('Done');
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

    it('renders the Mission Dashboard button in idle when requested', () => {
        const agentState = {
            state: SessionState.idle,
            uiState: idleUi,
            context: makeContext({
                missionStatus: 'idle',
                parentTurnStatus: 'idle',
                sawApiReqStarted: false,
                sawSessionCreated: false,
            }),
            send: () => {},
        } as any;

        const html = renderToStaticMarkup(createElement(MissionWidget, {
            agentState,
            onOpenDashboard: () => {},
            inline: true,
            alwaysVisible: true,
        }));

        expect(html).toContain('Mission Dashboard');
        expect(html).toContain('Open Mission Dashboard');
        expect(html).not.toContain('animate-ping');
    });

    it('keeps pending edit review priority on the Mission Dashboard button', () => {
        const agentState = {
            state: SessionState.idle,
            uiState: idleUi,
            context: makeContext({
                missionStatus: 'idle',
                parentTurnStatus: 'idle',
                sawApiReqStarted: false,
                sawSessionCreated: false,
            }),
            send: () => {},
        } as any;

        const html = renderToStaticMarkup(createElement(MissionWidget, {
            agentState,
            onOpenDashboard: () => {},
            inline: true,
            pendingEditCount: 2,
            alwaysVisible: true,
        }));

        expect(html).toContain('Review');
        expect(html).toContain('2 pending edits');
    });

    it('does not render the Mission widget with a pulsing indicator', () => {
        const agentState = {
            state: SessionState.streaming,
            uiState: activeUi,
            context: makeContext({
                activeToolCalls: {
                    'tool-live': {
                        id: 'tool-live',
                        name: 'read_file',
                        args: { path: 'README.md' },
                        status: 'running',
                        updatedAt: Date.now(),
                    },
                },
            }),
            send: () => {},
        } as any;

        const html = renderToStaticMarkup(createElement(MissionWidget, {
            agentState,
            onOpenDashboard: () => {},
            inline: true,
        }));

        expect(html).toContain('Tool running');
        expect(html).not.toContain('animate-ping');
    });
});
