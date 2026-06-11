import { useEffect, useState } from 'react';
import { useVSCodeApi } from './useVSCodeApi';
import { ContextStatus, UsageSnapshot } from '../types/protocol';

export function buildUsageRequestPayload(sessionId: string | null = null): { session_id?: string } {
    return sessionId ? { session_id: sessionId } : {};
}

export function useUsage(sessionId: string | null = null) {
    const { postMessage, onMessage } = useVSCodeApi();
    const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null);
    const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);

    useEffect(() => {
        setUsageSnapshot(null);
        setContextStatus(null);
        postMessage({ type: 'get_usage', payload: buildUsageRequestPayload(sessionId) });
    }, [postMessage, sessionId]);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            if (message.type === 'usage_update') {
                const payload = message.payload as UsageSnapshot;
                if (sessionId && payload.sessionId && payload.sessionId !== sessionId) return;
                setUsageSnapshot(payload);
                return;
            }

            if (message.type === 'context_status') {
                const payload = message.payload as ContextStatus;
                if (sessionId && payload.session_id && payload.session_id !== sessionId) return;
                setContextStatus(payload);
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage, sessionId]);

    return { usageSnapshot, contextStatus };
}
