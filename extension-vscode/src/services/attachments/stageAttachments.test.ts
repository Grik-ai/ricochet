import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { stageAttachmentsForWorkspace } from './stageAttachments';

describe('stageAttachmentsForWorkspace', () => {
    it('stages multiple files in order with mime, size, and stagedPath metadata', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ricochet-attachments-'));
        try {
            const files = [
                { id: 'jpg', name: 'photo.jpg', mime: 'image/jpeg', data: Buffer.from('jpg-data').toString('base64') },
                { id: 'png', name: 'screen.png', mime: 'image/png', data: Buffer.from('png-data').toString('base64') },
                { id: 'pdf', name: 'notice.pdf', mime: 'application/pdf', data: Buffer.from('%PDF').toString('base64') },
                { id: 'csv', name: 'prices.csv', mime: 'text/csv', data: Buffer.from('sku,price').toString('base64') },
            ];

            const result = await stageAttachmentsForWorkspace({
                request_id: 'request-1',
                session_id: 'session-1',
                files,
            }, workspaceRoot);

            expect(result.request_id).toBe('request-1');
            expect(result.errors).toEqual([]);
            expect(result.attachments.map(file => file.id)).toEqual(['jpg', 'png', 'pdf', 'csv']);
            expect(result.attachments.map(file => file.mime)).toEqual(['image/jpeg', 'image/png', 'application/pdf', 'text/csv']);
            expect(result.attachments.every(file => file.kind === 'attachment' && file.source === 'attachment')).toBe(true);
            expect(result.attachments.every(file => file.path === file.stagedPath)).toBe(true);
            expect(result.attachments.every(file => file.stagedPath.startsWith('.ricochet/attachments/session-1/'))).toBe(true);
            expect(result.attachments.map(file => file.size)).toEqual(files.map(file => Buffer.from(file.data, 'base64').length));
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('allows blob image previews in the production webview CSP', () => {
        const source = fs.readFileSync(new URL('../../webview-provider.ts', import.meta.url), 'utf8');

        expect(source).toContain('img-src ${webview.cspSource} data: blob:');
    });
});
