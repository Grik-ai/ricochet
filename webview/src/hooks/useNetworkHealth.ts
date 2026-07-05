import { useEffect, useMemo, useState } from 'react';
import { useVSCodeApi } from './useVSCodeApi';
import { NetworkHealthState, NetworkStatusPayload } from '../types/protocol';
import { sanitizeNetworkStatusPayload } from '../utils/chatErrors';

const STALE_ACTIVITY_MS = 20_000;
const BROWSER_STATUS_INTERVAL_MS = 60_000;

export interface NetworkHealthOptions {
    runtimeActive: boolean;
    lastActivityAt?: number | null;
}

export interface NetworkDisplayStatus extends NetworkStatusPayload {
    label: string;
    tone: 'neutral' | 'good' | 'slow' | 'bad' | 'working';
    staleForMs?: number;
}

const initialStatus: NetworkStatusPayload = {
    state: 'unknown',
    scope: 'core',
    lastCheckedAt: Date.now(),
    message: 'Checking connection',
};

function formatMs(ms?: number): string | null {
    if (ms === undefined || Number.isNaN(ms)) return null;
    if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
    return `${Math.max(0, Math.round(ms))} ms`;
}

export function formatNetworkStatusLabel(status: NetworkStatusPayload, staleForMs = 0): string {
    if (status.scope === 'agent' && staleForMs > 0) {
        return `Waiting for model · ${Math.max(1, Math.round(staleForMs / 1000))}s no updates`;
    }
    if (status.state === 'offline') {
        return 'Offline';
    }
    if (status.state === 'reconnecting') {
        const attempt = status.attempt && status.maxAttempts ? ` ${status.attempt}/${status.maxAttempts}` : '';
        return `Reconnecting${attempt}`;
    }
    if (status.state === 'degraded') {
        const ping = formatMs(status.pingMs);
        return ping ? `Slow · ${ping}` : 'Slow connection';
    }
    if (status.state === 'online') {
        const ping = formatMs(status.pingMs);
        return ping ? `Online · ${ping}` : 'Online';
    }
    return 'Checking network';
}

export function toneForNetworkState(state: NetworkHealthState, scope?: string): NetworkDisplayStatus['tone'] {
    if (scope === 'agent') return 'working';
    if (state === 'online') return 'good';
    if (state === 'degraded' || state === 'reconnecting') return 'slow';
    if (state === 'offline') return 'bad';
    return 'neutral';
}

export function deriveNetworkDisplayStatus(status: NetworkStatusPayload, options: NetworkHealthOptions, now = Date.now()): NetworkDisplayStatus {
    const lastActivityAt = options.lastActivityAt || status.lastActivityAt || status.details?.agent?.lastActivityAt;
    const staleForMs = options.runtimeActive && lastActivityAt ? Math.max(0, now - lastActivityAt) : 0;
    const shouldShowStale = staleForMs > STALE_ACTIVITY_MS && (status.state === 'online' || status.state === 'unknown');
    const effective: NetworkStatusPayload = shouldShowStale
        ? {
            ...status,
            state: 'degraded',
            scope: 'agent',
            lastActivityAt,
            message: 'No agent activity received recently',
        }
        : status;

    return {
        ...effective,
        label: formatNetworkStatusLabel(effective, shouldShowStale ? staleForMs : 0),
        tone: toneForNetworkState(effective.state, effective.scope),
        staleForMs: shouldShowStale ? staleForMs : undefined,
    };
}

export function useNetworkHealth(options: NetworkHealthOptions): NetworkDisplayStatus {
    const { postMessage, onMessage } = useVSCodeApi();
    const [status, setStatus] = useState<NetworkStatusPayload>(initialStatus);
    const [tick, setTick] = useState(Date.now());

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            if (message.type === 'network_status') {
                setStatus(sanitizeNetworkStatusPayload((message.payload || initialStatus) as NetworkStatusPayload));
            }
            if (message.type === 'webview_ping') {
                const payload = message.payload as any;
                postMessage({ type: 'webview_pong', payload: { id: payload?.id, sentAt: payload?.sentAt, receivedAt: Date.now() } });
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage, postMessage]);

    useEffect(() => {
        const emitBrowserStatus = () => {
            postMessage({
                type: 'network_browser_status',
                payload: {
                    online: typeof navigator === 'undefined' ? true : navigator.onLine,
                    checkedAt: Date.now(),
                },
            });
        };

        emitBrowserStatus();
        const timer = window.setInterval(emitBrowserStatus, BROWSER_STATUS_INTERVAL_MS);
        window.addEventListener('online', emitBrowserStatus);
        window.addEventListener('offline', emitBrowserStatus);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('online', emitBrowserStatus);
            window.removeEventListener('offline', emitBrowserStatus);
        };
    }, [postMessage]);

    useEffect(() => {
        if (!options.runtimeActive) return;
        const timer = setInterval(() => setTick(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [options.runtimeActive]);

    return useMemo(
        () => deriveNetworkDisplayStatus(status, options, tick),
        [options, status, tick]
    );
}
