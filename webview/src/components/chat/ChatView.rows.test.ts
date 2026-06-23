import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildChatRows } from './ChatView';
import type { ChatMessage, QueuedTurnState, WorkSummary } from '../../hooks/useChat';

function message(id: string, role: ChatMessage['role'], runId: string, timestamp: number): ChatMessage {
    return {
        id,
        role,
        content: role === 'user' ? id : '',
        timestamp,
        run_id: runId,
        turn_id: runId,
    };
}

function summary(turnId: string, status: WorkSummary['status'], itemCount = 0): WorkSummary {
    return {
        turnId,
        status,
        startedAt: 100,
        completedAt: status === 'completed' ? 200 : undefined,
        durationMs: status === 'completed' ? 100 : undefined,
        counts: {
            filesRead: itemCount,
            filesExplored: 0,
            foldersExplored: 0,
            searches: 0,
            commands: 0,
            edits: 0,
            workers: 0,
            approvals: 0,
        },
        items: Array.from({ length: itemCount }, (_, index) => ({
            id: `item-${index}`,
            type: 'read' as const,
            label: 'Read',
            target: `file-${index}.ts`,
            status: 'completed' as const,
            timestamp: 100 + index,
        })),
    };
}

describe('buildChatRows', () => {
    it('attaches work summary to the matching user turn when no assistant message exists yet', () => {
        const rows = buildChatRows(
            [message('u1', 'user', 'run-1', 1)],
            { 'run-1': summary('run-1', 'running', 1) }
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].message.id).toBe('u1');
        expect(rows[0].workSummary?.turnId).toBe('run-1');
    });

    it('suppresses completed empty orphan summaries', () => {
        const rows = buildChatRows([], { 'run-empty': summary('run-empty', 'completed', 0) });

        expect(rows).toEqual([]);
    });

    it('attaches an active orphan summary to the latest user turn instead of creating a detached row', () => {
        const rows = buildChatRows(
            [message('u1', 'user', 'run-user', 1)],
            { 'run-active-from-core': summary('run-active-from-core', 'running', 1) }
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].message.id).toBe('u1');
        expect(rows[0].workSummary?.turnId).toBe('run-active-from-core');
        expect(rows.some(row => row.message.id.startsWith('work-summary-'))).toBe(false);
    });

    it('attaches a completed orphan summary to the nearest user turn when possible', () => {
        const rows = buildChatRows(
            [message('u1', 'user', 'run-user', 1)],
            { 'run-completed-from-core': summary('run-completed-from-core', 'completed', 2) }
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].message.id).toBe('u1');
        expect(rows[0].workSummary?.turnId).toBe('run-completed-from-core');
        expect(rows.some(row => row.message.id.startsWith('work-summary-'))).toBe(false);
    });

    it('keeps an empty running summary visible on the user turn for hidden reasoning', () => {
        const rows = buildChatRows(
            [message('u1', 'user', 'run-user', 1)],
            { 'run-user': summary('run-user', 'running', 0) }
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].workSummary?.status).toBe('running');
        expect(rows[0].workSummary?.items).toEqual([]);
    });

    it('keeps queued follow-up messages as chronological user rows', () => {
        const queued: Record<string, QueuedTurnState> = {
            'run-q1': { runId: 'run-q1', status: 'queued', text: 'прервалось', timestamp: 20 },
            'run-q2': { runId: 'run-q2', status: 'queued', text: 'повтори задачу', timestamp: 30 },
        };

        const rows = buildChatRows(
            [
                message('u-original', 'user', 'run-original', 10),
                message('u-q1', 'user', 'run-q1', 20),
                message('u-q2', 'user', 'run-q2', 30),
            ],
            { 'run-original': summary('run-original', 'completed', 2) },
            queued
        );

        expect(rows.map(row => row.message.id)).toEqual(['u-original', 'u-q1', 'u-q2']);
        expect(rows[0].workSummary?.turnId).toBe('run-original');
        expect(rows[1].queuedTurn?.runId).toBe('run-q1');
        expect(rows[2].queuedTurn?.runId).toBe('run-q2');
        expect(rows.some(row => row.message.id.startsWith('work-summary-'))).toBe(false);
    });

    it('keeps completed work summaries inspectable when the matching final assistant answer is visible', () => {
        const rows = buildChatRows(
            [
                message('u1', 'user', 'run-1', 1),
                {
                    ...message('a1', 'assistant', 'run-1', 2),
                    content: 'Final project analysis answer',
                    isStreaming: false,
                },
            ],
            { 'run-1': summary('run-1', 'completed', 2) }
        );

        expect(rows).toHaveLength(2);
        expect(rows[0].message.id).toBe('u1');
        expect(rows[0].workSummary?.turnId).toBe('run-1');
        expect(rows[0].workSummary?.status).toBe('completed');
        expect(rows[1].message.id).toBe('a1');
        expect(rows[1].workSummary).toBeUndefined();
    });

    it('keeps run chronology as user work summary, intermediate draft, then final answer', () => {
        const rows = buildChatRows(
            [
                message('u1', 'user', 'run-1', 1),
                {
                    ...message('draft', 'assistant', 'run-1', 2),
                    content: '# Draft analysis',
                    isStreaming: false,
                    metadata: { tokensIn: 0, tokensOut: 0, totalCost: 0, contextLimit: 0, runPhase: 'intermediate' },
                    toolCalls: [{ id: 'tool-1', name: 'task_boundary', arguments: {}, status: 'completed' }],
                },
                {
                    ...message('final', 'assistant', 'run-1', 3),
                    content: '# Final analysis',
                    isStreaming: false,
                    metadata: { tokensIn: 0, tokensOut: 0, totalCost: 0, contextLimit: 0, runPhase: 'final' },
                },
            ],
            { 'run-1': summary('run-1', 'completed', 2) }
        );

        expect(rows.map(row => row.message.id)).toEqual(['u1', 'draft', 'final']);
        expect(rows[0].workSummary?.turnId).toBe('run-1');
        expect(rows[1].workSummary).toBeUndefined();
        expect(rows[2].workSummary).toBeUndefined();
    });

    it('keeps completed empty summaries hidden even when a final assistant answer is visible', () => {
        const rows = buildChatRows(
            [
                message('u1', 'user', 'run-1', 1),
                {
                    ...message('a1', 'assistant', 'run-1', 2),
                    content: 'Final project analysis answer',
                    isStreaming: false,
                },
            ],
            { 'run-1': summary('run-1', 'completed', 0) }
        );

        expect(rows).toHaveLength(2);
        expect(rows[0].workSummary).toBeUndefined();
        expect(rows[1].workSummary).toBeUndefined();
    });

    it('keeps failed work summaries visible even if the assistant has text', () => {
        const rows = buildChatRows(
            [
                message('u1', 'user', 'run-1', 1),
                {
                    ...message('a1', 'assistant', 'run-1', 2),
                    content: 'The task failed before completion.',
                    isStreaming: false,
                    errorInfo: {
                        kind: 'unknown',
                        title: 'Task failed',
                        message: 'Task failed before completion.',
                        retryable: false,
                        timestamp: 2,
                    },
                },
            ],
            { 'run-1': summary('run-1', 'failed', 1) }
        );

        expect(rows[0].workSummary?.status).toBe('failed');
    });

    it('suppresses duplicate orphan approval-only summaries when the run summary already owns the approval', () => {
        const approvalItem = {
            id: 'approval-choice-1',
            type: 'approval' as const,
            label: 'Waiting for approval',
            target: 'The agent wants to execute the following tools',
            status: 'waiting' as const,
            timestamp: 120,
        };
        const runSummary: WorkSummary = {
            ...summary('run-1', 'waiting', 1),
            counts: {
                filesRead: 1,
                filesExplored: 0,
                foldersExplored: 0,
                searches: 0,
                commands: 1,
                edits: 0,
                workers: 0,
                approvals: 1,
            },
            items: [
                {
                    id: 'read-1',
                    type: 'read',
                    label: 'Read',
                    target: 'README.md',
                    status: 'completed',
                    timestamp: 100,
                },
                approvalItem,
            ],
        };
        const orphanApproval: WorkSummary = {
            ...summary('turn-choice-1', 'waiting', 0),
            counts: {
                filesRead: 0,
                filesExplored: 0,
                foldersExplored: 0,
                searches: 0,
                commands: 0,
                edits: 0,
                workers: 0,
                approvals: 1,
            },
            items: [approvalItem],
        };

        const rows = buildChatRows(
            [message('u1', 'user', 'run-1', 1)],
            { 'run-1': runSummary, 'turn-choice-1': orphanApproval }
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].workSummary?.turnId).toBe('run-1');
        expect(rows.some(row => row.message.id.startsWith('work-summary-turn-choice'))).toBe(false);
    });
});

describe('ChatView animation hooks', () => {
    it('always wires the Mission Dashboard widget into the chat input status strip', () => {
        const source = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');

        expect(source).toContain('missionStatus={(');
        expect(source).toContain('alwaysVisible');
        expect(source).not.toContain('shouldShowMissionWidget');
    });

    it('uses Ricochet-owned animation classes instead of missing animate-in utilities in the chat shell', () => {
        const source = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');

        expect(source).toContain('ricochet-message-enter');
        expect(source).toContain('ricochet-composer-dock-enter');
        expect(source).not.toContain('animate-in');
        expect(source).not.toContain('slide-in-from');
    });
});
