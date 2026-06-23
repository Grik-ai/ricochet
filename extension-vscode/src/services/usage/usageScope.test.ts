import { describe, expect, it } from 'vitest';
import {
    attachContextSessionId,
    buildEmptyUsageSnapshot,
    explicitSessionIdFromPayload,
    shouldUseCachedUsage,
} from './usageScope';

describe('usage scoping helpers', () => {
    it('requires an explicit session id instead of falling back to active state', () => {
        expect(explicitSessionIdFromPayload(undefined)).toBeNull();
        expect(explicitSessionIdFromPayload({})).toBeNull();
        expect(explicitSessionIdFromPayload({ session_id: '  ' })).toBeNull();
        expect(explicitSessionIdFromPayload({ session_id: 'session-1' })).toBe('session-1');
        expect(explicitSessionIdFromPayload({ sessionId: 'session-2' })).toBe('session-2');
    });

    it('builds an empty snapshot for new composer sessions without inherited totals', () => {
        expect(buildEmptyUsageSnapshot()).toMatchObject({
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
            requestCount: 0,
            source: 'estimated',
            models: [],
            events: [],
        });
        expect(buildEmptyUsageSnapshot().sessionId).toBeUndefined();
        expect(buildEmptyUsageSnapshot('session-1').sessionId).toBe('session-1');
    });

    it('uses cached usage only when it belongs to the requested session', () => {
        expect(shouldUseCachedUsage({ usage: { sessionId: 'session-1' } as any }, 'session-1')).toBe(true);
        expect(shouldUseCachedUsage({ usage: { sessionId: 'session-2' } as any }, 'session-1')).toBe(false);
        expect(shouldUseCachedUsage({ usage: {} as any }, 'session-1')).toBe(false);
        expect(shouldUseCachedUsage(null, 'session-1')).toBe(false);
    });

    it('adds a session id to context status only when the payload is unscoped', () => {
        expect(attachContextSessionId({ tokens_used: 0 }, 'session-1')).toEqual({
            tokens_used: 0,
            session_id: 'session-1',
            sessionId: 'session-1',
        });
        expect(attachContextSessionId({ session_id: 'session-2', tokens_used: 0 }, 'session-1')).toEqual({
            session_id: 'session-2',
            tokens_used: 0,
        });
        expect(attachContextSessionId({ tokens_used: 0 }, null)).toEqual({ tokens_used: 0 });
    });
});
