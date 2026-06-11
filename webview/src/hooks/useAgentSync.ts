import { useEffect } from 'react';
import { useVSCodeApi } from './useVSCodeApi';
import { useAgentStateMachine } from './useAgentStateMachine';
import { normalizeChatUpdate, normalizeInteractionRequest, normalizeTaskProgress } from '../types/protocol';

/**
 * useAgentSync
 *
 * Bridges incoming VS Code extension messages to the global Agent State Machine.
 * Ensures that the Mission Dashboard and other AI-aware components stay in sync
 * regardless of which view (Chat, History, MCP) is currently active.
 */
export function useAgentSync(agentState: ReturnType<typeof useAgentStateMachine>) {
    const { onMessage } = useVSCodeApi();
    const { send } = agentState;

    useEffect(() => {
        const unsubscribe = onMessage((message: any) => {
            switch (message.type) {
                case 'session_created':
                    send({ type: 'session_created', sessionId: message.payload?.sessionId });
                    break;
                case 'api_req_started':
                    send({ type: 'api_req_started' });
                    break;
                case 'say_text':
                    send({ type: 'say_text', payload: message.payload });
                    break;
                case 'ask_tool':
                    send({ type: 'ask_tool', payload: message.payload, partial: message.payload?.partial });
                    break;
                case 'ask_user_choice':
                case 'request_permission':
                    {
                        const request = normalizeInteractionRequest(message);
                        if (request) {
                            send({ type: 'ask_user_choice', payload: request });
                        }
                    }
                    break;
                case 'ask_completion_result':
                    send({ type: 'ask_completion_result' });
                    break;
                case 'permission_response_received':
                    send({ type: 'submit_input' });
                    break;
                case 'error':
                    send({ type: 'process_error', error: message.payload?.message || 'Unknown error' });
                    break;
                case 'chat_update':
                    {
                        const update = normalizeChatUpdate(message);
                        if (update?.message) {
                            send({ type: 'chat_update', message: update.message });
                        }
                    }
                    break;
                case 'task_progress':
                    {
                        const progress = normalizeTaskProgress(message);
                        if (progress) {
                            send({ type: 'task_progress', payload: progress });
                        }
                    }
                    break;
                case 'process_error':
                    send({ type: 'process_error', error: message.payload?.message || 'Unknown error' });
                    break;
            }
        });

        return () => {
            unsubscribe();
        };
    }, [onMessage, send]);
}
