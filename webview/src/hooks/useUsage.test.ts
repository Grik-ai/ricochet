import { describe, expect, it } from 'vitest';
import {
    buildUsageRequestPayload,
    contextStatusMatchesSession,
    shouldRequestUsageForSession,
    usageSnapshotMatchesSession,
} from './useUsage';

describe('useUsage request payload', () => {
    it('does not substitute default when session id is absent', () => {
        expect(buildUsageRequestPayload(null)).toEqual({});
    });

    it('passes an explicit session id through', () => {
        expect(buildUsageRequestPayload('session-1')).toEqual({ session_id: 'session-1' });
    });

    it('does not request usage until the visible session is known', () => {
        expect(shouldRequestUsageForSession(null)).toBe(false);
        expect(shouldRequestUsageForSession('session-1')).toBe(true);
    });

    it('accepts only usage snapshots scoped to the visible session', () => {
        expect(usageSnapshotMatchesSession({ sessionId: 'session-1' } as any, 'session-1')).toBe(true);
        expect(usageSnapshotMatchesSession({ session_id: 'session-1' } as any, 'session-1')).toBe(true);
        expect(usageSnapshotMatchesSession({ sessionId: 'session-2' } as any, 'session-1')).toBe(false);
        expect(usageSnapshotMatchesSession({} as any, 'session-1')).toBe(false);
        expect(usageSnapshotMatchesSession({ sessionId: 'session-1' } as any, null)).toBe(false);
    });

    it('accepts only context snapshots scoped to the visible session', () => {
        expect(contextStatusMatchesSession({ session_id: 'session-1' } as any, 'session-1')).toBe(true);
        expect(contextStatusMatchesSession({ sessionId: 'session-1' } as any, 'session-1')).toBe(true);
        expect(contextStatusMatchesSession({ session_id: 'session-2' } as any, 'session-1')).toBe(false);
        expect(contextStatusMatchesSession({} as any, 'session-1')).toBe(false);
        expect(contextStatusMatchesSession({ session_id: 'session-1' } as any, null)).toBe(false);
    });
});
