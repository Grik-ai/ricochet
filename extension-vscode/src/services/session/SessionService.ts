import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SessionMetadata {
    id: string;
    title: string;
    lastModified: number;
    messageCount: number;
    workspaceDir: string;
    usage?: any;
}

export interface SessionData {
    messages: any[]; // ChatMessage[]
    todos: any[];    // Todo[]
    usage?: any;
}

export class SessionService {
    private readonly globalStateKey = 'ricochet_sessions';
    private readonly storageDir: string;
    private static readonly defaultTitle = 'New Chat';
    private static readonly maxTitleLength = 72;
    private readonly sessionWriteQueues = new Map<string, Promise<void>>();

    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        this.storageDir = path.join(context.globalStorageUri.fsPath, 'sessions');
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }
    }

    public async listSessions(): Promise<SessionMetadata[]> {
        const sessions = this.context.globalState.get<SessionMetadata[]>(this.globalStateKey, []);
        // Sort by lastModified desc
        return sessions.sort((a, b) => b.lastModified - a.lastModified);
    }

    public createTitleFromPrompt(prompt?: string): string {
        const cleaned = (prompt || '')
            .replace(/^\s*\[PLAN MODE\]\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!cleaned) {
            return SessionService.defaultTitle;
        }

        if (cleaned.length <= SessionService.maxTitleLength) {
            return cleaned;
        }

        return `${cleaned.slice(0, SessionService.maxTitleLength - 1).trimEnd()}…`;
    }

    public async createSession(workspaceDir: string, title?: string): Promise<string> {
        const id = crypto.randomUUID();
        const metadata: SessionMetadata = {
            id,
            title: this.createTitleFromPrompt(title),
            lastModified: Date.now(),
            messageCount: 0,
            workspaceDir
        };

        // Update list
        const sessions = await this.listSessions();
        sessions.unshift(metadata);
        await this.context.globalState.update(this.globalStateKey, sessions);

        // Create empty session file
        const data: SessionData = { messages: [], todos: [] };
        const filePath = path.join(this.storageDir, `${id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

        return id;
    }

    public async getSessionMetadata(id: string): Promise<SessionMetadata | undefined> {
        const sessions = await this.listSessions();
        return sessions.find(s => s.id === id);
    }

    public async updateSessionTitle(id: string, promptOrTitle?: string): Promise<SessionMetadata | undefined> {
        const sessions = await this.listSessions();
        const index = sessions.findIndex(s => s.id === id);
        if (index === -1) {
            return undefined;
        }

        const current = sessions[index];
        const title = this.createTitleFromPrompt(promptOrTitle);
        const metadata: SessionMetadata = {
            ...current,
            title,
            lastModified: Date.now()
        };

        sessions[index] = metadata;
        await this.context.globalState.update(this.globalStateKey, sessions);
        return metadata;
    }

    public async loadSession(id: string): Promise<SessionData | null> {
        const filePath = path.join(this.storageDir, `${id}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(content);
            } catch (e) {
                console.error(`Failed to load session ${id}:`, e);
            }
        }
        return null;
    }

    public async saveSession(id: string, data: SessionData, workspaceDir: string): Promise<void> {
        await this.runSerialized(id, async () => {
            await this.writeSessionUnlocked(id, data, workspaceDir);
        });
    }

    public async deleteSession(id: string): Promise<void> {
        const filePath = path.join(this.storageDir, `${id}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        const sessions = await this.listSessions();
        const updated = sessions.filter(s => s.id !== id);
        await this.context.globalState.update(this.globalStateKey, updated);
    }

    public async appendMessage(sessionId: string, message: any): Promise<void> {
        await this.upsertMessage(sessionId, message);
    }

    public async upsertMessage(sessionId: string, message: any): Promise<void> {
        await this.runSerialized(sessionId, async () => {
            const sessionData = await this.loadSession(sessionId);
            if (!sessionData) {
                console.warn(`[SessionService] Cannot update non-existent session: ${sessionId}`);
                return;
            }

            sessionData.messages = this.upsertIntoMessages(sessionData.messages || [], message);

            const sessionMeta = await this.getSessionMetadata(sessionId);
            await this.writeSessionUnlocked(sessionId, sessionData, sessionMeta?.workspaceDir || '');
        });
    }

    public async updateUsage(sessionId: string, usage: any): Promise<void> {
        await this.runSerialized(sessionId, async () => {
            const sessionData = await this.loadSession(sessionId);
            if (!sessionData) {
                return;
            }
            sessionData.usage = usage;
            const sessionMeta = await this.getSessionMetadata(sessionId);
            await this.writeSessionUnlocked(sessionId, sessionData, sessionMeta?.workspaceDir || '');
        });
    }

    private async runSerialized(sessionId: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.sessionWriteQueues.get(sessionId) || Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        const stored = next.catch(() => undefined);
        this.sessionWriteQueues.set(sessionId, stored);

        try {
            await next;
        } finally {
            if (this.sessionWriteQueues.get(sessionId) === stored) {
                this.sessionWriteQueues.delete(sessionId);
            }
        }
    }

    private async writeSessionUnlocked(id: string, data: SessionData, workspaceDir: string): Promise<void> {
        const normalizedData: SessionData = {
            messages: Array.isArray(data.messages) ? data.messages : [],
            todos: Array.isArray(data.todos) ? data.todos : [],
            usage: data.usage
        };

        const filePath = path.join(this.storageDir, `${id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(normalizedData, null, 2));

        // Update metadata
        const sessions = await this.listSessions();
        const index = sessions.findIndex(s => s.id === id);

        let title = SessionService.defaultTitle;
        if (normalizedData.messages.length > 0) {
            const firstUserMsg = normalizedData.messages.find(m => m.role === 'user');
            if (firstUserMsg) {
                title = this.createTitleFromPrompt(firstUserMsg.content);
            }
        }

        const metadata: SessionMetadata = {
            id,
            title,
            lastModified: Date.now(),
            messageCount: normalizedData.messages.length,
            workspaceDir,
            usage: normalizedData.usage
        };

        if (index !== -1) {
            sessions[index] = metadata;
        } else {
            sessions.unshift(metadata);
        }
        await this.context.globalState.update(this.globalStateKey, sessions);
    }

    private upsertIntoMessages(messages: any[], incoming: any): any[] {
        if (!incoming || typeof incoming !== 'object') {
            return [...messages, incoming];
        }

        if (incoming.id) {
            const byId = messages.findIndex(message => message?.id === incoming.id);
            if (byId !== -1) {
                return messages.map((message, index) => index === byId ? { ...message, ...incoming } : message);
            }
        }

        const optimisticUserIndex = this.findOptimisticUserMessageIndex(messages, incoming);
        if (optimisticUserIndex !== -1) {
            return messages.map((message, index) => index === optimisticUserIndex ? { ...message, ...incoming } : message);
        }

        const duplicateAssistantIndex = this.findDuplicateAssistantFinalIndex(messages, incoming);
        if (duplicateAssistantIndex !== -1) {
            return messages.map((message, index) => index === duplicateAssistantIndex ? { ...message, ...incoming } : message);
        }

        return [...messages, incoming];
    }

    private findOptimisticUserMessageIndex(messages: any[], incoming: any): number {
        if (incoming.role !== 'user') return -1;

        const incomingRunId = incoming.run_id || incoming.runId;
        const incomingTurnId = incoming.turn_id || incoming.turnId;
        if (!incomingRunId && !incomingTurnId) return -1;

        return messages.findIndex(message => {
            if (message?.role !== 'user') return false;
            const messageRunId = message.run_id || message.runId;
            const messageTurnId = message.turn_id || message.turnId;
            return Boolean(
                (incomingRunId && messageRunId === incomingRunId) ||
                (incomingTurnId && messageTurnId === incomingTurnId)
            );
        });
    }

    private findDuplicateAssistantFinalIndex(messages: any[], incoming: any): number {
        if (incoming.role !== 'assistant' || incoming.isStreaming === true) return -1;

        const incomingRunId = incoming.run_id || incoming.runId;
        const incomingTurnId = incoming.turn_id || incoming.turnId;
        const incomingContent = typeof incoming.content === 'string' ? incoming.content : '';

        return messages.findIndex(message => {
            if (message?.role !== 'assistant' || message.isStreaming === true) return false;

            if (incomingRunId && (message.run_id || message.runId) === incomingRunId) {
                return true;
            }
            if (incomingTurnId && (message.turn_id || message.turnId) === incomingTurnId) {
                return true;
            }

            return incomingContent !== '' && message.content === incomingContent;
        });
    }
}
