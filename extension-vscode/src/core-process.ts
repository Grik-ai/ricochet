import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import { CoreNotificationPayloads, CoreRequestPayloads } from './protocol/coreMessages';

export interface CoreMessage {
    type: string;
    payload: unknown;
}

type MessageHandler<TPayload = unknown> = (payload: TPayload) => void;
type RequestHandler<TPayload = unknown> = (payload: TPayload) => Promise<unknown>;
type Unsubscribe = () => void;

/**
 * Manages the ricochet-core Go process lifecycle.
 * Communicates via JSON-RPC over stdio.
 */
export class CoreProcess {
    private process: ChildProcess | null = null;
    private messageHandlers: Map<string, Set<MessageHandler>> = new Map();
    private requestHandlers: Map<string, RequestHandler> = new Map();
    private pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }> = new Map();
    private requestId = 0;
    private rl: readline.Interface | null = null;
    private ready = false;

    constructor(private rootPath: string, private extensionPath: string) { }

    async start(): Promise<void> {
        const binaryPath = this.getBinaryPath();

        // Load default API keys from .env.keys file
        const envKeys = this.loadEnvKeys();

        console.log(`[Extension] Starting core process: ${binaryPath} in ${this.rootPath}`);

        this.process = spawn(binaryPath, ['--stdio'], {
            cwd: this.rootPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...envKeys, PROJECT_ROOT: this.rootPath }
        });

        if (!this.process.stdout || !this.process.stdin) {
            throw new Error('Failed to start core process: stdio not available');
        }

        // Setup readline for JSON-RPC messages
        this.rl = readline.createInterface({
            input: this.process.stdout,
            crlfDelay: Infinity
        });

        this.rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('{')) {
                // Not a JSON message, probably a log from the core
                if (trimmed) {
                    // Suppress known non-critical telemetry errors
                    if (trimmed.includes('UnleashProvider must be initialized first')) {
                        return;
                    }
                    console.log(`[ricochet-core] LOG: ${trimmed}`);
                }
                return;
            }

            try {
                const message = JSON.parse(line);
                this.handleMessage(message);
            } catch (error) {
                console.error(`[Core -> Ext] Failed to parse JSON message`, error);
            }
        });

        this.process.stderr?.on('data', (data) => {
            console.error(`[ricochet-core] ${data}`);
        });

        this.process.on('exit', (code) => {
            console.log(`ricochet-core exited with code ${code}`);
            this.process = null;
            this.rejectPendingRequests(new Error(`Core process exited with code ${code}`));
        });

        // Wait for ready message
        await this.waitForReady();
    }

    async stop(): Promise<void> {
        await this.abortActiveRuntime(750);

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        if (this.rl) {
            this.rl.close();
            this.rl = null;
        }
        this.rejectPendingRequests(new Error('Core process stopped'));
    }

    async abortActiveRuntime(timeoutMs = 1500): Promise<void> {
        if (!this.process?.stdin) {
            return;
        }

        try {
            await Promise.race([
                this.send('abort_chat', {}),
                new Promise((_, reject) => setTimeout(() => reject(new Error('abort_chat timeout')), timeoutMs))
            ]);
        } catch (error) {
            console.warn('[CoreProcess] Failed to abort active runtime before shutdown:', error);
        }
    }

    async send(type: string, payload: unknown, timeoutMs?: number): Promise<unknown> {
        if (!this.process?.stdin) {
            throw new Error('Core process not running');
        }

        const id = ++this.requestId;
        const message = JSON.stringify({ id, type, payload }) + '\n';
        console.log(`[Ext -> Core] SEND id=${id} type=${type}`);

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.process!.stdin!.write(message);

            const requestTimeoutMs = timeoutMs ?? (type !== 'chat_message' && type !== 'audio_start' ? 600000 : 0);
            if (requestTimeoutMs > 0) {
                setTimeout(() => {
                    if (this.pendingRequests.has(id)) {
                        console.error(`[Ext -> Core] TIMEOUT id=${id} type=${type}`);
                        this.pendingRequests.delete(id);
                        reject(new Error(`Request timeout (${type}) after ${Math.round(requestTimeoutMs / 1000)}s`));
                    }
                }, requestTimeoutMs);
            }
        });
    }

    onMessage<T extends keyof CoreNotificationPayloads>(type: T, handler: (payload: CoreNotificationPayloads[T]) => void): Unsubscribe;
    onMessage(type: string, handler: MessageHandler): Unsubscribe;
    onMessage(type: string, handler: MessageHandler): Unsubscribe {
        const handlers = this.messageHandlers.get(type) ?? new Set<MessageHandler>();
        handlers.add(handler);
        this.messageHandlers.set(type, handlers);
        return () => {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.messageHandlers.delete(type);
            }
        };
    }

    onRequest<T extends keyof CoreRequestPayloads>(type: T, handler: (payload: CoreRequestPayloads[T]) => Promise<unknown>): void;
    onRequest(type: string, handler: RequestHandler): void;
    onRequest(type: string, handler: RequestHandler): void {
        if (this.requestHandlers.has(type)) {
            console.warn(`[CoreProcess] Replacing request handler for '${type}'`);
        }
        this.requestHandlers.set(type, handler);
    }

    private async handleMessage(message: any): Promise<void> {
        if (message.type !== 'chat_update') {
            console.log(`[Core -> Ext] RECV id=${message.id} type=${message.type}`);
        } else {
            const payload = message.payload || {};
            const chatMessage = payload.message || {};
            const visibleContent = this.cleanVisibleChatText(String(chatMessage.content || ''));
            const toolCount = Array.isArray(chatMessage.toolCalls) ? chatMessage.toolCalls.length : 0;
            const activityCount = Array.isArray(chatMessage.activities) ? chatMessage.activities.length : 0;
            const artifactCount = Array.isArray(chatMessage.artifacts) ? chatMessage.artifacts.length : 0;
            console.log(`[Core -> Ext] CHAT_UPDATE run=${payload.run_id || chatMessage.run_id || ''} role=${chatMessage.role || ''} streaming=${Boolean(chatMessage.isStreaming)} visible=${visibleContent.length > 0} tools=${toolCount} activities=${activityCount} artifacts=${artifactCount}`);
        }
        if (message.type === 'ready') {
            this.ready = true;
        }
        // Handle response to pending request (Extension -> Core -> Extension)
        if (message.type === 'response' || ('id' in message && this.pendingRequests.has(message.id))) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                console.log(`[Core -> Ext] RESOLVING id=${message.id}`);
                this.pendingRequests.delete(message.id);
                if (message.error) {
                    pending.reject(new Error(String(message.error)));
                } else {
                    pending.resolve(message.payload);
                }
                return;
            } else {
                console.warn(`[Core -> Ext] No pending request for id=${message.id}`);
            }
        }

        // Handle incoming request from core (Core -> Extension -> Core)
        // Correcting protocol check: if it has an ID and is NOT a response, it's a request
        if (message.id && message.type !== 'response') {
            const handler = this.requestHandlers.get(message.type);
            if (handler) {
                try {
                    const result = await handler(message.payload);
                    this.sendResponse(message.id, result);
                } catch (error) {
                    this.sendResponse(message.id, null, String(error));
                }
                return;
            }
        }

        // Handle push notifications
        const handlers = this.messageHandlers.get(message.type);
        if (handlers) {
            for (const handler of [...handlers]) {
                try {
                    handler(message.payload);
                } catch (error) {
                    console.error(`[CoreProcess] Message handler for '${message.type}' failed:`, error);
                }
            }
        }
    }

    private cleanVisibleChatText(text: string): string {
        return text
            .replace(/<(?:thinking|think)>[\s\S]*?(?:<\/(?:thinking|think)>|$)/gi, '')
            .replace(/<\/(?:thinking|think)>/gi, '')
            .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, '')
            .trim();
    }

    private rejectPendingRequests(error: Error): void {
        for (const [, pending] of this.pendingRequests) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }

    private sendResponse(id: string | number, payload: unknown, error?: string): void {
        if (!this.process?.stdin) return;
        const message = JSON.stringify({
            id,
            type: 'response',
            payload,
            error
        }) + '\n';
        this.process.stdin.write(message);
    }

    private async waitForReady(): Promise<void> {
        if (this.ready) {
            return;
        }
        return new Promise((resolve, reject) => {
            let unsubscribe: Unsubscribe | undefined;
            const timeout = setTimeout(() => {
                unsubscribe?.();
                reject(new Error('Core process did not start in time'));
            }, 30000);

            unsubscribe = this.onMessage('ready', () => {
                clearTimeout(timeout);
                unsubscribe?.();
                resolve();
            });
        });
    }

    private getBinaryPath(): string {
        const platform = process.platform;
        const arch = process.arch;

        let binaryName = 'ricochet-core';
        if (platform === 'win32') {
            binaryName += '.exe';
        }

        // Binary is bundled with extension
        return path.join(this.extensionPath, 'bin', `${platform}-${arch}`, binaryName);
    }

    /**
     * Load default API keys from .env.keys file
     */
    private loadEnvKeys(): Record<string, string> {
        const envPath = path.join(this.extensionPath, '.env.keys');
        const result: Record<string, string> = {};

        try {
            if (fs.existsSync(envPath)) {
                const content = fs.readFileSync(envPath, 'utf-8');
                for (const line of content.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        const eqIndex = trimmed.indexOf('=');
                        if (eqIndex > 0) {
                            const key = trimmed.substring(0, eqIndex).trim();
                            const value = trimmed.substring(eqIndex + 1).trim();
                            result[key] = value;
                        }
                    }
                }
                console.log(`Loaded ${Object.keys(result).length} API keys from .env.keys`);
            }
        } catch (error) {
            console.warn('Failed to load .env.keys:', error);
        }

        return result;
    }
}
