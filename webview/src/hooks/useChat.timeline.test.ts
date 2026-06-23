import { describe, expect, it } from 'vitest';
import {
    activityToWorkEvent,
    aggregateTaskActivityItems,
    applyPlanDecisionResult,
    buildTaskRunViewModel,
    buildTaskTokenUsage,
    classifyTool,
    completeActiveWorkSummaries,
    completeRuntimeWorkSummaries,
    completeWorkSummaryForTurn,
    closeEditRows,
    commandEventToWorkEvent,
    hasMatchingPlanArtifact,
    hasPlanArtifact,
    isIntermediateAssistantDraft,
    markWorkSummaryActivityHint,
    normalizeHubTasksPayload,
    normalizeWorkCommentaryText,
    promoteCompletedIntermediateDrafts,
    promoteLatestIntermediateDraft,
    isWorkCommentaryText,
    parseProgressStatus,
    rebuildWorkSummariesFromMessages,
    resolveRuntimeTurnIdForEvent,
    shouldCreateWorkCommentary,
    shouldKeepAssistantBubble,
    toolLifecycleEventToWorkEvent,
    upsertAssistantMessage,
    upsertWorkEvents,
    withInferredRunPhase,
    type ActivityItem,
    type ChatMessage,
    type TaskProgress,
    type ToolCall,
    type WorkEvent,
} from './useChat';
import { chatErrorInfoFromRaw, findRetryPromptBefore, sanitizeNetworkStatusPayload } from '../utils/chatErrors';
import { isRenderableChatMessage } from '../utils/chatVisibility';

