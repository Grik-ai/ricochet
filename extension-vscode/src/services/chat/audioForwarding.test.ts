import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('audio RPC forwarding', () => {
    it('posts transcription results back to the webview from both message routes', () => {
        const chatService = readFileSync(new URL('./ChatService.ts', import.meta.url), 'utf8');
        const webviewProvider = readFileSync(new URL('../../webview-provider.ts', import.meta.url), 'utf8');

        for (const source of [chatService, webviewProvider]) {
            expect(source).toContain("case 'audio_stop'");
            expect(source).toContain("type: 'audio_transcription_result'");
            expect(source).toContain("type: 'audio_recording_status'");
            expect(source).toContain("phase: 'recording'");
            expect(source).toContain("phase: 'transcription'");
            expect(source).toContain('retryable: true');
            expect(source).toContain('retryable: false');
            expect(source).toContain("ok: false");
        }
    });

    it('opens platform microphone permission settings from the webview', () => {
        const webviewProvider = readFileSync(new URL('../../webview-provider.ts', import.meta.url), 'utf8');

        expect(webviewProvider).toContain("case 'open_microphone_permissions'");
        expect(webviewProvider).toContain('openMicrophonePermissionSettings');
        expect(webviewProvider).toContain('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
        expect(webviewProvider).toContain('ms-settings:privacy-microphone');
        expect(webviewProvider).toContain('Allow microphone access');
    });
});
