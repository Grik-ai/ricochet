import { describe, expect, it } from 'vitest';
import {
    MAX_CHAT_ATTACHMENT_BYTES,
    attachmentLimitError,
    attachmentSizeError,
    buildContextMessage,
    formatAttachmentSize,
    getPlanFirstToggleState,
    isImageContextFile,
    isReadyContextFile,
    shouldRenderInputStatusStrip
} from './ChatInput';
import type { ContextStatus, UsageSnapshot } from '../../types/protocol';
import type { NetworkDisplayStatus } from '../../hooks/useNetworkHealth';

describe('ChatInput layout helpers', () => {
    it('renders the compact status strip when network or usage data exists', () => {
        const networkStatus = { label: 'Online · 42 ms' } as NetworkDisplayStatus;
        const contextStatus = { tokens_used: 40200, tokens_max: 128000 } as ContextStatus;
        const usageSnapshot = { contextTokens: 40200, contextWindow: 128000 } as UsageSnapshot;

        expect(shouldRenderInputStatusStrip(networkStatus, null, null)).toBe(true);
        expect(shouldRenderInputStatusStrip(undefined, contextStatus, null)).toBe(true);
        expect(shouldRenderInputStatusStrip(undefined, null, usageSnapshot)).toBe(true);
        expect(shouldRenderInputStatusStrip(undefined, null, null, true)).toBe(true);
        expect(shouldRenderInputStatusStrip(undefined, null, null)).toBe(false);
    });

    it('moves Plan first behavior into a toggle model', () => {
        expect(getPlanFirstToggleState('plan')).toEqual({ active: true, nextMode: 'act' });
        expect(getPlanFirstToggleState('act')).toEqual({ active: false, nextMode: 'plan' });
        expect(getPlanFirstToggleState('mission')).toEqual({ active: false, nextMode: 'plan' });
    });

    it('builds send text with ready workspace and staged attachments only', () => {
        const message = buildContextMessage('inspect these', [
            { path: 'src/main.ts', name: 'main.ts', status: 'ready', source: 'workspace' },
            { path: 'staging://a1', stagedPath: '.ricochet/attachments/default/pasted.txt', name: 'pasted.txt', status: 'ready', source: 'attachment', kind: 'attachment' },
            { path: 'staging://a2', name: 'uploading.txt', status: 'staging', source: 'attachment', kind: 'attachment' },
            { path: 'big.bin', name: 'big.bin', status: 'error', source: 'attachment', kind: 'attachment', error: 'too large' },
        ]);

        expect(message).toContain('@src/main.ts');
        expect(message).toContain('@.ricochet/attachments/default/pasted.txt');
        expect(message).not.toContain('uploading.txt');
        expect(message).not.toContain('big.bin');
    });

    it('marks only non-staging and non-error files as sendable', () => {
        expect(isReadyContextFile({ path: 'src/main.ts', status: 'ready' })).toBe(true);
        expect(isReadyContextFile({ path: 'src/main.ts' })).toBe(true);
        expect(isReadyContextFile({ path: 'staging://1', status: 'staging' })).toBe(false);
        expect(isReadyContextFile({ path: 'big.bin', status: 'error' })).toBe(false);
    });

    it('validates local attachment limits', () => {
        expect(attachmentSizeError(MAX_CHAT_ATTACHMENT_BYTES)).toBeNull();
        expect(attachmentSizeError(MAX_CHAT_ATTACHMENT_BYTES + 1)).toContain('larger than 5 MB');
        expect(attachmentLimitError(1, 7)).toBeNull();
        expect(attachmentLimitError(2, 7)).toContain('Attach up to 8 files');
    });

    it('detects image attachments from mime type or filename', () => {
        expect(isImageContextFile({ path: 'staging://1', name: 'pasted', mime: 'image/webp' })).toBe(true);
        expect(isImageContextFile({ path: 'uploads/screenshot.PNG' })).toBe(true);
        expect(isImageContextFile({ path: 'notes.txt', mime: 'text/plain' })).toBe(false);
    });

    it('formats attachment sizes for preview cards', () => {
        expect(formatAttachmentSize(512)).toBe('512 B');
        expect(formatAttachmentSize(2048)).toBe('2 KB');
        expect(formatAttachmentSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
        expect(formatAttachmentSize()).toBe('');
    });
});
