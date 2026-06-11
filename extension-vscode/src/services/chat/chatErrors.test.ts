import { describe, expect, it } from 'vitest';
import { formatChatErrorInfo } from './chatErrors';

describe('formatChatErrorInfo', () => {
    it('sanitizes DNS/network provider errors for users while preserving raw diagnostics', () => {
        const raw = 'request failed: Post "https://open.bigmodel.cn/api/paas/v4/chat/completions": dial tcp: lookup open.bigmodel.cn: no such host';
        const info = formatChatErrorInfo(new Error(raw));

        expect(info.kind).toBe('network');
        expect(info.retryable).toBe(true);
        expect(info.diagnosticCode).toBe('dns_lookup_failed');
        expect(info.rawMessage).toBe(raw);
        expect(info.message).not.toMatch(/https?:\/\/|open\.bigmodel\.cn|dial tcp|lookup|no such host/i);
    });

    it('classifies BigModel socket exhaustion as retryable network without exposing raw text', () => {
        const raw = "read tcp 172.20.10.12:53725->60.205.172.105:443: read: can't assign requested address";
        const info = formatChatErrorInfo(raw, { provider: 'zhipu' });

        expect(info.kind).toBe('network');
        expect(info.provider).toBe('Zhipu/BigModel');
        expect(info.retryable).toBe(true);
        expect(info.message).not.toMatch(/172\.20|60\.205|tcp|assign requested address/i);
    });

    it('classifies HTTP configuration/model errors as provider_config', () => {
        const raw = 'OpenAI Embed error 400: {"error":{"code":"1211","message":"Unknown Model, please check the model code."}}';
        const info = formatChatErrorInfo(raw, { provider: 'zhipu', category: 'config' });

        expect(info.kind).toBe('provider_config');
        expect(info.retryable).toBe(false);
        expect(info.rawMessage).toBe(raw);
        expect(info.message).not.toContain('Unknown Model');
    });
});
