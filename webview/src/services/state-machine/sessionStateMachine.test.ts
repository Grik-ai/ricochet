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
});
