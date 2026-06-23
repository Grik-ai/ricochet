import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessage, CompletionMarkdownCard, ProcessEventBlock, ThinkingRow, summarizeWork } from './ChatMessage';
import { ActivityStrip, TaskRunHeader, buildActivityBars, buildTaskContextDisplay, clampActivityTooltipPlacement, focusReviewRequestTarget, formatTaskTokens, taskContextFillClass } from './TaskRunHeader';
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
        expect(html).toContain('Run context · 5%');
        expect(html).toContain('52.3k of 1.0m tokens');
        expect(html).toContain('Current run context window: 52.3k of 1.0m tokens');
        expect(html).toContain('aria-label="Run context: 5% used, 52.3k of 1.0m tokens"');
        expect(html).toContain('role="progressbar"');
        expect(html).not.toContain('52.3k / 1.0m');
        expect(html).not.toContain('bg-emerald-400/65');
        expect(html).toContain('Task steps');
        expect(html).not.toContain('rounded-md border border-vscode-border bg-vscode-input-bg');
    });

    it('uses context threshold colors instead of green completion color', () => {
        expect(taskContextFillClass(5)).toBe('bg-blue-400/60');
        expect(taskContextFillClass(70)).toBe('bg-amber-400/75');
        expect(taskContextFillClass(95)).toBe('bg-rose-400/75');

        const pending = buildTaskContextDisplay({
            used: 0,
            max: 0,
            percent: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
        }, true);

        expect(pending.label).toBe('Run context pending');
        expect(pending.percent).toBe(0);
    });

    it('hides unavailable run context for inactive runs without usage data', () => {
        const taskRun: TaskRunViewModel = {
            title: 'Project analysis',
            status: 'completed',
            statusText: 'Done',
            mode: 'execution',
            isActive: false,
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

        expect(html).not.toContain('No run context yet');
        expect(html).not.toContain('Run context unavailable');
        expect(html).not.toContain('role="progressbar"');
    });

    it('keeps active task steps compact by default', () => {
        const taskRun: TaskRunViewModel = {
            title: 'Project analysis',
            status: 'running',
            statusText: 'Reading project files',
            mode: 'execution',
            isActive: true,
            checklist: [
                { text: 'Current visible status', status: 'current', source: 'todo' },
                { text: 'Hidden pending detail', status: 'pending', source: 'todo' },
            ],
            completedChecklistCount: 0,
            totalChecklistCount: 2,
            checklistSource: 'todo',
            tokenUsage: {
                used: 8_600,
                max: 128_000,
                percent: 7,
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 8_600,
                costUsd: 0,
            },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('Task steps');
        expect(html).toContain('Project analysis');
        expect(html).not.toContain('Hidden pending detail');
    });

    it('formats token counts without noisy precision', () => {
        expect(formatTaskTokens(999)).toBe('999');
        expect(formatTaskTokens(52_300)).toBe('52.3k');
        expect(formatTaskTokens(128_000)).toBe('128k');
        expect(formatTaskTokens(1_000_000)).toBe('1.0m');
    });

    it('renders Activity only when work events exist', () => {
        const taskRun: TaskRunViewModel = {
            title: 'Project analysis',
            status: 'running',
            statusText: 'Reading project files',
            mode: 'execution',
            isActive: true,
            checklist: [],
            completedChecklistCount: 0,
            totalChecklistCount: 0,
            checklistSource: 'none',
            tokenUsage: {
                used: 52_300,
                max: 1_000_000,
                percent: 5,
                inputTokens: 40_000,
                outputTokens: 12_300,
                cachedInputTokens: 7_000,
                cacheCreationTokens: 2_000,
                reasoningOutputTokens: 900,
                totalTokens: 52_300,
                costUsd: 0.12,
            },
            workSummary: {
                turnId: 'turn-1',
                status: 'running',
                startedAt: 100,
                counts: {
                    filesRead: 1,
                    filesExplored: 0,
                    foldersExplored: 0,
                    searches: 0,
                    commands: 0,
                    edits: 0,
                    workers: 0,
                    approvals: 0,
                },
                items: [
                    { id: 'read-1', type: 'read', label: 'Read file', path: 'src/main.ts', status: 'completed', timestamp: 100 },
                ],
            },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);
        const emptyHtml = renderToStaticMarkup(
            <TaskRunHeader taskRun={{ ...taskRun, workSummary: { ...taskRun.workSummary!, items: [] } }} />,
        );

        expect(html).toContain('Activity');
        expect(emptyHtml).not.toContain('Activity');
    });

    it('renders Activity from aggregated activityItems when selected summary is empty', () => {
        const taskRun: TaskRunViewModel = {
            title: 'Project analysis',
            status: 'completed',
            statusText: 'Work summary ready',
            mode: 'execution',
            isActive: false,
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
            workSummary: {
                turnId: 'turn-empty',
                status: 'completed',
                startedAt: 300,
                completedAt: 310,
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
            },
            activityItems: [
                { id: 'read-1', type: 'read', label: 'Read file', path: 'src/main.ts', status: 'completed', timestamp: 100 },
                { id: 'command-1', type: 'command', label: 'Ran', command: 'python3 <script>', status: 'completed', timestamp: 120 },
            ],
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);
        const bars = buildActivityBars(taskRun.activityItems || []);

        expect(html).toContain('Activity');
        expect(bars.map(bar => `${bar.tone}:${bar.label}`)).toEqual(['read:Read file', 'command:Ran']);
    });

    it('classifies activity bars by event type and failure state', () => {
        const bars = buildActivityBars([
            { id: 'read', type: 'read', label: 'Read file', path: 'src/main.ts', status: 'completed', timestamp: 1 },
            { id: 'search', type: 'search', label: 'Search', target: 'useChat', status: 'completed', timestamp: 2 },
            { id: 'edit', type: 'edit', label: 'Edit file', path: 'src/main.ts', additions: 8, status: 'completed', timestamp: 3 },
            { id: 'command', type: 'command', label: 'Run command', command: 'npm test', status: 'completed', timestamp: 4 },
            { id: 'approval', type: 'approval', label: 'Approval', status: 'waiting', timestamp: 5 },
            { id: 'worker', type: 'worker', label: 'Worker', target: 'reviewer', status: 'running', timestamp: 6 },
            { id: 'failed', type: 'command', label: 'Run command', command: 'npm test', status: 'failed', exitCode: 1, timestamp: 7 },
        ]);

        expect(bars.map(bar => bar.tone)).toEqual(['read', 'search', 'edit', 'command', 'approval', 'worker', 'error']);
        expect(bars.every(bar => bar.height >= 8 && bar.height <= 26)).toBe(true);
        expect(bars.every(bar => bar.width === 10)).toBe(true);
        expect(bars.map(bar => bar.glyph)).toEqual(['file', 'search', 'edit', 'command', 'approval', 'worker', 'error']);
        expect(bars[5].active).toBe(true);
        expect(bars[0].title).toContain('Read file');
        expect(bars[0].title).toContain('duration');
        expect(bars[0].title).toContain('Path src/main.ts');
        expect(bars[0].title).not.toBe('Read file - src/main.ts');
    });

    it('does not treat stale waiting read events as approval or active bars', () => {
        const bars = buildActivityBars([
            { id: 'read-waiting', type: 'read', label: 'Read', path: 'src/ingestion/mod.rs', status: 'waiting', timestamp: 1 },
            { id: 'read-completed', type: 'read', label: 'Read', path: 'src/main.rs', status: 'completed', timestamp: 2 },
        ]);

        expect(bars[0].tone).toBe('read');
        expect(bars.some(bar => bar.active)).toBe(false);
        expect(bars[0].title).toContain('event size');
        expect(bars[0].title).not.toContain('tokens');
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
        expect(html).toContain('Analyzing');
        expect(html).not.toContain('Implementing');
        expect(html).not.toContain('>Plan<');
        expect(html).toContain('lucide-loader2');
        expect(html).not.toContain('0/3');
        expect(html).not.toContain('Understand project purpose');
        expect(html).not.toContain('Task steps');
        expect(html).not.toContain('rounded-md border border-vscode-border');
    });

    it('renders read-only project analysis as Analyzing', () => {
        const taskRun: TaskRunViewModel = {
            title: 'Project analysis',
            status: 'completed',
            statusText: 'Work summary ready',
            mode: 'execution',
            isActive: false,
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
            workSummary: {
                turnId: 'run-analysis',
                status: 'completed',
                startedAt: 100,
                completedAt: 200,
                counts: {
                    filesRead: 1,
                    filesExplored: 0,
                    foldersExplored: 0,
                    searches: 1,
                    commands: 0,
                    edits: 0,
                    workers: 0,
                    approvals: 0,
                },
                items: [
                    { id: 'read-1', type: 'read', label: 'Read file', path: 'README.md', status: 'completed', timestamp: 100 },
                    { id: 'search-1', type: 'search', label: 'Search', target: 'controller', status: 'completed', timestamp: 110 },
                ],
            },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('Analyzing');
        expect(html).not.toContain('Implementing');
    });

    it('renders activity bars as compact cells without inner icons or frame', () => {
        const html = renderToStaticMarkup(
            <ActivityStrip
                items={[
                    { id: 'read-1', type: 'read', label: 'Read file', path: 'src/main.ts', status: 'completed', timestamp: 100 },
                ]}
                tokenUsage={{
                    used: 10_000,
                    max: 128_000,
                    percent: 8,
                    inputTokens: 8_000,
                    outputTokens: 2_000,
                    totalTokens: 10_000,
                    costUsd: 0,
                }}
            />,
        );

        expect(html).not.toContain('title="Read file - src/main.ts"');
        expect(html).not.toContain('border border-vscode-border/70 bg-vscode-editor-background/55');
        expect(html).not.toContain('rounded-md border');
        expect(html).not.toContain('h-[28px]');
        expect(html).not.toContain('border-t border-vscode-border/55');
        expect(html).toContain('data-testid="task-activity-timeline"');
        expect(html).toContain('ricochet-activity-bar');
        expect(html).toContain('width:10px');
        expect(html).not.toContain('<svg');
        expect(html).not.toContain('lucide-file-text');
        expect(html).toContain('aria-label="read: Read file"');
    });

    it('clamps activity tooltips inside the webview viewport', () => {
        const leftEdge = clampActivityTooltipPlacement(
            { left: 0, right: 10, top: 100, bottom: 126, width: 10, height: 26 },
            { width: 220, height: 48 },
            { width: 320, height: 240 },
        );
        const rightEdge = clampActivityTooltipPlacement(
            { left: 310, right: 320, top: 100, bottom: 126, width: 10, height: 26 },
            { width: 220, height: 48 },
            { width: 320, height: 240 },
        );
        const topEdge = clampActivityTooltipPlacement(
            { left: 120, right: 132, top: 4, bottom: 30, width: 12, height: 26 },
            { width: 180, height: 48 },
            { width: 320, height: 240 },
        );

        expect(leftEdge.left).toBeGreaterThanOrEqual(8);
        expect(rightEdge.left + 220).toBeLessThanOrEqual(312);
        expect(topEdge.placement).toBe('below');
        expect(topEdge.top).toBeGreaterThan(30);
    });

    it('renders agent summary, failed agent reason, and action', () => {
        const taskRun: TaskRunViewModel = {
            title: 'запусти рой агентов',
            status: 'failed',
            statusText: 'Agent failed: Tests agent',
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
                { id: 'w1', name: 'Audit agent', status: 'running', isActive: true },
                { id: 'w2', name: 'Tests agent', status: 'failed', isActive: false },
                { id: 'w3', name: 'Docs agent', status: 'queued', isActive: false },
            ],
            workerSummary: '1 agent running · 1 queued · 1 failed',
            attentionReason: 'Agent failed: Tests agent',
            attentionAction: { kind: 'open_agent', label: 'Open Agent' },
        };

        const html = renderToStaticMarkup(<TaskRunHeader taskRun={taskRun} />);

        expect(html).toContain('Planning');
        expect(html).toContain('1 agent running · 1 queued · 1 failed');
        expect(html).toContain('Agent failed: Tests agent');
        expect(html).toContain('Open Agent');
        expect(html).toContain('Tests agent');
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

    it('focuses the shared pending approval target for review requests', () => {
        const target = {
            scrollIntoView: vi.fn(),
            focus: vi.fn(),
        };
        const doc = {
            querySelector: vi.fn(() => target),
        };

        expect(focusReviewRequestTarget(doc as any)).toBe(true);
        expect(doc.querySelector).toHaveBeenCalledWith(expect.stringContaining('data-ricochet-pending-approval'));
        expect(doc.querySelector).toHaveBeenCalledWith(expect.stringContaining('data-ricochet-pending-edit-review'));
        expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
        expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
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

describe('ProcessEventBlock', () => {
    it('renders command details as a muted block without borders or divider lines', () => {
        const html = renderToStaticMarkup(
            <ProcessEventBlock
                command="npm test"
                output="tests passed"
                status="completed"
                exitCode={0}
                durationMs={1200}
                cwd="/workspace/ricochet"
            />
        );

        expect(html).toContain('data-testid="ricochet-process-event"');
        expect(html).toContain('bash');
        expect(html).toContain('npm test');
        expect(html).toContain('Completed');
        expect(html).toContain('tests passed');
        expect(html).not.toContain('border ');
        expect(html).not.toContain('border-');
        expect(html).not.toContain('divide-');
        expect(html).not.toContain('border-l');
    });

    it('distinguishes running and failed command states without line accents', () => {
        const running = renderToStaticMarkup(
            <ProcessEventBlock command="npm run build" status="running" />
        );
        const failed = renderToStaticMarkup(
            <ProcessEventBlock command="npm run build" status="failed" exitCode={1} output="failed" />
        );

        expect(running).toContain('Running');
        expect(running).toContain('codicon-loading');
        expect(failed).toContain('Failed');
        expect(failed).toContain('exit 1');
        expect(`${running}${failed}`).not.toContain('border-l');
        expect(`${running}${failed}`).not.toContain('divide-');
    });

    it('renders pending command approval without pretending output is running', () => {
        const html = renderToStaticMarkup(
            <ProcessEventBlock
                command="python3 <script>"
                script="print('analysis')"
                shell="python"
                status="waiting"
            />
        );

        expect(html).toContain('Waiting for approval');
        expect(html).not.toContain('Waiting for output...');
    });

    it('keeps completed long command output collapsed in the shell card', () => {
        const html = renderToStaticMarkup(
            <ProcessEventBlock
                command="graph_status"
                output={JSON.stringify({ workspace_root: '/workspace', files_total: 150, definitions: 959 }, null, 2).repeat(6)}
                status="completed"
            />
        );

        expect(html).toContain('bash');
        expect(html).toContain('Command graph_status');
        expect(html).toContain('data-open="false"');
    });
});

describe('work summary labels', () => {
    it('renders user-owned live work summaries in the chat turn', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <ChatMessage
                message={{
                    id: 'u-live',
                    role: 'user',
                    content: 'проанализируй проект',
                    timestamp: 100,
                    run_id: 'run-live',
                    turn_id: 'run-live',
                }}
                workSummary={{
                    turnId: 'run-live',
                    status: 'running',
                    activityHint: 'hidden_reasoning',
                    startedAt: 100,
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

        expect(html).toContain('проанализируй проект');
        expect(html).toContain('Working');
        expect(html).toContain('Thinking...');
        expect(html).toContain('codicon-loading');
        expect(html).not.toContain('No visible agent activity captured');

        vi.unstubAllGlobals();
    });

    it('renders real read activity under the user turn while the run is active', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <ChatMessage
                message={{
                    id: 'u-read',
                    role: 'user',
                    content: 'проанализируй проект',
                    timestamp: 100,
                    run_id: 'run-read',
                    turn_id: 'run-read',
                }}
                workSummary={{
                    turnId: 'run-read',
                    status: 'running',
                    startedAt: 100,
                    counts: {
                        filesRead: 1,
                        filesExplored: 0,
                        foldersExplored: 0,
                        searches: 0,
                        commands: 0,
                        edits: 0,
                        workers: 0,
                        approvals: 0,
                    },
                    items: [{
                        id: 'read-cargo',
                        type: 'read',
                        label: 'Read',
                        target: 'Cargo.toml',
                        path: '/Users/igoryan_dao/Polybot/Cargo.toml',
                        status: 'completed',
                        timestamp: 120,
                    }],
                }}
            />
        );

        expect(html).toContain('Explored');
        expect(html).toContain('Analyzed');
        expect(html).toContain('Cargo.toml');
        expect(html).not.toContain('No visible agent activity captured');

        vi.unstubAllGlobals();
    });

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
        })).toBe('Ricochet explored 13 files, 2 folders, performed 2 searches, ran 1 command');
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
                        edits: 0,
                        workers: 0,
                        approvals: 0,
                    },
                    items: [{
                        id: 'tool-write-test-script',
                        type: 'review',
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
        expect(html).toContain('Review');
        expect(html).toContain('test_script.rs');
        expect(html).toContain('permission denied');
        expect(html).not.toContain('No detailed activity captured');
        expect(html).not.toContain('Thought');

        vi.unstubAllGlobals();
    });

    it('renders progress updates without exposing them as Thought', () => {
        vi.stubGlobal('window', { acquireVsCodeApi: undefined });

        const html = renderToStaticMarkup(
            <ChatMessage
                message={{
                    id: 'assistant-progress',
                    role: 'assistant',
                    content: '',
                    timestamp: 100,
                    run_id: 'run-progress',
                }}
                workSummary={{
                    turnId: 'run-progress',
                    status: 'running',
                    startedAt: 100,
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
                    items: [{
                        id: 'progress-1',
                        type: 'commentary',
                        label: 'Progress',
                        target: 'Running tests and checking project health',
                        status: 'running',
                        timestamp: 120,
                    }],
                }}
            />
        );

        expect(html).toContain('Progress');
        expect(html).toContain('Running tests and checking project health');
        expect(html).not.toContain('Thought');

        vi.unstubAllGlobals();
    });

    it('uses a live fallback when only hidden reasoning is currently streaming', () => {
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

        expect(html).toContain('Thinking...');
        expect(html).toContain('codicon-loading');
        expect(html).not.toContain('No detailed activity captured');

        vi.unstubAllGlobals();
    });

    it('renders implementation plan artifacts as a compact transcript record', () => {
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
        expect(html).toContain('data-ricochet-plan-transcript-card');
        expect(html).toContain('Plan created');
        expect(html).not.toContain('Review');
        expect(html).not.toContain('Proceed');
        expect(html).not.toContain('Revise');
        expect(html).not.toContain('{&quot;content&quot;');

        vi.unstubAllGlobals();
    });
});
