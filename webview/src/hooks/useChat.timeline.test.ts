import { describe, expect, it } from 'vitest';
import {
    activityToWorkEvent,
    buildTaskRunViewModel,
    buildTaskTokenUsage,
    classifyTool,
    closeEditRows,
    commandEventToWorkEvent,
    hasPlanArtifact,
    markWorkSummaryActivityHint,
    normalizeHubTasksPayload,
    normalizeWorkCommentaryText,
    parseProgressStatus,
    resolveRuntimeTurnIdForEvent,
    shouldCreateWorkCommentary,
    shouldKeepAssistantBubble,
    toolLifecycleEventToWorkEvent,
    upsertWorkEvents,
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
            title: 'проанализируй проект',
            status: 'running',
            completedChecklistCount: 1,
            totalChecklistCount: 2,
            tokenUsage: { used: 52_300, max: 1_000_000, percent: 5 },
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

    it('summarizes workers and reports failed worker attention reason', () => {
        const taskRun = buildTaskRunViewModel({
            messages: [{ id: 'u1', role: 'user', content: 'запусти рой агентов', timestamp: 100 }],
            todos: [],
            hubTasks: [],
            workers: [
                { id: 'w1', name: 'Audit worker', status: 'running', isActive: true },
                { id: 'w2', name: 'Tests worker', status: 'failed', isActive: false },
                { id: 'w3', name: 'Docs worker', status: 'queued', isActive: false },
            ],
            taskProgress: null,
            workSummariesByTurn: {},
            usageSnapshot: null,
            contextStatus: null,
            isLoading: true,
        });

        expect(taskRun?.workerSummary).toBe('1 worker running · 1 queued · 1 failed');
        expect(taskRun?.status).toBe('failed');
        expect(taskRun?.attentionReason).toBe('Worker failed: Tests worker');
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
            type: 'edit',
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
            type: 'edit',
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
        expect(normalizeWorkCommentaryText('{"content":"# Plan","summary":"Plan summary","title":"Implementation Plan","kind":"implementation_plan"}')).toBe('');
        expect(normalizeWorkCommentaryText('Разработка комплексного плана\n\n{"content":"# Plan","summary":"Plan summary","title":"Implementation Plan","kind":"implementation_plan"}')).toBe('Разработка комплексного плана');

        expect(shouldCreateWorkCommentary({
            ...message,
            id: 'assistant-python-raw-only',
            content: rawPayload,
        })).toBe(false);
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
