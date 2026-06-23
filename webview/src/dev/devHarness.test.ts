import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandEventToWorkEvent, parseProgressStatus, toolLifecycleEventToWorkEvent, type TaskProgress, type WorkEvent, type WorkEventType } from '../hooks/useChat';
import { createAllTimelineFixtureTimeline, createEtherFixtureTimeline, createSwarmFixtureTimeline } from './devHarness';

function normalizedWorkEvents(): WorkEvent[] {
    return createAllTimelineFixtureTimeline('run-test', 'session-test', 1_000)
        .flatMap(([, message]) => {
            if (message.type === 'command_event') {
                return [commandEventToWorkEvent(message.payload)];
            }
            if (message.type === 'tool_lifecycle') {
                return [toolLifecycleEventToWorkEvent(message.payload)];
            }
            if (message.type === 'task_progress') {
                return [parseProgressStatus(message.payload as TaskProgress)];
            }
            if (message.type === 'pending_edits') {
                return (message.payload.edits || []).map((edit: any) => ({
                    id: `pending-edit-${edit.proposalId || edit.relativePath || edit.filePath}`,
                    type: /failed/i.test(`${edit.status || ''} ${edit.state || ''}`) ? 'review' : 'edit',
                    label: /failed/i.test(`${edit.status || ''} ${edit.state || ''}`) ? 'Edit failed' : 'Edited',
                    target: edit.relativePath || edit.filePath || edit.displayName,
                    path: edit.relativePath || edit.filePath,
                    status: /failed/i.test(`${edit.status || ''} ${edit.state || ''}`) ? 'failed' : 'completed',
                    error: edit.error,
                    timestamp: 1_000,
                }));
            }
            if (message.type === 'request_permission') {
                return [{
                    id: `approval-${message.payload.id}`,
                    type: 'approval' as const,
                    label: 'Waiting for approval',
                    target: message.payload.question,
                    status: 'waiting' as const,
                    timestamp: 1_000,
                }];
            }
            if (message.type === 'checkpoint_event' || message.type === 'context_compaction') {
                return [{
                    id: `${message.type}-${message.payload.run_id}`,
                    type: 'artifact' as const,
                    label: message.type === 'checkpoint_event' ? 'Checkpoint' : 'Context compacted',
                    target: message.payload.message || message.payload.summary,
                    status: 'completed' as const,
                    timestamp: message.payload.timestamp || 1_000,
                }];
            }
            return [];
        })
        .filter(Boolean) as WorkEvent[];
}

