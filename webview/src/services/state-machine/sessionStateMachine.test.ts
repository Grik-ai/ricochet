import { describe, expect, it } from 'vitest';
import { createSessionStateMachine, SessionState } from './sessionStateMachine';

describe('session state machine completion', () => {
    it('treats final chat_update with no active work as completed from streaming', () => {
        const machine = createSessionStateMachine();

        machine.send({ type: 'start_session', content: 'Analyze project' });
        machine.send({ type: 'session_created', sessionId: 'session-1' });
        machine.send({ type: 'api_req_started' });

        expect(machine.getState()).toBe(SessionState.streaming);

        machine.send({
            type: 'chat_update',
            message: {
                id: 'assistant-final',
                role: 'assistant',
                content: 'Analysis complete.',
                timestamp: 100,
                isStreaming: false,
                toolCalls: [],
            },
        });

        expect(machine.getState()).toBe(SessionState.completed);
        expect(machine.getUiState()).toEqual({
            showSpinner: false,
            showCancelButton: false,
            isActive: false,
        });
        expect(machine.getContext()).toMatchObject({
            missionStatus: 'completed',
            parentTurnStatus: 'completed',
            activeToolCalls: {},
        });
    });

    it('treats final assistant chat_update without isStreaming as completed from streaming', () => {
        const machine = createSessionStateMachine();

        machine.send({ type: 'start_session', content: 'Analyze project' });
        machine.send({ type: 'session_created', sessionId: 'session-1' });
        machine.send({ type: 'api_req_started' });

        machine.send({
            type: 'chat_update',
            message: {
                id: 'assistant-final-no-flag',
                role: 'assistant',
                content: 'Analysis complete.',
                timestamp: 100,
                toolCalls: [],
            },
        });

        expect(machine.getState()).toBe(SessionState.completed);
        expect(machine.getUiState()).toEqual({
            showSpinner: false,
            showCancelButton: false,
            isActive: false,
        });
    });

    it('treats budget exceeded progress as terminal stopped state', () => {
        const machine = createSessionStateMachine();

        machine.send({ type: 'session_created', sessionId: 'session-1' });
        machine.send({ type: 'api_req_started' });
        machine.send({
            type: 'task_progress',
            payload: {
                session_id: 'session-1',
                run_id: 'run-1',
                event: 'stopped',
                status: 'Run stopped after budget limit. The agent reached its internal exploration budget and returned the latest available result.',
                result: 'budget_exceeded',
                is_active: false,
            },
        });

        expect(machine.getState()).toBe(SessionState.stopped);
        expect(machine.getUiState()).toEqual({
            showSpinner: false,
            showCancelButton: false,
            isActive: false,
        });
        expect(machine.getContext()).toMatchObject({
            missionStatus: 'stopped',
            parentTurnStatus: 'failed',
        });
    });

    it('does not keep composer active for non-mission worker leftovers after completion', () => {
        const machine = createSessionStateMachine();

        machine.send({ type: 'session_created', sessionId: 'session-1' });
        machine.send({
            type: 'chat_update',
            message: {
                id: 'assistant-tools',
                role: 'assistant',
                content: '',
                timestamp: 100,
                isStreaming: true,
                toolCalls: [
                    {
                        id: 'tool-worker',
                        name: 'command_status',
                        status: 'completed',
                        arguments: JSON.stringify({ id: 'agent-reviewer' }),
                    },
                ],
            },
        });

        expect(machine.getUiState().isActive).toBe(true);

        machine.send({ type: 'ask_completion_result', payload: { session_id: 'session-1', run_id: 'run-1' } });

        expect(machine.getState()).toBe(SessionState.completed);
        expect(machine.getUiState()).toEqual({
            showSpinner: false,
            showCancelButton: false,
            isActive: false,
        });
        expect(machine.getContext().workers['agent-reviewer']).toMatchObject({
            status: 'completed',
            isActive: false,
        });
    });

    it('clears active tool calls on completion and process errors', () => {
        const machine = createSessionStateMachine();

        machine.send({ type: 'start_session', content: 'Analyze project' });
        machine.send({ type: 'session_created', sessionId: 'session-1' });
        machine.send({ type: 'api_req_started' });
        machine.send({
            type: 'chat_update',
            message: {
                id: 'assistant-tool',
                role: 'assistant',
                content: '',
                timestamp: 100,
                isStreaming: true,
                toolCalls: [{
                    id: 'tool-read',
                    name: 'read_file',
                    status: 'running',
                    arguments: JSON.stringify({ path: 'README.md' }),
                }],
            },
        });

        expect(Object.keys(machine.getContext().activeToolCalls)).toEqual(['tool-read']);

        machine.send({ type: 'ask_completion_result', payload: { session_id: 'session-1', run_id: 'run-1' } });

        expect(machine.getContext().activeToolCalls).toEqual({});

        const errorMachine = createSessionStateMachine();
        errorMachine.send({ type: 'start_session', content: 'Analyze project' });
        errorMachine.send({ type: 'session_created', sessionId: 'session-1' });
        errorMachine.send({ type: 'api_req_started' });
        errorMachine.send({
            type: 'chat_update',
            message: {
                id: 'assistant-tool',
                role: 'assistant',
                content: '',
                timestamp: 100,
                isStreaming: true,
                toolCalls: [{
                    id: 'tool-read',
                    name: 'read_file',
                    status: 'running',
                    arguments: JSON.stringify({ path: 'README.md' }),
                }],
            },
        });
        errorMachine.send({ type: 'process_error', error: 'network failed' });

        expect(errorMachine.getState()).toBe(SessionState.error);
        expect(errorMachine.getContext().activeToolCalls).toEqual({});
    });

    it('stays completed after timeout warning, final message, ask completion, and stale progress', () => {
        const machine = createSessionStateMachine();

        machine.send({ type: 'session_created', sessionId: 'session-1' });
        machine.send({ type: 'api_req_started' });
        machine.send({
            type: 'task_progress',
            payload: {
                session_id: 'session-1',
                run_id: 'run-1',
                event: 'timeout_warning',
                task_name: 'Agent work',
                status: 'Still working. The agent has not sent a final completion yet.',
                result: 'RUNNING',
                is_active: true,
            },
        });

        expect(machine.getState()).toBe(SessionState.streaming);
        expect(machine.getUiState().isActive).toBe(true);

        machine.send({
            type: 'chat_update',
            message: {
                id: 'assistant-final',
                role: 'assistant',
                content: 'Done.',
                timestamp: 200,
                isStreaming: false,
                toolCalls: [],
            },
        });
        machine.send({ type: 'ask_completion_result', payload: { session_id: 'session-1', run_id: 'run-1' } });

        expect(machine.getState()).toBe(SessionState.completed);
        expect(machine.getUiState()).toEqual({
            showSpinner: false,
            showCancelButton: false,
            isActive: false,
        });

        machine.send({
            type: 'task_progress',
            payload: {
                session_id: 'session-1',
                run_id: 'run-1',
                event: 'timeout_warning',
                task_name: 'Agent work',
                status: 'Still working. The agent has not sent a final completion yet.',
                result: 'RUNNING',
                is_active: true,
            },
        });

        expect(machine.getState()).toBe(SessionState.completed);
        expect(machine.getUiState()).toEqual({
            showSpinner: false,
            showCancelButton: false,
            isActive: false,
        });
        expect(machine.getContext()).toMatchObject({
            missionStatus: 'completed',
            parentTurnStatus: 'completed',
            activeToolCalls: {},
            pendingChoice: undefined,
            pendingTool: undefined,
        });
    });

    it('ask completion clears waiting approval and waiting input when no mission workers block completion', () => {
        const approvalMachine = createSessionStateMachine();
        approvalMachine.send({ type: 'session_created', sessionId: 'session-1' });
        approvalMachine.send({
            type: 'ask_tool',
            partial: false,
            payload: { toolId: 'tool-approval', name: 'read_file', args: { path: 'README.md' } },
        });

        expect(approvalMachine.getState()).toBe(SessionState.waiting_approval);
        expect(approvalMachine.getUiState().isActive).toBe(true);

        approvalMachine.send({ type: 'ask_completion_result', payload: { session_id: 'session-1', run_id: 'run-1' } });

        expect(approvalMachine.getState()).toBe(SessionState.completed);
        expect(approvalMachine.getUiState().isActive).toBe(false);
        expect(approvalMachine.getContext().pendingTool).toBeUndefined();

        const inputMachine = createSessionStateMachine();
        inputMachine.send({ type: 'session_created', sessionId: 'session-1' });
        inputMachine.send({ type: 'ask_followup', partial: false });

        expect(inputMachine.getState()).toBe(SessionState.waiting_input);
        expect(inputMachine.getUiState().isActive).toBe(true);

        inputMachine.send({ type: 'ask_completion_result', payload: { session_id: 'session-1', run_id: 'run-1' } });

        expect(inputMachine.getState()).toBe(SessionState.completed);
        expect(inputMachine.getUiState().isActive).toBe(false);
        expect(inputMachine.getContext().pendingChoice).toBeUndefined();
    });

    it('keeps mission workers active after parent ask completion until worker completion arrives', () => {
        const machine = createSessionStateMachine();

        machine.send({ type: 'start_session', content: 'Analyze project with workers' });
        machine.send({ type: 'session_created', sessionId: 'session-1' });
        machine.send({ type: 'api_req_started' });
        machine.send({
            type: 'task_progress',
            payload: {
                session_id: 'session-1',
                run_id: 'run-1',
                agent_identifier: 'agent-reviewer',
                task_name: 'Reviewer',
                status: 'running',
                event: 'worker_running',
                is_active: true,
            },
        });

        machine.send({ type: 'ask_completion_result', payload: { session_id: 'session-1', run_id: 'run-1' } });

        expect(machine.getState()).toBe(SessionState.streaming);
        expect(machine.getUiState().isActive).toBe(true);
        expect(machine.getContext()).toMatchObject({
            missionStatus: 'running',
            parentTurnStatus: 'completed',
        });

        machine.send({
            type: 'task_progress',
            payload: {
                session_id: 'session-1',
                run_id: 'run-1',
                agent_identifier: 'agent-reviewer',
                task_name: 'Reviewer',
                status: 'completed',
                result: 'COMPLETED',
                event: 'worker_completed',
                is_active: false,
            },
        });

        expect(machine.getState()).toBe(SessionState.completed);
        expect(machine.getUiState().isActive).toBe(false);
        expect(machine.getContext().workers['agent-reviewer']).toMatchObject({
            status: 'completed',
            isActive: false,
        });
    });
});