describe('chat timeline normalization', () => {
    it('builds a task run view model from progress todos and usage', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'проанализируй проект', timestamp: 100 }],
            todos: [{ text: 'stale todo', status: 'pending' }],
            taskProgress: {
                task_name: 'Agent activity',
                status: 'Review UI flow',
                mode: 'execution',
                is_active: true,
                todos: [
                    { text: 'Analyze architecture', status: 'completed' },
                    { text: 'Review UI flow', status: 'current' },
                ],
                timestamp: 200,
            },
            workSummariesByTurn: {},
            usageSnapshot: {
                inputTokens: 40_000,
                outputTokens: 12_300,
                cachedInputTokens: 7_000,
                cacheCreationTokens: 2_000,
                reasoningOutputTokens: 900,
                contextTokens: 52_300,
                contextWindow: 1_000_000,
                estimatedCostUsd: 0.12,
                requestCount: 1,
                actualCount: 1,
                estimatedCount: 0,
                source: 'actual',
            },
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun).toMatchObject({
            title: 'Project analysis',
            status: 'running',
            completedChecklistCount: 1,
            totalChecklistCount: 2,
            tokenUsage: {
                used: 52_300,
                max: 1_000_000,
                percent: 5,
                cachedInputTokens: 7_000,
                cacheCreationTokens: 2_000,
                reasoningOutputTokens: 900,
            },
        });
        expect(taskRun?.checklist.map(item => item.text)).toEqual(['Analyze architecture', 'Review UI flow']);
    });

    it('falls back to context status for task token usage', () => {
        expect(buildTaskTokenUsage(null, null, {
            tokens_used: 64_000,
            tokens_max: 128_000,
            percentage: 50,
        }).percent).toBe(50);
    });

    it('carries cache read, cache write, and reasoning token usage', () => {
        expect(buildTaskTokenUsage(null, {
            inputTokens: 40_000,
            outputTokens: 12_300,
            cachedInputTokens: 7_000,
            cacheCreationTokens: 2_000,
            reasoningOutputTokens: 900,
            contextTokens: 52_300,
            contextWindow: 1_000_000,
            estimatedCostUsd: 0.12,
            requestCount: 1,
            actualCount: 1,
            estimatedCount: 0,
            source: 'actual',
        }, null)).toMatchObject({
            used: 52_300,
            max: 1_000_000,
            percent: 5,
            cachedInputTokens: 7_000,
            cacheCreationTokens: 2_000,
            reasoningOutputTokens: 900,
        });
    });

    it('normalizes tasks_updated payloads from the task hub', () => {
        expect(normalizeHubTasksPayload({
            tasks: [
                { id: 1, title: 'Audit project', status: 'active', column: 'in_progress', priority: 3 },
            ],
        })).toEqual([
            { id: '1', title: 'Audit project', description: undefined, status: 'active', column: 'in_progress', priority: 3, assigned_to: undefined, subtasks: undefined },
        ]);
    });

    it('uses Hub tasks as checklist when task progress todos are absent', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'запусти рой агентов', timestamp: 100 }],
            todos: [],
            hubTasks: [
                { id: '1', title: 'Run architecture swarm', status: 'active', column: 'in_progress', priority: 3 },
                { id: '2', title: 'Summarize findings', status: 'pending', column: 'backlog', priority: 1 },
            ],
            taskProgress: null,
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun?.checklistSource).toBe('hub');
        expect(taskRun?.status).toBe('running');
        expect(taskRun?.checklist.map(item => item.text)).toEqual(['Run architecture swarm', 'Summarize findings']);
    });

    it('summarizes agents and reports failed agent attention reason', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'запусти рой агентов', timestamp: 100 }],
            todos: [],
            hubTasks: [],
            workers: [
                { id: 'w1', name: 'Audit agent', status: 'running', isActive: true },
                { id: 'w2', name: 'Tests agent', status: 'failed', isActive: false },
                { id: 'w3', name: 'Docs agent', status: 'queued', isActive: false },
            ],
            taskProgress: null,
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun?.workerSummary).toBe('1 agent running · 1 queued · 1 failed');
        expect(taskRun?.status).toBe('failed');
        expect(taskRun?.attentionReason).toBe('Agent failed: Tests agent');
        expect(taskRun?.attentionAction).toEqual({ kind: 'open_agent', label: 'Open Agent' });
    });

    it('counts cancelled todos as terminal checklist items', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'implement plan', timestamp: 100 }],
            todos: [],
            taskProgress: {
                task_name: 'implement plan',
                status: 'Task complete',
                mode: 'execution',
                is_active: false,
                todos: [
                    { text: 'Wire lifecycle', status: 'completed' },
                    { text: 'Skip obsolete fallback', status: 'cancelled' },
                ],
                timestamp: 200,
            },
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(taskRun?.completedChecklistCount).toBe(2);
        expect(taskRun?.totalChecklistCount).toBe(2);
    });

    it('does not turn raw tool progress steps into task checklist items', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'analyze project', timestamp: 100 }],
            todos: [],
            taskProgress: {
                task_name: 'Project analysis',
                status: 'Read file `src/state/mod.rs`',
                summary: 'Reading project files',
                mode: 'planning',
                is_active: true,
                steps: [
                    'Read file `Cargo.toml`',
                    'List directory `src`',
                    'Read file `src/state/mod.rs`',
                ],
                timestamp: 200,
            },
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun?.checklist).toEqual([]);
        expect(taskRun?.totalChecklistCount).toBe(0);
        expect(taskRun?.statusText).toBe('Reading project files');
    });

    it('uses provisional progress only as a planning status when todos are missing', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'analyze project', timestamp: 100 }],
            todos: [],
            taskProgress: {
                task_name: 'Project analysis',
                status: 'Read file `src/monitoring/mod.rs`',
                summary: 'Read file `src/monitoring/mod.rs`',
                mode: 'planning',
                is_active: true,
                checklist_source: 'provisional',
                steps: [
                    'Examine project structure and documentation',
                    'Read file `Cargo.toml`',
                    'Summarize architecture and next steps',
                ],
                timestamp: 200,
            },
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun?.checklist).toEqual([]);
        expect(taskRun?.completedChecklistCount).toBe(0);
        expect(taskRun?.totalChecklistCount).toBe(0);
        expect(taskRun?.checklistSource).toBe('provisional');
        expect(taskRun?.statusText).toBe('Planning project analysis...');
        expect(taskRun?.statusText).not.toContain('Read file');
        expect(taskRun?.statusText).not.toContain('Examine project structure');
    });

    it('does not show provisional checklist counts when the task completes successfully', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'проанализируй проект', timestamp: 100 }],
            todos: [],
            taskProgress: {
                task_name: 'проанализируй проект',
                status: 'Task complete',
                result: 'COMPLETED',
                mode: 'execution',
                is_active: false,
                checklist_source: 'provisional',
                steps: [
                    'Understand project purpose',
                    'Map architecture and modules',
                    'Review key files and dependencies',
                    'Identify risks and gaps',
                    'Summarize findings',
                ],
                timestamp: 200,
            },
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(taskRun?.status).toBe('completed');
        expect(taskRun?.checklist).toEqual([]);
        expect(taskRun?.completedChecklistCount).toBe(0);
        expect(taskRun?.totalChecklistCount).toBe(0);
        expect(taskRun?.statusText).toBe('Task completed');
    });

    it('normalizes generic check-project prompts into a project analysis task title', () => {
        const summaries = upsertWorkEvents({}, 'run-check-project', 'session-1', [
            { id: 'read-readme', type: 'read', label: 'Read', target: 'README.md', status: 'completed', timestamp: 100 },
        ], 'completed');

        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'hello check project', timestamp: 90, run_id: 'run-check-project' }],
            todos: [],
            taskProgress: {
                task_name: 'HelloCheckProject',
                status: 'Mission Accomplished',
                result: 'COMPLETED',
                mode: 'execution',
                is_active: false,
                run_id: 'run-check-project',
                session_id: 'session-1',
                timestamp: 200,
            },
            workSummariesByTurn: summaries,
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(taskRun?.title).toBe('Project analysis');
        expect(taskRun?.status).toBe('completed');
        expect(taskRun?.isActive).toBe(false);
        expect(taskRun?.statusText).toBe('Work summary ready');
    });

    it('infers generated project-analysis milestones as provisional when the source flag is missing', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'проанализируй проект Polybot', timestamp: 100 }],
            todos: [],
            taskProgress: {
                task_name: 'Polybot Project Analysis',
                status: 'Verifying',
                summary: 'Planning task',
                result: 'COMPLETED',
                mode: 'verification',
                is_active: true,
                steps: [
                    'Examine project structure and main components',
                    'Analyze core modules (ingestion, signal, execution)',
                    'Review mathematical and ML components',
                    'Examine monitoring and state management',
                    'Compile comprehensive analysis report',
                ],
                timestamp: 200,
            },
            workSummariesByTurn: {
                run1: {
                    turnId: 'run1',
                    status: 'completed',
                    startedAt: 100,
                    completedAt: 200,
                    counts: {
                        filesRead: 14,
                        filesExplored: 0,
                        foldersExplored: 0,
                        searches: 0,
                        commands: 1,
                        edits: 0,
                        workers: 0,
                        approvals: 0,
                    },
                    items: [],
                },
            },
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(taskRun?.status).toBe('completed');
        expect(taskRun?.checklistSource).toBe('provisional');
        expect(taskRun?.checklist).toEqual([]);
        expect(taskRun?.completedChecklistCount).toBe(0);
        expect(taskRun?.totalChecklistCount).toBe(0);
        expect(taskRun?.statusText).toBe('Work summary ready');
    });

    it('does not show provisional checklist when a task is stopped', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'проанализируй проект', timestamp: 100 }],
            todos: [],
            taskProgress: {
                task_name: 'проанализируй проект',
                status: 'Stopped',
                mode: 'planning',
                is_active: false,
                checklist_source: 'provisional',
                steps: [
                    'Understand project purpose',
                    'Map architecture and modules',
                ],
                timestamp: 200,
            },
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(taskRun?.status).toBe('stopped');
        expect(taskRun?.checklist).toEqual([]);
        expect(taskRun?.completedChecklistCount).toBe(0);
        expect(taskRun?.totalChecklistCount).toBe(0);
        expect(taskRun?.statusText).toBe('Stopped');
    });

    it('keeps real todos as the source of truth for completed runs', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'проанализируй проект', timestamp: 100 }],
            todos: [],
            taskProgress: {
                task_name: 'проанализируй проект',
                status: 'Task complete',
                result: 'COMPLETED',
                mode: 'execution',
                is_active: false,
                checklist_source: 'provisional',
                steps: ['Understand project purpose', 'Map architecture and modules'],
                todos: [
                    { text: 'Inspect repo', status: 'completed' },
                    { text: 'Summarize', status: 'current' },
                ],
                timestamp: 200,
            },
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(taskRun?.checklistSource).toBe('todo');
        expect(taskRun?.completedChecklistCount).toBe(1);
        expect(taskRun?.totalChecklistCount).toBe(2);
        expect(taskRun?.checklist.map(item => item.text)).toEqual(['Inspect repo', 'Summarize']);
    });

    it('keeps list_dir counts and expandable entries', () => {
        const activity: ActivityItem = {
            type: 'list_dir',
            file: 'src',
            counts: { files: 8, folders: 20 },
            entries: [
                { name: 'App.tsx', type: 'file', path: 'src/App.tsx' },
                { name: 'components', type: 'dir', path: 'src/components' },
            ],
            timestamp: 100,
        };

        const event = activityToWorkEvent(activity, 0);

        expect(event).toMatchObject({
            type: 'read',
            label: 'Explored',
            target: 'src',
            counts: { files: 8, folders: 20 },
        });
        expect(event?.entries).toHaveLength(2);
    });

    it('keeps command text and output preview on command tool calls', () => {
        const tool: ToolCall = {
            id: 'tool-1',
            name: 'execute_command',
            arguments: { command: 'find core/internal -name "*.go" | head -80', cwd: '/Users/igoryan_dao/GRIKAI/Ricochet' },
            result: 'core/internal/agent/controller.go\ncore/internal/tools/fs_tools.go\n',
            status: 'completed',
            timestamp: 200,
            durationMs: 1200,
        };

        const event = classifyTool(tool);

        expect(event).toMatchObject({
            type: 'command',
            label: 'Ran',
            command: 'find core/internal -name "*.go" | head -80',
            resultPreview: tool.result,
            status: 'completed',
            cwd: '/Users/igoryan_dao/GRIKAI/Ricochet',
            durationMs: 1200,
        });
    });

    it('maps generic lifecycle events to grouped work rows', () => {
        const read = toolLifecycleEventToWorkEvent({
            event: 'tool_finished',
            status: 'completed',
            tool_name: 'read_file',
            tool_use_id: 'read-1',
            args_summary: '/repo/core/internal/agent/controller.go',
            affected_files: ['/repo/core/internal/agent/controller.go'],
            timestamp: 300,
        });

        expect(read).toMatchObject({
            id: 'tool-read-1',
            type: 'read',
            label: 'Read',
            target: 'agent/controller.go',
            status: 'completed',
        });

        const command = toolLifecycleEventToWorkEvent({
            event: 'tool_started',
            status: 'running',
            tool_name: 'execute_command',
            tool_use_id: 'cmd-1',
            args_summary: 'go test ./...',
            started_at: 400,
        });

        expect(command).toMatchObject({
            id: 'tool-cmd-1',
            type: 'command',
            label: 'Running',
            command: 'go test ./...',
            status: 'running',
        });
    });

    it('maps read line ranges from lifecycle metadata and text previews', () => {
        const structured = toolLifecycleEventToWorkEvent({
            event: 'tool_finished',
            status: 'completed',
            tool_name: 'read_file',
            tool_use_id: 'read-lines-1',
            args_summary: '/repo/src/main.rs',
            affected_files: ['/repo/src/main.rs'],
            readLineStart: 1,
            readLineEnd: 150,
            timestamp: 300,
        } as any);

        const textPreview = toolLifecycleEventToWorkEvent({
            event: 'tool_finished',
            status: 'completed',
            tool_name: 'read_file',
            tool_use_id: 'read-lines-2',
            args_summary: 'src/main.rs lines 151-297',
            affected_files: ['src/main.rs'],
            timestamp: 320,
        } as any);

        const colonPreview = toolLifecycleEventToWorkEvent({
            event: 'tool_finished',
            status: 'completed',
            tool_name: 'read_file',
            tool_use_id: 'read-lines-3',
            args_summary: 'src/lib.rs range 1:125',
            affected_files: ['src/lib.rs'],
            timestamp: 340,
        } as any);

        expect(structured).toMatchObject({ lineRange: 'L1-L150' });
        expect(textPreview).toMatchObject({ lineRange: 'L151-L297' });
        expect(colonPreview).toMatchObject({ lineRange: 'L1-L125' });
    });

    it('merges line ranges when repeated read events target the same file', () => {
        const firstRead = toolLifecycleEventToWorkEvent({
            run_id: 'run-read-ranges',
            event: 'tool_finished',
            status: 'completed',
            tool_name: 'read_file',
            tool_use_id: 'read-range-1',
            args_summary: 'src/main.rs',
            affected_files: ['src/main.rs'],
            readLineStart: 1,
            readLineEnd: 150,
            timestamp: 100,
        } as any) as WorkEvent;
        const secondRead = toolLifecycleEventToWorkEvent({
            run_id: 'run-read-ranges',
            event: 'tool_finished',
            status: 'completed',
            tool_name: 'read_file',
            tool_use_id: 'read-range-2',
            args_summary: 'src/main.rs',
            affected_files: ['src/main.rs'],
            readLineStart: 151,
            readLineEnd: 297,
            timestamp: 200,
        } as any) as WorkEvent;

        const summaries = upsertWorkEvents(
            upsertWorkEvents({}, 'run-read-ranges', 'session-1', [firstRead], 'running'),
            'run-read-ranges',
            'session-1',
            [secondRead],
            'running',
        );

        expect(summaries['run-read-ranges'].items).toHaveLength(1);
        expect(summaries['run-read-ranges'].items[0].lineRange).toBe('L1-L150, L151-L297');
    });

    it('surfaces failed write_file tool calls as edit failures with permission details', () => {
        const event = classifyTool({
            id: 'tool-write-script',
            name: 'write_file',
            arguments: { path: '/Users/igoryan_dao/Polybot/test_script.rs' },
            result: 'permission denied: Mode Tester is restricted to test files',
            status: 'error',
            timestamp: 500,
        });

        expect(event).toMatchObject({
            type: 'review',
            label: 'Edit failed',
            target: 'Polybot/test_script.rs',
            path: '/Users/igoryan_dao/Polybot/test_script.rs',
            status: 'failed',
            error: 'permission denied: Mode Tester is restricted to test files',
        });
    });

    it('surfaces failed write_file lifecycle events as visible edit failures', () => {
        const event = toolLifecycleEventToWorkEvent({
            event: 'tool_failed',
            status: 'failed',
            tool_name: 'write_file',
            tool_use_id: 'write-test-script',
            args_summary: '/Users/igoryan_dao/Polybot/test_script.rs',
            affected_files: ['/Users/igoryan_dao/Polybot/test_script.rs'],
            error: 'permission denied: Mode Tester is restricted to test files',
            timestamp: 510,
        });

        expect(event).toMatchObject({
            id: 'tool-write-test-script',
            type: 'review',
            label: 'Edit failed',
            target: 'Polybot/test_script.rs',
            path: '/Users/igoryan_dao/Polybot/test_script.rs',
            status: 'failed',
            error: 'permission denied: Mode Tester is restricted to test files',
        });
    });

    it('binds orphan runtime events to the active run when the candidate run has no visible message', () => {
        expect(resolveRuntimeTurnIdForEvent({
            runId: undefined,
            turnId: undefined,
            activeRunId: 'run-active',
            messages: [{ id: 'user-1', run_id: 'run-active' }],
            fallback: 'tool-write',
        })).toBe('run-active');

        expect(resolveRuntimeTurnIdForEvent({
            runId: 'run-orphan',
            activeRunId: 'run-active',
            messages: [{ id: 'user-1', run_id: 'run-active' }],
            fallback: 'tool-write',
        })).toBe('run-active');

        expect(resolveRuntimeTurnIdForEvent({
            runId: 'run-known',
            activeRunId: 'run-active',
            messages: [{ id: 'assistant-1', run_id: 'run-known' }],
            fallback: 'tool-write',
        })).toBe('run-known');
    });

    it('hides internal Ricochet artifacts from edited files', () => {
        const brainPath = '.ricochet/brain/c8f6c563-441e-406f-b4ac-ceb084366d06/polybot_improvement_plan_ru.resolved';
        const planArtifactPath = '.ricochet/artifacts/session-1/implementation_plan.md';

        expect(classifyTool({
            id: 'tool-internal-edit',
            name: 'write_file',
            arguments: { path: brainPath },
            status: 'completed',
            timestamp: 310,
        })).toBeNull();

        expect(classifyTool({
            id: 'tool-submit-plan',
            name: 'submit_plan',
            arguments: { title: 'Implementation Plan', content: '# Plan' },
            status: 'completed',
            timestamp: 315,
        })).toBeNull();

        expect(classifyTool({
            id: 'tool-create-task',
            name: 'create_task',
            arguments: { title: 'Plan task' },
            status: 'completed',
            timestamp: 315,
        })).toBeNull();

        expect(toolLifecycleEventToWorkEvent({
            event: 'tool_finished',
            status: 'completed',
            tool_name: 'add_subtask',
            tool_use_id: 'meta-add-subtask',
            args_summary: 'Plan task',
            timestamp: 315,
        })).toBeNull();

        expect(classifyTool({
            id: 'tool-internal-artifact-edit',
            name: 'write_file',
            arguments: { path: planArtifactPath },
            status: 'completed',
            timestamp: 316,
        })).toBeNull();

        expect(activityToWorkEvent({
            type: 'edit',
            file: brainPath,
            timestamp: 320,
        }, 0)).toBeNull();

        expect(toolLifecycleEventToWorkEvent({
            event: 'tool_finished',
            status: 'completed',
            tool_name: 'write_file',
            tool_use_id: 'internal-write',
            affected_files: [brainPath],
            timestamp: 330,
        })).toBeNull();

        const summaries = upsertWorkEvents({}, 'run-internal', undefined, [{
            id: 'legacy-internal',
            type: 'edit',
            label: 'Edited',
            target: 'c8f6c563-441e-406f-b4ac-ceb084366d06/polybot_improvement_plan_ru.resolved',
            path: brainPath,
            status: 'completed',
            timestamp: 340,
        }], 'completed');

        expect(summaries['run-internal'].items).toHaveLength(0);
        expect(summaries['run-internal'].counts.edits).toBe(0);
    });

    it('keeps normal workspace edits in the work summary', () => {
        const event = classifyTool({
            id: 'tool-normal-edit',
            name: 'write_file',
            arguments: { path: 'src/main.rs' },
            status: 'completed',
            timestamp: 350,
        });

        expect(event).toMatchObject({
            type: 'edit',
            path: 'src/main.rs',
            target: 'src/main.rs',
        });

        const summaries = upsertWorkEvents({}, 'run-edit', undefined, [event as WorkEvent], 'completed');
        expect(summaries['run-edit'].items).toHaveLength(1);
        expect(summaries['run-edit'].counts.edits).toBe(1);
    });

    it('does not treat ordinary workspace artifact payloads as renderable chat artifacts', () => {
        expect(isRenderableChatMessage({
            id: 'assistant-rs-artifact',
            role: 'assistant',
            content: '',
            timestamp: 100,
            artifacts: [{ type: 'other', title: 'Artifact', path: 'tests/math_tests.rs' }],
        })).toBe(false);

        expect(isRenderableChatMessage({
            id: 'assistant-plan-artifact',
            role: 'assistant',
            content: '',
            timestamp: 100,
            artifacts: [{ type: 'implementation_plan', title: 'Implementation Plan', path: '.ricochet/artifacts/session/implementation_plan.md' }],
        })).toBe(true);
    });

    it('derives task steps and approval reason from pending workspace edits', () => {
        const edits: WorkEvent[] = [
            { id: 'pending-edit-tests/math_tests.rs', type: 'edit', label: 'Created', target: 'tests/math_tests.rs', path: 'tests/math_tests.rs', status: 'waiting', timestamp: 100 },
            { id: 'pending-edit-tests/signal_tests.rs', type: 'edit', label: 'Created', target: 'tests/signal_tests.rs', path: 'tests/signal_tests.rs', status: 'waiting', timestamp: 110 },
            { id: 'pending-edit-tests/ingestion_tests.rs', type: 'edit', label: 'Created', target: 'tests/ingestion_tests.rs', path: 'tests/ingestion_tests.rs', status: 'waiting', timestamp: 120 },
        ];
        const summaries = upsertWorkEvents({}, 'run-edits', undefined, edits, 'waiting');

        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'создай несколько тестовых файлов', timestamp: 90 }],
            todos: [],
            taskProgress: null,
            workSummariesByTurn: summaries,
            usageSnapshot: null,
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun?.status).toBe('waiting');
        expect(taskRun?.attentionReason).toBe('3 files waiting for approval');
        expect(taskRun?.statusText).toBe('3 files waiting for approval');
        expect(taskRun?.checklistSource).toBe('edit');
        expect(taskRun?.completedChecklistCount).toBe(0);
        expect(taskRun?.totalChecklistCount).toBe(3);
        expect(taskRun?.checklist.map(item => item.text)).toEqual([
            'Create tests/math_tests.rs',
            'Create tests/signal_tests.rs',
            'Create tests/ingestion_tests.rs',
        ]);
    });

    it('closes pending edit rows when file approval is accepted', () => {
        const waiting: WorkEvent = {
            id: 'pending-edit-tests/math_tests.rs',
            type: 'edit',
            label: 'Created',
            target: 'tests/math_tests.rs',
            path: 'tests/math_tests.rs',
            additions: 12,
            deletions: 0,
            hasDiff: true,
            reviewable: true,
            status: 'waiting',
            timestamp: 100,
        };
        const summaries = upsertWorkEvents({}, 'run-edit-approval', undefined, [waiting], 'waiting');
        const closed = closeEditRows(summaries, ['tests/math_tests.rs'], 'accepted');
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'создай тестовый файл', timestamp: 90 }],
            todos: [],
            taskProgress: null,
            workSummariesByTurn: closed,
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(closed['run-edit-approval'].status).toBe('completed');
        expect(closed['run-edit-approval'].items[0].status).toBe('completed');
        expect(taskRun?.status).toBe('completed');
        expect(taskRun?.statusText).toBe('1 change applied');
        expect(taskRun?.completedChecklistCount).toBe(1);
    });

    it('marks rejected edit approvals as discarded rather than failed', () => {
        const waiting: WorkEvent = {
            id: 'pending-edit-tests/math_tests.rs',
            type: 'edit',
            label: 'Created',
            target: 'tests/math_tests.rs',
            path: 'tests/math_tests.rs',
            status: 'waiting',
            timestamp: 100,
        };
        const summaries = upsertWorkEvents({}, 'run-edit-reject', undefined, [waiting], 'waiting');
        const closed = closeEditRows(summaries, ['tests/math_tests.rs'], 'rejected');
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'создай тестовый файл', timestamp: 90 }],
            todos: [],
            taskProgress: null,
            workSummariesByTurn: closed,
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(closed['run-edit-reject'].status).toBe('rejected');
        expect(closed['run-edit-reject'].items[0]).toMatchObject({ label: 'Changes discarded', status: 'completed' });
        expect(taskRun?.status).toBe('rejected');
        expect(taskRun?.statusText).toBe('1 change discarded');
        expect(taskRun?.attentionReason).toBeUndefined();
    });

    it('normalizes execute_python as a structured Python command row', () => {
        const script = 'print("Project analysis completed")';
        const tool: ToolCall = {
            id: 'tool-python',
            name: 'execute_python',
            arguments: { script },
            result: 'Project analysis completed\n',
            status: 'completed',
            timestamp: 230,
        };

        const event = classifyTool(tool);

        expect(event).toMatchObject({
            type: 'command',
            label: 'Ran Python script',
            target: 'Python script',
            command: 'python3 <script>',
            script,
            resultPreview: tool.result,
            shell: 'python',
            status: 'completed',
        });
        expect(event?.target).not.toContain('{"script"');
        expect(event?.command).not.toContain(script);
    });

    it('marks pending execute_python as waiting for approval rather than running', () => {
        const tool: ToolCall = {
            id: 'tool-python-pending',
            name: 'execute_python',
            arguments: { script: 'print("Project analysis")' },
            status: 'pending',
            timestamp: 240,
        };

        const event = classifyTool(tool);

        expect(event).toMatchObject({
            type: 'command',
            label: 'Ran Python script',
            target: 'Python script',
            command: 'python3 <script>',
            shell: 'python',
            status: 'waiting',
        });
    });

    it('does not render background command start acknowledgement as shell output', () => {
        const event = classifyTool({
            id: 'tool-bg',
            name: 'execute_command',
            arguments: { command: 'docker logs --since 10m --tail 100 app', background: true },
            result: 'Command started in background. ID: abc\nUse command_status to check progress.',
            status: 'completed',
            timestamp: 210,
        });

        expect(event).toBeNull();
    });

    it('does not treat non-shell tools with run in the name as command rows', () => {
        const event = classifyTool({
            id: 'tool-runner',
            name: 'run_analysis',
            arguments: { target: 'src' },
            result: 'analysis complete',
            status: 'completed',
            timestamp: 220,
        });

        expect(event?.type).not.toBe('command');
    });

    it('drops old heartbeat prose so it does not render as markdown commentary', () => {
        const heartbeat: TaskProgress = {
            task_name: 'Agent activity',
            status: 'Изучен файл `README.md`; продолжаю сверять проект.',
            is_active: true,
            timestamp: 300,
        };

        expect(parseProgressStatus(heartbeat)).toBeNull();
    });

    it('drops generic Working progress instead of rendering it as a command row', () => {
        const progress: TaskProgress = {
            task_name: 'проанализируй проект',
            status: 'Working',
            is_active: true,
            timestamp: 350,
        };

        expect(parseProgressStatus(progress)).toBeNull();
    });

    it('keeps explicit execute_command progress as a command row', () => {
        const event = parseProgressStatus({
            task_name: 'Agent activity',
            status: 'Running tool execute_command: {"command":"find core/internal -name \\"*.go\\" | wc -l"}',
            is_active: true,
            run_id: 'run-command',
            timestamp: 360,
        } as TaskProgress);

        expect(event).toMatchObject({
            type: 'command',
            label: 'Ran',
            command: 'find core/internal -name "*.go" | wc -l',
            status: 'running',
        });
    });

    it('normalizes command lifecycle events into one streaming command row', () => {
        const started = commandEventToWorkEvent({
            event: 'command_started',
            tool_use_id: 'tool-shell',
            command: 'docker logs --since 10m --tail 100 app',
            cwd: '/repo',
            status: 'running',
            startedAt: 100,
            timestamp: 100,
        }) as WorkEvent;
        const chunk = commandEventToWorkEvent({
            event: 'command_output',
            tool_use_id: 'tool-shell',
            command: 'docker logs --since 10m --tail 100 app',
            outputChunk: 'line one\n',
            status: 'running',
            timestamp: 120,
        }) as WorkEvent;
        const done = commandEventToWorkEvent({
            event: 'command_succeeded',
            tool_use_id: 'tool-shell',
            command: 'docker logs --since 10m --tail 100 app',
            status: 'completed',
            exitCode: 0,
            durationMs: 4000,
            completedAt: 4100,
            timestamp: 4100,
        }) as WorkEvent;

        const summaries = upsertWorkEvents(
            upsertWorkEvents(
                upsertWorkEvents({}, 'run-shell', undefined, [started], 'running'),
                'run-shell',
                undefined,
                [chunk],
                'running',
            ),
            'run-shell',
            undefined,
            [done],
            'running',
        );

        expect(summaries['run-shell'].items).toHaveLength(1);
        expect(summaries['run-shell'].items[0]).toMatchObject({
            type: 'command',
            command: 'docker logs --since 10m --tail 100 app',
            resultPreview: 'line one\n',
            status: 'completed',
            exitCode: 0,
            durationMs: 4000,
        });
    });

    it('appends command output chunks without duplicating the row', () => {
        const first = commandEventToWorkEvent({
            event: 'command_output',
            tool_use_id: 'tool-psql',
            command: 'psql -c "select * from orders limit 3"',
            outputChunk: ' id | status\n----+--------\n',
            status: 'running',
            timestamp: 100,
        }) as WorkEvent;
        const second = commandEventToWorkEvent({
            event: 'command_output',
            tool_use_id: 'tool-psql',
            command: 'psql -c "select * from orders limit 3"',
            outputChunk: ' 1 | done\n',
            status: 'running',
            timestamp: 120,
        }) as WorkEvent;

        const summaries = upsertWorkEvents(
            upsertWorkEvents({}, 'run-psql', undefined, [first], 'running'),
            'run-psql',
            undefined,
            [second],
            'running',
        );

        expect(summaries['run-psql'].items).toHaveLength(1);
        expect(summaries['run-psql'].items[0].resultPreview).toBe(' id | status\n----+--------\n 1 | done\n');
    });

    it('deduplicates task_progress, tool call, and activity for the same read', () => {
        const progress = parseProgressStatus({
            task_name: 'Agent activity',
            status: 'Read file `README.md`',
            is_active: true,
            run_id: 'run-1',
            timestamp: 100,
        } as TaskProgress) as WorkEvent;

        const tool = classifyTool({
            id: 'tool-read',
            name: 'read_file',
            arguments: { path: 'README.md' },
            result: '# README',
            status: 'completed',
            timestamp: 200,
        } as ToolCall) as WorkEvent;

        const activity = activityToWorkEvent({
            type: 'analyze',
            file: 'README.md',
            timestamp: 300,
        }, 0) as WorkEvent;

        const summaries = upsertWorkEvents(
            upsertWorkEvents(
                upsertWorkEvents({}, 'run-1', undefined, [progress], 'running'),
                'run-1',
                undefined,
                [tool],
            ),
            'run-1',
            undefined,
            [activity],
        );

        expect(summaries['run-1'].items).toHaveLength(1);
        expect(summaries['run-1'].counts.filesRead).toBe(1);
        expect(summaries['run-1'].items[0]).toMatchObject({
            label: 'Read',
            target: 'README.md',
            status: 'completed',
        });
    });

    it('keeps sequential tool lifecycle events grouped under one run id', () => {
        const listEvent = toolLifecycleEventToWorkEvent({
            run_id: 'run-sequential',
            tool_name: 'list_dir',
            status: 'completed',
            affected_files: ['src'],
            timestamp: 100,
        } as any) as WorkEvent;
        const readEvent = toolLifecycleEventToWorkEvent({
            run_id: 'run-sequential',
            tool_name: 'read_file',
            status: 'completed',
            affected_files: ['src/main.ts'],
            timestamp: 200,
        } as any) as WorkEvent;

        const summaries = upsertWorkEvents(
            upsertWorkEvents({}, 'run-sequential', 'session-1', [listEvent], 'running'),
            'run-sequential',
            'session-1',
            [readEvent],
            'running',
        );

        expect(Object.keys(summaries)).toEqual(['run-sequential']);
        expect(summaries['run-sequential'].items).toHaveLength(2);
        expect(summaries['run-sequential'].items.map(item => item.target)).toEqual(['src', 'src/main.ts']);
    });

    it('aggregates task activity bars from informative summaries when latest summary is empty', () => {
        const readEvent: WorkEvent = {
            id: 'read-project',
            type: 'read',
            label: 'Read',
            target: 'project_analysis.md',
            path: 'project_analysis.md',
            status: 'completed',
            timestamp: 100,
        };
        const commandEvent: WorkEvent = {
            id: 'command-python',
            type: 'command',
            label: 'Ran',
            target: 'python3 <script>',
            command: 'python3 <script>',
            status: 'completed',
            timestamp: 200,
        };
        const summaries = {
            'run-informative': {
                turnId: 'run-informative',
                status: 'completed' as const,
                startedAt: 100,
                completedAt: 300,
                durationMs: 200,
                counts: {
                    filesRead: 1,
                    filesExplored: 0,
                    foldersExplored: 0,
                    searches: 0,
                    commands: 1,
                    edits: 0,
                    workers: 0,
                    approvals: 0,
                },
                items: [readEvent, commandEvent],
            },
            'run-empty-latest': {
                turnId: 'run-empty-latest',
                status: 'completed' as const,
                startedAt: 500,
                completedAt: 510,
                durationMs: 10,
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
        };

        expect(aggregateTaskActivityItems(summaries).map(item => item.id)).toEqual(['read-project', 'command-python']);
        const taskRun = buildTaskRunViewModel({
            messages: [],
            todos: [],
            workSummariesByTurn: summaries,
            taskProgress: null,
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(taskRun?.workSummary?.turnId).toBe('run-informative');
        expect(taskRun?.activityItems?.map(item => item.id)).toEqual(['read-project', 'command-python']);
        expect(taskRun?.activityHistoryCount).toBe(2);
    });

    it('keeps session activity bars across multiple user turns', () => {
        const summaries = {
            'run-first': {
                turnId: 'run-first',
                status: 'completed' as const,
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
                    id: 'read-first',
                    type: 'read' as const,
                    label: 'Read',
                    target: 'README.md',
                    path: 'README.md',
                    status: 'completed' as const,
                    timestamp: 100,
                }],
            },
            'run-second': {
                turnId: 'run-second',
                status: 'running' as const,
                startedAt: 300,
                counts: {
                    filesRead: 0,
                    filesExplored: 0,
                    foldersExplored: 0,
                    searches: 0,
                    commands: 1,
                    edits: 0,
                    workers: 0,
                    approvals: 0,
                },
                items: [{
                    id: 'command-second',
                    type: 'command' as const,
                    label: 'Ran',
                    target: 'cargo test',
                    command: 'cargo test',
                    status: 'running' as const,
                    timestamp: 300,
                }],
            },
        };

        const taskRun = buildTaskRunViewModel({
            messages: [],
            todos: [],
            workSummariesByTurn: summaries,
            taskProgress: null,
            usageSnapshot: null,
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun?.workSummary?.turnId).toBe('run-second');
        expect(taskRun?.activityItems?.map(item => item.id)).toEqual(['read-first', 'command-second']);
        expect(taskRun?.activityHistoryCount).toBe(2);
    });

    it('renders forced-completed provisional steps as terminal instead of spinning', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'проанализируй проект', timestamp: 100 }],
            todos: [],
            workSummariesByTurn: {},
            taskProgress: {
                task_name: 'Project Analysis',
                status: 'Provide comprehensive analysis summary',
                mode: 'verification',
                is_active: false,
                steps: [
                    'Examine project structure',
                    'Provide comprehensive analysis summary',
                ],
                run_id: 'run-completed',
                timestamp: 300,
            },
            usageSnapshot: null,
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun?.status).toBe('completed');
        expect(taskRun?.isActive).toBe(false);
        expect(taskRun?.checklist.map(item => item.status)).toEqual(['completed', 'completed']);
    });

    it('hides completed approvals and does not count them in the summary', () => {
        const waiting: WorkEvent = {
            id: 'approval-request-1',
            type: 'approval',
            label: 'Waiting for approval',
            target: 'Allow command?',
            status: 'waiting',
            timestamp: 100,
        };
        const completed: WorkEvent = {
            ...waiting,
            label: 'Approval received',
            status: 'completed',
            timestamp: 200,
        };

        const summaries = upsertWorkEvents(
            upsertWorkEvents({}, 'run-approval', undefined, [waiting], 'waiting'),
            'run-approval',
            undefined,
            [completed],
            'running',
        );

        expect(summaries['run-approval'].items.find(item => item.type === 'approval')).toBeUndefined();
        expect(summaries['run-approval'].counts.approvals).toBe(0);
    });

    it('terminal summaries close and hide stale waiting approvals', () => {
        const waiting: WorkEvent = {
            id: 'approval-request-2',
            type: 'approval',
            label: 'Waiting for approval',
            target: 'Allow command?',
            status: 'waiting',
            timestamp: 100,
        };

        const summaries = upsertWorkEvents(
            upsertWorkEvents({}, 'run-terminal-approval', undefined, [waiting], 'waiting'),
            'run-terminal-approval',
            undefined,
            [],
            'completed',
        );

        expect(summaries['run-terminal-approval'].status).toBe('completed');
        expect(summaries['run-terminal-approval'].items.find(item => item.type === 'approval')).toBeUndefined();
        expect(summaries['run-terminal-approval'].counts.approvals).toBe(0);
    });

    it('completion fallback closes stale active work summaries by run id', () => {
        const runningRead: WorkEvent = {
            id: 'tool-read-stale',
            type: 'read',
            label: 'Read',
            target: 'src/lib.rs',
            status: 'running',
            timestamp: 100,
        };

        const running = upsertWorkEvents({}, 'run-stale', 'session-1', [runningRead], 'running');
        const completed = completeWorkSummaryForTurn(running, 'run-stale', 'session-1');

        expect(completed['run-stale'].status).toBe('completed');
        expect(completed['run-stale'].items[0].status).toBe('completed');
    });

    it('completion fallback without a run id closes active summaries for the current session only', () => {
        const sessionRunning = upsertWorkEvents({}, 'run-session', 'session-1', [], 'running');
        const otherRunning = upsertWorkEvents(sessionRunning, 'run-other', 'session-2', [], 'running');

        const completed = completeActiveWorkSummaries(otherRunning, 'session-1');

        expect(completed['run-session'].status).toBe('completed');
        expect(completed['run-other'].status).toBe('running');
    });

    it('terminal completion closes active summaries for the same session even when keyed differently', () => {
        const exact = upsertWorkEvents({}, 'run-main', 'session-1', [], 'running');
        const orphan = upsertWorkEvents(exact, 'tool-orphan', 'session-1', [
            { id: 'tool-read-orphan', type: 'read', label: 'Read', target: 'src/main.ts', status: 'running', timestamp: 100 },
        ], 'running');

        const completed = completeRuntimeWorkSummaries(orphan, 'run-main', 'session-1', true);

        expect(completed['run-main'].status).toBe('completed');
        expect(completed['tool-orphan'].status).toBe('completed');
        expect(completed['tool-orphan'].items[0].status).toBe('completed');
    });

    it('stale completion for an old run does not close a newer active run', () => {
        const oldRun = upsertWorkEvents({}, 'run-old', 'session-1', [], 'running');
        const newRun = upsertWorkEvents(oldRun, 'run-new', 'session-1', [
            { id: 'tool-read-new', type: 'read', label: 'Read', target: 'src/new.ts', status: 'running', timestamp: 100 },
        ], 'running');

        const completed = completeRuntimeWorkSummaries(newRun, 'run-old', 'session-1', false);

        expect(completed['run-old'].status).toBe('completed');
        expect(completed['run-new'].status).toBe('running');
        expect(completed['run-new'].items[0].status).toBe('running');
    });

    it('lets completed lifecycle events replace stale waiting read events', () => {
        const waiting = upsertWorkEvents({}, 'run-1', 'session-1', [
            { id: 'tool-read-1', type: 'read', label: 'Read', path: 'src/main.rs', status: 'waiting', timestamp: 1 },
        ], 'running');
        const completed = upsertWorkEvents(waiting, 'run-1', 'session-1', [
            { id: 'tool-read-1', type: 'read', label: 'Read', path: 'src/main.rs', status: 'completed', timestamp: 2 },
        ], 'running');
        const terminal = completeRuntimeWorkSummaries(completed, 'run-1', 'session-1', true);

        expect(terminal['run-1'].items[0].status).toBe('completed');
        expect(terminal['run-1'].status).toBe('completed');
    });

    it('does not force normal streaming markdown into timeline commentary', () => {
        const message: ChatMessage = {
            id: 'assistant-final-stream',
            role: 'assistant',
            content: 'Полный анализ проекта',
            timestamp: 500,
            isStreaming: true,
        };

        expect(shouldCreateWorkCommentary(message)).toBe(false);
    });

    it('does not turn pure hidden reasoning into Thought / plan commentary', () => {
        const message: ChatMessage = {
            id: 'assistant-hidden-reasoning',
            role: 'assistant',
            content: '',
            reasoning: 'I should create a test script.',
            timestamp: 505,
            isStreaming: true,
        };

        expect(shouldCreateWorkCommentary(message)).toBe(false);
        expect(normalizeWorkCommentaryText(message.content)).toBe('');
    });

    it('keeps an empty work summary explainable when only hidden reasoning was captured', () => {
        const summaries = markWorkSummaryActivityHint(
            {},
            'run-hidden',
            'session-1',
            'hidden_reasoning',
            'running',
        );

        expect(summaries['run-hidden']).toMatchObject({
            turnId: 'run-hidden',
            sessionId: 'session-1',
            status: 'running',
            activityHint: 'hidden_reasoning',
            items: [],
        });
    });

    it('keeps streaming work payloads eligible for timeline commentary', () => {
        const message: ChatMessage = {
            id: 'assistant-tool-stream',
            role: 'assistant',
            content: 'I will inspect the project.',
            timestamp: 500,
            isStreaming: true,
            toolCalls: [{
                id: 'tool-read',
                name: 'read_file',
                arguments: { path: 'README.md' },
                status: 'running',
            }],
        };

        expect(shouldCreateWorkCommentary(message)).toBe(true);
    });

    it('keeps long structured streaming reports in the chat answer instead of Thought', () => {
        const report = [
            'Анализ проекта Polybot',
            '',
            '## Архитектура проекта',
            'Polybot — это Rust-трейдинговый бот для предсказательных рынков.',
            '',
            '### Ключевые особенности',
            '- Получение данных из Polymarket и Binance.',
            '- ML анализ и исполнение сделок.',
            '- Мониторинг и Telegram оповещения.',
            '',
            '## Рекомендации',
            'Добавить тестовую инфраструктуру и улучшить документацию.',
        ].join('\n');
        const message: ChatMessage = {
            id: 'assistant-long-report-stream',
            role: 'assistant',
            content: report,
            timestamp: 501,
            isStreaming: true,
            toolCalls: [{
                id: 'tool-read',
                name: 'read_file',
                arguments: { path: 'project_analysis.md' },
                status: 'completed',
            }],
        };

        expect(isWorkCommentaryText(normalizeWorkCommentaryText(report))).toBe(false);
        expect(shouldCreateWorkCommentary(message)).toBe(false);
        expect(shouldKeepAssistantBubble(message)).toBe(true);
    });

    it('treats visible assistant reports with tool calls as intermediate drafts', () => {
        const report = [
            '# Polybot Project Comprehensive Analysis',
            '',
            '## Executive Summary',
            'Polybot is a Rust trading bot.',
            '',
            '## Architecture',
            'It has ingestion, analysis, and execution layers.',
        ].join('\n');
        const message = withInferredRunPhase({
            id: 'assistant-report-with-tool',
            role: 'assistant',
            content: report,
            timestamp: 520,
            isStreaming: false,
            run_id: 'run-polybot',
            toolCalls: [{
                id: 'tool-boundary',
                name: 'task_boundary',
                arguments: { TaskName: 'Polybot Project Analysis' },
                status: 'completed',
            }],
        });

        expect(isIntermediateAssistantDraft(message)).toBe(true);
        expect(message.metadata?.runPhase).toBe('intermediate');
        expect(shouldKeepAssistantBubble(message)).toBe(true);
        expect(shouldCreateWorkCommentary(message)).toBe(false);
    });

    it('promotes the latest intermediate draft to final on completion when no final exists', () => {
        const messages: ChatMessage[] = [
            { id: 'user-1', role: 'user', content: 'проанализируй проект', timestamp: 1, run_id: 'run-polybot', turn_id: 'run-polybot' },
            withInferredRunPhase({
                id: 'assistant-draft',
                role: 'assistant',
                content: '# Polybot Project Comprehensive Analysis\n\n## Summary\nDone.',
                timestamp: 2,
                run_id: 'run-polybot',
                turn_id: 'run-polybot',
                isStreaming: false,
                toolCalls: [{
                    id: 'tool-boundary',
                    name: 'task_boundary',
                    arguments: { TaskName: 'Polybot Project Analysis' },
                    status: 'completed',
                }],
            }),
        ];

        const promoted = promoteLatestIntermediateDraft(messages, 'run-polybot');
        expect(promoted[1].metadata?.runPhase).toBe('final');
        expect(isIntermediateAssistantDraft(promoted[1])).toBe(false);
    });

    it('promotes intermediate drafts deterministically when rebuilding completed history', () => {
        const messages: ChatMessage[] = [
            { id: 'user-1', role: 'user', content: 'проанализируй проект', timestamp: 1, run_id: 'run-polybot', turn_id: 'run-polybot' },
            withInferredRunPhase({
                id: 'assistant-draft',
                role: 'assistant',
                content: '# Polybot Project Comprehensive Analysis\n\n## Summary\nDone.',
                timestamp: 2,
                run_id: 'run-polybot',
                turn_id: 'run-polybot',
                isStreaming: false,
                toolCalls: [{
                    id: 'tool-boundary',
                    name: 'task_boundary',
                    arguments: { TaskName: 'Polybot Project Analysis' },
                    status: 'completed',
                }],
            }),
        ];

        const promoted = promoteCompletedIntermediateDrafts(messages);
        expect(promoted[1].metadata?.runPhase).toBe('final');
    });

    it('does not create Thought notes from generic Planning task or empty JSON leftovers', () => {
        expect(normalizeWorkCommentaryText('{}')).toBe('');
        expect(normalizeWorkCommentaryText('{ }')).toBe('');
        expect(normalizeWorkCommentaryText('[]')).toBe('');
        expect(normalizeWorkCommentaryText('Planning task\n\n{}')).toBe('');

        expect(isWorkCommentaryText('Planning task')).toBe(false);
        expect(shouldCreateWorkCommentary({
            id: 'assistant-planning-task',
            role: 'assistant',
            content: 'Planning task\n\n{}',
            timestamp: 502,
            isStreaming: true,
            toolCalls: [{
                id: 'tool-boundary',
                name: 'task_boundary',
                arguments: { TaskName: 'Project Analysis' },
                status: 'completed',
            }],
        })).toBe(false);
    });

    it('drops raw tool argument JSON from Thought / plan commentary', () => {
        const script = 'print("Project analysis completed")';
        const rawPayload = `{"script":${JSON.stringify(script)}}`;
        const message: ChatMessage = {
            id: 'assistant-python-tool-stream',
            role: 'assistant',
            content: `Generating comprehensive project analysis report\n\n${rawPayload}`,
            timestamp: 510,
            isStreaming: true,
            toolCalls: [{
                id: 'tool-python',
                name: 'execute_python',
                arguments: { script },
                status: 'running',
            }],
        };

        expect(shouldCreateWorkCommentary(message)).toBe(true);
        expect(normalizeWorkCommentaryText(message.content)).toBe('Generating comprehensive project analysis report');
        expect(normalizeWorkCommentaryText(rawPayload)).toBe('');
        expect(normalizeWorkCommentaryText('{"mode":"code"}')).toBe('');
        expect(normalizeWorkCommentaryText('{"hash":"abc","start_line":1,"end_line":100}')).toBe('');
        expect(normalizeWorkCommentaryText('{"content":"# Plan","summary":"Plan summary","title":"Implementation Plan","kind":"implementation_plan"}')).toBe('');
        expect(normalizeWorkCommentaryText('Разработка комплексного плана\n\n{"content":"# Plan","summary":"Plan summary","title":"Implementation Plan","kind":"implementation_plan"}')).toBe('Разработка комплексного плана');

        expect(shouldCreateWorkCommentary({
            ...message,
            id: 'assistant-python-raw-only',
            content: rawPayload,
        })).toBe(false);
    });

    it('normalizes Polybot run noise into structured timeline events', () => {
        expect(normalizeWorkCommentaryText('{"mode":"code"}')).toBe('');
        expect(normalizeWorkCommentaryText('Planning task\n\n{}')).toBe('');

        expect(parseProgressStatus({
            task_name: 'Project analysis',
            status: 'Planning task',
            event: 'task_boundary',
            is_active: true,
            run_id: 'run-polybot',
            timestamp: 600,
        } as TaskProgress)).toBeNull();

        const cargoCheck = commandEventToWorkEvent({
            run_id: 'run-polybot',
            command_id: 'cmd-cargo-check',
            event: 'command_succeeded',
            command: 'cargo check',
            status: 'completed',
            resultPreview: 'Finished `dev` profile',
            exitCode: 0,
            durationMs: 1250,
            timestamp: 610,
        });
        const cargoTest = commandEventToWorkEvent({
            run_id: 'run-polybot',
            command_id: 'cmd-cargo-test',
            event: 'command_failed',
            command: 'cargo test',
            status: 'failed',
            resultPreview: 'xgboost-sys build failed',
            exitCode: 101,
            durationMs: 4500,
            timestamp: 620,
        });
        const auditReject = parseProgressStatus({
            task_name: 'Project analysis',
            status: 'File updated, but VERIFICATION REJECTED: src/error.rs',
            event: 'phase',
            is_active: true,
            run_id: 'run-polybot',
            timestamp: 630,
        } as TaskProgress);

        const summaries = upsertWorkEvents(
            upsertWorkEvents({}, 'run-polybot', 'session-1', [cargoCheck, cargoTest].filter(Boolean) as WorkEvent[], 'running'),
            'run-polybot',
            'session-1',
            [auditReject].filter(Boolean) as WorkEvent[],
            'failed',
        );

        expect(summaries['run-polybot'].items.filter(item => item.type === 'command').map(item => item.command)).toEqual(['cargo check', 'cargo test']);
        expect(summaries['run-polybot'].items.find(item => item.type === 'review')).toMatchObject({
            label: 'Edit failed',
            status: 'failed',
        });
        expect(summaries['run-polybot'].items.some(item => item.target === '{"mode":"code"}' || item.target === 'Planning task')).toBe(false);
    });

    it('normalizes created Hub Tasks into first-class timeline events', () => {
        const createdTask = parseProgressStatus({
            task_name: 'Project task creation',
            status: 'Created Hub Task: Fix chat timeline completion state',
            event: 'hub_task_created',
            result: '✅ Task created with ID: 7',
            is_active: true,
            run_id: 'run-hub-tasks',
            timestamp: 640,
        } as TaskProgress);

        expect(createdTask).toMatchObject({
            type: 'task',
            label: 'Created Hub Task',
            target: 'Fix chat timeline completion state',
            status: 'completed',
        });

        const summaries = upsertWorkEvents({}, 'run-hub-tasks', 'session-1', [createdTask].filter(Boolean) as WorkEvent[], 'running');
        expect(summaries['run-hub-tasks'].counts.tasks).toBe(1);
        expect(aggregateTaskActivityItems(summaries).map(item => item.type)).toContain('task');
    });

    it('keeps budget-exceeded runs stopped instead of completing them after ask completion cleanup', () => {
        const stopped = upsertWorkEvents({}, 'run-stopped', 'session-1', [], 'stopped');
        const afterCompletion = completeRuntimeWorkSummaries(stopped, 'run-stopped', 'session-1', true);

        expect(afterCompletion['run-stopped'].status).toBe('stopped');

        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'создай задачи в Hub', timestamp: 1, run_id: 'run-stopped' }],
            todos: [],
            taskProgress: {
                task_name: 'Hub Task creation',
                status: 'Run stopped after budget limit',
                result: 'BUDGET_EXCEEDED',
                event: 'stopped',
                is_active: false,
                run_id: 'run-stopped',
                timestamp: 2,
            } as TaskProgress,
            workSummariesByTurn: afterCompletion,
            usageSnapshot: null,
            contextStatus: null,
            isLoading: false,
        });

        expect(taskRun?.status).toBe('stopped');
        expect(taskRun?.statusText).toBe('Run stopped after budget limit');
    });

    it('rebuilds persisted work summaries from saved assistant tool metadata', () => {
        const summaries = rebuildWorkSummariesFromMessages([
            {
                id: 'assistant-polybot-final',
                role: 'assistant',
                content: 'Комплексный анализ проекта Polybot\n\nКлючевые выводы и рекомендации.',
                timestamp: 700,
                run_id: 'run-polybot',
                turn_id: 'run-polybot',
                isStreaming: false,
                toolCalls: [
                    {
                        id: 'cmd-cargo-check',
                        name: 'execute_command',
                        arguments: { command: 'cargo check' },
                        result: 'Finished `dev` profile',
                        status: 'completed',
                        timestamp: 710,
                    },
                    {
                        id: 'write-error-rs',
                        name: 'write_file',
                        arguments: { path: 'src/error.rs' },
                        result: 'File updated, but VERIFICATION REJECTED: src/error.rs',
                        status: 'error',
                        timestamp: 720,
                    },
                ],
            },
        ], 'session-1');

        expect(summaries['run-polybot']).toMatchObject({
            status: 'completed',
            sessionId: 'session-1',
        });
        expect(summaries['run-polybot'].items.map(item => item.type)).toEqual(['command', 'review']);
        expect(summaries['run-polybot'].items.some(item => item.type === 'commentary')).toBe(false);
    });

    it('keeps assistant bubbles that carry implementation plan artifacts', () => {
        const message: ChatMessage = {
            id: 'assistant-plan-tool',
            role: 'assistant',
            content: '{"content":"# Plan","summary":"Plan summary","title":"Implementation Plan","kind":"implementation_plan"}',
            timestamp: 520,
            isStreaming: false,
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
                path: '.ricochet/artifacts/session-1/implementation_plan.md',
                content: '# Plan',
            }],
        };

        expect(hasPlanArtifact(message)).toBe(true);
        expect(shouldKeepAssistantBubble(message)).toBe(true);
        expect(shouldCreateWorkCommentary(message)).toBe(false);
        expect(isRenderableChatMessage(message)).toBe(true);
    });

    it('keeps final visible assistant text even when the terminal update still carries work payload', () => {
        const message: ChatMessage = {
            id: 'assistant-final-with-tool-metadata',
            role: 'assistant',
            content: 'Комплексный анализ проекта Polybot\n\nКлючевые выводы и рекомендации.',
            timestamp: 530,
            isStreaming: false,
            toolCalls: [{
                id: 'tool-read',
                name: 'read_file',
                arguments: { path: 'README.md' },
                status: 'completed',
            }],
        };

        expect(shouldKeepAssistantBubble(message)).toBe(true);
    });

    it('does not replace a long streamed final answer with a short terminal fragment', () => {
        const longAnswer = [
            'Комплексный анализ проекта Polybot',
            '',
            'Ключевые выводы:',
            '- Архитектура проекта разделена на ingestion, execution, analysis и monitoring.',
            '- Основные риски связаны с конфигурацией и тестовым покрытием.',
            '- Рекомендуется усилить интеграционные тесты и документацию.',
            '',
            'Детальный разбор модулей: '.repeat(40),
        ].join('\n');
        const messages: ChatMessage[] = [{
            id: 'assistant-final',
            role: 'assistant',
            content: longAnswer,
            timestamp: 100,
            isStreaming: true,
            run_id: 'run-1',
            turn_id: 'run-1',
        }];

        const next = upsertAssistantMessage(messages, {
            id: 'assistant-final',
            role: 'assistant',
            content: 'Комплексный анализ проекта Polybot. Ключевые выводы.',
            timestamp: 200,
            isStreaming: false,
            run_id: 'run-1',
            turn_id: 'run-1',
        });

        expect(next).toHaveLength(1);
        expect(next[0].isStreaming).toBe(false);
        expect(next[0].content).toBe(longAnswer);
    });

    it('appends implementation plan artifacts instead of replacing old activity placeholders', () => {
        const messages: ChatMessage[] = [
            { id: 'user-old', role: 'user', content: 'old request', timestamp: 100 },
            { id: 'activity-placeholder-old', role: 'assistant', content: '', timestamp: 110 },
            { id: 'user-new', role: 'user', content: 'create a plan', timestamp: 200 },
            { id: 'activity-placeholder-new', role: 'assistant', content: '', timestamp: 210 },
        ];
        const planMessage: ChatMessage = {
            id: 'assistant-plan-new',
            role: 'assistant',
            content: '',
            timestamp: 220,
            artifacts: [{
                id: 'plan-1',
                type: 'implementation_plan',
                title: 'Implementation Plan',
                path: '.ricochet/artifacts/session-1/implementation_plan.md',
                content: '# Plan',
            }],
        };

        const next = upsertAssistantMessage(messages, planMessage);

        expect(next).toHaveLength(5);
        expect(next[next.length - 1]?.id).toBe('assistant-plan-new');
        expect(next[1].id).toBe('activity-placeholder-old');
        expect(next[3].id).toBe('activity-placeholder-new');
    });

    it('updates implementation plan decision status in place without clearing history', () => {
        const messages: ChatMessage[] = [
            { id: 'user-1', role: 'user', content: 'create a plan', timestamp: 100 },
            {
                id: 'assistant-plan',
                role: 'assistant',
                content: '',
                timestamp: 110,
                artifacts: [{
                    id: 'plan-1',
                    type: 'implementation_plan',
                    title: 'Implementation Plan',
                    path: '.ricochet/artifacts/session-1/implementation_plan.md',
                    content: '# Plan',
                }],
            },
            { id: 'assistant-after', role: 'assistant', content: 'still here', timestamp: 120 },
        ];

        const next = applyPlanDecisionResult(messages, {
            session_id: 'session-1',
            artifact_id: 'plan-1',
            path: '.ricochet/artifacts/session-1/implementation_plan.md',
            decision: 'revise',
        });

        expect(next).toHaveLength(messages.length);
        expect(next.map(message => message.id)).toEqual(messages.map(message => message.id));
        expect((next[1] as any).artifacts[0].status).toBe('revision_requested');
        expect((next[1] as any).artifacts[0].decision).toBe('revise');
    });

    it('can match plan decision results by artifact path when session ids diverge', () => {
        const messages: ChatMessage[] = [
            {
                id: 'assistant-plan',
                role: 'assistant',
                content: '',
                timestamp: 110,
                artifacts: [{
                    id: 'plan-1',
                    type: 'implementation_plan',
                    title: 'Implementation Plan',
                    path: '.ricochet/artifacts/session-1/implementation_plan.md',
                    content: '# Plan',
                    session_id: 'visible-session',
                }],
            },
        ];
        const payload = {
            session_id: 'legacy-core-session',
            artifact_id: 'plan-1',
            path: '.ricochet/artifacts/session-1/implementation_plan.md',
            decision: 'implement',
            planApproved: true,
        };

        expect(hasMatchingPlanArtifact(messages, payload)).toBe(true);
        const next = applyPlanDecisionResult(messages, payload);
        expect((next[0] as any).artifacts[0].status).toBe('approved');
    });

    it('sanitizes legacy raw network errors into renderable error cards', () => {
        const raw = 'request failed: Post "https://open.bigmodel.cn/api/paas/v4/chat/completions": dial tcp: lookup open.bigmodel.cn: no such host';
        const errorInfo = chatErrorInfoFromRaw(raw);
        const message: ChatMessage = {
            id: 'err-1',
            role: 'assistant',
            content: '',
            errorInfo,
            timestamp: 100,
        };

        expect(errorInfo.kind).toBe('network');
        expect(errorInfo.retryable).toBe(true);
        expect(errorInfo.rawMessage).toBe(raw);
        expect(errorInfo.message).not.toMatch(/https?:\/\/|open\.bigmodel\.cn|dial tcp|lookup|no such host/i);
        expect(isRenderableChatMessage(message)).toBe(true);
    });

    it('sanitizes raw network status details but keeps diagnostics copyable', () => {
        const raw = 'Post "https://open.bigmodel.cn/api/paas/v4/chat/completions": dial tcp: lookup open.bigmodel.cn: no such host';
        const status = sanitizeNetworkStatusPayload({
            state: 'degraded',
            scope: 'provider',
            provider: 'zhipu',
            lastCheckedAt: 100,
            message: raw,
            details: {
                provider: {
                    state: 'degraded',
                    message: raw,
                    errorCode: 'network',
                },
            },
        });

        expect(status.message).not.toMatch(/https?:\/\/|open\.bigmodel\.cn|dial tcp|lookup|no such host/i);
        expect(status.details?.provider?.message).not.toMatch(/https?:\/\/|open\.bigmodel\.cn|dial tcp|lookup|no such host/i);
        expect(status.details?.provider?.rawMessage).toBe(raw);
    });

    it('finds the previous user prompt for manual retry', () => {
        const prompt = findRetryPromptBefore([
            { role: 'user', content: 'проанализируй проект', timestamp: 100 },
            { role: 'assistant', content: '', timestamp: 200 },
        ], { role: 'assistant', content: '', timestamp: 200 });

        expect(prompt).toBe('проанализируй проект');
    });
});
