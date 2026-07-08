import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('webview session creation', () => {
    it('emits normalized session ids and an empty loaded state for new chats', () => {
        const source = readFileSync(new URL('./webview-provider.ts', import.meta.url), 'utf8');
        const start = source.indexOf('async createNewSession()');
        const end = source.indexOf('private async loadSessionDataWithCoreRepair', start);
        const createSessionBlock = source.slice(start, end);

        expect(createSessionBlock).toContain("await this.core.send('hydrate_session'");
        expect(createSessionBlock).toContain('const sessionPayload = { id: newId, session_id: newId, sessionId: newId };');
        expect(createSessionBlock).toContain("type: 'session_created'");
        expect(createSessionBlock).toContain("type: 'session_loaded'");
        expect(createSessionBlock).toContain('messages: []');
        expect(createSessionBlock).toContain('todos: []');
        expect(createSessionBlock).not.toContain('send_message');
        expect(createSessionBlock).not.toContain('start_session');
    });
});
