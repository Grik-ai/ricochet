import type { SessionMetadata } from '../../types/session';
import type { UsageEvent, UsageModelTotal, UsageSnapshot, UsageSource } from '../../types/protocol';
import {
    hasUsageData,
    mergeUsageSnapshots,
    recentUsageEvents,
    usageSourceLabel,
} from '../settings/usageUtils';

export type AccountUsageRange = '7d' | '30d' | 'all';

export type AccountUsageSummary = {
    range: AccountUsageRange;
    snapshot: UsageSnapshot;
    hasData: boolean;
    sessionsScanned: number;
    sessionsWithUsage: number;
    eventCount: number;
    sourceLabel: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function n(value?: number): number {
    return Number.isFinite(value) ? Number(value) : 0;
}

function rangeCutoff(range: AccountUsageRange, now: number): number | null {
    if (range === '7d') return now - 7 * DAY_MS;
    if (range === '30d') return now - 30 * DAY_MS;
    return null;
}

function normalizeTimestamp(timestamp?: number): number {
    if (!timestamp) return 0;
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function mergeSource(current: UsageSource | null, incoming: UsageSource | undefined): UsageSource {
    if (!current) return incoming || 'estimated';
    if (!incoming) return current;
    return current === incoming ? current : 'estimated';
}

function eventToModelTotal(event: UsageEvent): UsageModelTotal {
    const source = event.source || 'estimated';
    return {
        provider: event.provider,
        model: event.model,
        keySource: event.keySource,
        inputTokens: n(event.inputTokens),
        outputTokens: n(event.outputTokens),
        cachedInputTokens: n(event.cachedInputTokens),
        cacheCreationTokens: n(event.cacheCreationTokens),
        reasoningOutputTokens: n(event.reasoningOutputTokens),
        estimatedCostUsd: n(event.estimatedCostUsd),
        requestCount: 1,
        actualCount: source === 'actual' ? 1 : 0,
        estimatedCount: source === 'actual' ? 0 : 1,
        source,
    };
}

function snapshotFromEvents(sessionId: string | undefined, events: UsageEvent[]): UsageSnapshot {
    const snapshot: UsageSnapshot = {
        sessionId,
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
        models: [],
        events: [...events],
    };
    const byModel = new Map<string, UsageModelTotal>();
    let source: UsageSource | null = null;

    for (const event of events) {
        snapshot.inputTokens += n(event.inputTokens);
        snapshot.outputTokens += n(event.outputTokens);
        snapshot.cachedInputTokens = n(snapshot.cachedInputTokens) + n(event.cachedInputTokens);
        snapshot.cacheCreationTokens = n(snapshot.cacheCreationTokens) + n(event.cacheCreationTokens);
        snapshot.reasoningOutputTokens = n(snapshot.reasoningOutputTokens) + n(event.reasoningOutputTokens);
        snapshot.estimatedCostUsd += n(event.estimatedCostUsd);
        snapshot.requestCount += 1;
        snapshot.actualCount += event.source === 'actual' ? 1 : 0;
        snapshot.estimatedCount += event.source === 'actual' ? 0 : 1;
        source = mergeSource(source, event.source);

        const model = eventToModelTotal(event);
        const key = `${model.provider}:${model.model}:${model.keySource || ''}`;
        const current = byModel.get(key);
        if (!current) {
            byModel.set(key, model);
            continue;
        }
        current.inputTokens += model.inputTokens;
        current.outputTokens += model.outputTokens;
        current.cachedInputTokens = n(current.cachedInputTokens) + n(model.cachedInputTokens);
        current.cacheCreationTokens = n(current.cacheCreationTokens) + n(model.cacheCreationTokens);
        current.reasoningOutputTokens = n(current.reasoningOutputTokens) + n(model.reasoningOutputTokens);
        current.estimatedCostUsd += model.estimatedCostUsd;
        current.requestCount += 1;
        current.actualCount += model.actualCount;
        current.estimatedCount += model.estimatedCount;
        current.source = mergeSource(current.source, model.source);
    }

    snapshot.source = source || 'estimated';
    snapshot.models = [...byModel.values()].sort((a, b) => n(b.requestCount) - n(a.requestCount) || a.model.localeCompare(b.model));
    snapshot.events = recentUsageEvents(snapshot, 100);
    snapshot.lastEvent = snapshot.events[0] ? { ...snapshot.events[0] } : undefined;
    return snapshot;
}

export function filterUsageSnapshotsByRange(
    sessions: SessionMetadata[],
    range: AccountUsageRange,
    now = Date.now(),
): UsageSnapshot[] {
    const cutoff = rangeCutoff(range, now);
    const snapshots: UsageSnapshot[] = [];

    for (const session of sessions) {
        const usage = session.usage;
        if (!usage || !hasUsageData(usage)) continue;
        if (!cutoff) {
            snapshots.push({ ...usage });
            continue;
        }

        const events = usage.events?.length
            ? usage.events
            : usage.lastEvent
                ? [usage.lastEvent]
                : [];
        if (events.length > 0) {
            const recentEvents = events.filter(event => normalizeTimestamp(event.timestamp) >= cutoff);
            if (recentEvents.length > 0) {
                snapshots.push(snapshotFromEvents(usage.sessionId || session.id, recentEvents));
            }
            continue;
        }

        if (session.lastModified >= cutoff) {
            snapshots.push({ ...usage });
        }
    }

    return snapshots;
}

export function buildAccountUsageSummary(
    sessions: SessionMetadata[],
    range: AccountUsageRange,
    now = Date.now(),
): AccountUsageSummary {
    const snapshots = filterUsageSnapshotsByRange(sessions, range, now);
    const snapshot = mergeUsageSnapshots(snapshots);
    const eventCount = recentUsageEvents(snapshot, 100).length;
    return {
        range,
        snapshot,
        hasData: hasUsageData(snapshot),
        sessionsScanned: sessions.length,
        sessionsWithUsage: snapshots.length,
        eventCount,
        sourceLabel: usageSourceLabel(snapshot),
    };
}

export function formatAccountUsageTokens(tokens?: number): string {
    const value = n(tokens);
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
    return String(value);
}

export function formatAccountUsageCost(cost?: number): string {
    const value = n(cost);
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
}
