import { describe, expect, it } from 'vitest';
import { deriveNetworkDisplayStatus, formatNetworkStatusLabel } from './useNetworkHealth';
import { NetworkStatusPayload } from '../types/protocol';

const baseStatus: NetworkStatusPayload = {
    state: 'online',
    scope: 'provider',
    provider: 'zhipu',
    model: 'glm-4.5',
    pingMs: 42,
    lastCheckedAt: 1_000,
    lastSuccessAt: 1_000,
};

describe('network health display', () => {
    it('renders compact online ping label', () => {
        expect(formatNetworkStatusLabel(baseStatus)).toBe('Online · 42 ms');
    });

    it('shows stale active run as waiting for model', () => {
        const status = deriveNetworkDisplayStatus(baseStatus, {
            runtimeActive: true,
            lastActivityAt: 1_000,
        }, 35_000);

        expect(status.scope).toBe('agent');
        expect(status.state).toBe('degraded');
        expect(status.label).toBe('Waiting for model · 34s no updates');
    });

    it('keeps reconnecting attempts visible', () => {
        const status = deriveNetworkDisplayStatus({
            ...baseStatus,
            state: 'reconnecting',
            scope: 'provider',
            attempt: 3,
            maxAttempts: 5,
            message: 'timeout',
        }, { runtimeActive: true, lastActivityAt: 1_000 }, 35_000);

        expect(status.label).toBe('Reconnecting 3/5');
        expect(status.tone).toBe('slow');
    });

    it('does not hide offline network state behind stale activity', () => {
        const status = deriveNetworkDisplayStatus({
            ...baseStatus,
            state: 'offline',
            scope: 'internet',
            message: 'Browser reports offline',
        }, { runtimeActive: true, lastActivityAt: 1_000 }, 35_000);

        expect(status.scope).toBe('internet');
        expect(status.label).toBe('Offline');
        expect(status.tone).toBe('bad');
    });

    it('marks high latency as slow', () => {
        const status = deriveNetworkDisplayStatus({
            ...baseStatus,
            state: 'degraded',
            pingMs: 820,
        }, { runtimeActive: false }, 2_000);

        expect(status.label).toBe('Slow · 820 ms');
        expect(status.tone).toBe('slow');
    });
});
