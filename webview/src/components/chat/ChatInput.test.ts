import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    APPROVAL_PRESETS,
    MAX_CHAT_ATTACHMENT_BYTES,
    approvalModeFromSettings,
    attachmentContentWarning,
    attachmentFileKind,
    attachmentIngestionStatus,
    attachmentLimitError,
    attachmentSizeError,
    attachmentStatusBadgeLabel,
    buildApprovalPresetPayload,
    buildContextMessage,
    computeEtherMenuPosition,
    computeToolbarPopoverPosition,
    buildUsageBadgeDisplay,
    buildUsageExtraLabels,
    etherAdapterButtonClass,
    etherAdapterDisplayName,
    etherAdapterStatusDotClass,
    etherAdapterStatusLabel,
    etherMainStatusDotClass,
    formatAttachmentSize,
    getPlanFirstToggleState,
    isImageContextFile,
    isReadyContextFile,
    shouldRenderInputStatusStrip,
    USAGE_BADGE_BUTTON_CLASS,
    USAGE_POPOVER_CLASS
} from './ChatInput';
import { microphoneStartErrorMessage, microphoneStartErrorPhase, normalizeAudioResultError, selectAudioMimeType } from '../../hooks/useAudioRecorder';
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
        expect(shouldRenderInputStatusStrip(undefined, null, null, false, true)).toBe(true);
        expect(shouldRenderInputStatusStrip(undefined, null, null, false, false, true)).toBe(true);
        expect(shouldRenderInputStatusStrip(undefined, null, null)).toBe(false);
    });

    it('moves Plan first behavior into a toggle model', () => {
        expect(getPlanFirstToggleState('plan')).toEqual({ active: true, nextMode: 'act' });
        expect(getPlanFirstToggleState('act')).toEqual({ active: false, nextMode: 'plan' });
        expect(getPlanFirstToggleState('mission')).toEqual({ active: false, nextMode: 'plan' });
    });

    it('labels cache read, cache write, and reasoning usage explicitly', () => {
        expect(buildUsageExtraLabels({
            cachedInputTokens: 1_500,
            cacheCreationTokens: 2_500,
            reasoningOutputTokens: 500,
        } as UsageSnapshot)).toEqual(['Cache read 1.5k', 'Cache write 2.5k', 'Reasoning 500']);
    });

    it('separates latest request context from cumulative usage totals', () => {
        const display = buildUsageBadgeDisplay(null, {
            sessionId: 'session-1',
            contextTokens: 8_500,
            contextWindow: 128_000,
            inputTokens: 62_000,
            outputTokens: 313,
            estimatedCostUsd: 0,
            requestCount: 3,
            actualCount: 1,
            estimatedCount: 2,
            source: 'estimated',
        } as UsageSnapshot);

        expect(display.buttonLabel).toBe('Context 8.5k/128k');
        expect(display.contextLine).toBe('8.5k of 128k tokens in latest request context');
        expect(display.hasUsageTotals).toBe(true);
    });

    it('shows a no-context state for a scoped session with no model usage yet', () => {
        const display = buildUsageBadgeDisplay(null, {
            sessionId: 'session-1',
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
            requestCount: 0,
            actualCount: 0,
            estimatedCount: 0,
            source: 'estimated',
        } as UsageSnapshot);

        expect(display.buttonLabel).toBe('No context yet');
        expect(display.contextLine).toBe('No request context has been built for this session yet.');
        expect(display.hasUsageTotals).toBe(false);
    });

    it('uses the live context snapshot before stale usage context totals', () => {
        const display = buildUsageBadgeDisplay(
            { session_id: 'session-1', tokens_used: 10_000, tokens_max: 200_000, percentage: 5 } as ContextStatus,
            { sessionId: 'session-1', contextTokens: 8_500, contextWindow: 128_000 } as UsageSnapshot
        );

        expect(display.buttonLabel).toBe('Context 10.0k/200k');
        expect(display.contextPercent).toBe(5);
    });

    it('uses a details label during active runs so it does not duplicate the run header', () => {
        const display = buildUsageBadgeDisplay(
            { session_id: 'session-1', tokens_used: 11_200, tokens_max: 128_000 } as ContextStatus,
            { sessionId: 'session-1', contextTokens: 11_200, contextWindow: 128_000 } as UsageSnapshot,
            true
        );

        expect(display.buttonLabel).toBe('Usage details');
        expect(display.buttonDetail).toBe('· context 9%');
        expect(display.contextLine).toBe('11.2k of 128k tokens in latest request context');
    });

    it('keeps the context badge visually quiet and the popover above composer layers', () => {
        expect(USAGE_BADGE_BUTTON_CLASS).not.toMatch(/\bborder\b/);
        expect(USAGE_BADGE_BUTTON_CLASS).toContain('bg-transparent');
        expect(USAGE_POPOVER_CLASS).toContain('fixed');
        expect(USAGE_POPOVER_CLASS).toContain('z-[2147483647]');
    });

    it('keeps attachment paths out of visible send text', () => {
        const message = buildContextMessage('inspect these', [
            { path: 'src/main.ts', name: 'main.ts', status: 'ready', source: 'workspace' },
            { path: 'staging://a1', stagedPath: '.ricochet/attachments/default/pasted.txt', name: 'pasted.txt', status: 'ready', source: 'attachment', kind: 'attachment' },
            { path: 'staging://a2', name: 'uploading.txt', status: 'staging', source: 'attachment', kind: 'attachment' },
            { path: 'big.bin', name: 'big.bin', status: 'error', source: 'attachment', kind: 'attachment', error: 'too large' },
        ]);

        expect(message).toBe('inspect these');
        expect(message).not.toContain('Context Files');
        expect(message).not.toContain('@src/main.ts');
        expect(message).not.toContain('@.ricochet/attachments/default/pasted.txt');
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

    it('marks PDF, image, and binary attachments as attached but not readable content', () => {
        expect(attachmentContentWarning({ path: 'staging://1', name: 'invoice.pdf', mime: 'application/pdf', source: 'attachment' })).toContain('PDF content');
        expect(attachmentContentWarning({ path: 'staging://2', name: 'screenshot.png', mime: 'image/png', source: 'attachment' })).toContain('Image content');
        expect(attachmentContentWarning({ path: 'staging://3', name: 'archive.zip', mime: 'application/zip', source: 'attachment' })).toContain('Binary content');
        expect(attachmentContentWarning({ path: 'staging://4', name: 'notes.md', mime: 'text/markdown', source: 'attachment' })).toBeNull();
    });

    it('derives compact attachment ingestion statuses and badges', () => {
        const jpg = { path: 'staging://1', name: 'photo.jpg', mime: 'image/jpeg', source: 'attachment' as const, status: 'ready' as const };
        const pdf = { path: 'staging://2', name: 'invoice.pdf', mime: 'application/pdf', source: 'attachment' as const, status: 'ready' as const };
        const csv = { path: 'staging://3', name: 'prices.csv', mime: 'text/csv', source: 'attachment' as const, status: 'ready' as const };
        const zip = { path: 'staging://4', name: 'archive.zip', mime: 'application/zip', source: 'attachment' as const, status: 'ready' as const };

        expect(attachmentFileKind(jpg)).toBe('image');
        expect(attachmentIngestionStatus(jpg)).toBe('needs_ocr');
        expect(attachmentStatusBadgeLabel(jpg)).toBe('OCR');
        expect(attachmentFileKind(pdf)).toBe('pdf');
        expect(attachmentIngestionStatus(pdf)).toBe('needs_pdf_parse');
        expect(attachmentStatusBadgeLabel(pdf)).toBe('PDF');
        expect(attachmentFileKind(csv)).toBe('csv');
        expect(attachmentIngestionStatus(csv)).toBe('included_text');
        expect(attachmentStatusBadgeLabel(csv)).toBe('Text');
        expect(attachmentIngestionStatus(zip)).toBe('unsupported_binary');
        expect(attachmentStatusBadgeLabel(zip)).toBe('Saved');
    });

    it('formats attachment sizes for preview cards', () => {
        expect(formatAttachmentSize(512)).toBe('512 B');
        expect(formatAttachmentSize(2048)).toBe('2 KB');
        expect(formatAttachmentSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
        expect(formatAttachmentSize()).toBe('');
    });

    it('selects the first supported microphone recording mime type', () => {
        const recorder = {
            isTypeSupported: (type: string) => type === 'audio/webm',
        };

        expect(selectAudioMimeType(recorder)).toBe('audio/webm');
        expect(selectAudioMimeType({ isTypeSupported: () => false })).toBeUndefined();
    });

    it('normalizes microphone startup errors for display', () => {
        expect(microphoneStartErrorMessage({ name: 'NotAllowedError' })).toBe('Microphone permission was denied.');
        expect(microphoneStartErrorPhase({ name: 'NotAllowedError' })).toBe('permission');
        expect(microphoneStartErrorMessage({ name: 'NotFoundError' })).toBe('No microphone was found.');
        expect(microphoneStartErrorPhase({ name: 'NotFoundError' })).toBe('startup');
        expect(microphoneStartErrorMessage(new Error('device busy'))).toBe('device busy');
    });

    it('classifies audio result errors by phase and retry behavior', () => {
        expect(normalizeAudioResultError({ error: 'No speech was detected.', phase: 'transcription' })).toMatchObject({
            phase: 'transcription',
            retryable: true,
        });
        expect(normalizeAudioResultError({ error: 'Voice input requires local Whisper setup.', phase: 'setup' })).toMatchObject({
            phase: 'setup',
            retryable: false,
        });
        expect(normalizeAudioResultError({ error: 'Audio chunk failed.', phase: 'recording', retryable: false })).toMatchObject({
            phase: 'recording',
            retryable: false,
        });
    });

    it('uses Ether status dots instead of selected channel badges', () => {
        const unconfigured = { key: 'telegram' as const, configured: false, active: false };

        expect(etherAdapterStatusLabel(unconfigured)).toBe('not configured');
        expect(etherAdapterStatusLabel({ key: 'telegram', configured: true, active: true })).toBe('connected');
        expect(etherAdapterStatusLabel({ key: 'discord', configured: true, active: false })).toBe('configured');
        expect(etherAdapterStatusLabel({ key: 'discord', configured: true, active: false, error: 'bad token' })).toBe('error');
        expect(etherAdapterStatusDotClass({ key: 'telegram', configured: true, active: true })).toContain('bg-emerald');
        expect(etherAdapterStatusDotClass({ key: 'discord', configured: true, active: false, error: 'bad token' })).toContain('bg-amber');
        expect(etherMainStatusDotClass(true, true, false)).toContain('bg-emerald');
        expect(etherMainStatusDotClass(false, true, true)).toContain('bg-amber');
        expect(etherAdapterDisplayName('telegram', 'Telegram Gateway')).toBe('Telegram');
        expect(etherAdapterDisplayName('discord', 'Discord Gateway')).toBe('Discord');
    });

    it('keeps Ether channel rows quiet without selected styling', () => {
        const activeRow = etherAdapterButtonClass({ key: 'telegram', configured: true, active: true });
        const errorRow = etherAdapterButtonClass({ key: 'discord', configured: true, active: false, error: 'bad token' });

        expect(activeRow).not.toContain('bg-emerald');
        expect(activeRow).not.toContain('ring-vscode-button-bg');
        expect(activeRow).toContain('h-8');
        expect(errorRow).toContain('text-amber');
    });

    it('positions the Ether menu as a fixed viewport-clamped popover', () => {
        const compactStyle = computeEtherMenuPosition(
            { top: 640, right: 780, bottom: 672 },
            { width: 800, height: 720 },
        );
        const style = computeEtherMenuPosition(
            { top: 660, right: 780, bottom: 692 },
            { width: 800, height: 720 },
            { width: 274, height: 56 },
        );

        expect(Number(compactStyle.width)).toBeLessThanOrEqual(226);
        expect(Number(compactStyle.top)).toBeGreaterThan(672);
        expect(style.position).toBe('fixed');
        expect(Number(style.top)).toBeGreaterThan(692);
        expect(Number(style.maxHeight)).toBeGreaterThan(0);
        expect(Number(style.top) + Number(style.maxHeight)).toBeLessThanOrEqual(720 - 12);
        expect(Number(style.left)).toBeGreaterThanOrEqual(12);
        expect(Number(style.left)).toBeLessThanOrEqual(800 - 274 - 12);
    });

    it('keeps auto toolbar popovers flippable while below placement stays below', () => {
        const anchor = { top: 660, left: 24, right: 56, bottom: 692 };
        const viewport = { width: 800, height: 720 };
        const autoStyle = computeToolbarPopoverPosition(anchor, viewport, {
            width: 256,
            height: 56,
            minWidth: 240,
            align: 'start',
        });
        const belowStyle = computeToolbarPopoverPosition(anchor, viewport, {
            width: 256,
            height: 56,
            minWidth: 240,
            align: 'start',
            placement: 'below',
        });

        expect(Number(autoStyle.top)).toBeLessThan(660);
        expect(Number(belowStyle.top)).toBeGreaterThan(692);
    });

    it('prefers placing toolbar popovers below their button when viewport space allows it', () => {
        const style = computeToolbarPopoverPosition(
            { top: 120, left: 24, right: 56, bottom: 152 },
            { width: 800, height: 720 },
            { width: 256, height: 220, minWidth: 240, align: 'start' },
        );

        expect(style.position).toBe('fixed');
        expect(Number(style.top)).toBeGreaterThan(152);
        expect(Number(style.left)).toBe(24);
    });

    it('uses fixed portaled toolbar menus instead of inline bottom-full menus', () => {
        const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

        expect(source).toContain('ref={contextPopoverRef}');
        expect(source).toContain('ref={approvalPopoverRef}');
        expect(source).not.toContain('absolute bottom-full left-0 mb-2 w-64');
        expect(source).not.toContain('absolute bottom-full left-0 mb-2 w-72');
        expect(source).toContain('border border-transparent bg-transparent text-vscode-fg/55');
    });

    it('uses a hover Ether details popover without arrow, separator, or channel overlay badges', () => {
        const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

        expect(source).toContain('handleEtherToggleClick');
        expect(source).toContain('onMouseEnter={openEtherDetails}');
        expect(source).toContain('onMouseLeave={scheduleEtherDetailsClose}');
        expect(source).toContain('etherMainStatusDotClass');
        expect(source).toContain('w-max items-center gap-1 overflow-y-auto');
        expect(source).toContain("placement: 'below'");
        expect(source).not.toContain('Show Ether channels');
        expect(source).not.toContain('border-l border-current/15');
        expect(source).not.toContain('h-6 w-px');
        expect(source).not.toContain('shown on Ether badge');
        expect(source).not.toContain('adapter.short');
        expect(source).not.toContain("short: 'TG'");
        expect(source).not.toContain("short: 'DC'");
        expect(source).not.toContain('width: 268');
        expect(source).not.toContain('width: 348');
        expect(source).not.toContain('min-w-[92px]');
    });

    it('keeps microphone recording, waiting, and retry states compact', () => {
        const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
        const hookSource = readFileSync(new URL('../../hooks/useAudioRecorder.ts', import.meta.url), 'utf8');

        expect(source).toContain('RotateCcw');
        expect(source).toContain('Recording. Click to stop.');
        expect(source).toContain('handleMicButtonClick');
        expect(source).toContain('onClick={handleMicButtonClick}');
        expect(source).toContain('Voice input setup is required: ffmpeg, Whisper binary, and Whisper model.');
        expect(source).toContain('Voice input settings');
        expect(source).toContain('showMicStatusBanner');
        expect(source).toContain('Recording microphone audio');
        expect(source).toContain('disabled={isRequesting || isTranscribing}');
        expect(source).toContain("audioError.phase === 'transcription'");
        expect(source).toContain('audioErrorOpensMicrophonePermissions');
        expect(source).toContain("postMessage({ type: 'open_microphone_permissions' })");
        expect(source).toContain('Open microphone permission settings');
        expect(source).toContain('top-full');
        expect(source).not.toContain('Microphone permission waiting');
        expect(source).not.toContain('Microphone permission was denied...');
        expect(source).not.toContain('Transcribing voice input...');
        expect(source).not.toContain('max-w-[150px]');
        expect(hookSource).toContain("'requesting'");
        expect(hookSource).toContain("setAudioState('requesting')");
        expect(hookSource).toContain("isRequesting: audioState === 'requesting'");
        expect(hookSource).toContain("message.type === 'audio_recording_status'");
        expect(hookSource).toContain('MICROPHONE_PERMISSION_TIMEOUT_MS');
        expect(hookSource).toContain('recordingAttemptRef');
    });

    it('renders attachments as compact chips instead of tall image cards', () => {
        const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

        expect(source).toContain('group flex h-11');
        expect(source).toContain('h-9 w-9');
        expect(source).toContain('attachmentStatusBadgeLabel(file)');
        expect(source).not.toContain('relative h-20 bg-vscode-editor-background');
        expect(source).not.toContain("imageAttachment ? 'w-40'");
    });

    it('uses the shared Ether icon and removes the old damaged local SVG', () => {
        const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

        expect(source).toContain("import { EtherIcon } from './EtherIcon'");
        expect(source).toContain('<EtherIcon className={`w-4 h-4');
        expect(source).not.toContain('function VoiceIcon');
        expect(source).not.toContain('M21 10C21 9.44772 20.5523 9 20 9C19.4477 9 19 10V22');
    });

    it('maps approval policy presets to core auto-approval categories', () => {
        expect(APPROVAL_PRESETS.ask).toMatchObject({
            enabled: false,
            edit_files: false,
            execute_safe_commands: false,
            execute_all_commands: false,
            use_browser: false,
            use_mcp: false,
        });
        expect(APPROVAL_PRESETS.auto).toMatchObject({
            enabled: true,
            read_files: true,
            edit_files: false,
            execute_safe_commands: true,
            execute_all_commands: false,
            use_browser: false,
            use_mcp: false,
        });
        expect(APPROVAL_PRESETS.full).toMatchObject({
            enabled: true,
            edit_files: true,
            execute_all_commands: true,
            use_browser: true,
            use_mcp: true,
        });

        expect(approvalModeFromSettings(APPROVAL_PRESETS.ask)).toBe('ask');
        expect(approvalModeFromSettings(APPROVAL_PRESETS.auto)).toBe('auto');
        expect(approvalModeFromSettings(APPROVAL_PRESETS.full)).toBe('full');
        expect(approvalModeFromSettings({ enabled: true, use_mcp: true })).toBe('full');
    });

    it('preserves auto-approval budgets when applying quick presets', () => {
        expect(buildApprovalPresetPayload('auto', {
            max_requests: 7,
            max_cost_usd: 1.25,
            enable_notifications: true,
        })).toMatchObject({
            enabled: true,
            execute_safe_commands: true,
            max_requests: 7,
            max_cost_usd: 1.25,
        });
    });

    it('does not optimistically switch approval mode before settings_loaded confirms it', () => {
        const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
        const handlerBody = source.match(/const handleApprovalModeChange = \(mode: ApprovalMode\) => \{([\s\S]*?)\n    \};/)?.[1] || '';

        expect(handlerBody).toContain("postMessage({ type: 'auto_approve_settings'");
        expect(handlerBody).not.toContain('setApprovalMode(mode)');
    });
});
