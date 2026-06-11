import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../types/protocol';
import {
    hasUsageData,
    mergeUsageSnapshots,
    recentUsageEvents,
    usageSourceLabel,
} from './usageUtils';

const snapshotA: UsageSnapshot = {
    sessionId: 'a',
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 15,
    cacheCreationTokens: 5,
    reasoningOutputTokens: 8,
    estimatedCostUsd: 0.01,
    requestCount: 1,
    actualCount: 1,
    estimatedCount: 0,
    source: 'actual',
    models: [{
        provider: 'openai',
        model: 'gpt-4o',
        keySource: 'user',
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 15,
        cacheCreationTokens: 5,
        reasoningOutputTokens: 8,
        estimatedCostUsd: 0.01,
        requestCount: 1,
        actualCount: 1,
        estimatedCount: 0,
        source: 'actual',
    }],
    events: [{
        sessionId: 'a',
        turnId: 'a1',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 20,
        estimatedCostUsd: 0.01,
        source: 'actual',
        operation: 'chat',
        timestamp: 100,
    }],
};

const snapshotB: UsageSnapshot = {
    sessionId: 'b',
    inputTokens: 50,
    outputTokens: 10,
    cachedInputTokens: 10,
    cacheCreationTokens: 2,
    reasoningOutputTokens: 3,
    estimatedCostUsd: 0.02,
    requestCount: 1,
    actualCount: 0,
    estimatedCount: 1,
    source: 'estimated',
    models: [{
        provider: 'openai',
        model: 'gpt-4o',
        keySource: 'user',
        inputTokens: 50,
        outputTokens: 10,
        cachedInputTokens: 10,
        cacheCreationTokens: 2,
        reasoningOutputTokens: 3,
        estimatedCostUsd: 0.02,
        requestCount: 1,
        actualCount: 0,
        estimatedCount: 1,
        source: 'estimated',
    }],
    events: [{
        sessionId: 'b',
        turnId: 'b1',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 50,
        outputTokens: 10,
        estimatedCostUsd: 0.02,
        source: 'estimated',
        operation: 'worker',
        timestamp: 200,
    }],
};

describe('usage utils', () => {
    it('detects empty usage snapshots without showing fake zeros', () => {
        expect(hasUsageData(null)).toBe(false);
        expect(hasUsageData({
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
            requestCount: 0,
            actualCount: 0,
            estimatedCount: 0,
            source: 'estimated',
        })).toBe(false);
    });

    it('labels provider token data without calling estimated cost actual', () => {
        expect(usageSourceLabel(snapshotA)).toBe('Provider tokens, estimated cost');
        expect(usageSourceLabel(snapshotB)).toBe('Estimated tokens and cost');
        expect(usageSourceLabel(mergeUsageSnapshots([snapshotA, snapshotB]))).toBe('Mixed: provider tokens + estimated fallback');
        expect(usageSourceLabel(null)).toBe('No usage recorded');
    });

    it('aggregates all saved sessions without mutating originals', () => {
        const merged = mergeUsageSnapshots([snapshotA, snapshotB]);

        expect(merged).toMatchObject({
            inputTokens: 150,
            outputTokens: 30,
            cachedInputTokens: 25,
            cacheCreationTokens: 7,
            reasoningOutputTokens: 11,
            estimatedCostUsd: 0.03,
            requestCount: 2,
            actualCount: 1,
            estimatedCount: 1,
        });
        expect(merged.models?.[0]).toMatchObject({
            inputTokens: 150,
            outputTokens: 30,
            requestCount: 2,
            actualCount: 1,
            estimatedCount: 1,
        });
        expect(recentUsageEvents(merged).map((event) => event.turnId)).toEqual(['b1', 'a1']);

        merged.events![0].turnId = 'mutated';
        expect(snapshotB.events?.[0].turnId).toBe('b1');
    });
});
