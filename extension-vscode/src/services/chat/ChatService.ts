import * as vscode from 'vscode';
import { CoreProcess } from '../../core-process';
import { ChatUpdatePayload, UsageSnapshot } from '../../protocol/coreMessages';
import { parseSourceCodeDefinitionsForFile } from '../tree-sitter';
import { DiffService } from '../diff/DiffService';
import { SessionMetadata, SessionService } from '../session/SessionService';
import { formatChatErrorInfo } from './chatErrors';
import * as path from 'path';
import * as fs from 'fs';

export function isQueuedChatMessageResult(result: unknown): result is Record<string, any> {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    const record = result as Record<string, any>;
    const queuedMessage = record.message;
    return Boolean(
        queuedMessage &&
        typeof queuedMessage === 'object' &&
        (record.run_id || queuedMessage.run_id) &&
        (queuedMessage.id || record.message_id)
    );
}

export function normalizeQueuedMessagePayload(
    result: Record<string, any>,
    sessionId: string | null,
    runId: string | undefined,
    content: string | undefined
): Record<string, any> {
    const queuedMessage = result.message && typeof result.message === 'object' ? result.message : {};
    const normalizedSessionId = result.session_id || queuedMessage.session_id || sessionId || undefined;
    const normalizedRunId = result.run_id || queuedMessage.run_id || runId;
    const contextFiles = result.context_files || result.contextFiles || queuedMessage.context_files || queuedMessage.contextFiles || [];
    return {
        ...result,
        session_id: normalizedSessionId,
        sessionId: normalizedSessionId,
        run_id: normalizedRunId,
        runId: normalizedRunId,
        context_files: contextFiles,
        contextFiles,
        message_id: result.message_id || queuedMessage.id,
        queue_length: result.queue_length,
        status: result.status || 'queued',
        text: queuedMessage.text || content,
        message: {
            ...queuedMessage,
            session_id: queuedMessage.session_id || normalizedSessionId,
            run_id: queuedMessage.run_id || normalizedRunId,
            text: queuedMessage.text || content,
            context_files: contextFiles,
            contextFiles,
        },
    };
}

export class ChatService {
    private isLiveModeEnabled = false;
    private diffService: DiffService;
    private readonly workspaceStateKey = 'ricochet_active_session_id';
    private readonly hydratedCoreSessions = new Set<string>();
    private activeRunIdValue: string | null = null;

