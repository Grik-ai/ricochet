import { useState, useCallback, useEffect } from 'react';
import { useVSCodeApi } from './useVSCodeApi';
import { SessionMetadata } from '../types/session';

export function useSessions() {
    const { postMessage, onMessage } = useVSCodeApi();
    const [sessions, setSessions] = useState<SessionMetadata[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'session_list':
                    setSessions((message.payload as { sessions: SessionMetadata[] }).sessions || []);
                    break;
                case 'session_created':
                    const createdPayload = (message.payload || {}) as { id?: string; sessionId?: string };
                    const createdId = createdPayload.id || createdPayload.sessionId || null;
                    if (createdId) {
                        setCurrentSessionId(createdId);
                    }
                    // Refresh list
                    postMessage({ type: 'list_sessions' });
                    break;
                case 'session_loaded':
                    // Handled by useChat mostly, but we update current ID here
                    setCurrentSessionId((message.payload as { id: string }).id);
                    break;
                case 'session_metadata_updated':
                    const metadata = message.payload as SessionMetadata;
                    if (!metadata?.id) break;
                    setSessions(prev => {
                        const index = prev.findIndex(session => session.id === metadata.id);
                        if (index === -1) {
                            return [metadata, ...prev].sort((a, b) => b.lastModified - a.lastModified);
                        }
                        const next = [...prev];
                        next[index] = { ...next[index], ...metadata };
                        return next.sort((a, b) => b.lastModified - a.lastModified);
                    });
                    break;
            }
        });

        // Initial fetch
        postMessage({ type: 'list_sessions' });

        return () => { unsubscribe(); };
    }, [postMessage, onMessage]);

    const createSession = useCallback(() => {
        postMessage({ type: 'create_session' });
    }, [postMessage]);

    const loadSession = useCallback((id: string) => {
        setCurrentSessionId(id);
        postMessage({ type: 'load_session', payload: { id } });
    }, [postMessage]);

    const deleteSession = useCallback((id: string) => {
        postMessage({ type: 'delete_session', payload: { id } });
    }, [postMessage]);

    return {
        sessions,
        currentSessionId,
        createSession,
        loadSession,
        deleteSession
    };
}
