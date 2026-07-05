import * as vscode from 'vscode';
import { CoreProcess } from './core-process';
import { McpServerManager } from './services/mcp/McpServerManager';
import { McpHub } from './services/mcp/McpHub';
import { ShadowCheckpointService } from './services/checkpoints/ShadowCheckpointService';
import { SessionMetadata, SessionService } from './services/session/SessionService';
import { ChatService } from './services/chat/ChatService';
import { McpService } from './services/mcp/McpService';
import { AgentService } from './services/agent/AgentService';
import * as path from 'path';
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import { DiffService } from './services/diff/DiffService';
import { ReviewService } from './services/review/ReviewService';
import { PERMISSION_CHOICES, WebviewMessage } from './protocol/events';
import { NetworkHealthService } from './services/network/NetworkHealthService';
import { AuthService } from './services/auth/AuthService';
import { syncAutoApprovalSettings } from './services/settings/autoApprovalSync';
import { attachContextSessionId, buildEmptyUsageSnapshot, explicitSessionIdFromPayload, shouldUseCachedUsage } from './services/usage/usageScope';
import { stageAttachmentsForWorkspace } from './services/attachments/stageAttachments';

function deriveChoiceMetadata(question: string, choices: string[]) {
    const looksLikePlan = /plan|implementation|implement|approve|proceed|task|phase|план|реализ|задач/i.test(question);

    return choices.map((choice, index) => {
        const normalized = choice.trim().toLowerCase();
        const metadata: {
            value: string;
            label: string;
            description: string;
            recommended?: boolean;
            danger?: boolean;
        } = {
            value: choice,
            label: choice,
            description: 'Send this decision to the agent.',
            recommended: index === 0,
        };

        if (looksLikePlan) {
            if (/proceed|implement|start|phase|execute|go/i.test(choice)) {
                metadata.label = choice.replace(/^proceed$/i, 'Implement plan');
                metadata.description = 'Start implementation using this plan as the active scope.';
            } else if (/task|hub|create/i.test(choice)) {
                metadata.description = 'Create trackable tasks from the plan without starting code changes.';
            } else if (/revise|edit|update|change/i.test(choice)) {
                metadata.description = 'Ask the agent to refine the plan before any implementation.';
                metadata.recommended = false;
            } else if (/save|stop|cancel|reject|deny|no/i.test(choice)) {
                metadata.description = 'Keep the plan as a document and do not start implementation.';
                metadata.recommended = false;
                metadata.danger = /cancel|reject|deny|no/i.test(choice);
            }
        }

        return metadata;
    });
}

interface PendingInteractionRequest {
    resolve: (response: any) => void;
    sessionId?: string;
    runId?: string;
    question: string;
    toolName?: string;
    kind: 'permission' | 'choice';
}

function deriveToolNameFromApprovalQuestion(question: string): string | undefined {
    const bulletMatch = question.match(/•\s+\*\*([^*]+)\*\*/);
    if (bulletMatch?.[1]) return bulletMatch[1].trim();
    const rawMatch = question.match(/\b(execute_python|execute_command|run_command|write_file|replace_file_content|apply_diff|delete_file|browser_open|use_mcp)\b/i);
    return rawMatch?.[1];
}

function choiceListLooksLikePermissionApproval(choices?: string[]): boolean {
    if (!choices || choices.length === 0) return true;
    const normalized = choices.map(choice => choice.trim().toLowerCase());
    return normalized.some(choice => choice === 'yes' || choice === 'allow' || choice === 'approve')
        && normalized.some(choice => choice === 'no' || choice === 'deny' || choice === 'reject');
}

function isConfirmedFullAccess(autoApproval: Record<string, any> | undefined): boolean {
    return Boolean(
        autoApproval?.enabled &&
        autoApproval.execute_safe_commands &&
        autoApproval.execute_all_commands &&
        autoApproval.edit_files &&
        autoApproval.edit_files_external &&
        autoApproval.delete_files &&
        autoApproval.delete_files_external &&
        autoApproval.use_browser &&
        autoApproval.use_mcp
    );
}

function requestCanResumeUnderFullAccess(request: PendingInteractionRequest, choices?: string[]): boolean {
    if (!choiceListLooksLikePermissionApproval(choices)) return false;
    if (request.kind === 'permission') return true;
    const question = request.question || '';
    const toolName = request.toolName || deriveToolNameFromApprovalQuestion(question) || '';
    return Boolean(toolName) || /wants to execute|following tools|execute|command|python|edit|write|delete|browser|mcp/i.test(question);
}

function approvalChoiceIndex(choices: string[]): number {
    const yesIndex = choices.findIndex(choice => /^(yes|allow|approve)$/i.test(choice.trim()));
    if (yesIndex >= 0) return yesIndex;
    const nonDenyIndex = choices.findIndex(choice => !/no|deny|reject|cancel/i.test(choice));
    return nonDenyIndex >= 0 ? nonDenyIndex : 0;
}

/**
 * WebviewProvider for Ricochet sidebar panel.
 * Handles communication between webview UI and core process.
 */
