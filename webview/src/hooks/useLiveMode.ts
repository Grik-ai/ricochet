import { useState, useCallback, useEffect } from 'react';
import { useVSCodeApi } from './useVSCodeApi';

export type EtherStage = 'idle' | 'listening' | 'processing' | 'responding' | 'receiving';

export interface LiveModeStatus {
    enabled: boolean;
    connectedVia?: 'telegram' | 'discord' | string | null;
    lastActivity?: string;
    sessionId?: string;
    isDaemon?: boolean;
    // Ether display fields
    stage?: EtherStage;
    lastMessage?: string;
    isVoiceReady?: boolean;
}

export interface EtherActivity {
    stage: 'receiving' | 'processing' | 'responding';
    source: 'telegram' | 'discord';
    username?: string;
    preview?: string;
}

/**
 * Hook for managing Live Mode state.
 * Syncs with extension and provides toggle functionality.
 */
export function useLiveMode() {
    const [status, setStatus] = useState<LiveModeStatus>({ enabled: false });
    const [activity, setActivity] = useState<EtherActivity | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const { postMessage, onMessage } = useVSCodeApi();

    // Listen for Live Mode status updates from extension
    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            console.log('useLiveMode: Received message:', message.type, message.payload);
            if (message.type === 'live_mode_status') {
                console.log('useLiveMode: Updating status to:', message.payload);
                setStatus(message.payload as LiveModeStatus);
                setIsLoading(false);
            }
            if (message.type === 'ether_activity') {
                const act = message.payload as EtherActivity;
                setActivity(act);
                // Update status stage as well
                setStatus(prev => ({
                    ...prev,
                    stage: act.stage as EtherStage,
                    lastMessage: act.preview || prev.lastMessage
                }));
                // Clear activity after responding (cycle complete)
                if (act.stage === 'responding') {
                    setTimeout(() => setActivity(null), 2000);
                }
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage]);

    // Initial status fetch
    useEffect(() => {
        postMessage({ type: 'get_live_mode_status' });
    }, [postMessage]);

    const toggleLiveMode = useCallback(async () => {
        setIsLoading(true);
        postMessage({ type: 'toggle_live_mode' });
    }, [postMessage]);

    return {
        isLiveMode: status.enabled,
        status,
        activity,
        isLoading,
        toggleLiveMode
    };
}
