import type { UsageSnapshot } from '../../protocol/coreMessages';

export function explicitSessionIdFromPayload(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const value = (payload as { session_id?: unknown; sessionId?: unknown }).session_id
        || (payload as { session_id?: unknown; sessionId?: unknown }).sessionId;
    if (typeof value !== 'string') return null;
    const sessionId = value.trim();
    return sessionId || null;
}

export function buildEmptyUsageSnapshot(sessionId: string | null = null): UsageSnapshot {
    return {
        ...(sessionId ? { sessionId } : {}),
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        requestCount: 0,
        actualCount: 0,
        estimatedCount: 0,
        source: 'estimated',
        models: [],
        events: [],
    };
}

export function shouldUseCachedUsage(
    sessionData: { usage?: UsageSnapshot | null } | null | undefined,
    sessionId: string
): sessionData is { usage: UsageSnapshot } {
    return Boolean(sessionData?.usage && sessionData.usage.sessionId === sessionId);
}

export function attachContextSessionId<T>(payload: T, sessionId: string | null | undefined): T {
    if (!sessionId || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const record = payload as Record<string, unknown>;
    if (typeof record.session_id === 'string' && record.session_id.trim()) return payload;
    return { ...record, session_id: sessionId, sessionId } as T;
}