export class WebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ricochet.chatView';
    private static readonly defaultViewTitle = 'Ricochet Chat';

    private view?: vscode.WebviewView;
    private isLiveModeEnabled = false;

    private checkpointService?: ShadowCheckpointService;
    private sessionService: SessionService;
    private chatService?: ChatService;
    private mcpService?: McpService;
    private networkHealthService?: NetworkHealthService;
    private authService: AuthService;
    private agentService: AgentService;
    private pendingPermissionRequests: Map<string, PendingInteractionRequest> = new Map();
    private pendingChoices: Map<string, string[]> = new Map();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly core: CoreProcess
    ) {
        this.sessionService = new SessionService(context);
        this.agentService = new AgentService(
            this.core,
            (msg) => this.postMessage(msg),
            this.sessionService,
            (metadata) => this.handleSessionMetadataChanged(metadata)
        );

        // Initialize services
        this.chatService = new ChatService(
            this.context,
            this.core,
            (msg: any) => this.postMessage(msg),
            this.sessionService,
            (metadata) => this.handleSessionMetadataChanged(metadata)
        );
        this.mcpService = new McpService(this.context, (msg: any) => this.postMessage(msg));
        this.networkHealthService = new NetworkHealthService(
            this.core,
            (msg: any) => this.postMessage(msg)
        );
        this.authService = new AuthService(
            this.context,
            (msg) => this.postMessage(msg),
            async (accessToken) => {
                await this.core.send('set_grik_access_token', { access_token: accessToken });
            }
        );

        // Initialize Review Service
        ReviewService.getInstance(this.context);

        // Listen for pending edits changes and broadcast to webview
        DiffService.getInstance().on('change', () => this.broadcastPendingEdits());

        // Listen for core messages and forward to webview
        this.core.onMessage('chat_update', (payload) => {
            // Single routing point for chat stream side effects and UI updates.
            this.networkHealthService?.recordActivity(Date.now());
            this.chatService?.onChatUpdate(payload);
            this.agentService.onChatUpdate(payload);
        });

        this.core.onMessage('task_progress', (payload) => {
            this.networkHealthService?.recordActivity(Date.now());
            if (this.chatService && !this.chatService.acceptsRuntimePayload(payload)) return;
            this.postMessage({ type: 'task_progress', payload });
        });

        this.core.onMessage('command_event', (payload) => {
            this.networkHealthService?.recordActivity(Date.now());
            if (this.chatService && !this.chatService.acceptsRuntimePayload(payload)) return;
            this.postMessage({ type: 'command_event', payload });
        });

        this.core.onMessage('tool_lifecycle', (payload) => {
            this.networkHealthService?.recordActivity(Date.now());
            if (this.chatService && !this.chatService.acceptsRuntimePayload(payload)) return;
            console.log(`[Core -> Ext] TOOL_LIFECYCLE run=${payload?.run_id || ''} tool=${payload?.tool_name || ''} status=${payload?.status || ''} files=${Array.isArray(payload?.affected_files) ? payload.affected_files.length : 0} error=${payload?.error || ''}`);
            this.postMessage({ type: 'tool_lifecycle', payload });
        });

        this.core.onMessage('context_compaction', (payload) => {
            this.networkHealthService?.recordActivity(Date.now());
            if (this.chatService && !this.chatService.acceptsRuntimePayload(payload)) return;
            this.postMessage({ type: 'context_compaction', payload });
        });

        this.core.onMessage('checkpoint_event', (payload) => {
            this.networkHealthService?.recordActivity(Date.now());
            if (this.chatService && !this.chatService.acceptsRuntimePayload(payload)) return;
            this.postMessage({ type: 'checkpoint_event', payload });
        });

        this.core.onMessage('batch_event', (payload) => {
            this.networkHealthService?.recordActivity(Date.now());
            this.postMessage({ type: 'batch_event', payload });
        });

        this.core.onMessage('message_queued', (payload) => {
            this.postMessage({ type: 'message_queued', payload });
        });

        this.core.onMessage('queued_message_error', (payload) => {
            this.postMessage({ type: 'queued_message_error', payload });
        });

        this.core.onMessage('usage_update', (payload) => {
            this.chatService?.onUsageUpdate(payload as any);
        });

        this.core.onMessage('context_status', (payload) => {
            const sessionId = this.chatService?.activeSessionId || this.agentService?.activeSessionId || null;
            const scopedPayload = attachContextSessionId(payload, sessionId);
            const scopedRecord = scopedPayload && typeof scopedPayload === 'object' && !Array.isArray(scopedPayload)
                ? scopedPayload as Record<string, unknown>
                : null;
            const runId = this.chatService?.activeRunId;
            this.postMessage({
                type: 'context_status',
                payload: runId && scopedRecord && !scopedRecord.run_id ? { ...scopedRecord, run_id: runId } : scopedPayload
            });
        });

        this.core.onMessage('live_mode_status', (payload) => {
            this.postMessage({ type: 'live_mode_status', payload });
        });

        // Forward Ether activity events (receiving, processing, responding)
        this.core.onMessage('ether_activity', (payload) => {
            this.postMessage({ type: 'ether_activity', payload });
        });

        this.core.onMessage('show_message', (payload: any) => {
            const { level, text } = payload;
            switch (level) {
                case 'error':
                    vscode.window.showErrorMessage(text);
                    break;
                case 'warning':
                    vscode.window.showWarningMessage(text);
                    break;
                case 'info':
                    vscode.window.showInformationMessage(text);
                    break;
            }
        });

        this.core.onMessage('mode_changed', (payload) => {
            this.postMessage({ type: 'mode_changed', payload });
        });

        this.core.onMessage('tasks_updated', (payload) => {
            this.postMessage({ type: 'tasks_updated', payload });
        });

        this.core.onMessage('provider_request_started', (payload) => {
            this.networkHealthService?.recordProviderEvent({ ...(payload as any), type: 'provider_request_started' });
        });
        this.core.onMessage('provider_request_retrying', (payload) => {
            this.networkHealthService?.recordProviderEvent({ ...(payload as any), type: 'provider_request_retrying' });
        });
        this.core.onMessage('provider_request_succeeded', (payload) => {
            this.networkHealthService?.recordProviderEvent({ ...(payload as any), type: 'provider_request_succeeded' });
        });
        this.core.onMessage('provider_request_failed', (payload) => {
            this.networkHealthService?.recordProviderEvent({ ...(payload as any), type: 'provider_request_failed' });
        });

        // Handle synchronous requests from the core
        this.core.onRequest('ask_user', (payload) => {
            const { question, session_id } = payload;
            const runId = payload?.run_id || payload?.runId || this.chatService?.activeRunId || undefined;
            const toolName = payload?.tool_name || payload?.toolName || deriveToolNameFromApprovalQuestion(question);
            console.log(`[Extension] ask_user request for: "${question.substring(0, 50)}..." (Session: ${session_id})`);

            return new Promise((resolve) => {
                const requestId = `perm-${Date.now()}`;
                console.log(`[Extension] Created permission request ID: ${requestId}`);
                this.pendingPermissionRequests.set(requestId, { resolve, sessionId: session_id, runId, question, toolName, kind: 'permission' });

                this.postMessage({
                    type: 'request_permission',
                    payload: {
                        id: requestId,
                        sessionId: session_id,
                        runId,
                        run_id: runId,
                        toolName,
                        tool_name: toolName,
                        question,
                        choices: [...PERMISSION_CHOICES],
                        kind: 'permission'
                    }
                });
            });
        });

        this.core.onRequest('ask_user_choice', (payload) => {
            const { question, choices, session_id } = payload;
            const normalizedChoices = Array.isArray(choices) ? choices : [];
            const runId = payload?.run_id || payload?.runId || this.chatService?.activeRunId || undefined;
            const toolName = payload?.tool_name || payload?.toolName || deriveToolNameFromApprovalQuestion(question);
            console.log(`[Extension] ask_user_choice request for: "${question.substring(0, 50)}..." (Session: ${session_id})`);

            return new Promise((resolve) => {
                const requestId = `choice-${Date.now()}`;
                console.log(`[Extension] Created choice request ID: ${requestId}`);
                this.pendingPermissionRequests.set(requestId, { resolve, sessionId: session_id, runId, question, toolName, kind: 'choice' });
                this.pendingChoices.set(requestId, normalizedChoices);

                this.postMessage({
                    type: 'ask_user_choice',
                    payload: {
                        id: requestId,
                        sessionId: session_id,
                        runId,
                        run_id: runId,
                        toolName,
                        tool_name: toolName,
                        question,
                        choices: normalizedChoices,
                        choiceMetadata: deriveChoiceMetadata(question, normalizedChoices),
                        kind: 'choice'
                    }
                });
            });
        });

        this.core.onRequest('propose_edit', async (payload) => {
            return this.handleProposedEdit(payload as any);
        });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        this.setViewTitle(WebviewProvider.defaultViewTitle);

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'webview-dist'),
                vscode.Uri.joinPath(this.context.extensionUri, 'assets')
            ]
        };

        webviewView.webview.html = this.getWebviewContent(webviewView.webview);

        webviewView.onDidDispose(() => {
            console.log('[WebviewProvider] Webview disposed; cancelling active Ricochet runtime.');
            if (this.view === webviewView) {
                this.view = undefined;
            }
            this.networkHealthService?.stop();
            this.cancelActiveRuntime('webview disposed').catch((error) => {
                console.error('[WebviewProvider] Failed to cancel runtime after webview disposal:', error);
            });
        });

        // Initialize checkpoints
        this.initCheckpoints().catch(console.error);
        this.restoreWebviewState().catch(console.error);
        this.authService.syncState().catch(console.error);
        this.networkHealthService?.start();

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            try {
                console.log(`[Webview] Received message: ${message.type}`);
                // Forward shared messages to services; agent control messages are routed below to avoid duplicate starts.
                await this.chatService?.handleMessage(message);
                await this.mcpService?.handleMessage(message);

                switch (message.type) {
                    case 'permission_response':
                        const { id: responseId, answer: responseAnswer } = message.payload;
                        const request = this.pendingPermissionRequests.get(responseId);
                        if (request) {
                            const { resolve, sessionId, runId, toolName } = request;
                            const choices = this.pendingChoices.get(responseId);
                            if (choices) {
                                const index = choices.indexOf(responseAnswer);
                                console.log(`[Webview -> Core] Resolving choice index: ${index} for ID: ${responseId} (Session: ${sessionId})`);
                                resolve(index !== -1 ? index : 0);
                                this.pendingChoices.delete(responseId);
                            } else {
                                console.log(`[Webview -> Core] Resolving raw answer for ID: ${responseId} (Session: ${sessionId})`);
                                resolve(responseAnswer);
                            }

                            this.pendingPermissionRequests.delete(responseId);
                            this.postMessage({
                                type: 'permission_response_received',
                                payload: { id: responseId, sessionId, runId, run_id: runId, toolName, tool_name: toolName }
                            });
                            this.broadcastPendingEdits();
                        } else {
                            console.warn(`[Webview -> Core] No pending request found for ID: ${responseId}`);
                            this.postMessage({
                                type: 'permission_response_received',
                                payload: { id: responseId, expired: true }
                            });
                        }
                        break;

                    case 'webview_pong':
                        this.networkHealthService?.handleWebviewPong(message.payload);
                        break;

                    case 'network_browser_status':
                        this.networkHealthService?.handleBrowserStatus(message.payload);
                        break;

                    case 'stage_attachments':
                        await this.stageAttachments(message.payload || {});
                        break;

                    case 'auth_login':
                        await this.authService.startLogin();
                        break;

                    case 'auth_cancel':
                        this.authService.cancelLogin();
                        break;

                    case 'auth_logout':
                        await this.authService.logout();
                        break;

                    case 'auth_refresh':
                        await this.authService.syncState();
                        break;

                    case 'open_billing':
                        await this.authService.openBilling(message.payload);
                        break;

                    case 'billing_subscription_cancel':
                        try {
                            const result = await this.authService.cancelSubscription(message.payload?.subscriptionId, message.payload?.reason);
                            this.postMessage({ type: 'billing_subscription_action_result', payload: { ok: true, action: 'cancel', result } });
                        } catch (e: any) {
                            const error = e?.message || String(e);
                            this.postMessage({ type: 'billing_subscription_action_result', payload: { ok: false, action: 'cancel', error } });
                            vscode.window.showErrorMessage(`Failed to cancel subscription: ${error}`);
                        }
                        break;

                    case 'billing_subscription_resume':
                        try {
                            const result = await this.authService.resumeSubscription(message.payload?.subscriptionId);
                            this.postMessage({ type: 'billing_subscription_action_result', payload: { ok: true, action: 'resume', result } });
                        } catch (e: any) {
                            const error = e?.message || String(e);
                            this.postMessage({ type: 'billing_subscription_action_result', payload: { ok: false, action: 'resume', error } });
                            vscode.window.showErrorMessage(`Failed to resume subscription: ${error}`);
                        }
                        break;

                    case 'open_external':
                        await this.authService.openExternal(message.payload?.url);
                        break;

                    case 'open_microphone_permissions':
                        await this.openMicrophonePermissionSettings();
                        break;

                    case 'get_workspace_state':
                        this.postWorkspaceState();
                        break;

                    case 'send_message':
                    case 'toggle_live_mode':
                    case 'clear_chat':
                    case 'execute_command':
                        // Handled by ChatService
                        break;
                    case 'get_mcp_servers':
                        try {
                            const mcpHub = await McpServerManager.getInstance(this.context);
                            const servers = mcpHub.getServers();
                            this.view?.webview.postMessage({ type: 'mcp_servers', payload: { servers } });
                        } catch (e) {
                            console.error('Failed to get MCP servers:', e);
                        }
                        break;

                    case 'connect_mcp_server':
                        try {
                            const mcpHub = await McpServerManager.getInstance(this.context);
                            await mcpHub.connectToServer(message.payload.name, message.payload.config);
                            // Refresh list
                            const servers = mcpHub.getServers();
                            this.view?.webview.postMessage({ type: 'mcp_servers', payload: { servers } });
                        } catch (e) {
                            vscode.window.showErrorMessage(`Failed to connect MCP server: ${e}`);
                        }
                        break;

                    case 'call_mcp_tool':
                        try {
                            const mcpHub = await McpServerManager.getInstance(this.context);
                            const result = await mcpHub.callTool(message.payload.serverName, message.payload.toolName, message.payload.args);
                            this.view?.webview.postMessage({
                                type: 'mcp_tool_result',
                                payload: {
                                    id: message.payload.id,
                                    result
                                }
                            });
                        } catch (e: any) {
                            this.view?.webview.postMessage({
                                type: 'mcp_tool_error',
                                payload: {
                                    id: message.payload.id,
                                    error: e.message
                                }
                            });
                        }
                        break;

                    case 'checkpoint_init':
                        await this.initCheckpoints();
                        break;

                    case 'save_checkpoint':
                        if (this.checkpointService) {
                            try {
                                const result = await this.checkpointService.saveCheckpoint(message.payload.message || 'Manual Checkpoint');
                                this.view?.webview.postMessage({ type: 'checkpoint_saved', payload: { hash: result?.commit, message: message.payload.message || 'Manual Checkpoint' } });
                            } catch (e: any) {
                                vscode.window.showErrorMessage(`Failed to save checkpoint: ${e.message}`);
                            }
                        }
                        break;

                    case 'checkpoint_list':
                        if (this.checkpointService) {
                            this.view?.webview.postMessage({
                                type: 'checkpoint_list',
                                payload: {
                                    checkpoints: this.checkpointService.getCheckpoints(),
                                    baseHash: this.checkpointService.baseHash || ''
                                }
                            });
                        }
                        break;

                    case 'checkpoint_preview_restore':
                        if (this.checkpointService) {
                            try {
                                const hash = message.payload.checkpoint_hash || message.payload.hash;
                                const preview = await this.checkpointService.previewRestore(hash);
                                this.view?.webview.postMessage({ type: 'checkpoint_restore_preview', payload: preview });
                            } catch (e: any) {
                                this.view?.webview.postMessage({ type: 'checkpoint_restore_error', payload: { error: e.message } });
                            }
                        }
                        break;

                    case 'checkpoint_restore':
                        if (this.checkpointService) {
                            try {
                                const result = await this.checkpointService.restoreWithOptions({
                                    checkpoint_hash: message.payload.checkpoint_hash || message.payload.hash,
                                    mode: message.payload.mode || 'full',
                                    paths: message.payload.paths || [],
                                    create_safety_checkpoint: message.payload.create_safety_checkpoint !== false
                                });
                                vscode.window.showInformationMessage("Checkpoint restore completed.");
                                this.view?.webview.postMessage({ type: 'checkpoint_restored', payload: result });
                            } catch (e: any) {
                                this.view?.webview.postMessage({ type: 'checkpoint_restore_error', payload: { error: e.message } });
                                vscode.window.showErrorMessage(`Failed to restore checkpoint: ${e.message}`);
                            }
                        }
                        break;

                    case 'checkpoint_create_patch':
                        if (this.checkpointService) {
                            try {
                                const hash = message.payload.checkpoint_hash || message.payload.hash;
                                const patchPath = await this.checkpointService.createPatch(hash);
                                this.view?.webview.postMessage({ type: 'checkpoint_patch', payload: { patch_path: patchPath } });
                            } catch (e: any) {
                                this.view?.webview.postMessage({ type: 'checkpoint_restore_error', payload: { error: e.message } });
                            }
                        }
                        break;

                    case 'restore_checkpoint':
                        if (this.checkpointService) {
                            // Confirmation dialog
                            const ans = await vscode.window.showWarningMessage("Restore this checkpoint? Ricochet will create a safety checkpoint first.", "Restore", "Cancel");
                            if (ans === 'Restore') {
                                try {
                                    const result = await this.checkpointService.restoreWithOptions({
                                        checkpoint_hash: message.payload.hash,
                                        mode: 'full',
                                        create_safety_checkpoint: true
                                    });
                                    vscode.window.showInformationMessage("Checkpoint restored.");
                                    this.view?.webview.postMessage({ type: 'checkpoint_restored', payload: result });
                                    // Reload window or notify core?
                                } catch (e: any) {
                                    vscode.window.showErrorMessage(`Failed to restore checkpoint: ${e.message}`);
                                }
                            }
                        }
                        break;

                    case 'batch_run_create':
                    case 'batch_run_start':
                    case 'batch_run_abort':
                    case 'batch_run_list':
                    case 'batch_worker_diff':
                    case 'batch_worker_apply':
                    case 'batch_worker_retry':
                    case 'batch_worker_artifacts':
                    case 'batch_run_cleanup':
                        try {
                            const result = await this.core.send(message.type, message.payload || {});
                            this.view?.webview.postMessage({ type: `${message.type}_result`, payload: result });
                            if (message.type === 'batch_run_list') {
                                this.view?.webview.postMessage({ type: 'batch_runs', payload: result });
                            } else if (String(message.type).startsWith('batch_run_')) {
                                this.view?.webview.postMessage({ type: 'batch_run', payload: result });
                            } else if (message.type === 'batch_worker_diff') {
                                this.view?.webview.postMessage({ type: 'batch_worker_diff', payload: result });
                            } else if (message.type === 'batch_worker_apply') {
                                this.view?.webview.postMessage({ type: 'batch_worker', payload: result });
                            } else if (message.type === 'batch_worker_retry') {
                                this.view?.webview.postMessage({ type: 'batch_run', payload: result });
                            } else if (message.type === 'batch_worker_artifacts') {
                                this.view?.webview.postMessage({ type: 'batch_worker_artifacts', payload: result });
                            }
                        } catch (e: any) {
                            this.view?.webview.postMessage({ type: 'batch_error', payload: { error: e.message, action: message.type } });
                            vscode.window.showErrorMessage(`Ricochet batch action failed: ${e.message}`);
                        }
                        break;

                    case 'search_files':
                        // Handle file search request from webview
                        const query = message.payload.query || '';
                        if (!vscode.workspace.workspaceFolders) {
                            this.view?.webview.postMessage({ type: 'file_search_results', payload: [] });
                            return;
                        }

                        // Find files matching the query
                        // Use a glob pattern that matches the query in the filename
                        const globPattern = `**/*${query}*`;
                        const excludePattern = '**/{node_modules,.git,dist,out,build}/**';

                        vscode.workspace.findFiles(globPattern, excludePattern, 20).then(async uris => {
                            const results = await Promise.all(uris.map(async uri => {
                                // Get workspace-relative path
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

                            this.view?.webview.postMessage({
                                type: 'file_search_results',
                                payload: results
                            });
                        });
                        break;

                    case 'open_skill_file':
                    case 'open_file': {
                        const filePath = message.payload?.path || message.payload?.content_path;
                        if (filePath) {
                            // First priority: open with inline review if possible
                            // For now we still use vscode.diff as a fallback
                            const diffService = DiffService.getInstance();
                            const isArtifactPath = filePath.includes('.ricochet/artifacts');
                            const pending = isArtifactPath
                                ? undefined
                                : diffService.getPendingEdit(filePath) || this.findPendingEditByBasename(filePath);

                            if (pending) {
                                try {
                                    await this.openPendingEditForReview(pending.filePath);
                                    return;
                                } catch (e) {
                                    console.error('[WebviewProvider] Failed to open file for review:', e);
                                }
                            }

                            const fullPath = await this.resolveOpenFilePath(filePath, {
                                allowBasenameFallback: !filePath.includes('.ricochet/artifacts')
                            });

                            try {
                                if (!fullPath) {
                                    const fileName = path.basename(filePath);
                                    this.view?.webview.postMessage({
                                        type: 'open_file_result',
                                        payload: { ok: false, path: filePath, reason: 'not_found' }
                                    });
                                    vscode.window.showWarningMessage(`Document not found yet: ${fileName}. The agent mentioned it, but no file exists at that path.`);
                                    break;
                                }

                                const uri = vscode.Uri.file(fullPath);
                                const stats = fs.statSync(fullPath);
                                if (stats.isDirectory()) {
                                    await vscode.commands.executeCommand('revealInExplorer', uri);
                                } else {
                                    await vscode.window.showTextDocument(uri);
                                }
                                this.view?.webview.postMessage({
                                    type: 'open_file_result',
                                    payload: { ok: true, path: filePath, resolvedPath: fullPath }
                                });
                            } catch (e) {
                                console.error(`[Extension] Failed to open/reveal ${fullPath}:`, e);
                                this.view?.webview.postMessage({
                                    type: 'open_file_result',
                                    payload: { ok: false, path: filePath, reason: e instanceof Error ? e.message : String(e) }
                                });
                            }
                        }
                        break;
                    }

                    case 'plan_decision':
                        try {
                            const result = await this.core.send('plan_decision', message.payload || {});
                            const payload = message.payload || {};
                            this.view?.webview.postMessage({
                                type: 'plan_decision_result',
                                payload: {
                                    ok: true,
                                    session_id: payload.session_id,
                                    artifact_id: payload.artifact_id,
                                    path: payload.path,
                                    decision: payload.decision,
                                    ...(result && typeof result === 'object' ? result : {}),
                                }
                            });
                        } catch (e: any) {
                            this.view?.webview.postMessage({
                                type: 'plan_decision_result',
                                payload: {
                                    ok: false,
                                    error: e?.message || String(e),
                                    artifact_id: message.payload?.artifact_id,
                                    session_id: message.payload?.session_id,
                                    path: message.payload?.path,
                                    decision: message.payload?.decision
                                }
                            });
                            vscode.window.showErrorMessage(`Failed to apply plan decision: ${e?.message || e}`);
                        }
                        break;

                    case 'audio_start':
                    case 'audio_chunk':
                    case 'audio_stop':
                        try {
                            const result = await this.core.send(message.type, message.payload || {});
                            if (message.type === 'audio_stop') {
                                this.postMessage({ type: 'audio_transcription_result', payload: result });
                            }
                        } catch (error: any) {
                            const errorMessage = error?.message || String(error);
                            if (message.type === 'audio_stop') {
                                this.postMessage({
                                    type: 'audio_transcription_result',
                                    payload: {
                                        ok: false,
                                        error: errorMessage,
                                        phase: 'transcription',
                                        retryable: true,
                                    },
                                });
                            } else {
                                this.postMessage({
                                    type: 'audio_recording_status',
                                    payload: {
                                        state: 'error',
                                        phase: 'recording',
                                        message: errorMessage,
                                        retryable: false,
                                    },
                                });
                            }
                        }
                        break;
                    // case 'get_state':
                    //     // Handled by ChatService which respects session_id
                    //     break;

                    // Session Management
                    case 'list_sessions':
                        const sessions = await this.sessionService.listSessions();
                        this.postMessage({ type: 'session_list', payload: { sessions } });
                        break;
                    case 'create_session':
                        await this.createNewSession();
                        break;

                    case 'load_session':
                        // Cancel any active runtime before loading another chat. Late events from the
                        // old session are filtered by ChatService, but aborting here keeps the core loop
                        // and the input state aligned with the visible session.
                        await this.chatService?.cancelActiveChatRuntime('load_session');
                        await this.agentService.handleMessage({ type: 'cancel_session' });

                        const sessionData = await this.sessionService.loadSession(message.payload.id);
                        if (sessionData) {
                            this.chatService?.setActiveSession(message.payload.id);
                            await this.syncViewTitleForSession(message.payload.id);

                            try {
                                // Hydrate backend with session history
                                await this.core.send('hydrate_session', {
                                    session_id: message.payload.id,
                                    messages: sessionData.messages
                                });
                            } catch (e) {
                                console.error('Failed to hydrate session:', e);
                            }

                            this.postMessage({ type: 'session_loaded', payload: { id: message.payload.id, ...sessionData } });
                        }
                        break;

                    case 'delete_session':
                        await this.sessionService.deleteSession(message.payload.id);
                        const updatedSessions = await this.sessionService.listSessions();
                        this.postMessage({ type: 'session_list', payload: { sessions: updatedSessions } });
                        if (message.payload.id === this.chatService?.activeSessionId) {
                            this.setViewTitle(WebviewProvider.defaultViewTitle);
                        }
                        break;

                    // Agent Manager Handlers
                    case 'start_session':
                    case 'cancel_session':
                    case 'cancel_generation': // Alias for webview compatibility
                        if (message.type === 'cancel_session' || message.type === 'cancel_generation') {
                            await this.cancelActiveRuntime(message.type, message.payload);
                            break;
                        }

                        if (message.payload?.session_id && message.payload?.prompt) {
                            const metadata = await this.sessionService.updateSessionTitle(message.payload.session_id, message.payload.prompt);
                            if (metadata) {
                                this.handleSessionMetadataChanged(metadata);
                            }
                        }

                        await this.agentService.handleMessage(message);

                        // Sync active session ID to ChatService so it can persist mission logs
                        if (message.type === 'start_session' && this.agentService.activeSessionId) {
                            if (this.chatService) {
                                this.chatService.activeSessionId = this.agentService.activeSessionId;
                            }
                        }
                        break;

                    case 'create_task_ui':
                    case 'move_task_column':
                    case 'delete_task_ui':
                    case 'add_subtask_ui':
                    case 'complete_task_ui':
                    case 'get_tasks':
                        await this.agentService.handleMessage(message);
                        break;

                    case 'verify_telegram_token':
                        try {
                            const token = message.payload.token;
                            const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
                            const data = await response.json();
                            if (data.ok) {
                                this.postMessage({
                                    type: 'bot_verification_result',
                                    payload: {
                                        ok: true,
                                        username: data.result.username,
                                        firstName: data.result.first_name
                                    }
                                });
                            } else {
                                this.postMessage({
                                    type: 'bot_verification_result',
                                    payload: { ok: false, error: data.description || 'Invalid token' }
                                });
                            }
                        } catch (e: any) {
                            this.postMessage({
                                type: 'bot_verification_result',
                                payload: { ok: false, error: 'Failed to verify: ' + e.message }
                            });
                        }
                        break;

                    case 'verify_discord_token':
                        try {
                            const token = message.payload.token;
                            const response = await fetch('https://discord.com/api/v10/users/@me', {
                                headers: { Authorization: `Bot ${token}` }
                            });
                            const data: any = await response.json();
                            if (response.ok) {
                                this.postMessage({
                                    type: 'discord_bot_verification_result',
                                    payload: {
                                        ok: true,
                                        username: data.username,
                                        firstName: data.global_name || data.username
                                    }
                                });
                            } else {
                                this.postMessage({
                                    type: 'discord_bot_verification_result',
                                    payload: { ok: false, error: data.message || 'Invalid token' }
                                });
                            }
                        } catch (e: any) {
                            this.postMessage({
                                type: 'discord_bot_verification_result',
                                payload: { ok: false, error: 'Failed to verify: ' + e.message }
                            });
                        }
                        break;

                    case 'get_settings':
                        try {
                            const settings = await this.core.send('get_settings', {});
                            this.postMessage({ type: 'settings_loaded', payload: settings });
                        } catch (e) {
                            console.error('Failed to get settings:', e);
                        }
                        break;

                    case 'get_models':
                        try {
                            const payload = await this.core.send('get_models', message.payload || {});
                            this.postMessage({ type: 'models', payload });
                        } catch (e) {
                            console.error('Failed to get models:', e);
                        }
                        break;

                    case 'validate_provider_key':
                        try {
                            const payload = await this.core.send('validate_provider_key', message.payload || {});
                            this.postMessage({ type: 'provider_key_validation', payload: { ...(payload || {}), providerId: payload?.providerId || message.payload?.providerId } });
                        } catch (e: any) {
                            this.postMessage({
                                type: 'provider_key_validation',
                                payload: {
                                    providerId: message.payload?.providerId,
                                    ok: false,
                                    status: 'network_error',
                                    message: e?.message || String(e),
                                    checkedAt: Date.now(),
                                }
                            });
                        }
                        break;

                    case 'get_usage':
                        try {
                            const sessionId = explicitSessionIdFromPayload(message.payload);
                            if (!sessionId) {
                                this.postMessage({ type: 'usage_update', payload: buildEmptyUsageSnapshot() });
                                break;
                            }

                            const sessionData = await this.sessionService.loadSession(sessionId);
                            if (shouldUseCachedUsage(sessionData, sessionId)) {
                                this.postMessage({ type: 'usage_update', payload: sessionData.usage });
                                break;
                            }
                            const payload = await this.core.send('get_usage', { session_id: sessionId });
                            this.postMessage({ type: 'usage_update', payload: { ...payload, sessionId: payload?.sessionId || sessionId } });
                        } catch (e) {
                            console.error('Failed to get usage:', e);
                        }
                        break;

                    case 'get_context_status':
                        try {
                            const sessionId = explicitSessionIdFromPayload(message.payload) || '';
                            if (sessionId) {
                                const sessionData = await this.sessionService.loadSession(sessionId);
                                await this.core.send('hydrate_session', {
                                    session_id: sessionId,
                                    messages: sessionData?.messages || []
                                });
                            }
                            const payload = await this.core.send('get_context_status', sessionId ? { session_id: sessionId } : {});
                            this.postMessage({ type: 'context_status', payload: attachContextSessionId(payload, sessionId) });
                        } catch (e: any) {
                            console.error('Failed to get context status:', e);
                            this.postMessage({ type: 'context_action_error', payload: { action: 'get_context_status', error: e?.message || String(e) } });
                        }
                        break;

                    case 'compact_context_now':
                        try {
                            const sessionId = message.payload?.session_id || this.chatService?.activeSessionId || this.agentService?.activeSessionId || '';
                            if (sessionId) {
                                const sessionData = await this.sessionService.loadSession(sessionId);
                                await this.core.send('hydrate_session', {
                                    session_id: sessionId,
                                    messages: sessionData?.messages || []
                                });
                            }
                            const result: any = await this.core.send('compact_context_now', sessionId ? { session_id: sessionId } : {});
                            if (result?.event) {
                                this.postMessage({ type: 'context_compaction', payload: result.event });
                            }
                            if (sessionId && result?.event?.event === 'context_condensed') {
                                const state: any = await this.core.send('get_state', { session_id: sessionId });
                                const existing = await this.sessionService.loadSession(sessionId);
                                const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                                await this.sessionService.saveSession(sessionId, {
                                    messages: state?.messages || existing?.messages || [],
                                    todos: state?.todos || existing?.todos || [],
                                    usage: existing?.usage
                                }, workspaceDir);
                            }
                            if (result?.status) {
                                this.postMessage({ type: 'context_status', payload: result.status });
                            }
                        } catch (e: any) {
                            console.error('Failed to compact context:', e);
                            this.postMessage({ type: 'context_action_error', payload: { action: 'compact_context_now', error: e?.message || String(e) } });
                        }
                        break;

                    case 'get_live_mode_status':
                        try {
                            const result: any = await this.core.send('get_live_mode_status', {});
                            this.postMessage({ type: 'live_mode_status', payload: result });
                        } catch (e) {
                            console.error('Error fetching live status:', e);
                        }
                        break;

                    case 'set_remote_session_start':
                        try {
                            const result: any = await this.core.send('set_remote_session_start', message.payload || {});
                            this.postMessage({ type: 'live_mode_status', payload: result });
                        } catch (e) {
                            console.error('Error updating remote session start:', e);
                            vscode.window.showErrorMessage('Failed to update Ether remote session permission');
                        }
                        break;

                    case 'save_settings':
                        try {
                            const result: any = await this.core.send('save_settings', message.payload);
                            this.postMessage({ type: 'settings_saved', payload: result });
                            if (message.payload?.auto_approval) {
                                const settings: any = await this.core.send('get_settings', {});
                                this.postMessage({ type: 'settings_loaded', payload: settings });
                                this.resolvePendingRequestsApprovedBySettings(settings?.auto_approval || message.payload.auto_approval, 'full_access');
                            }
                            const liveStatus: any = await this.core.send('get_live_mode_status', {});
                            this.postMessage({ type: 'live_mode_status', payload: liveStatus });
                            if (result?.liveModeRestartRequired) {
                                vscode.window.showWarningMessage('Settings saved. Ether messenger token changed; toggle Ether off and on, or restart Ricochet, to reconnect with the new token.');
                            } else {
                                vscode.window.showInformationMessage('Settings saved');
                            }
                        } catch (e) {
                            vscode.window.showErrorMessage('Failed to save settings');
                        }
                        break;

                    case 'auto_approve_settings':
                        try {
                            const settings: any = await syncAutoApprovalSettings(this.core, (msg) => this.postMessage(msg), message.payload || {});
                            this.resolvePendingRequestsApprovedBySettings(settings?.auto_approval || message.payload || {}, 'full_access');
                        } catch (e) {
                            console.error('Failed to sync auto-approve settings:', e);
                        }
                        break;

                    case 'set_auto_approve':
                        try {
                            // 1. Get current settings
                            const currentSettings: any = await this.core.send('get_settings', {});
                            const autoApproval = currentSettings.auto_approval || {};

                            // 2. Patch settings
                            if (message.payload.commands) {
                                autoApproval.execute_safe_commands = true;
                                autoApproval.execute_all_commands = true;
                            }

                            // 3. Save
                            await this.core.send('save_settings', { auto_approval: autoApproval });

                            // 4. Resolve all pending requests since user said "Always" (HACK: using first session ID we find or just global)
                            if (message.payload.commands) {
                                for (const [id, req] of this.pendingPermissionRequests.entries()) {
                                    req.resolve('yes'); // Assuming 'yes' is the approval string expected by Core
                                }
                                this.pendingPermissionRequests.clear();
                                this.pendingChoices.clear();
                            }

                            // 5. Broadcast update so Panel refreshes
                            const newSettings = await this.core.send('get_settings', {});
                            this.postMessage({ type: 'settings_loaded', payload: newSettings });

                            vscode.window.showInformationMessage('Auto-approve enabled. Resuming commands...');
                        } catch (e) {
                            console.error('Failed to set auto-approve:', e);
                            vscode.window.showErrorMessage('Failed to enable auto-approve');
                        }
                        break;

                    case 'test_telegram':
                        try {
                            const { token, chatId } = message.payload as { token: string; chatId: number };
                            const response = await fetch(
                                `https://api.telegram.org/bot${token}/sendMessage`,
                                {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: chatId,
                                        text: '✅ *Ricochet Ether Connected!*\n\nYour IDE is now paired with this chat.',
                                        parse_mode: 'Markdown'
                                    })
                                }
                            );
                            const data = await response.json();
                            this.postMessage({
                                type: 'test_telegram_result',
                                payload: { ok: data.ok }
                            });
                        } catch (e) {
                            this.postMessage({
                                type: 'test_telegram_result',
                                payload: { ok: false }
                            });
                        }
                        break;

                    case 'test_discord':
                        try {
                            const { token, channelId } = message.payload as { token: string; channelId: string };
                            const response = await fetch(
                                `https://discord.com/api/v10/channels/${channelId}/messages`,
                                {
                                    method: 'POST',
                                    headers: {
                                        Authorization: `Bot ${token}`,
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify({
                                        content: '✅ **Ricochet Ether Connected!**\n\nYour IDE can now pair with this Discord channel.'
                                    })
                                }
                            );
                            this.postMessage({
                                type: 'test_discord_result',
                                payload: { ok: response.ok }
                            });
                        } catch (e) {
                            this.postMessage({
                                type: 'test_discord_result',
                                payload: { ok: false }
                            });
                        }
                        break;

                    case 'get_skills':
                        try {
                            const result = await this.core.send('get_skills', {});
                            this.postMessage({ type: 'skills', payload: result });
                        } catch (e) {
                            console.error('Failed to get skills:', e);
                        }
                        break;
                    case 'set_skill_enabled':
                        try {
                            const result = await this.core.send('set_skill_enabled', message.payload || {});
                            this.postMessage({ type: 'skills', payload: result });
                        } catch (e) {
                            console.error('Failed to update skill:', e);
                            this.postMessage({ type: 'skill_update_failed', payload: { error: e instanceof Error ? e.message : String(e) } });
                        }
                        break;
                    case 'rescan_skills':
                        try {
                            const result = await this.core.send('rescan_skills', {});
                            this.postMessage({ type: 'skills', payload: result });
                        } catch (e) {
                            console.error('Failed to rescan skills:', e);
                            this.postMessage({ type: 'skill_update_failed', payload: { error: e instanceof Error ? e.message : String(e) } });
                        }
                        break;
                    case 'create_project_skill':
                        try {
                            const result = await this.core.send('create_project_skill', message.payload || {});
                            this.postMessage({ type: 'skills', payload: result });
                        } catch (e) {
                            console.error('Failed to create project skill:', e);
                            this.postMessage({ type: 'skill_update_failed', payload: { error: e instanceof Error ? e.message : String(e) } });
                        }
                        break;
                    case 'delete_project_skill':
                        try {
                            const result = await this.core.send('delete_project_skill', message.payload || {});
                            this.postMessage({ type: 'skills', payload: result });
                        } catch (e) {
                            console.error('Failed to delete project skill:', e);
                            this.postMessage({ type: 'skill_update_failed', payload: { error: e instanceof Error ? e.message : String(e) } });
                        }
                        break;

                    case 'get_index_status':
                        try {
                            const result = await this.core.send('get_index_status', {});
                            this.postMessage({ type: 'index_status', payload: result });
                        } catch (e) {
                            console.error('Failed to get index status:', e);
                        }
                        break;

                    case 'get_permissions':
                        try {
                            const result = await this.core.send('get_permissions', {});
                            this.postMessage({ type: 'permissions', payload: result });
                        } catch (e) {
                            console.error('Failed to get permissions:', e);
                        }
                        break;

                    case 'add_permission_rule':
                        try {
                            const result = await this.core.send('add_permission_rule', message.payload);
                            this.postMessage({ type: 'permission_rule_added', payload: result });
                            const permissions = await this.core.send('get_permissions', {});
                            this.postMessage({ type: 'permissions', payload: permissions });
                        } catch (e: any) {
                            this.postMessage({ type: 'permission_rule_added', payload: { error: e.message } });
                        }
                        break;

                    case 'remove_permission_rule':
                        try {
                            const result = await this.core.send('remove_permission_rule', message.payload);
                            this.postMessage({ type: 'permission_rule_removed', payload: result });
                            const permissions = await this.core.send('get_permissions', {});
                            this.postMessage({ type: 'permissions', payload: permissions });
                        } catch (e: any) {
                            this.postMessage({ type: 'permission_rule_removed', payload: { error: e.message } });
                        }
                        break;

                    case 'clear_permission_audit':
                        try {
                            const result = await this.core.send('clear_permission_audit', {});
                            this.postMessage({ type: 'permission_audit_cleared', payload: result });
                            const permissions = await this.core.send('get_permissions', {});
                            this.postMessage({ type: 'permissions', payload: permissions });
                        } catch (e: any) {
                            this.postMessage({ type: 'permission_audit_cleared', payload: { error: e.message } });
                        }
                        break;

                    case 'reindex_project':
                        try {
                            const result = await this.core.send('reindex_project', {});
                            this.postMessage({ type: 'reindex_started', payload: result });
                            const status = await this.core.send('get_index_status', {});
                            this.postMessage({ type: 'index_status', payload: status });
                        } catch (e) {
                            console.error('Failed to trigger re-index:', e);
                            this.postMessage({ type: 'reindex_failed', payload: { error: e instanceof Error ? e.message : String(e) } });
                        }
                        break;

                    case 'probe_mcp_server':
                        try {
                            const result = await this.core.send('probe_mcp_server', message.payload);
                            this.postMessage({ type: 'mcp_probe_result', payload: result });
                        } catch (e: any) {
                            this.postMessage({ type: 'mcp_probe_result', payload: { error: e.message } });
                        }
                        break;

                    case 'get_mcp_registry':
                        try {
                            const result = await this.core.send('get_mcp_registry', {});
                            this.postMessage({ type: 'mcp_registry', payload: result });
                        } catch (e) {
                            console.error('Failed to get MCP registry:', e);
                        }
                        break;

                    case 'refresh_mcp_registry':
                        try {
                            const result = await this.core.send('refresh_mcp_registry', {});
                            this.postMessage({ type: 'mcp_registry', payload: result });
                        } catch (e) {
                            console.error('Failed to refresh MCP registry:', e);
                        }
                        break;

                    case 'get_marketplace_catalog':
                        try {
                            const result = await this.core.send('get_marketplace_catalog', {});
                            this.postMessage({ type: 'marketplace_catalog', payload: result });
                        } catch (e: any) {
                            this.postMessage({ type: 'marketplace_error', payload: { error: e.message || String(e) } });
                        }
                        break;

                    case 'refresh_marketplace_catalog':
                        try {
                            const result = await this.core.send('refresh_marketplace_catalog', {});
                            this.postMessage({ type: 'marketplace_catalog', payload: result });
                        } catch (e: any) {
                            this.postMessage({ type: 'marketplace_error', payload: { error: e.message || String(e) } });
                        }
                        break;

                    case 'get_marketplace_installed_metadata':
                        try {
                            const result = await this.core.send('get_marketplace_installed_metadata', {});
                            this.postMessage({ type: 'marketplace_installed_metadata', payload: result });
                        } catch (e: any) {
                            this.postMessage({ type: 'marketplace_error', payload: { error: e.message || String(e) } });
                        }
                        break;

                    case 'install_marketplace_item':
                        try {
                            const result = await this.core.send('install_marketplace_item', message.payload || {});
                            this.postMessage({ type: 'marketplace_install_result', payload: result });
                            const metadata = await this.core.send('get_marketplace_installed_metadata', {});
                            this.postMessage({ type: 'marketplace_installed_metadata', payload: metadata });
                        } catch (e: any) {
                            this.postMessage({ type: 'marketplace_error', payload: { error: e.message || String(e) } });
                        }
                        break;

                    case 'remove_marketplace_item':
                        try {
                            const result = await this.core.send('remove_marketplace_item', message.payload || {});
                            this.postMessage({ type: 'marketplace_remove_result', payload: result });
                            const metadata = await this.core.send('get_marketplace_installed_metadata', {});
                            this.postMessage({ type: 'marketplace_installed_metadata', payload: metadata });
                        } catch (e: any) {
                            this.postMessage({ type: 'marketplace_error', payload: { error: e.message || String(e) } });
                        }
                        break;

                    default:
                }
            } catch (error) {
                console.error('[WebviewProvider] Global error handler for webview messages:', error);
            }
        });
    }

    private async cancelActiveRuntime(reason: string, payload?: any): Promise<void> {
        console.log(`[WebviewProvider] Cancelling active runtime: ${reason}`);
        this.rejectPendingInteractionRequests(reason);
        const runId = payload?.run_id;
        const sessionId = payload?.session_id;

        if (this.agentService.activeSessionId) {
            this.clearPendingRequests(this.agentService.activeSessionId);
            await this.agentService.handleMessage({ type: 'cancel_session' });
            this.postMessage({ type: 'run_aborted', payload: { run_id: runId, session_id: sessionId } });
            return;
        }

        await this.core.send('abort_chat', { run_id: runId, session_id: sessionId });
        this.postMessage({ type: 'generation_cancelled', payload: { run_id: runId, session_id: sessionId } });
    }

    private rejectPendingInteractionRequests(reason: string): void {
        for (const [id, request] of this.pendingPermissionRequests.entries()) {
            const choices = this.pendingChoices.get(id);
            if (choices && choices.length > 0) {
                const denialIndex = choices.findIndex(choice => /no|deny|reject|cancel/i.test(choice));
                request.resolve(denialIndex >= 0 ? denialIndex : choices.length - 1);
            } else {
                request.resolve('No');
            }
            console.log(`[WebviewProvider] Rejected pending interaction ${id}: ${reason}`);
        }
        this.pendingPermissionRequests.clear();
        this.pendingChoices.clear();
    }

    private resolvePendingRequestsApprovedBySettings(autoApproval: Record<string, any>, reason: 'full_access'): void {
        if (!isConfirmedFullAccess(autoApproval)) return;

        for (const [id, request] of Array.from(this.pendingPermissionRequests.entries())) {
            const choices = this.pendingChoices.get(id);
            if (!requestCanResumeUnderFullAccess(request, choices)) continue;

            if (choices && choices.length > 0) {
                request.resolve(approvalChoiceIndex(choices));
            } else {
                request.resolve('Yes');
            }

            this.pendingPermissionRequests.delete(id);
            this.pendingChoices.delete(id);
            this.postMessage({
                type: 'permission_response_received',
                payload: {
                    id,
                    sessionId: request.sessionId,
                    runId: request.runId,
                    run_id: request.runId,
                    toolName: request.toolName,
                    tool_name: request.toolName,
                    autoApproved: true,
                    reason,
                }
            });
            console.log(`[WebviewProvider] Auto-approved pending interaction ${id} after ${reason}`);
        }

        this.broadcastPendingEdits();
    }

    private async restoreWebviewState(): Promise<void> {
        const sessions = await this.sessionService.listSessions();

        this.postWorkspaceState();
        this.postMessage({ type: 'session_list', payload: { sessions } });
        await this.syncViewTitleForSession(this.chatService?.activeSessionId || undefined);

        this.replayPendingRequests();
        this.broadcastPendingEdits();
        await this.refreshTasksAndPermissions();
    }

    private handleSessionMetadataChanged(metadata: SessionMetadata): void {
        if (metadata.id === this.chatService?.activeSessionId || metadata.id === this.agentService.activeSessionId) {
            this.setViewTitle(this.displayTitleForMetadata(metadata));
        }
        this.postMessage({ type: 'session_metadata_updated', payload: metadata });
        this.sessionService.listSessions()
            .then(sessions => this.postMessage({ type: 'session_list', payload: { sessions } }))
            .catch(error => console.error('[WebviewProvider] Failed to refresh session list after metadata update:', error));
    }

    private async syncViewTitleForSession(sessionId?: string | null): Promise<void> {
        if (!sessionId) {
            this.setViewTitle(WebviewProvider.defaultViewTitle);
            return;
        }

        const metadata = await this.sessionService.getSessionMetadata(sessionId);
        this.setViewTitle(this.displayTitleForMetadata(metadata));
    }

    private setViewTitle(title?: string): void {
        if (!this.view) return;
        this.view.title = title && title.trim() ? title.trim() : WebviewProvider.defaultViewTitle;
    }

    private displayTitleForMetadata(metadata?: SessionMetadata): string {
        if (!metadata || (metadata.messageCount === 0 && metadata.title === 'New Chat')) {
            return WebviewProvider.defaultViewTitle;
        }
        return metadata.title || WebviewProvider.defaultViewTitle;
    }

    private postWorkspaceState(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.postMessage({ type: 'workspace_state', payload: { name: 'Project', path: '' } });
            return;
        }

        const workspacePath = workspaceFolder.uri.fsPath;
        this.postMessage({
            type: 'workspace_state',
            payload: {
                name: workspaceFolder.name || path.basename(workspacePath) || 'Project',
                path: workspacePath
            }
        });
    }

    private replayPendingRequests(): void {
        for (const [id, request] of this.pendingPermissionRequests.entries()) {
            const choices = this.pendingChoices.get(id);
            this.postMessage({
                type: choices ? 'ask_user_choice' : 'request_permission',
                payload: {
                    id,
                    sessionId: request.sessionId,
                    runId: request.runId,
                    run_id: request.runId,
                    toolName: request.toolName,
                    tool_name: request.toolName,
                    question: request.question,
                    choices: choices || [...PERMISSION_CHOICES],
                    kind: choices ? 'choice' : 'permission',
                    restored: true
                }
            });
        }
    }

    private async refreshTasksAndPermissions(): Promise<void> {
        try {
            const tasks = await this.core.send('get_tasks', {});
            this.postMessage({ type: 'tasks_updated', payload: tasks });
        } catch (e) {
            console.error('Failed to restore tasks:', e);
        }

        try {
            const permissions = await this.core.send('get_permissions', {});
            this.postMessage({ type: 'permissions', payload: permissions });
        } catch (e) {
            console.error('Failed to restore permissions:', e);
        }
    }

    private async initCheckpoints() {
        if (this.checkpointService) {
            this.view?.webview.postMessage({
                type: 'checkpoint_initialized',
                payload: { baseHash: this.checkpointService.baseHash || '' }
            });
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }
        const workspaceDir = workspaceFolders[0].uri.fsPath;
        const globalStorageDir = this.context.globalStorageUri.fsPath;
        const taskId = "default-session"; // TODO: mult-session support

        // Hash workspace to avoid collision if multiple Workspaces use same taskId (though taskId should be unique)
        // Roo uses tasks/{taskId}/checkpoints. We can use simplified path for now.
        const checkpointsDir = path.join(globalStorageDir, "checkpoints", nodeCrypto.createHash('md5').update(workspaceDir).digest('hex'));

        this.checkpointService = new ShadowCheckpointService(
            taskId,
            checkpointsDir,
            workspaceDir,
            (msg) => console.log(`[Checkpoint] ${msg}`)
        );

        await this.checkpointService.initShadowGit();

        // Send confirmation to webview
        this.view?.webview.postMessage({
            type: 'checkpoint_initialized',
            payload: { baseHash: this.checkpointService.baseHash || '' }
        });

        // Listen for internal events
        this.checkpointService.on('checkpoint', (data) => {
            this.view?.webview.postMessage({ type: 'checkpoint_update', payload: data });
        });
    }

    public clearPendingRequests(sessionId: string) {
        console.log(`[Extension] Clearing pending requests for session: ${sessionId}`);
        for (const [id, req] of this.pendingPermissionRequests.entries()) {
            if (req.sessionId === sessionId) {
                this.pendingPermissionRequests.delete(id);
                this.pendingChoices.delete(id);
            }
        }
    }

    // Public methods for extension.ts
    async clearChat(): Promise<void> {
        await this.chatService?.handleMessage({ type: 'clear_chat' });
    }

    async createNewSession(): Promise<void> {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            // Cancel any active runtime before creating a new chat.
            await this.chatService?.cancelActiveChatRuntime('create_session');
            await this.agentService.handleMessage({ type: 'cancel_session' });

            const newId = await this.sessionService.createSession(vscode.workspace.workspaceFolders[0].uri.fsPath);
            this.chatService?.setActiveSession(newId);
            this.setViewTitle(WebviewProvider.defaultViewTitle);

            // Hydrate core with empty session to reset context
            try {
                await this.core.send('hydrate_session', {
                    session_id: newId,
                    messages: []
                });
            } catch (e) {
                console.error('Failed to hydrate new session:', e);
            }

            this.postMessage({ type: 'session_created', payload: { id: newId } });
        }
    }

    async toggleLiveMode(): Promise<void> {
        await this.chatService?.handleMessage({ type: 'toggle_live_mode' });
    }

    async openSettings(): Promise<void> {
        this.postMessage({ type: 'open_settings' });
    }

    async openAgent(): Promise<void> {
        this.postMessage({ type: 'open_agent' });
    }

    async openHistory(): Promise<void> {
        this.postMessage({ type: 'open_history' });
    }

    async openAccount(): Promise<void> {
        this.postMessage({ type: 'open_account' });
    }

    private postMessage(message: WebviewMessage): void {
        const delivery = this.view?.webview.postMessage(message);
        if (message.type === 'ask_completion_result') {
            const payload = (message.payload || {}) as { session_id?: string; sessionId?: string; run_id?: string };
            delivery?.then(
                delivered => console.log('[WebviewProvider] ask_completion_result delivery', {
                    delivered,
                    session_id: payload.session_id || payload.sessionId,
                    run_id: payload.run_id,
                }),
                error => console.warn('[WebviewProvider] ask_completion_result delivery failed', {
                    session_id: payload.session_id || payload.sessionId,
                    run_id: payload.run_id,
                    error: error instanceof Error ? error.message : String(error),
                }),
            );
        }
    }

    private async handleProposedEdit(payload: {
        proposal_id?: string;
        session_id?: string;
        tool?: string;
        path?: string;
        original_content?: string;
        new_content?: string;
    }): Promise<{ decision: 'accepted' | 'rejected' | 'timeout'; applied: boolean; reason?: string }> {
        const filePath = payload.path;
        if (!filePath || payload.new_content === undefined) {
            return { decision: 'rejected', applied: false };
        }

        const proposalId = payload.proposal_id || `proposal-${Date.now()}`;
        const fullPath = this.resolveWorkspacePath(filePath);
        const diffService = DiffService.getInstance();

        const edit = diffService.registerPendingEdit(fullPath, payload.new_content, {
            originalContent: payload.original_content ?? '',
            proposalId,
            tool: payload.tool
        });
        if (!edit) {
            return { decision: 'accepted', applied: false, reason: 'no_changes' };
        }
        this.broadcastPendingEdits();

        await this.openPendingEditForReview(fullPath);

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                diffService.off('decision', onDecision);
                resolve({ decision: 'timeout', applied: false });
            }, 24 * 60 * 60 * 1000);

            const onDecision = (event: any) => {
                if (event?.proposalId) {
                    if (event.proposalId !== proposalId) return;
                } else if (event?.filePath !== fullPath) {
                    return;
                }
                clearTimeout(timeout);
                diffService.off('decision', onDecision);
                resolve({
                    decision: event.decision === 'accepted' ? 'accepted' : 'rejected',
                    applied: !!event.applied,
                    reason: event.reason
                });
            };

            diffService.on('decision', onDecision);
        });
    }

    private resolveWorkspacePath(filePath: string): string {
        const cleanPath = filePath.replace(/^file:\/\//, '');
        if (path.isAbsolute(cleanPath)) {
            return cleanPath;
        }
        return path.join(vscode.workspace.workspaceFolders?.[0].uri.fsPath || '', cleanPath);
    }

    private findPendingEditByBasename(filePath: string) {
        const fileName = path.basename(filePath.replace(/^file:\/\//, ''));
        if (!fileName || fileName === '.' || fileName === path.sep) return undefined;
        const matches = DiffService.getInstance().getPendingEdits().filter(edit => path.basename(edit.filePath) === fileName);
        return matches.length === 1 ? matches[0] : undefined;
    }

    private async resolveOpenFilePath(filePath: string, options: { allowBasenameFallback?: boolean } = {}): Promise<string | undefined> {
        const cleanPath = filePath.replace(/^file:\/\//, '');
        const directPath = this.resolveWorkspacePath(cleanPath);
        if (fs.existsSync(directPath)) {
            return directPath;
        }
        if (path.isAbsolute(cleanPath) || options.allowBasenameFallback === false) {
            return undefined;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const fileName = path.basename(cleanPath);
        if (!workspaceRoot || !fileName || fileName === '.' || fileName === path.sep) {
            return undefined;
        }

        const workspaceName = path.basename(workspaceRoot);
        const slashPath = cleanPath.replace(/\\/g, '/');
        if (slashPath.startsWith(`${workspaceName}/`)) {
            const strippedCandidate = path.join(workspaceRoot, slashPath.slice(workspaceName.length + 1));
            if (fs.existsSync(strippedCandidate)) {
                return strippedCandidate;
            }
        }

        const rootCandidate = path.join(workspaceRoot, fileName);
        if (fs.existsSync(rootCandidate)) {
            return rootCandidate;
        }

        const exclude = '**/{node_modules,.git,dist,out,build,target}/**';
        const matches = await vscode.workspace.findFiles(`**/${fileName}`, exclude, 10);
        return matches[0]?.fsPath;
    }

    private async openPendingEditForReview(filePath: string): Promise<void> {
        const diffService = DiffService.getInstance();
        const pending = diffService.refreshPendingEdit(filePath);
        if (!pending) return;

        if (pending.status === 'conflicted') {
            vscode.window.showWarningMessage(pending.conflictReason || `Cannot open ${path.basename(filePath)} for Ricochet review because it changed.`);
            ReviewService.getInstance().refresh();
            return;
        }

        if (!fs.existsSync(filePath)) {
            const uri = vscode.Uri.from({ scheme: 'untitled', path: filePath });
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            if (doc.getText() !== pending.newContent) {
                await editor.edit(editBuilder => {
                    const start = doc.lineCount > 0 ? doc.lineAt(0).range.start : new vscode.Position(0, 0);
                    const end = doc.lineCount > 0 ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(0, 0);
                    editBuilder.replace(new vscode.Range(start, end), pending.newContent);
                });
            }
            diffService.markReviewing(filePath);
            vscode.window.showInformationMessage(`Review new file from chat pending changes: ${path.basename(filePath)}`);
            ReviewService.getInstance().refresh();
            return;
        }

        await diffService.showDiff(filePath, pending.newContent);
        diffService.markReviewing(filePath);
        ReviewService.getInstance().refresh();
    }

    private async stageAttachments(payload: any): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const result = await stageAttachmentsForWorkspace(payload, workspaceRoot);
        this.postMessage({
            type: 'attachments_staged',
            payload: result,
        });
    }

    private languageForPath(filePath: string): string {
        switch (path.extname(filePath).toLowerCase()) {
            case '.ts':
            case '.tsx':
                return 'typescript';
            case '.js':
            case '.jsx':
                return 'javascript';
            case '.go':
                return 'go';
            case '.rs':
                return 'rust';
            case '.py':
                return 'python';
            case '.json':
                return 'json';
            case '.md':
                return 'markdown';
            default:
                return 'plaintext';
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const devServerUrl = this.webviewDevServerUrl();
        if (devServerUrl) {
            return this.getDevWebviewContent(webview, devServerUrl);
        }

        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'webview-dist', 'main.js')
        );
        const stylePath = vscode.Uri.joinPath(this.context.extensionUri, 'webview-dist', 'main.css');
        const styleTag = fs.existsSync(stylePath.fsPath)
            ? `<link href="${webview.asWebviewUri(stylePath)}" rel="stylesheet">`
            : '';
        const logoUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'ricochet.png')
        );

        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  ${styleTag}
  <title>Ricochet</title>
  <script nonce="${nonce}">
    window.RICOCHET_LOGO_URI = "${logoUri}";
  </script>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getDevWebviewContent(webview: vscode.Webview, devServerUrl: string): string {
        const nonce = this.getNonce();
        const logoUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'ricochet.png')
        );
        const devOrigin = new URL(devServerUrl).origin;
        const viteClientUri = `${devOrigin}/@vite/client`;
        const viteEntryUri = `${devOrigin}/src/main.tsx`;
        const devServerJson = JSON.stringify(devOrigin);
        const logoJson = JSON.stringify(String(logoUri));

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} ${devOrigin} data: blob:; style-src ${webview.cspSource} ${devOrigin} 'unsafe-inline'; script-src 'nonce-${nonce}' ${devOrigin} 'unsafe-eval'; connect-src ${devOrigin} ws://127.0.0.1:* ws://localhost:*; font-src ${webview.cspSource} ${devOrigin};">
  <title>Ricochet Dev</title>
  <script nonce="${nonce}">
    window.RICOCHET_LOGO_URI = ${logoJson};
    window.RICOCHET_WEBVIEW_DEV_SERVER = true;
    window.RICOCHET_WEBVIEW_DEV_SERVER_URL = ${devServerJson};
  </script>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${viteClientUri}"></script>
  <script nonce="${nonce}" type="module" src="${viteEntryUri}"></script>
