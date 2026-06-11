import { describe, expect, it } from 'vitest';
import { buildUsageRequestPayload } from './useUsage';

describe('useUsage request payload', () => {
    it('does not substitute default when session id is absent', () => {
        expect(buildUsageRequestPayload(null)).toEqual({});
    });

    it('passes an explicit session id through', () => {
        expect(buildUsageRequestPayload('session-1')).toEqual({ session_id: 'session-1' });
    });
});