    // Throttling for chat updates to prevent webview crash
    private pendingChatUpdate: any = null;
    private chatUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly THROTTLE_MS = 300; // ~3 updates per second - aggressive rate limiting for stability

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly core: CoreProcess,
        private readonly postMessage: (msg: any) => void,
        private readonly sessionService: SessionService,
        private readonly onSessionMetadataChanged?: (metadata: SessionMetadata) => void
    ) {
        this.diffService = DiffService.getInstance();
    }

    public get activeSessionId(): string | null {
        return this.context.workspaceState.get<string>(this.workspaceStateKey) || null;
    }

    public set activeSessionId(sessionId: string | null) {
        console.log(`[ChatService] Setting activeSessionId to: ${sessionId}`);
        this.context.workspaceState.update(this.workspaceStateKey, sessionId);
    }

    public get activeRunId(): string | null {
        return this.activeRunIdValue;
    }

    public setActiveSession(sessionId: string) {
        this.activeSessionId = sessionId;
    }

    public async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'send_message':
                const requestedRunId = message.payload?.run_id;
                if (!this.activeRunIdValue) {
                    this.activeRunIdValue = requestedRunId || null;
                }
                if (message.payload?.session_id && message.payload.session_id !== this.activeSessionId) {
                    this.activeSessionId = message.payload.session_id;
                }

                // If UI did not pass a session_id, this is a fresh start from the welcome screen.
                // Do not reuse the persisted active session, because that reopens an old chat.
                if (!message.payload?.session_id) {
                    const workspaces = vscode.workspace.workspaceFolders;
                    if (workspaces && workspaces.length > 0) {
                        this.activeSessionId = await this.sessionService.createSession(workspaces[0].uri.fsPath, message.payload.content);
                        console.log('[ChatService] Auto-created session:', this.activeSessionId);
                        message.payload.session_id = this.activeSessionId;
                        this.postMessage({
                            type: 'session_created',
                            payload: { id: this.activeSessionId, sessionId: this.activeSessionId }
                        });
                        await this.notifySessionMetadata(this.activeSessionId);
                    }
                }

                if (this.activeSessionId) {
                    message.payload.session_id = this.activeSessionId;
                    await this.ensureCoreSessionHydrated(this.activeSessionId);
                }

                const requestSessionId = this.activeSessionId;
                let timeoutWarningTimer: ReturnType<typeof setTimeout> | null = null;

                // Save user message to session
                if (requestSessionId) {
                    await this.sessionService.appendMessage(requestSessionId, {
                        role: 'user',
                        content: message.payload.content,
                        timestamp: Date.now(),
                        sessionId: requestSessionId,
                        run_id: requestedRunId,
                        turn_id: requestedRunId,
                        contextFiles: message.payload.context_files || [],
                        context_files: message.payload.context_files || []
                    });
                    await this.notifySessionMetadata(requestSessionId);
                }

                try {
                    timeoutWarningTimer = setTimeout(() => {
                        if (requestedRunId && this.activeRunIdValue && this.activeRunIdValue !== requestedRunId) return;
                        this.postMessage({
                            type: 'task_progress',
                            payload: {
                                session_id: requestSessionId,
                                run_id: requestedRunId,
                                turn_id: requestedRunId,
                                event: 'timeout_warning',
                                task_name: 'Agent work',
                                status: 'Still working. The agent has not sent a final completion yet.',
                                summary: 'Still working',
                                is_active: true,
                                result: 'RUNNING',
                                timestamp: Date.now(),
                            }
                        });
                    }, 90_000);
                    const result = await this.core.send('chat_message', message.payload);
                    if (isQueuedChatMessageResult(result)) {
                        const queuedPayload = normalizeQueuedMessagePayload(result, requestSessionId, requestedRunId, message.payload.content);
                        console.log('[ChatService] Posting message_queued', {
                            session_id: queuedPayload.session_id,
                            run_id: queuedPayload.run_id,
                            message_id: queuedPayload.message_id,
                        });
                        this.postMessage({ type: 'message_queued', payload: queuedPayload });
                        if (!requestedRunId || this.activeRunIdValue === requestedRunId) {
                            this.activeRunIdValue = null;
                        }
                        return;
                    }

                    // The core promise resolves when the autonomous loop has concluded.
                    // Some short/read-only runs can finish without a final chat_update,
                    // so always release the webview input as a completion fallback.
                    console.log('[ChatService] Posting ask_completion_result', { session_id: requestSessionId, run_id: requestedRunId });
                    this.postMessage({ type: 'ask_completion_result', payload: { session_id: requestSessionId, run_id: requestedRunId } });
                    if (!requestedRunId || this.activeRunIdValue === requestedRunId) {
                        this.activeRunIdValue = null;
                    }
                } catch (e: any) {
                    console.error('[ChatService] Error sending chat message:', e);
                    const errorInfo = this.formatChatError(e);
                    this.postMessage({
                        type: 'chat_update',
                        payload: {
                            session_id: requestSessionId,
                            run_id: requestedRunId,
                            message: {
                                id: Date.now().toString(),
                                role: 'assistant',
                                content: '',
                                errorInfo,
                                timestamp: Date.now(),
                                isStreaming: false,
                                metadata: { tokensIn: 0, tokensOut: 0, totalCost: 0, contextLimit: 0 },
                                sessionId: requestSessionId,
                                run_id: requestedRunId
                            }
                        }
                    });
                    console.log('[ChatService] Posting ask_completion_result after error', { session_id: requestSessionId, run_id: requestedRunId });
                    this.postMessage({ type: 'ask_completion_result', payload: { session_id: requestSessionId, run_id: requestedRunId } });
                    if (!requestedRunId || this.activeRunIdValue === requestedRunId) {
                        this.activeRunIdValue = null;
                    }
                } finally {
                    if (timeoutWarningTimer) {
                        clearTimeout(timeoutWarningTimer);
                    }
                }
                break;

            case 'toggle_live_mode':
                await this.toggleLiveMode();
                break;

            case 'clear_chat':
                await this.clearChat();
                break;

            case 'execute_command':
                this.executeCommand(message.payload.command);
                break;

            case 'search_files':
                await this.searchFiles(message.payload.query);
                break;

            case 'parse_file':
                await this.parseFile(message.payload.path);
                break;

            case 'audio_start':
            case 'audio_chunk':
            case 'audio_stop':
                await this.core.send(message.type, message.payload || {});
                break;

            case 'get_state':
                const state = await this.core.send('get_state', { session_id: message.payload.sessionId });
                this.postMessage({ type: 'state', payload: state });
                break;

            case 'show_native_diff':
                try {
                    const { path, newContent, targetContent } = message.payload as any;
                    if (targetContent !== undefined) {
                        await this.diffService.showPartialDiff(path, targetContent, newContent);
                    } else {
                        await this.diffService.showDiff(path, newContent);
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to show diff: ${e.message}`);
                }
                break;
        }
    }

    public async onChatUpdate(payload: ChatUpdatePayload): Promise<void> {
        if (!this.belongsToActiveSession(payload)) return;
        if (payload.usage) {
            await this.onUsageUpdate(payload.usage);
        }

        const isFinalMessage = payload.message?.isStreaming === false || payload.done === true;

        // Final messages bypass throttle and flush immediately
        if (isFinalMessage) {
            this.flushPendingUpdate();
            this.postChatUpdate(payload);

            // Check for pending edits in tool calls. The core can either ask the extension
            // to review an edit via propose_edit, or apply an auto-approved edit directly.
            // Register both running and completed edit tools so the review bar/decorations
            // still appear after auto-approved writes.
            const toolCalls = payload.message?.toolCalls;
            if (toolCalls && toolCalls.length > 0) {
                for (const tool of toolCalls as any[]) {
                    if (tool.status === 'completed') {
                        this.registerToolEditProposal(tool);
                    }
                }
            }

            // Save to session
            if (this.activeSessionId && payload.message && !(payload.message as any).partial) {
                await this.sessionService.appendMessage(this.activeSessionId, {
                    ...payload.message,
                    timestamp: Date.now()
                });
            }
            return;
        }

        // Streaming updates are throttled
        this.pendingChatUpdate = payload;

        if (!this.chatUpdateTimer) {
            // Send first update immediately, then throttle subsequent ones
            this.postChatUpdate(payload);
            this.chatUpdateTimer = setTimeout(() => {
                this.chatUpdateTimer = null;
                if (this.pendingChatUpdate) {
                    this.postChatUpdate(this.pendingChatUpdate);
                    this.pendingChatUpdate = null;
                }
            }, this.THROTTLE_MS);
        }
    }

    public async onUsageUpdate(payload: UsageSnapshot): Promise<void> {
        const sessionId = payload.sessionId || this.activeSessionId;
        if (!sessionId || (this.activeSessionId && sessionId !== this.activeSessionId)) return;

        const scopedPayload = { ...payload, sessionId, session_id: (payload as any).session_id || sessionId, run_id: (payload as any).run_id || this.activeRunIdValue || undefined };
        await this.sessionService.updateUsage(sessionId, scopedPayload);
        this.postMessage({ type: 'usage_update', payload: scopedPayload });
        await this.notifySessionMetadata(sessionId);
    }

    public acceptsRuntimePayload(payload: any): boolean {
        return this.belongsToActiveSession(payload);
    }

    public async cancelActiveChatRuntime(reason = 'session_switch'): Promise<void> {
        const sessionId = this.activeSessionId;
        if (!sessionId) return;

        this.flushPendingUpdate();
        this.pendingChatUpdate = null;
        this.activeRunIdValue = null;

        try {
            await this.core.send('abort_chat', { session_id: sessionId });
        } catch (e) {
            console.error(`[ChatService] Failed to abort active chat runtime (${reason}):`, e);
        }

        this.postMessage({ type: 'generation_cancelled', payload: { session_id: sessionId } });
    }

    private async ensureCoreSessionHydrated(sessionId: string): Promise<void> {
        if (this.hydratedCoreSessions.has(sessionId)) return;

        const sessionData = await this.sessionService.loadSession(sessionId);
        try {
            await this.core.send('hydrate_session', {
                session_id: sessionId,
                messages: sessionData?.messages || []
            });
            this.hydratedCoreSessions.add(sessionId);
        } catch (hydrateError) {
            console.error('[ChatService] Failed to hydrate core session:', hydrateError);
            throw hydrateError;
        }
    }

    private belongsToActiveSession(payload: ChatUpdatePayload): boolean {
        const payloadSessionId = payload.session_id || (payload.message as any)?.sessionId;
        return !payloadSessionId || !this.activeSessionId || payloadSessionId === this.activeSessionId;
    }

    private postChatUpdate(payload: ChatUpdatePayload): void {
        if (this.belongsToActiveSession(payload)) {
            this.postMessage({ type: 'chat_update', payload });
        }
    }

    private async notifySessionMetadata(sessionId: string): Promise<void> {
        const metadata = await this.sessionService.getSessionMetadata(sessionId);
        if (!metadata) return;

        this.onSessionMetadataChanged?.(metadata);
    }

    private formatChatError(error: any) {
        return formatChatErrorInfo(error);
    }

    private registerToolEditProposal(tool: any): void {
        const toolName = String(tool?.name || '');
        if (!/(write|edit|replace)/.test(toolName)) return;

        const args = this.parseToolArguments(tool.arguments);
        let filePath = args.TargetFile || args.targetFile || args.path || args.file;
        if (!filePath) return;

        if (!path.isAbsolute(filePath) && vscode.workspace.workspaceFolders) {
            filePath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath);
        }

        const proposal = this.buildEditProposal(filePath, toolName, args);
        if (!proposal) return;

        this.diffService.registerPendingEdit(filePath, proposal.newContent, {
            originalContent: proposal.originalContent,
            proposalId: tool.id,
            tool: toolName
        });
    }

    private parseToolArguments(rawArgs: unknown): Record<string, any> {
        if (!rawArgs) return {};
        if (typeof rawArgs !== 'string') return rawArgs as Record<string, any>;

        try {
            return JSON.parse(rawArgs || "{}");
        } catch {
            return {};
        }
    }

    private buildEditProposal(filePath: string, toolName: string, args: Record<string, any>): { originalContent?: string; newContent: string } | undefined {
        const currentContent = this.readTextIfExists(filePath);

        if (toolName === 'write_file' || toolName === 'write_to_file') {
            const newContent = Object.prototype.hasOwnProperty.call(args, 'content')
                ? args.content
                : args.CodeContent;
            if (typeof newContent !== 'string') return undefined;
            if (currentContent === newContent) return undefined;
            return {
                originalContent: currentContent,
                newContent
            };
        }

        const target = args.TargetContent || args.targetContent || args.target || '';
        const replacement = args.ReplacementContent || args.replacementContent || args.replacement || '';
        if (!target) return undefined;

        if (currentContent !== undefined) {
            if (currentContent.includes(target)) {
                const newContent = currentContent.replace(target, replacement);
                if (newContent === currentContent) return undefined;
                return {
                    originalContent: currentContent,
                    newContent
                };
            }

            if (replacement && currentContent.includes(replacement)) {
                return {
                    originalContent: currentContent.replace(replacement, target),
                    newContent: currentContent
                };
            }
        }

        return undefined;
    }

    private readTextIfExists(filePath: string): string | undefined {
        try {
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf8');
            }
        } catch (e) {}
        return undefined;
    }

    private flushPendingUpdate(): void {
        if (this.chatUpdateTimer) {
            clearTimeout(this.chatUpdateTimer);
            this.chatUpdateTimer = null;
        }
        if (this.pendingChatUpdate) {
            this.postChatUpdate(this.pendingChatUpdate);
            this.pendingChatUpdate = null;
        }
    }

    private async toggleLiveMode(): Promise<void> {
        const requestedState = !this.isLiveModeEnabled;

        const result = await this.core.send('set_live_mode', {
            enabled: requestedState
        }) as { enabled?: boolean; error?: string };

        console.log('ChatService: Live Mode Result from Core:', result);

        this.isLiveModeEnabled = result?.enabled ?? false;

        this.postMessage({
            type: 'live_mode_status',
            payload: result
        });

        if (result?.error) {
            vscode.window.showWarningMessage(`Ether: ${result.error}`);
        } else {
            vscode.window.showInformationMessage(
                `Ether ${this.isLiveModeEnabled ? 'enabled' : 'disabled'}`
            );
        }
    }

    private async clearChat(): Promise<void> {
        await this.core.send('clear_chat', {});
        this.postMessage({ type: 'chat_cleared' });
    }

    private async executeCommand(command: string): Promise<void> {
        if (!command) return;

        if (command === '/accept-all') {
            const edits = this.diffService.getPendingEdits();
            const files = edits.map(edit => edit.filePath).filter(Boolean);
            const proposalIds = edits.map(edit => edit.proposalId).filter(Boolean);
            for (const edit of edits) {
                await this.diffService.applyPendingEdit(edit.filePath);
            }
            this.postMessage({
                type: 'edit_approval_resolved',
                payload: {
                    decision: 'accepted',
                    files,
                    proposalIds,
                    session_id: this.activeSessionId,
                    run_id: this.activeRunIdValue || undefined,
                    timestamp: Date.now()
                }
            });
            this.postMessage({
                type: 'pending_edits',
                payload: {
                    session_id: this.activeSessionId,
                    run_id: this.activeRunIdValue || undefined,
                    edits: []
                }
            });
            return;
        }

        if (command === '/reject-all') {
            const edits = this.diffService.getPendingEdits();
            const files = edits.map(edit => edit.filePath).filter(Boolean);
            const proposalIds = edits.map(edit => edit.proposalId).filter(Boolean);
            for (const edit of edits) {
                await this.diffService.rejectPendingEdit(edit.filePath);
            }
            this.postMessage({
                type: 'edit_approval_resolved',
                payload: {
                    decision: 'rejected',
                    files,
                    proposalIds,
                    session_id: this.activeSessionId,
                    run_id: this.activeRunIdValue || undefined,
                    timestamp: Date.now()
                }
            });
            this.postMessage({
                type: 'pending_edits',
                payload: {
                    session_id: this.activeSessionId,
                    run_id: this.activeRunIdValue || undefined,
                    edits: []
                }
            });
            vscode.window.showInformationMessage(`Discarded all ${edits.length} pending changes.`);
            return;
        }

        const terminal = vscode.window.terminals.find(t => t.name === 'Ricochet')
            || vscode.window.createTerminal('Ricochet');
        terminal.show();
        terminal.sendText(command);
    }

    private async searchFiles(query: string): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            this.postMessage({ type: 'file_search_results', payload: [] });
            return;
        }

        const globPattern = `**/*${query || ''}*`;
        const excludePattern = '**/{node_modules,.git,dist,out,build,.next}/**';

        try {
            const uris = await vscode.workspace.findFiles(globPattern, excludePattern, 20);
            const results = await Promise.all(uris.map(async uri => {
                const relativePath = vscode.workspace.asRelativePath(uri);
                let size: number | undefined;
                try {
                    size = (await vscode.workspace.fs.stat(uri)).size;
                } catch {
                    size = undefined;
                }
                return {
                    path: relativePath,
                    name: uri.path.split('/').pop() || relativePath,
                    kind: 'file',
                    size
                };
            }));

            this.postMessage({
                type: 'file_search_results',
                payload: results
            });
        } catch (e) {
            console.error('File search failed:', e);
            this.postMessage({ type: 'file_search_results', payload: [] });
        }
    }

    private async parseFile(filePath: string): Promise<void> {
        try {
            let fullPath = filePath;
            if (!filePath.startsWith('/') && vscode.workspace.workspaceFolders) {
                fullPath = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, filePath).fsPath;
            }

            const definitions = await parseSourceCodeDefinitionsForFile(fullPath);
            this.postMessage({
                type: 'parse_file_result',
                payload: {
                    path: filePath,
                    definitions: definitions || 'No definitions found.'
                }
            });
        } catch (e: any) {
            this.postMessage({
                type: 'parse_file_error',
                payload: {
                    path: filePath,
                    error: e.message
                }
            });
        }
    }
}
