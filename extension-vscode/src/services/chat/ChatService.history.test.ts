import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const vscodeMock = vi.hoisted(() => ({
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
}));

vi.mock('vscode', () => ({
    workspace: {
        get workspaceFolders() {
            return vscodeMock.workspaceFolders;
        },
        asRelativePath: (value: string) => value,
        findFiles: vi.fn(async () => []),
        fs: {
            stat: vi.fn(async () => ({ size: 0 })),
        },
    },
    window: {
        terminals: [],
        createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() })),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
    },
    Uri: {
        joinPath: (_base: any, filePath: string) => ({ fsPath: filePath }),
    },
}));

import { ChatService } from './ChatService';
import { SessionService } from '../session/SessionService';

describe('ChatService history persistence', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        vi.restoreAllMocks();
        vscodeMock.workspaceFolders = [];
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('persists a final assistant message when Go omits isStreaming false', async () => {
        const { chatService, sessionService, workspaceDir } = createHarness(async () => ({}));
        const sessionId = await sessionService.createSession(workspaceDir, 'hello');
        chatService.setActiveSession(sessionId);

        await chatService.onChatUpdate({
            session_id: sessionId,
            message: {
                id: 'assistant-final',
                role: 'assistant',
                content: 'done'
            }
        });

        const saved = await sessionService.loadSession(sessionId);
        expect(saved?.messages).toHaveLength(1);
        expect(saved?.messages[0]).toMatchObject({
            id: 'assistant-final',
            role: 'assistant',
            content: 'done'
        });
    });

    it('replaces optimistic user messages when the core echo has the same run or turn id', async () => {
        const { sessionService, workspaceDir } = createHarness(async () => ({}));
        const sessionId = await sessionService.createSession(workspaceDir, 'hello');

        await sessionService.upsertMessage(sessionId, {
            role: 'user',
            content: 'hello',
            run_id: 'run-1',
            turn_id: 'run-1'
        });
        await sessionService.upsertMessage(sessionId, {
            id: 'core-user-1',
            role: 'user',
            content: 'hello',
            run_id: 'run-1',
            turn_id: 'run-1'
        });

        const saved = await sessionService.loadSession(sessionId);
        expect(saved?.messages).toHaveLength(1);
        expect(saved?.messages[0]).toMatchObject({ id: 'core-user-1', role: 'user' });
    });

    it('syncs a completed chat from the raw core snapshot and overwrites partial UI history', async () => {
        const snapshot = {
            session_id: 'session-sync',
            messages: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi from core' }
            ],
            todos: []
        };
        const { chatService, sessionService, core, workspaceDir } = createHarness(async (method: string) => {
            if (method === 'get_session_snapshot') return snapshot;
            if (method === 'hydrate_session') return {};
            if (method === 'chat_message') return { status: 'done' };
            return {};
        });
        const sessionId = await sessionService.createSession(workspaceDir, 'hello');
        await sessionService.upsertMessage(sessionId, { role: 'user', content: 'hello' });

        await chatService.handleMessage({
            type: 'send_message',
            payload: {
                session_id: sessionId,
                run_id: 'run-sync',
                content: 'follow up'
            }
        });

        const saved = await sessionService.loadSession(sessionId);
        expect(saved?.messages).toEqual(snapshot.messages);
        expect(core.send).toHaveBeenCalledWith('get_session_snapshot', { session_id: sessionId });
    });

    it('hydrates core from a richer core snapshot instead of broken local user-only history', async () => {
        const snapshot = {
            session_id: 'session-repair',
            messages: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'restored answer' }
            ],
            todos: []
        };
        const hydratePayloads: any[] = [];
        const { chatService, sessionService, workspaceDir } = createHarness(async (method: string, payload: any) => {
            if (method === 'get_session_snapshot') return snapshot;
            if (method === 'hydrate_session') {
                hydratePayloads.push(payload);
                return {};
            }
            if (method === 'chat_message') return { status: 'done' };
            return {};
        });
        const sessionId = await sessionService.createSession(workspaceDir, 'hello');
        await sessionService.upsertMessage(sessionId, { role: 'user', content: 'hello' });

        await chatService.handleMessage({
            type: 'send_message',
            payload: {
                session_id: sessionId,
                run_id: 'run-repair',
                content: 'continue'
            }
        });

        expect(hydratePayloads[0]).toMatchObject({
            session_id: sessionId,
            messages: snapshot.messages
        });
    });

    it('disables snapshot sync after old core reports get_session_snapshot as unknown and still completes chat', async () => {
        let snapshotCalls = 0;
        const { chatService, sessionService, core, postedMessages, workspaceDir } = createHarness(async (method: string) => {
            if (method === 'get_session_snapshot') {
                snapshotCalls += 1;
                throw new Error('Unknown message type: get_session_snapshot');
            }
            if (method === 'hydrate_session') return {};
            if (method === 'chat_message') return { status: 'done' };
            return {};
        });
        const sessionId = await sessionService.createSession(workspaceDir, 'hello');

        await chatService.handleMessage({
            type: 'send_message',
            payload: {
                session_id: sessionId,
                run_id: 'run-old-core',
                content: 'continue'
            }
        });

        expect(snapshotCalls).toBe(1);
        expect(core.send).toHaveBeenCalledWith('chat_message', expect.objectContaining({ session_id: sessionId }));
        expect(postedMessages).toContainEqual({
            type: 'ask_completion_result',
            payload: { session_id: sessionId, run_id: 'run-old-core' }
        });
    });

    function createHarness(sendImpl: (method: string, payload: any) => Promise<any>) {
        const root = mkdtempSync(join(tmpdir(), 'ricochet-history-test-'));
        tempDirs.push(root);
        const workspaceDir = join(root, 'workspace');
        vscodeMock.workspaceFolders = [{ uri: { fsPath: workspaceDir } }];

        const core = {
            send: vi.fn(sendImpl),
            onMessage: vi.fn(),
            onRequest: vi.fn()
        };
        const context = createContext(join(root, 'globalStorage'));
        const sessionService = new SessionService(context as any);
        const postedMessages: any[] = [];
        const chatService = new ChatService(
            context as any,
            core as any,
            message => postedMessages.push(message),
            sessionService
        );

        return { chatService, sessionService, core, postedMessages, workspaceDir };
    }
});

function createContext(globalStoragePath: string) {
    const globalState = new Map<string, any>();
    const workspaceState = new Map<string, any>();
    return {
        globalStorageUri: { fsPath: globalStoragePath },
        globalState: {
            get: (key: string, defaultValue?: any) => globalState.has(key) ? globalState.get(key) : defaultValue,
            update: async (key: string, value: any) => {
                globalState.set(key, value);
            },
        },
        workspaceState: {
            get: (key: string, defaultValue?: any) => workspaceState.has(key) ? workspaceState.get(key) : defaultValue,
            update: async (key: string, value: any) => {
                workspaceState.set(key, value);
            },
        },
    };
}
