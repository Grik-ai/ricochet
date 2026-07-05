import { describe, expect, it } from 'vitest';
import { NetworkHealthService } from './NetworkHealthService';
import type { NetworkStatusPayload } from '../../protocol/coreMessages';

function createService() {
    const messages: Array<{ type: string; payload: NetworkStatusPayload }> = [];
    const service = new NetworkHealthService({} as any, (message) => messages.push(message));
    return { service, messages };
}

describe('NetworkHealthService browser status', () => {
    it('records browser online as diagnostic detail without making aggregate health online', () => {
        const { service, messages } = createService();

        service.handleBrowserStatus({ online: true });

        const payload = messages[messages.length - 1]?.payload;
        expect(payload?.state).toBe('unknown');
        expect(payload?.scope).toBe('core');
        expect(payload?.details?.internet?.state).toBe('online');
        expect(payload?.details?.internet?.message).toBe('Browser network available');
    });

    it('keeps browser offline as a blocking internet health state', () => {
        const { service, messages } = createService();

        service.handleBrowserStatus({ online: false });

        const payload = messages[messages.length - 1]?.payload;
        expect(payload?.state).toBe('offline');
        expect(payload?.scope).toBe('internet');
        expect(payload?.message).toBe('Browser is offline');
        expect(payload?.details?.internet?.state).toBe('offline');
    });
});
