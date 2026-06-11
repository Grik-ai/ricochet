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
        const filePath = path.join(this.storageDir, `${id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

        // Update metadata
        const sessions = await this.listSessions();
        const index = sessions.findIndex(s => s.id === id);

        let title = SessionService.defaultTitle;
        if (data.messages.length > 0) {
            const firstUserMsg = data.messages.find(m => m.role === 'user');
            if (firstUserMsg) {
                title = this.createTitleFromPrompt(firstUserMsg.content);
            }
        }

        const metadata: SessionMetadata = {
            id,
            title,
            lastModified: Date.now(),
            messageCount: data.messages.length,
            workspaceDir,
            usage: data.usage
        };

        if (index !== -1) {
            sessions[index] = metadata;
        } else {
            sessions.unshift(metadata);
        }
        await this.context.globalState.update(this.globalStateKey, sessions);
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
        const sessionData = await this.loadSession(sessionId);
        if (!sessionData) {
            console.warn(`[SessionService] Cannot append to non-existent session: ${sessionId}`);
            return;
        }

        sessionData.messages.push(message);

        // Use the workspace from metadata if possible, or fallback
        const sessions = await this.listSessions();
        const sessionMeta = sessions.find(s => s.id === sessionId);
        const workspaceDir = sessionMeta ? sessionMeta.workspaceDir : ''; // Ideally we shouldn't lose this

        await this.saveSession(sessionId, sessionData, workspaceDir);
    }

    public async updateUsage(sessionId: string, usage: any): Promise<void> {
        const sessionData = await this.loadSession(sessionId);
        if (!sessionData) {
            return;
        }
        sessionData.usage = usage;
        const sessions = await this.listSessions();
        const sessionMeta = sessions.find(s => s.id === sessionId);
        await this.saveSession(sessionId, sessionData, sessionMeta?.workspaceDir || '');
    }
}
