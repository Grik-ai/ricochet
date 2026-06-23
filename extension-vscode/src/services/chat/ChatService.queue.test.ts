import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [],
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
        showErrorMessage: vi.fn(),
    },
    Uri: {
        joinPath: (_base: any, filePath: string) => ({ fsPath: filePath }),
    },
}));

import {
    isQueuedChatMessageResult,
    normalizeQueuedMessagePayload,
} from './ChatService';

describe('ChatService queued chat responses', () => {
    it('distinguishes queued chat acknowledgements from completed chat responses', () => {
        expect(isQueuedChatMessageResult({ status: 'done' })).toBe(false);
        expect(isQueuedChatMessageResult({
            session_id: 'session-1',
            run_id: 'run-queued',
            message: {
                id: 'queue-message-1',
                text: 'повтори задачу',
            },
        })).toBe(true);
    });

    it('normalizes queued payloads with the original session and run metadata', () => {
        const payload = normalizeQueuedMessagePayload({
            message: {
                id: 'queue-message-1',
                text: 'прервалось',
                context_files: [{ path: '.ricochet/attachments/session/doc.md', name: 'doc.md' }],
            },
        }, 'session-1', 'run-queued', 'fallback text');

        expect(payload).toMatchObject({
            session_id: 'session-1',
            sessionId: 'session-1',
            run_id: 'run-queued',
            runId: 'run-queued',
            message_id: 'queue-message-1',
            status: 'queued',
            text: 'прервалось',
            context_files: [{ path: '.ricochet/attachments/session/doc.md', name: 'doc.md' }],
            message: {
                id: 'queue-message-1',
                session_id: 'session-1',
                run_id: 'run-queued',
                text: 'прервалось',
                context_files: [{ path: '.ricochet/attachments/session/doc.md', name: 'doc.md' }],
            },
        });
    });
});
