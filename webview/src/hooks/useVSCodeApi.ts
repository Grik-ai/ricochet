import { useCallback } from 'react';

interface VSCodeApi {
    postMessage: (message: unknown) => void;
    getState: () => unknown;
    setState: (state: unknown) => void;
}

declare global {
    interface Window {
        acquireVsCodeApi?: () => VSCodeApi;
    }
}

// Singleton to ensure we only acquire the API once
let vscodeApi: VSCodeApi | null = null;

function getVSCodeApi(): VSCodeApi | null {
    if (vscodeApi) return vscodeApi;
    if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
        vscodeApi = window.acquireVsCodeApi();
        return vscodeApi;
    }
    return null;
}

// Singleton event logic
type MessageHandler = (message: { type: string; payload?: unknown }) => void;
const globalHandlers = new Set<MessageHandler>();

// Setup global listener once
if (typeof window !== 'undefined') {
    window.addEventListener('message', (event: MessageEvent) => {
        const message = event.data;
        // console.log('[VSCodeApi] Received:', message.type);
        globalHandlers.forEach(handler => handler(message));
    });
}

/**
 * Hook for communicating with VSCode extension host.
 * Returns postMessage function and onMessage subscriber.
 */
export function useVSCodeApi() {
    const api = getVSCodeApi();

    const postMessage = useCallback((message: unknown) => {
        if (api) {
            api.postMessage(message);
        } else {
            console.log('[DEV] postMessage:', message);
        }
    }, [api]);

    const onMessage = useCallback((handler: MessageHandler) => {
        globalHandlers.add(handler);
        return () => {
            globalHandlers.delete(handler);
        };
    }, []);

    const getState = useCallback(() => api?.getState(), [api]);
    const setState = useCallback((state: unknown) => api?.setState(state), [api]);

    return { postMessage, onMessage, getState, setState };
}