</body>
</html>`;
    }

    private webviewDevServerUrl(): string | null {
        const raw = String(
            vscode.workspace.getConfiguration('ricochet.webview').get('devServerUrl') ||
            process.env.RICOCHET_WEBVIEW_DEV_SERVER_URL ||
            ''
        ).trim();
        if (!raw) return null;
        try {
            const url = new URL(raw);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
            return url.origin;
        } catch {
            return null;
        }
    }

    private broadcastPendingEdits() {
        const diffService = DiffService.getInstance();
        const edits = diffService.getPendingEdits().map(edit => {
            const relativePath = vscode.workspace.asRelativePath(edit.filePath, false);
            const hunks = diffService.getHunks(edit.filePath).slice(0, 4).map(hunk => ({
                id: hunk.id,
                oldStart: hunk.oldStart,
                oldLength: hunk.oldLength,
                newStart: hunk.newStart,
                newLength: hunk.newLength,
                oldLines: hunk.oldLines.slice(0, 6),
                newLines: hunk.newLines.slice(0, 6),
                additions: hunk.additions,
                deletions: hunk.deletions,
            }));
            const hasDiff = hunks.length > 0 || edit.additions > 0 || edit.deletions > 0;
            const state = edit.status === 'conflicted'
                ? 'conflicted'
                : hasDiff
                    ? 'pending'
                    : 'no_changes';
            return {
                filePath: edit.filePath,
                relativePath,
                displayName: path.basename(edit.filePath),
                additions: edit.additions,
                deletions: edit.deletions,
                status: edit.status,
                state,
                hasDiff,
                reviewable: hasDiff && edit.status !== 'conflicted',
                conflictReason: edit.conflictReason,
                error: edit.conflictReason,
                isNewFile: edit.isNewFile,
                proposalId: edit.proposalId,
                tool: edit.tool,
                hunks,
                diffPreview: hunks[0]
                    ? [...(hunks[0].oldLines || []).slice(0, 2), ...(hunks[0].newLines || []).slice(0, 3)].join('\n')
                    : undefined,
            };
        });
        this.postMessage({
            type: 'pending_edits',
            payload: {
                session_id: this.chatService?.activeSessionId || this.agentService?.activeSessionId || undefined,
                run_id: this.chatService?.activeRunId || undefined,
                edits,
            },
        });
        // Also refresh editor decorations
        ReviewService.getInstance().refresh();
    }

    private async openMicrophonePermissionSettings(): Promise<void> {
        const appName = vscode.env.appName || 'VS Code';
        const hint = `Allow microphone access for ${appName}, then return to Ricochet and click the microphone again.`;

        try {
            if (process.platform === 'darwin') {
                await vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
                vscode.window.showInformationMessage(hint);
                return;
            }
            if (process.platform === 'win32') {
                await vscode.env.openExternal(vscode.Uri.parse('ms-settings:privacy-microphone'));
                vscode.window.showInformationMessage(hint);
                return;
            }

            await vscode.commands.executeCommand('workbench.action.openSettings', 'microphone');
            vscode.window.showInformationMessage(`Open your system privacy settings and ${hint}`);
        } catch (error) {
            vscode.window.showInformationMessage(`Open System Settings > Privacy & Security > Microphone. ${hint}`);
        }
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
