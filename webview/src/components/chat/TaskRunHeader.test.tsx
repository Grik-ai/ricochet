import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessage, CompletionMarkdownCard, ThinkingRow, summarizeWork } from './ChatMessage';
import { TaskRunHeader, formatTaskTokens } from './TaskRunHeader';
import type { TaskRunViewModel } from '../../hooks/useChat';

describe('TaskRunHeader', () => {
    it('renders task title, checklist progress, and compact context tokens', () => {
        const taskRun: TaskRunViewModel = {
            title: 'проанализируй проект',
            status: 'running',
            statusText: 'Reading project files',
            mode: 'execution',
            isActive: true,
            checklist: [
                { text: 'Analyze architecture', status: 'completed', source: 'todo' },
                { text: 'Review UI flow', status: 'completed', source: 'todo' },
                { text: 'Summarize findings', status: 'current', source: 'todo' },
            ],
            completedChecklistCount: 2,
            totalChecklistCount: 3,
            checklistSource: 'todo',
            tokenUsage: {
                used: 52_300,
                max: 1_000_000,
                percent: 5,
                inputTokens: 40_000,
                outputTokens: 12_300,
                totalTokens: 52_300,
                costUsd: 0.12,
                source: 'actual',
            },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('проанализируй проект');
        expect(html).toContain('2/3');
        expect(html).toContain('52.3k / 1.0m');
        expect(html).toContain('Task steps');
        expect(html).not.toContain('rounded-md border border-vscode-border bg-vscode-input-bg');
    });

    it('formats token counts without noisy precision', () => {
        expect(formatTaskTokens(999)).toBe('999');
        expect(formatTaskTokens(52_300)).toBe('52.3k');
        expect(formatTaskTokens(128_000)).toBe('128k');
        expect(formatTaskTokens(1_000_000)).toBe('1.0m');
    });

    it('does not render a task steps section without real checklist items', () => {
        const taskRun: TaskRunViewModel = {
            title: 'Project analysis',
            status: 'running',
            statusText: 'Reading project files',
            mode: 'planning',
            isActive: true,
            checklist: [],
            completedChecklistCount: 0,
            totalChecklistCount: 0,
            checklistSource: 'none',
            tokenUsage: {
                used: 0,
                max: 0,
                percent: 0,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                costUsd: 0,
            },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('Reading project files');
        expect(html).not.toContain('Task steps');
        expect(html).not.toContain('Read file');
    });

    it('renders provisional progress as a compact planning status without task steps', () => {
        const taskRun: TaskRunViewModel = {
            title: 'проанализируй проект',
            status: 'running',
            statusText: 'Planning project analysis...',
            mode: 'planning',
            isActive: true,
            checklist: [],
            completedChecklistCount: 0,
            totalChecklistCount: 0,
            checklistSource: 'provisional',
            tokenUsage: {
                used: 41_300,
                max: 128_000,
                percent: 32,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 41_300,
                costUsd: 0,
            },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('Planning project analysis...');
        expect(html).toContain('Planning');
        expect(html).not.toContain('>Plan<');
        expect(html).toContain('lucide-loader2');
        expect(html).not.toContain('0/3');
        expect(html).not.toContain('Understand project purpose');
        expect(html).not.toContain('Task steps');
        expect(html).not.toContain('rounded-md border border-vscode-border');
    });

    it('renders worker summary, failed worker reason, and action', () => {
        const taskRun: TaskRunViewModel = {
            title: 'запусти рой агентов',
            status: 'failed',
            statusText: 'Worker failed: Tests worker',
            mode: 'planning',
            isActive: false,
            checklist: [],
            completedChecklistCount: 0,
            totalChecklistCount: 0,
            checklistSource: 'hub',
            tokenUsage: {
                used: 0,
                max: 0,
                percent: 0,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                costUsd: 0,
            },
            workers: [
                { id: 'w1', name: 'Audit worker', status: 'running', isActive: true },
                { id: 'w2', name: 'Tests worker', status: 'failed', isActive: false },
                { id: 'w3', name: 'Docs worker', status: 'queued', isActive: false },
            ],
            workerSummary: '1 worker running · 1 queued · 1 failed',
            attentionReason: 'Worker failed: Tests worker',
            attentionAction: { kind: 'open_agent', label: 'Open Agent' },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('Planning');
        expect(html).toContain('1 worker running · 1 queued · 1 failed');
        expect(html).toContain('Worker failed: Tests worker');
        expect(html).toContain('Open Agent');
        expect(html).toContain('Tests worker');
        expect(html).toContain('Failed');
        expect(html).not.toContain('Needs attention');
    });

    it('renders completed provisional progress without fake checklist completion', () => {
        const taskRun: TaskRunViewModel = {
            title: 'проанализируй проект',
            status: 'completed',
            statusText: 'Task completed',
            mode: 'execution',
            isActive: false,
            checklist: [],
            completedChecklistCount: 0,
            totalChecklistCount: 0,
            checklistSource: 'provisional',
            tokenUsage: {
                used: 40_900,
                max: 128_000,
                percent: 32,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 40_900,
                costUsd: 0,
            },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('Completed');
        expect(html).toContain('Task completed');
        expect(html).not.toContain('5/5');
        expect(html).not.toContain('0/5');
        expect(html).not.toContain('All tasks completed');
        expect(html).not.toContain('Understand project purpose');
        expect(html).not.toContain('animate-pulse');
    });

    it('renders concrete edit approval status and file-derived steps', () => {
        const taskRun: TaskRunViewModel = {
            title: 'создай несколько тестовых файлов',
            status: 'waiting',
            statusText: '3 files waiting for approval',
            mode: 'execution',
            isActive: true,
            checklist: [
                { text: 'Create tests/math_tests.rs', status: 'current', source: 'edit' },
                { text: 'Create tests/signal_tests.rs', status: 'current', source: 'edit' },
                { text: 'Create tests/ingestion_tests.rs', status: 'current', source: 'edit' },
            ],
            completedChecklistCount: 0,
            totalChecklistCount: 3,
            checklistSource: 'edit',
            tokenUsage: {
                used: 17_000,
                max: 128_000,
                percent: 13,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 17_000,
                costUsd: 0,
            },
            attentionReason: '3 files waiting for approval',
            attentionAction: { kind: 'review_request', label: 'Review request' },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('3 files waiting for approval');
        expect(html).toContain('0/3');
        expect(html).toContain('Review request');
        expect(html).toContain('Create tests/math_tests.rs');
    });

    it('renders rejected edit approvals as discarded changes', () => {
        const taskRun: TaskRunViewModel = {
            title: 'создай тестовый файл',
            status: 'rejected',
            statusText: '1 change discarded',
            mode: 'execution',
            isActive: false,
            checklist: [
                { text: 'Create tests/math_tests.rs', status: 'completed', source: 'edit' },
            ],
            completedChecklistCount: 1,
            totalChecklistCount: 1,
            checklistSource: 'edit',
            tokenUsage: {
                used: 0,
                max: 0,
                percent: 0,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                costUsd: 0,
            },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('1 change discarded');
        expect(html).not.toContain('Needs attention');
        expect(html).not.toContain('All tasks completed');
    });
});

describe('CompletionMarkdownCard', () => {
    it('renders a neutral completed card with markdown and copy control', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <CompletionMarkdownCard content={'# Result\n\n- Done'} />
        );

        expect(html).toContain('Task completed');
        expect(html).not.toContain('Final markdown result');
        expect(html).toContain('Result');
        expect(html).toContain('codicon-copy');
        expect(html).toContain('border-vscode-border');
        expect(html).not.toContain('border-l-2');

        vi.unstubAllGlobals();
    });
});

describe('ThinkingRow', () => {
    it('renders completed reasoning as a subtle collapsed disclosure', () => {
        const html = renderToStaticMarkup(<ThinkingRow content="Now preparing final report." active={false} />);

        expect(html).toContain('Thinking');
        expect(html).not.toContain('Thinking...');
        expect(html).not.toContain('rounded-md border border-vscode-border/70 bg-vscode-input-bg/35');
        expect(html).toContain('data-open="false"');
    });

    it('renders active reasoning as an expanded streaming disclosure', () => {
        const html = renderToStaticMarkup(<ThinkingRow content="Reading files." active />);

        expect(html).toContain('Thinking...');
        expect(html).toContain('codicon-loading');
        expect(html).toContain('data-open="true"');
    });
});

describe('work summary labels', () => {
    it('summarizes grouped read and search activity in Ricochet voice', () => {
        expect(summarizeWork({
            turnId: 'run-1',
            status: 'completed',
            startedAt: 100,
            counts: {
                filesRead: 0,
                filesExplored: 13,
                foldersExplored: 2,
                searches: 2,
                commands: 1,
                edits: 0,
                workers: 0,
                approvals: 0,
            },
            items: [],
        })).toBe('Ricochet read 13 files, 2 folders, performed 2 searches, ran 1 command');
    });

    it('does not render ordinary workspace file artifacts as document rows', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <ChatMessage
                message={{
                    id: 'assistant-artifact',
                    role: 'assistant',
                    content: '',
                    timestamp: 100,
                    artifacts: [{
                        type: 'other',
                        title: 'Artifact',
                        path: 'tests/math_tests.rs',
                    }],
                }}
            />
        );

        expect(html).not.toContain('Artifacts');
        expect(html).not.toContain('Artifact</span>');

        vi.unstubAllGlobals();
    });

    it('renders multiline text fences as quiet output blocks without a bordered code card header', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <ChatMessage
                message={{
                    id: 'assistant-text-output',
                    role: 'assistant',
                    content: [
                        'Текущая структура тестов:',
                        '',
                        '```text',
                        'tests/',
                        '|-- config_ml_tests.rs',
                        '|-- execution_tests.rs',
                        '|-- ingestion_tests.rs',
                        '|-- integration.rs',
                        '|-- math_tests.rs',
                        '|-- signal_tests.rs',
                        '`-- unit.rs',
                        '```',
                    ].join('\n'),
                    timestamp: 100,
                }}
            />
        );

        expect(html).toContain('data-testid="plain-text-output-block"');
        expect(html).not.toContain('border-vscode-border/35');
        expect(html).not.toContain('>text</span>');

        vi.unstubAllGlobals();
    });

    it('renders failed edit work summaries instead of an empty activity fallback', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <ChatMessage
                message={{
                    id: 'assistant-failed-edit',
                    role: 'assistant',
                    content: '',
                    timestamp: 100,
                    run_id: 'run-failed-edit',
                }}
                workSummary={{
                    turnId: 'run-failed-edit',
                    status: 'failed',
                    startedAt: 100,
                    durationMs: 58000,
                    counts: {
                        filesRead: 0,
                        filesExplored: 0,
                        foldersExplored: 0,
                        searches: 0,
                        commands: 0,
                        edits: 1,
                        workers: 0,
                        approvals: 0,
                    },
                    items: [{
                        id: 'tool-write-test-script',
                        type: 'edit',
                        label: 'Edit failed',
                        target: 'test_script.rs',
                        path: '/Users/igoryan_dao/Polybot/test_script.rs',
                        status: 'failed',
                        error: 'permission denied: Mode Tester is restricted to test files',
                        timestamp: 120,
                    }],
                }}
            />
        );

        expect(html).toContain('Edit failed');
        expect(html).toContain('test_script.rs');
        expect(html).toContain('permission denied');
        expect(html).not.toContain('No detailed activity captured');

        vi.unstubAllGlobals();
    });

    it('uses an honest fallback when only hidden reasoning was captured', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <ChatMessage
                message={{
                    id: 'assistant-hidden-reasoning',
                    role: 'assistant',
                    content: '',
                    timestamp: 100,
                    run_id: 'run-hidden-reasoning',
                }}
                workSummary={{
                    turnId: 'run-hidden-reasoning',
                    status: 'running',
                    activityHint: 'hidden_reasoning',
                    startedAt: 100,
                    durationMs: 58000,
                    counts: {
                        filesRead: 0,
                        filesExplored: 0,
                        foldersExplored: 0,
                        searches: 0,
                        commands: 0,
                        edits: 0,
                        workers: 0,
                        approvals: 0,
                    },
                    items: [],
                }}
            />
        );

        expect(html).toContain('Only hidden reasoning was captured');
        expect(html).not.toContain('No detailed activity captured');

        vi.unstubAllGlobals();
    });

    it('renders implementation plan artifacts as a primary review card', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <ChatMessage
                message={{
                    id: 'assistant-plan-artifact',
                    role: 'assistant',
                    content: '{"content":"# Plan","summary":"Plan summary","title":"Implementation Plan","kind":"implementation_plan"}',
                    timestamp: 100,
                    toolCalls: [{
                        id: 'tool-submit-plan',
                        name: 'submit_plan',
                        arguments: { content: '# Plan', title: 'Implementation Plan' },
                        status: 'completed',
                    }],
                    artifacts: [{
                        type: 'implementation_plan',
                        title: 'Implementation Plan',
                        summary: 'Plan summary',
                        path: '.ricochet/artifacts/session/implementation_plan.md',
                        content: '# Plan',
                    }],
                }}
            />
        );

        expect(html).toContain('Implementation Plan');
        expect(html).toContain('Plan summary');
        expect(html).toContain('Review');
        expect(html).toContain('Proceed');
        expect(html).toContain('Revise');
        expect(html).not.toContain('{&quot;content&quot;');

        vi.unstubAllGlobals();
    });
});
