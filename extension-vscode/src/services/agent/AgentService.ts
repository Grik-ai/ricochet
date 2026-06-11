import * as vscode from 'vscode';
import { CoreProcess } from '../../core-process';
import { ChatUpdatePayload } from '../../protocol/coreMessages';
import { SessionMetadata, SessionService } from '../session/SessionService';

interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'error';
    result?: string;
}

interface ChatMessage {
    id: string;
    role: string;
    content: string;
    toolCalls?: ToolCall[];
    isStreaming?: boolean;
}

export class AgentService {
    public activeSessionId: string | null = null;

    constructor(
        private readonly core: CoreProcess,
        private readonly postMessage: (message: any) => void,
        private readonly sessionService: SessionService,
        private readonly onSessionMetadataChanged?: (metadata: SessionMetadata) => void
    ) {
        this.core.onMessage('plan_updated', async () => {
            // Fetch fresh tasks and broadcast to UI
            const tasks = await this.core.send('get_tasks', {});
            this.postMessage({ type: 'tasks_updated', payload: tasks });
        });
    }

    public async handleMessage(message: any) {
        switch (message.type) {
            case 'start_session':
                await this.startSession(message.payload);
                break;
            case 'cancel_session':
            case 'cancel_generation': // Alias from webview
                await this.cancelSession();
                break;
            case 'create_task_ui':
                await this.core.send('create_task', message.payload);
                break;
            case 'move_task_column':
                await this.core.send('set_column', message.payload);
                break;
            case 'delete_task_ui':
                await this.core.send('delete_task', message.payload);
                break;
            case 'add_subtask_ui':
                await this.core.send('add_subtask', message.payload);
                break;
            case 'complete_task_ui':
                await this.core.send('complete_task', message.payload);
                break;
            case 'get_tasks':
                const tasks = await this.core.send('get_tasks', {});
                this.postMessage({ type: 'tasks_updated', payload: tasks });
                break;
        }
    }

    private async startSession(payload?: { prompt: string; model?: string; provider?: string; session_id?: string }) {
        const workspaceDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        const existingSessionId = payload?.session_id;
        this.activeSessionId = existingSessionId || await this.sessionService.createSession(workspaceDir, payload?.prompt || "Start autonomous task.");

        let prompt = payload?.prompt || "Start autonomous task.";

        if (existingSessionId) {
            if (payload?.prompt) {
                const metadata = await this.sessionService.updateSessionTitle(existingSessionId, payload.prompt);
                if (metadata) {
                    this.notifySessionMetadata(metadata);
                }
            }
            try {
                const sessionData = await this.sessionService.loadSession(existingSessionId);
                await this.core.send('hydrate_session', {
                    session_id: existingSessionId,
                    messages: sessionData?.messages || []
                });
            } catch (e) {
                console.error('[AgentService] Failed to hydrate existing session:', e);
            }
        } else {
            this.postMessage({
                type: 'session_created',
                payload: { id: this.activeSessionId, sessionId: this.activeSessionId }
            });
            await this.notifyActiveSessionMetadata();

            // 1. Hydrate Backend to ensure session exists
            try {
                await this.core.send('create_session', {
                    session_id: this.activeSessionId,
                    model_id: payload?.model,
                    provider_id: payload?.provider
                });
            } catch (e) {
                console.error('[AgentService] Failed to create session:', e);
                // Fallback to hydration if create_session isn't supported as expected
                await this.core.send('hydrate_session', {
                    session_id: this.activeSessionId,
                    messages: []
                }).catch(ce => console.error('[AgentService] Hydration fallback failed:', ce));
            }
        }

        // Notify start
        this.postMessage({ type: 'api_req_started' });



        try {
            // Send initial Prompt to Core
            // The core already handles tool definitions and system prompt internally.
            // Sending it here as part of user message is redundant and clutters the UI.
            await this.core.send('chat_message', {
                session_id: this.activeSessionId,
                content: prompt,
                role: 'user'
            });

            // The Go backend runs the autonomous loop internally.
            // When this promise resolves, the session loop has concluded in Go.
            this.postMessage({ type: 'ask_completion_result' });
        } catch (err: any) {
            console.error('[AgentService] Session failed:', err);
            this.postMessage({ type: 'process_error', payload: { message: err.message || 'Session failed' } });
            this.postMessage({ type: 'ask_completion_result' });
        }
    }

    public async onChatUpdate(payload: ChatUpdatePayload) {
        // Ignore updates not for this agent session
        if (payload.session_id !== this.activeSessionId) return;

        const msg = payload.message;
        if (!msg) return;

        // Forward to UI to show progress (streaming text)
        // The AgentView should eventually display the conversation
        // For now, we rely on 'say_text' for status updates in the mocked UI,
        // but let's also send the raw update so we can maybe render it later.
        // this.postMessage({ type: 'chat_update', payload });

        // If we have text content, show it as 'say_text'
        if (msg.content && msg.isStreaming) {
            this.postMessage({
                type: 'say_text',
                payload: { text: msg.content, partial: true }
            });
        }

        // Detect Completion (Stop)
        if (!msg.isStreaming && (!msg.toolCalls || msg.toolCalls.length === 0)) {
            this.postMessage({ type: 'ask_completion_result' }); // Marks as done in UI
        }
    }

    private async cancelSession() {
        if (this.activeSessionId) {
            const sid = this.activeSessionId;
            console.log('[AgentService] Cancelling session:', sid);

            // Mark as null immediately to ignore incoming messages for this ID
            this.activeSessionId = null;

            // Send abort signal to Core
            try {
                await this.core.send('abort_chat', { session_id: sid });
            } catch (e) {
                console.error('[AgentService] Failed to send abort_chat:', e);
            }

            // Notify UI that generation has stopped
            this.postMessage({ type: 'generation_cancelled' });
        }
    }

    private async notifyActiveSessionMetadata(): Promise<void> {
        if (!this.activeSessionId) return;
        const metadata = await this.sessionService.getSessionMetadata(this.activeSessionId);
        if (metadata) {
            this.notifySessionMetadata(metadata);
        }
    }

    private notifySessionMetadata(metadata: SessionMetadata): void {
        this.onSessionMetadataChanged?.(metadata);
    }
}
