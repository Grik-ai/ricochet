import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('audio RPC forwarding', () => {
    it('keeps audio RPC forwarding owned by ChatService only', () => {
        const chatService = readFileSync(new URL('./ChatService.ts', import.meta.url), 'utf8');
        const webviewProvider = readFileSync(new URL('../../webview-provider.ts', import.meta.url), 'utf8');

        expect(chatService).toContain("case 'audio_start'");
        expect(chatService).toContain("case 'audio_chunk'");
        expect(chatService).toContain("case 'audio_stop'");
        expect(chatService).toContain('const result = await this.core.send(message.type, message.payload || {})');
        expect(chatService).toContain("type: 'audio_transcription_result'");
        expect(chatService).toContain("type: 'audio_recording_status'");
        expect(chatService).toContain("phase: 'recording'");
        expect(chatService).toContain("phase: 'transcription'");

        expect(webviewProvider).toContain("case 'audio_start'");
        expect(webviewProvider).toContain("case 'audio_chunk'");
        expect(webviewProvider).toContain("case 'audio_stop'");
        expect(webviewProvider).toContain('Handled by ChatService');
        expect(webviewProvider).not.toContain("type: 'audio_transcription_result'");
        expect(webviewProvider).not.toContain("type: 'audio_recording_status'");
        expect(webviewProvider).not.toContain("message.type === 'audio_stop'");
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
