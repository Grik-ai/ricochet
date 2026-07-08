import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('useChat session switching', () => {
    it('clears runtime state when a new active session is created', () => {
        const source = readFileSync(new URL('./useChat.ts', import.meta.url), 'utf8');
        const helperStart = source.indexOf('const resetChatRuntimeState = useCallback');
        const helperEnd = source.indexOf('const markRunTerminal', helperStart);
        const helperBlock = source.slice(helperStart, helperEnd);
        const eventStart = source.indexOf("case 'session_created':");
        const eventEnd = source.indexOf("case 'state':", eventStart);
        const eventBlock = source.slice(eventStart, eventEnd);

        expect(helperBlock).toContain('setMessages([])');
        expect(helperBlock).toContain('setTodos([])');
        expect(helperBlock).toContain('setWorkSummariesByTurn({})');
        expect(helperBlock).toContain('setQueuedTurnsByRunId({})');
        expect(helperBlock).toContain('setTaskProgress(null)');
        expect(helperBlock).toContain('setPendingPermissions({})');
        expect(helperBlock).toContain('setPendingEdits([])');
        expect(helperBlock).toContain('setIsLoading(false)');
        expect(helperBlock).toContain('setIsStopping(false)');
        expect(helperBlock).toContain('activeRunIdRef.current = null');

        expect(eventBlock).toContain('created?.id || created?.session_id || created?.sessionId');
        expect(eventBlock).toContain('resetChatRuntimeState();');
    });

    it('resets runtime state before hydrating session_loaded messages', () => {
        const source = readFileSync(new URL('./useChat.ts', import.meta.url), 'utf8');
        const start = source.indexOf("case 'session_loaded':");
        const end = source.indexOf("case 'mode_changed':", start);
        const loadedBlock = source.slice(start, end);

        expect(loadedBlock).toContain('resetChatRuntimeState();');
        expect(loadedBlock).toContain('loaded.id || loaded.session_id || loaded.sessionId');
        expect(loadedBlock).toContain('setMessages(nextMessages)');
        expect(loadedBlock).toContain('setTodos(loaded.todos || [])');
    });
});
