import type { UsageEvent, UsageModelTotal, UsageSnapshot } from '../../types/protocol';

export type UsageScope = 'current' | 'all';

const MAX_MERGED_EVENTS = 100;

function n(value?: number): number {
    return Number.isFinite(value) ? Number(value) : 0;
}

function mergeSource(current: UsageSnapshot['source'], incoming: UsageSnapshot['source']): UsageSnapshot['source'] {
    if (!current) return incoming || 'estimated';
    if (!incoming) return current;
    return current === incoming ? current : 'estimated';
}

function mergeModelSource(current: UsageModelTotal['source'], incoming: UsageModelTotal['source']): UsageModelTotal['source'] {
    if (!current) return incoming || 'estimated';
    if (!incoming) return current;
    return current === incoming ? current : 'estimated';
}

export function hasUsageData(snapshot?: UsageSnapshot | null): boolean {
    if (!snapshot) return false;
    return n(snapshot.requestCount) > 0
        || n(snapshot.inputTokens) > 0
        || n(snapshot.outputTokens) > 0
        || n(snapshot.cachedInputTokens) > 0
        || n(snapshot.cacheCreationTokens) > 0
        || n(snapshot.reasoningOutputTokens) > 0
        || n(snapshot.estimatedCostUsd) > 0
        || Boolean(snapshot.models?.length)
        || Boolean(snapshot.events?.length);
}

export function usageSourceLabel(snapshot?: UsageSnapshot | null): string {
    if (!hasUsageData(snapshot)) return 'No usage recorded';

    const actualCount = n(snapshot?.actualCount);
    const estimatedCount = n(snapshot?.estimatedCount);
    if (actualCount > 0 && estimatedCount > 0) return 'Mixed: provider tokens + estimated fallback';
    if (actualCount > 0) return 'Provider tokens, estimated cost';
    if (snapshot?.source === 'unconfirmed') return 'Unconfirmed usage source';
    return 'Estimated tokens and cost';
}

export function keySourceLabel(keySource?: string): string {
    if (keySource === 'user') return 'Key connected';
    if (keySource === 'server') return 'Included';
    if (keySource === 'hosted') return 'Grik Account';
    if (keySource === 'none') return 'No key';
    return keySource || 'Unknown key';
}

export function operationLabel(operation?: string): string {
    if (operation === 'chat') return 'Chat';
    if (operation === 'worker') return 'Worker';
    if (operation === 'condense') return 'Condense';
    if (operation === 'embedding') return 'Embedding';
    return operation || 'Model request';
}

export function recentUsageEvents(snapshot?: UsageSnapshot | null, limit = 50): UsageEvent[] {
    if (!snapshot) return [];
    const events = snapshot.events?.length
        ? snapshot.events
        : snapshot.lastEvent
            ? [snapshot.lastEvent]
            : [];
    return [...events]
        .sort((a, b) => n(b.timestamp) - n(a.timestamp))
        .slice(0, limit)
        .map((event) => ({ ...event }));
}

export function mergeUsageSnapshots(snapshots: UsageSnapshot[]): UsageSnapshot {
    const merged: UsageSnapshot = {
        sessionId: 'all-saved-sessions',
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
        events: [],
    };
    const byModel = new Map<string, UsageModelTotal>();
    let mergedSource: UsageSnapshot['source'] | null = null;

    for (const snapshot of snapshots) {
        if (!snapshot || !hasUsageData(snapshot)) continue;
        merged.inputTokens += n(snapshot.inputTokens);
        merged.outputTokens += n(snapshot.outputTokens);
        merged.cachedInputTokens = n(merged.cachedInputTokens) + n(snapshot.cachedInputTokens);
        merged.cacheCreationTokens = n(merged.cacheCreationTokens) + n(snapshot.cacheCreationTokens);
        merged.reasoningOutputTokens = n(merged.reasoningOutputTokens) + n(snapshot.reasoningOutputTokens);
        merged.estimatedCostUsd += n(snapshot.estimatedCostUsd);
        merged.requestCount += n(snapshot.requestCount);
        merged.actualCount += n(snapshot.actualCount);
        merged.estimatedCount += n(snapshot.estimatedCount);
        mergedSource = mergedSource ? mergeSource(mergedSource, snapshot.source) : snapshot.source;

        for (const model of snapshot.models || []) {
            const key = `${model.provider}:${model.model}:${model.keySource || ''}`;
            const current = byModel.get(key);
            if (!current) {
                byModel.set(key, { ...model });
                continue;
            }
            current.inputTokens += n(model.inputTokens);
            current.outputTokens += n(model.outputTokens);
            current.cachedInputTokens = n(current.cachedInputTokens) + n(model.cachedInputTokens);
            current.cacheCreationTokens = n(current.cacheCreationTokens) + n(model.cacheCreationTokens);
            current.reasoningOutputTokens = n(current.reasoningOutputTokens) + n(model.reasoningOutputTokens);
            current.estimatedCostUsd += n(model.estimatedCostUsd);
            current.requestCount += n(model.requestCount);
            current.actualCount += n(model.actualCount);
            current.estimatedCount += n(model.estimatedCount);
            current.source = mergeModelSource(current.source, model.source);
        }

        const snapshotEvents = snapshot.events?.length
            ? snapshot.events
            : snapshot.lastEvent
                ? [snapshot.lastEvent]
                : [];
        for (const event of snapshotEvents) {
            merged.events?.push({ ...event });
        }
    }

    merged.models = [...byModel.values()].sort((a, b) => n(b.requestCount) - n(a.requestCount) || a.model.localeCompare(b.model));
    merged.source = mergedSource || 'estimated';
    merged.events = recentUsageEvents(merged, MAX_MERGED_EVENTS);
    merged.lastEvent = merged.events[0] ? { ...merged.events[0] } : undefined;
    if (!hasUsageData(merged)) {
        merged.source = 'estimated';
    }
    return merged;
}
