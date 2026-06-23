import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    APPROVAL_PRESETS,
    MAX_CHAT_ATTACHMENT_BYTES,
    approvalModeFromSettings,
    attachmentLimitError,
    attachmentSizeError,
    buildContextMessage,
    buildUsageBadgeDisplay,
	buildUsageExtraLabels,
    etherAdapterButtonClass,
    etherAdapterStatusLabel,
    etherAdapterVisibleStatusLabel,
	formatAttachmentSize,
    getPlanFirstToggleState,
    isImageContextFile,
    isReadyContextFile,
    selectEtherBadgeAdapter,
    shouldRenderInputStatusStrip,
    USAGE_BADGE_BUTTON_CLASS,
    USAGE_POPOVER_CLASS
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

    it('formats attachment sizes for preview cards', () => {
        expect(formatAttachmentSize(512)).toBe('512 B');
        expect(formatAttachmentSize(2048)).toBe('2 KB');
        expect(formatAttachmentSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
        expect(formatAttachmentSize()).toBe('');
    });

    it('shows the selected Ether adapter badge when multiple adapters are active', () => {
        const adapters = [
            { key: 'telegram' as const, configured: true, active: true },
            { key: 'discord' as const, configured: true, active: true },
        ];

        expect(selectEtherBadgeAdapter(adapters, 'discord', null)?.key).toBe('discord');
        expect(selectEtherBadgeAdapter(adapters, 'telegram', null)?.key).toBe('telegram');
    });

    it('falls back to last-used Ether source and then first active adapter', () => {
        const adapters = [
            { key: 'telegram' as const, configured: true, active: true },
            { key: 'discord' as const, configured: true, active: true },
        ];

        expect(selectEtherBadgeAdapter(adapters, null, 'discord')?.key).toBe('discord');
        expect(selectEtherBadgeAdapter(adapters, null, null)?.key).toBe('telegram');
    });

    it('ignores an inactive preferred Ether adapter', () => {
        const adapters = [
            { key: 'telegram' as const, configured: true, active: true },
            { key: 'discord' as const, configured: true, active: false },
        ];

        expect(selectEtherBadgeAdapter(adapters, 'discord', null)?.key).toBe('telegram');
    });

    it('separates Ether channel activity from selected source styling', () => {
        const activeUnselected = etherAdapterButtonClass({ key: 'telegram', configured: true, active: true }, false);
        const activeSelected = etherAdapterButtonClass({ key: 'discord', configured: true, active: true }, true);

        expect(etherAdapterStatusLabel({ key: 'telegram', configured: true, active: true })).toBe('connected');
        expect(etherAdapterStatusLabel({ key: 'discord', configured: true, active: false })).toBe('Gateway enabled');
        expect(activeUnselected).not.toContain('bg-emerald');
        expect(activeUnselected).not.toContain('border-emerald');
        expect(activeSelected).toContain('ring-vscode-button-bg');
        expect(activeSelected).toContain('h-8');
        expect(activeSelected).not.toContain('h-10');
        expect(activeSelected).not.toContain('min-w-[104px]');
    });

    it('keeps Ether adapter gateway state in tooltip labels instead of visible menu text', () => {
        const unconfigured = { key: 'telegram' as const, configured: false, active: false };

        expect(etherAdapterStatusLabel(unconfigured)).toBe('Not configured');
        expect(etherAdapterVisibleStatusLabel(unconfigured)).toBe('');
        expect(etherAdapterVisibleStatusLabel({ key: 'discord', configured: true, active: false })).toBe('');
        expect(etherAdapterVisibleStatusLabel({ key: 'telegram', configured: true, active: true })).toBe('Active');
    });

    it('uses the shared Ether icon and removes the old damaged local SVG', () => {
        const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

        expect(source).toContain("import { EtherIcon } from './EtherIcon'");
        expect(source).toContain('<EtherIcon className="w-4 h-4" />');
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
    });

    it('does not optimistically switch approval mode before settings_loaded confirms it', () => {
        const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
        const handlerBody = source.match(/const handleApprovalModeChange = \(mode: ApprovalMode\) => \{([\s\S]*?)\n    \};/)?.[1] || '';

        expect(handlerBody).toContain("postMessage({ type: 'auto_approve_settings'");
        expect(handlerBody).not.toContain('setApprovalMode(mode)');
    });
});
