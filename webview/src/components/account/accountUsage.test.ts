import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '../../types/session';
import type { UsageEvent, UsageSnapshot } from '../../types/protocol';
import {
    buildAccountUsageSummary,
    filterUsageSnapshotsByRange,
    formatAccountUsageCost,
    formatAccountUsageTokens,
} from './accountUsage';

const NOW = Date.parse('2026-06-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function event(overrides: Partial<UsageEvent>): UsageEvent {
    return {
        sessionId: 'session-a',
        provider: 'grik',
        model: 'glm-4.5-flash',
        inputTokens: 100,
        outputTokens: 20,
        estimatedCostUsd: 0.01,
        source: 'actual',
        operation: 'chat',
        timestamp: NOW,
        ...overrides,
    };
}

function snapshot(overrides: Partial<UsageSnapshot>): UsageSnapshot {
    return {
        sessionId: 'session-a',
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        reasoningOutputTokens: 0,
        estimatedCostUsd: 0,
        requestCount: 0,
        actualCount: 0,
        estimatedCount: 0,
        source: 'estimated',
        ...overrides,
    };
}

function session(id: string, usage: UsageSnapshot, lastModified = NOW): SessionMetadata {
    return {
        id,
        title: id,
        lastModified,
        messageCount: 2,
        workspaceDir: '/tmp',
        usage,
    };
}

describe('account usage helpers', () => {
    it('filters usage events by selected range before aggregating totals', () => {
        const recent = event({ turnId: 'recent', timestamp: NOW - 2 * DAY, inputTokens: 120, outputTokens: 30 });
        const old = event({ turnId: 'old', timestamp: NOW - 20 * DAY, inputTokens: 800, outputTokens: 200 });
        const sessions = [
            session('session-a', snapshot({
                inputTokens: 920,
                outputTokens: 230,
                requestCount: 2,
                actualCount: 2,
                source: 'actual',
                events: [recent, old],
            })),
        ];

        const filtered = filterUsageSnapshotsByRange(sessions, '7d', NOW);

        expect(filtered).toHaveLength(1);
        expect(filtered[0]).toMatchObject({
            inputTokens: 120,
            outputTokens: 30,
            requestCount: 1,
            actualCount: 1,
        });
        expect(filtered[0].events?.map(item => item.turnId)).toEqual(['recent']);
    });

    it('includes snapshots without request events by session lastModified fallback', () => {
        const recentNoEvents = session('recent-session', snapshot({
            sessionId: 'recent-session',
            inputTokens: 50,
            outputTokens: 10,
            requestCount: 1,
            estimatedCount: 1,
        }), NOW - DAY);
        const oldNoEvents = session('old-session', snapshot({
            sessionId: 'old-session',
            inputTokens: 500,
            outputTokens: 100,
            requestCount: 1,
            estimatedCount: 1,
        }), NOW - 60 * DAY);

        expect(filterUsageSnapshotsByRange([recentNoEvents, oldNoEvents], '30d', NOW).map(item => item.sessionId)).toEqual(['recent-session']);
    });

    it('builds 7d, 30d, and all summaries without showing fake usage', () => {
        const recent = event({ turnId: 'recent', timestamp: NOW - 2 * DAY, inputTokens: 100, outputTokens: 20 });
        const older = event({ turnId: 'older', timestamp: NOW - 20 * DAY, inputTokens: 300, outputTokens: 80 });
        const sessions = [
            session('session-a', snapshot({
                inputTokens: 400,
                outputTokens: 100,
                estimatedCostUsd: 0.03,
                requestCount: 2,
                actualCount: 2,
                source: 'actual',
                events: [recent, older],
            })),
        ];

        expect(buildAccountUsageSummary(sessions, '7d', NOW).snapshot.inputTokens).toBe(100);
        expect(buildAccountUsageSummary(sessions, '30d', NOW).snapshot.inputTokens).toBe(400);
        expect(buildAccountUsageSummary(sessions, 'all', NOW).snapshot.inputTokens).toBe(400);
        expect(buildAccountUsageSummary([], '7d', NOW).hasData).toBe(false);
    });

    it('formats compact account usage values', () => {
        expect(formatAccountUsageTokens(1530)).toBe('1.5k');
        expect(formatAccountUsageCost(0.0042)).toBe('$0.0042');
        expect(formatAccountUsageCost(0)).toBe('$0.00');
    });
});