describe('dev chat harness fixtures', () => {
    it('covers every user-visible timeline event family in the all-events fixture', () => {
        const messages = createAllTimelineFixtureTimeline('run-test', 'session-test', 1_000).map(([, message]) => message);
        const messageTypes = new Set(messages.map(message => message.type));

        expect([...messageTypes]).toEqual(expect.arrayContaining([
            'chat_update',
            'task_progress',
            'tool_lifecycle',
            'command_event',
            'pending_edits',
            'request_permission',
            'permission_response_received',
            'tasks_updated',
            'file_search_results',
            'checkpoint_event',
            'context_compaction',
            'ask_completion_result',
            'context_status',
        ]));

        const workTypes = new Set(normalizedWorkEvents().map(event => event.type));
        const expectedTypes: WorkEventType[] = [
            'commentary',
            'task',
            'read',
            'search',
            'command',
            'edit',
            'review',
            'worker',
            'approval',
            'artifact',
            'error',
        ];
        expect([...workTypes]).toEqual(expect.arrayContaining(expectedTypes));
    });

    it('keeps Polybot command, search, read, edit, and review coverage in the fixture', () => {
        const events = normalizedWorkEvents();
        const commands = events
            .filter(event => event.type === 'command')
            .map(event => event.command);

        expect(commands).toEqual(expect.arrayContaining([
            'cargo check',
            'cargo test',
            'brew install xgboost',
        ]));
        expect(events.some(event => event.type === 'search' && /error handling/i.test(event.target || ''))).toBe(true);
        expect(events.some(event => event.type === 'read' && event.path === 'Polybot/src/main.rs')).toBe(true);
        expect(events.filter(event => event.type === 'read').map(event => event.lineRange)).toEqual(expect.arrayContaining(['L1-L150', 'L151-L297']));
        expect(events.some(event => event.type === 'edit' && event.path === 'Polybot/src/main.rs')).toBe(true);
        expect(events.some(event => event.type === 'review' && /verification rejected/i.test(event.error || ''))).toBe(true);
        expect(events.some(event => event.type === 'task' && /Fix rejected error handling edit/.test(event.target || ''))).toBe(true);
    });

    it('does not expose raw system leftovers through the all-events fixture normalization', () => {
        const visibleText = normalizedWorkEvents()
            .flatMap(event => [event.label, event.target, event.command, event.error])
            .filter(Boolean)
            .join('\n');

        expect(visibleText).not.toContain('Planning task');
        expect(visibleText).not.toContain('Running task');
        expect(visibleText).not.toContain('{"mode":"code"}');
        expect(visibleText).not.toContain('{hash');
        expect(visibleText).not.toContain('task_boundary');
    });

    it('covers swarm worker lifecycle events without relying on raw status text', () => {
        const messages = createSwarmFixtureTimeline('run-swarm-test', 'session-test', 1_000).map(([, message]) => message);
        const progressEvents = messages
            .filter(message => message.type === 'task_progress')
            .map(message => message.payload as TaskProgress);

        expect(messages.map(message => message.type)).toEqual(expect.arrayContaining([
            'session_created',
            'api_req_started',
            'chat_update',
            'tool_lifecycle',
            'command_event',
            'task_progress',
            'usage_update',
            'ask_completion_result',
        ]));

        expect(progressEvents.map(event => event.agent_identifier).filter(Boolean)).toEqual(expect.arrayContaining([
            'agent-architecture',
            'agent-tests',
            'agent-ui',
        ]));
        expect(progressEvents.map(event => event.event)).toEqual(expect.arrayContaining([
            'worker_spawned',
            'worker_running',
            'worker_completed',
        ]));

        const workerEvents = progressEvents
            .map(event => parseProgressStatus(event))
            .filter((event): event is WorkEvent => Boolean(event && event.type === 'worker'));

        expect(workerEvents.map(event => event.label)).toEqual(expect.arrayContaining([
            'Queued agent',
            'Running agent',
            'Completed agent',
        ]));
        expect(workerEvents.some(event => /Architecture Mapper/.test(event.target || ''))).toBe(true);

        const launchEvents = messages
            .filter(message => message.type === 'tool_lifecycle')
            .map(message => toolLifecycleEventToWorkEvent(message.payload))
            .filter((event): event is WorkEvent => Boolean(event && /agents/i.test(event.label)));
        expect(launchEvents.some(event => event.type === 'commentary' && event.label === 'Launched 3 agents')).toBe(true);
        expect(workerEvents.some(event => /start_swarm/i.test(`${event.label} ${event.target}`))).toBe(false);

        const visibleText = workerEvents
            .flatMap(event => [event.label, event.target, event.error])
            .filter(Boolean)
            .join('\n');
        expect(visibleText).not.toContain('Planning task');
        expect(visibleText).not.toContain('Running task');
        expect(visibleText).not.toContain('task_boundary');
        expect(visibleText).not.toContain('{"mode":"code"}');
    });

    it('covers Ether remote message flow with real webview event types', () => {
        const messages = createEtherFixtureTimeline('run-ether-test', 'session-test', 1_000).map(([, message]) => message);
        const messageTypes = messages.map(message => message.type);

        expect(messageTypes).toEqual(expect.arrayContaining([
            'live_mode_status',
            'ether_activity',
            'chat_update',
            'task_progress',
            'tool_lifecycle',
            'command_event',
            'ask_completion_result',
        ]));

        const liveStatus = messages.find(message => message.type === 'live_mode_status')?.payload;
        expect(liveStatus).toMatchObject({
            enabled: true,
            connectedVia: 'telegram+discord',
            channels: {
                telegram: { configured: true, active: true },
                discord: { configured: true, active: true },
            },
        });

        const activity = messages
            .filter(message => message.type === 'ether_activity')
            .map(message => message.payload);
        expect(activity.map(event => `${event.source}:${event.stage}`)).toEqual([
            'telegram:receiving',
            'telegram:processing',
            'discord:receiving',
            'discord:processing',
            'discord:responding',
        ]);

        const remoteUserMessages = messages
            .filter(message => message.type === 'chat_update')
            .map(message => message.payload.message)
            .filter(message => message.role === 'user');
        expect(remoteUserMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({ via: 'telegram', remoteUsername: 'Igor' }),
            expect.objectContaining({ via: 'discord', remoteUsername: 'Mila' }),
        ]));

        const finalMessage = messages
            .filter(message => message.type === 'chat_update')
            .map(message => message.payload.message)
            .find(message => message.role === 'assistant' && message.metadata?.runPhase === 'final');
        expect(finalMessage?.content).toContain('Ether fixture complete');
        expect(finalMessage?.content).toContain('Telegram and Discord');
    });

    it('wires the Ether messages dev button to the Ether fixture player', () => {
        const source = readFileSync(new URL('./devHarness.ts', import.meta.url), 'utf8');

        expect(source).toContain('data-action="ether">Ether messages');
        expect(source).toContain("if (action === 'ether')");
        expect(source).toContain('playEtherMessageFixture(`run-ether-${Date.now()}`, SESSION_ID)');
    });
});
