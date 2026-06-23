import { useEffect, useState } from 'react';
import { useVSCodeApi } from './useVSCodeApi';
import { ContextStatus, UsageSnapshot } from '../types/protocol';

export function buildUsageRequestPayload(sessionId: string | null = null): { session_id?: string } {
    return sessionId ? { session_id: sessionId } : {};
}

export function shouldRequestUsageForSession(sessionId: string | null = null): boolean {
    return Boolean(sessionId);
}

export function usageSnapshotMatchesSession(payload: UsageSnapshot | null | undefined, sessionId: string | null = null): boolean {
    const payloadSessionId = payload?.sessionId || (payload as any)?.session_id;
    return Boolean(sessionId && payloadSessionId === sessionId);
}

export function contextStatusMatchesSession(payload: ContextStatus | null | undefined, sessionId: string | null = null): boolean {
    const payloadSessionId = payload?.session_id || (payload as any)?.sessionId;
    return Boolean(sessionId && payloadSessionId === sessionId);
}

export function useUsage(sessionId: string | null = null) {
    const { postMessage, onMessage } = useVSCodeApi();
    const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null);
    const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);

    useEffect(() => {
        setUsageSnapshot(null);
        setContextStatus(null);
        if (!shouldRequestUsageForSession(sessionId)) return;
        const payload = buildUsageRequestPayload(sessionId);
        postMessage({ type: 'get_usage', payload });
        postMessage({ type: 'get_context_status', payload });
    }, [postMessage, sessionId]);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            if (message.type === 'usage_update') {
                const payload = message.payload as UsageSnapshot;
                if (!usageSnapshotMatchesSession(payload, sessionId)) return;
                setUsageSnapshot(payload);
                return;
            }

            if (message.type === 'context_status') {
                const payload = message.payload as ContextStatus;
                if (!contextStatusMatchesSession(payload, sessionId)) return;
                setContextStatus(payload);
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage, sessionId]);

    return { usageSnapshot, contextStatus };
}
