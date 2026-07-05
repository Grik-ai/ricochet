import { useRef, useEffect, KeyboardEvent, useState, useCallback, type ChangeEvent, type ClipboardEvent, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Send, Mic, Square, ChevronDown, FileCode, StopCircle, X, Plus, Bot, Hand, ShieldCheck, ShieldAlert, CheckCircle2, Play, Info, RotateCcw, Gauge, Paperclip, Image as ImageIcon, Settings, FileText, type LucideIcon } from 'lucide-react';
import { AffectedFilesList } from './AffectedFilesList';
import { useAudioRecorder } from '../../hooks/useAudioRecorder';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { FileSearchResult } from '../../hooks/useChat';
import { ContextFilePayload, ContextStatus, UsageSnapshot } from '../../types/protocol';
import { ModelPickerModal } from './ModelPickerModal';
import { EtherStatus } from './EtherPanel';
import { NetworkDisplayStatus } from '../../hooks/useNetworkHealth';
import { NetworkStatusPill } from './NetworkStatusPill';
import { DiscordIcon, TelegramIcon } from './MessengerIcon';
import { EtherIcon } from './EtherIcon';
import type { GrikAccountController } from '../../hooks/useGrikAccount';
import {
    deriveModelAccess,
    findModelProvider,
    modelAccessBadgeClass,
    selectBestModel,
    settingsTabForModelAccess,
    type ModelAccessProvider,
    type SelectedModelLike,
} from './modelAccess';

export interface SelectedModel {
    id: string;
    name: string;
    provider: string;
    mayTrainOnYourPrompts?: boolean;
    credentialMode?: 'none' | 'grik_account' | 'provider_key';
}

interface ChatInputProps {
    value: string;
    onChange: (value: string) => void;
    onSend: (value?: string, contextFiles?: ContextFilePayload[]) => void;
    onStartAgent?: (value?: string, contextFiles?: ContextFilePayload[]) => void;
    onCancel?: () => void;
    isLoading?: boolean;
    isStopping?: boolean;
    placeholder?: string;
    currentMode: 'plan' | 'act' | 'mission';
    onModeChange: (mode: 'plan' | 'act' | 'mission') => void;
    onOpenSettings?: (tab?: string) => void;
    onOpenAccount?: () => void;
    fileResults?: FileSearchResult[];
    searchFiles?: (query: string) => void;
    liveStatus?: EtherStatus;
    isLiveModeLoading?: boolean;
    onToggleLiveMode?: () => void;
    currentModel: SelectedModel;
    onModelChange: (model: SelectedModel) => void;
    recentlyEditedFiles?: { path: string, name: string }[];
    pendingEdits?: any[];
    pendingChoice?: ChoiceRequest | null;
    onChoiceResponse?: (id: string, answer: string) => void;
    contextStatus?: ContextStatus | null;
    usageSnapshot?: UsageSnapshot | null;
    networkStatus?: NetworkDisplayStatus;
    missionStatus?: ReactNode;
    accountStatus?: ReactNode;
    grikAccount?: GrikAccountController;
    sessionId?: string;
}

export type EtherAdapterKey = 'telegram' | 'discord';

export interface EtherAdapterDisplayState {
    key: EtherAdapterKey;
    configured: boolean;
    active: boolean;
    error?: string;
}

export function etherAdapterStatusLabel(adapter: EtherAdapterDisplayState): 'connected' | 'configured' | 'not configured' | 'error' {
    if (adapter.error) return 'error';
    if (adapter.active) return 'connected';
    if (adapter.configured) return 'configured';
    return 'not configured';
}

export function etherAdapterDisplayName(key: EtherAdapterKey, label?: string): string {
    if (key === 'telegram') return 'Telegram';
    if (key === 'discord') return 'Discord';
    return (label || key).replace(/\s*gateway\s*/ig, ' ').trim() || key;
}

export function etherAdapterButtonClass(adapter: EtherAdapterDisplayState): string {
    const base = 'relative flex h-8 min-w-[82px] items-center justify-start gap-1.5 rounded-md px-2 text-left transition-colors';
    if (!adapter.configured) {
        return `${base} bg-transparent text-vscode-fg/32 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/62`;
    }
    if (adapter.error) {
        return `${base} bg-transparent text-amber-200/72 hover:bg-vscode-list-hoverBackground hover:text-amber-100`;
    }
    return `${base} bg-transparent text-vscode-fg/70 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg`;
}

export interface EtherMenuRect {
    top: number;
    left?: number;
    right: number;
    bottom: number;
}

export interface EtherViewportSize {
    width: number;
    height: number;
}

export interface ToolbarPopoverOptions {
    width: number;
    height: number;
    minWidth?: number;
    align?: 'start' | 'end';
    placement?: 'auto' | 'below';
    gap?: number;
    margin?: number;
}

export function computeToolbarPopoverPosition(
    anchorRect: EtherMenuRect,
    viewport: EtherViewportSize,
    options: ToolbarPopoverOptions
): CSSProperties {
    const gap = options.gap ?? 6;
    const margin = options.margin ?? 12;
    const placement = options.placement ?? 'auto';
    const minWidth = options.minWidth ?? Math.min(220, options.width);
    const maxWidth = Math.max(0, viewport.width - margin * 2);
    const cappedWidth = maxWidth > 0 ? Math.min(options.width, maxWidth) : options.width;
    const width = maxWidth > 0 ? Math.max(Math.min(minWidth, maxWidth), cappedWidth) : options.width;
    const maxLeft = Math.max(margin, viewport.width - width - margin);
    const targetLeft = options.align === 'end'
        ? anchorRect.right - width
        : anchorRect.left ?? anchorRect.right - width;
    const left = Math.max(margin, Math.min(targetLeft, maxLeft));
    const roomAbove = anchorRect.top - margin;
    const roomBelow = viewport.height - anchorRect.bottom - margin;
    const openBelow = placement === 'below' || roomBelow >= options.height || roomBelow >= roomAbove;
    const top = openBelow
        ? placement === 'below'
            ? Math.max(margin, anchorRect.bottom + gap)
            : Math.min(anchorRect.bottom + gap, Math.max(margin, viewport.height - options.height - margin))
        : Math.max(margin, anchorRect.top - options.height - gap);
    const maxHeight = openBelow
        ? Math.max(placement === 'below' ? 1 : 48, viewport.height - top - margin)
        : Math.max(48, anchorRect.top - gap - margin);

    return {
        position: 'fixed',
        left,
        top,
        width,
        maxHeight,
        maxWidth: `calc(100vw - ${margin * 2}px)`,
        transformOrigin: openBelow ? 'top right' : 'bottom right',
    };
}

export function computeEtherMenuPosition(
    anchorRect: EtherMenuRect,
    viewport: EtherViewportSize,
    menuSize = { width: 226, height: 44 }
): CSSProperties {
    return computeToolbarPopoverPosition(anchorRect, viewport, {
        width: menuSize.width,
        height: menuSize.height,
        minWidth: Math.min(212, menuSize.width),
        align: 'end',
        placement: 'below',
        gap: 6,
    });
}

export function etherAdapterStatusDotClass(adapter: EtherAdapterDisplayState): string {
    if (adapter.error) return 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.35)]';
    if (adapter.active) return 'bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.32)]';
    if (adapter.configured) return 'bg-vscode-fg/38';
    return 'bg-transparent ring-1 ring-vscode-fg/30';
}

export function etherMainStatusDotClass(isLiveMode: boolean, hasConfiguredAdapter: boolean, hasChannelError: boolean): string {
    if (hasChannelError) return 'bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.35)]';
    if (isLiveMode) return 'bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.35)]';
    if (hasConfiguredAdapter) return 'bg-vscode-fg/38';
    return 'bg-transparent ring-1 ring-vscode-fg/35';
}

export const MAX_CHAT_ATTACHMENTS = 8;
export const MAX_CHAT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export function isReadyContextFile(file: ContextFilePayload): boolean {
    return file.status !== 'staging' && file.status !== 'error';
}

export function buildContextMessage(value: string, contextFiles: ContextFilePayload[]): string {
    void contextFiles;
    return value;
}

export function attachmentLimitError(fileCount: number, existingCount: number): string | null {
    if (fileCount + existingCount <= MAX_CHAT_ATTACHMENTS) return null;
    return `Attach up to ${MAX_CHAT_ATTACHMENTS} files per turn.`;
}

export function attachmentSizeError(size: number): string | null {
    if (size <= MAX_CHAT_ATTACHMENT_BYTES) return null;
    return `File is larger than ${Math.round(MAX_CHAT_ATTACHMENT_BYTES / 1024 / 1024)} MB.`;
}

const IMAGE_EXTENSION_PATTERN = /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;
const PDF_EXTENSION_PATTERN = /\.pdf$/i;
const TEXT_LIKE_MIME_PATTERN = /^(text\/|application\/(json|xml|javascript|x-javascript|typescript|x-typescript|x-sh|graphql|ld\+json|toml|yaml|x-yaml)|image\/svg\+xml\b)/i;

export function isImageContextFile(file: Pick<ContextFilePayload, 'mime' | 'name' | 'path'>): boolean {
    const mime = file.mime || '';
    if (mime.toLowerCase().startsWith('image/')) return true;
    return IMAGE_EXTENSION_PATTERN.test(file.name || file.path || '');
}

export function isPdfContextFile(file: Pick<ContextFilePayload, 'mime' | 'name' | 'path'>): boolean {
    const mime = (file.mime || '').split(';')[0].trim().toLowerCase();
    return mime === 'application/pdf' || PDF_EXTENSION_PATTERN.test(file.name || file.path || '');
}

export function isTextLikeContextFile(file: Pick<ContextFilePayload, 'mime' | 'name' | 'path' | 'source'>): boolean {
    const mime = (file.mime || '').split(';')[0].trim().toLowerCase();
    if (mime && TEXT_LIKE_MIME_PATTERN.test(mime)) return true;
    return /\.(csv|json|jsonl|md|markdown|txt|log|ts|tsx|js|jsx|mjs|cjs|css|scss|html|xml|yaml|yml|toml|go|py|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|zsh|sql)$/i.test(file.name || file.path || '');
}

export type AttachmentIngestionStatus = 'staged' | 'sent' | 'included_text' | 'needs_pdf_parse' | 'needs_ocr' | 'unsupported_binary';

export function attachmentIngestionStatus(file: Pick<ContextFilePayload, 'mime' | 'name' | 'path' | 'source' | 'status'>): AttachmentIngestionStatus {
    if (file.status === 'staging') return 'staged';
    if (file.status === 'error') return 'unsupported_binary';
    if (isPdfContextFile(file)) return 'needs_pdf_parse';
    if (isImageContextFile(file)) return 'needs_ocr';
    if (isTextLikeContextFile(file)) return 'included_text';
    return file.source === 'attachment' ? 'unsupported_binary' : 'sent';
}

export function attachmentStatusBadgeLabel(file: Pick<ContextFilePayload, 'mime' | 'name' | 'path' | 'source' | 'status'>): string {
    switch (attachmentIngestionStatus(file)) {
        case 'staged':
            return 'Saving';
        case 'included_text':
            return 'Text';
        case 'needs_pdf_parse':
            return 'PDF';
        case 'needs_ocr':
            return 'OCR';
        case 'unsupported_binary':
            return 'Saved';
        case 'sent':
        default:
            return 'Sent';
    }
}

export function attachmentStatusTitle(file: Pick<ContextFilePayload, 'mime' | 'name' | 'path' | 'source' | 'status'>): string {
    switch (attachmentIngestionStatus(file)) {
        case 'staged':
            return 'File is being saved before sending.';
        case 'included_text':
            return 'Readable text will be included in model context.';
        case 'needs_pdf_parse':
            return 'PDF will be parsed locally when pdftotext is available.';
        case 'needs_ocr':
            return 'Image text requires local OCR; the image is not uploaded to the provider.';
        case 'unsupported_binary':
            return 'File is attached and listed, but binary content is not readable as text.';
        case 'sent':
        default:
            return 'File will be sent as an attachment reference.';
    }
}

export function attachmentFileKind(file: Pick<ContextFilePayload, 'mime' | 'name' | 'path' | 'source'>): 'image' | 'pdf' | 'csv' | 'text' | 'file' {
    if (isImageContextFile(file)) return 'image';
    if (isPdfContextFile(file)) return 'pdf';
    const name = file.name || file.path || '';
    const mime = (file.mime || '').split(';')[0].trim().toLowerCase();
    if (mime === 'text/csv' || /\.csv$/i.test(name)) return 'csv';
    if (isTextLikeContextFile(file)) return 'text';
    return 'file';
}

export function attachmentContentWarning(file: Pick<ContextFilePayload, 'mime' | 'name' | 'path' | 'source'>): string | null {
    const mime = (file.mime || '').split(';')[0].trim().toLowerCase();
    const path = file.name || file.path || '';
    if (mime === 'application/pdf' || PDF_EXTENSION_PATTERN.test(path)) {
        return 'PDF content is not readable yet';
    }
    if (isImageContextFile(file)) {
        return 'Image content is not readable yet';
    }
    if (file.source === 'attachment' && mime && !TEXT_LIKE_MIME_PATTERN.test(mime)) {
        return 'Binary content is not readable yet';
    }
    return null;
}

export function formatAttachmentSize(size?: number): string {
    if (!size || size <= 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function attachmentDisplayName(file: ContextFilePayload): string {
    return file.name || file.path.split('/').pop() || file.path || 'attachment';
}

function attachmentMetaLabel(file: ContextFilePayload): string {
    if (file.status === 'staging') return 'Staging';
    if (file.status === 'error') return file.error || 'Failed';
    const size = formatAttachmentSize(file.size);
    const mime = file.mime?.split(';')[0];
    if (size && mime) return `${mime} · ${size}`;
    return size || mime || (file.source === 'workspace' ? 'Workspace file' : 'Attachment');
}

function createAttachmentPreviewUrl(file: File): string | undefined {
    if (!isImageContextFile({ mime: file.type, name: file.name, path: file.name })) return undefined;
    try {
        return URL.createObjectURL(file);
    } catch {
        return undefined;
    }
}

function revokeAttachmentPreview(file?: Pick<ContextFilePayload, 'previewUrl'>) {
    if (!file?.previewUrl?.startsWith('blob:')) return;
    try {
        URL.revokeObjectURL(file.previewUrl);
    } catch {
        // Best-effort cleanup; the preview is only a local webview object URL.
    }
}

export const DEFAULT_MODEL: SelectedModel = { id: '', name: 'Loading...', provider: '' };

function selectedModelFromAccess(model: SelectedModelLike): SelectedModel {
    return {
        id: model.id,
        name: model.name || model.id,
        provider: model.provider,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts === true,
        credentialMode: model.credentialMode,
    };
}

export function shouldRenderInputStatusStrip(
    networkStatus?: NetworkDisplayStatus,
    contextStatus?: ContextStatus | null,
    usageSnapshot?: UsageSnapshot | null,
    hasMissionStatus?: boolean,
    hasUsageStatus?: boolean,
    hasAccountStatus?: boolean
): boolean {
    return Boolean(networkStatus || contextStatus || usageSnapshot || hasMissionStatus || hasUsageStatus || hasAccountStatus);
}

export function getPlanFirstToggleState(currentMode: 'plan' | 'act' | 'mission') {
    return {
        active: currentMode === 'plan',
        nextMode: currentMode === 'plan' ? 'act' as const : 'plan' as const,
    };
}

function formatTokens(tokens?: number): string {
    const value = tokens || 0;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
    return String(value);
}

export function buildUsageExtraLabels(usageSnapshot?: UsageSnapshot | null): string[] {
    const labels: string[] = [];
    if (usageSnapshot?.cachedInputTokens) labels.push(`Cache read ${formatTokens(usageSnapshot.cachedInputTokens)}`);
    if (usageSnapshot?.cacheCreationTokens) labels.push(`Cache write ${formatTokens(usageSnapshot.cacheCreationTokens)}`);
    if (usageSnapshot?.reasoningOutputTokens) labels.push(`Reasoning ${formatTokens(usageSnapshot.reasoningOutputTokens)}`);
    return labels;
}

function formatCost(cost?: number): string {
    const value = cost || 0;
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
}

function usageSourceLabel(source?: string): string {
    if (source === 'actual') return 'actual';
    if (source === 'unconfirmed') return 'unconfirmed';
    return 'est';
}

export const USAGE_BADGE_BUTTON_CLASS = 'inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-transparent px-1.5 text-vscode-fg/55 transition-colors hover:bg-transparent hover:text-vscode-fg/85 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder';
export const USAGE_POPOVER_CLASS = 'fixed w-80 max-w-[calc(100vw-32px)] rounded-md border border-vscode-border bg-vscode-input-bg shadow-2xl z-[2147483647] overflow-y-auto animate-in fade-in slide-in-from-bottom-2';

export interface UsageBadgeDisplayState {
    contextTokens: number;
    contextWindow: number;
    contextPercent: number;
    source: string;
    hasUsageTotals: boolean;
    hasContextSnapshot: boolean;
    buttonLabel: string;
    buttonDetail: string;
    popoverStatus: string;
    contextLine: string;
}

export function buildUsageBadgeDisplay(
    contextStatus?: ContextStatus | null,
    usageSnapshot?: UsageSnapshot | null,
    isActive = false
): UsageBadgeDisplayState {
    const contextTokens = contextStatus?.tokens_used ?? usageSnapshot?.contextTokens ?? 0;
    const contextWindow = contextStatus?.tokens_max ?? usageSnapshot?.contextWindow ?? 0;
    const contextPercent = contextWindow > 0
        ? Math.round((contextTokens / contextWindow) * 100)
        : Math.round(contextStatus?.percentage || 0);
    const source = usageSourceLabel(usageSnapshot?.source);
    const hasUsageTotals = Boolean(usageSnapshot && (
        usageSnapshot.requestCount > 0
        || usageSnapshot.inputTokens > 0
        || usageSnapshot.outputTokens > 0
        || usageSnapshot.estimatedCostUsd > 0
    ));
    const hasContextSnapshot = contextWindow > 0 || contextTokens > 0 || Boolean(contextStatus?.report);
    const buttonLabel = contextWindow > 0
        ? isActive ? 'Usage details' : `Context ${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`
        : isActive ? 'Context pending' : 'No context yet';
    const buttonDetail = contextWindow > 0 && contextPercent > 0
        ? isActive ? `· context ${contextPercent}%` : `· ${contextPercent}%`
        : hasUsageTotals ? `· ${formatCost(usageSnapshot?.estimatedCostUsd)} ${source}` : isActive ? '· pending' : '';
    const popoverStatus = hasUsageTotals
        ? (source === 'actual' ? 'Provider reported' : 'Estimated')
        : isActive ? 'Waiting for provider usage' : 'No model usage yet';
    const contextLine = contextWindow > 0
        ? `${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} tokens in latest request context`
        : 'No request context has been built for this session yet.';

    return {
        contextTokens,
        contextWindow,
        contextPercent,
        source,
        hasUsageTotals,
        hasContextSnapshot,
        buttonLabel,
        buttonDetail,
        popoverStatus,
        contextLine,
    };
}

function UsageBadge({
    contextStatus,
    usageSnapshot,
    isActive,
    isOpen,
    onToggle,
    onClose,
}: {
    contextStatus?: ContextStatus | null;
    usageSnapshot?: UsageSnapshot | null;
    isActive?: boolean;
    isOpen: boolean;
    onToggle: () => void;
    onClose: () => void;
}) {
    const buttonRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
    const display = buildUsageBadgeDisplay(contextStatus, usageSnapshot, isActive);
    const models = usageSnapshot?.models || [];
    const contextReport = contextStatus?.report;
    const contextWarnings = contextStatus?.warnings || contextReport?.warnings || [];
    const contextSuggestions = contextStatus?.suggestions || contextReport?.suggestions || [];
    const topContributors = contextReport?.top_contributors || [];
    const compression = contextReport?.compression;
    const compressedFragments = compression?.fragments || [];
    const usageExtraLabels = buildUsageExtraLabels(usageSnapshot);

    useEffect(() => {
        if (!isOpen || typeof window === 'undefined') return;

        const updatePopoverPosition = () => {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (!rect) return;

            const viewportWidth = window.innerWidth || 0;
            const viewportHeight = window.innerHeight || 0;
            const width = Math.min(320, Math.max(240, viewportWidth - 32));
            let left = rect.right - width;
            left = Math.max(16, Math.min(left, viewportWidth - width - 16));

            setPopoverStyle({
                width,
                left,
                bottom: Math.max(12, viewportHeight - rect.top + 8),
                maxHeight: Math.max(220, rect.top - 24),
            });
        };

        updatePopoverPosition();
        window.addEventListener('resize', updatePopoverPosition);
        window.addEventListener('scroll', updatePopoverPosition, true);
        return () => {
            window.removeEventListener('resize', updatePopoverPosition);
            window.removeEventListener('scroll', updatePopoverPosition, true);
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || typeof document === 'undefined') return;

        const handlePointerDown = (event: globalThis.MouseEvent) => {
            const target = event.target as Node | null;
            if (target && (buttonRef.current?.contains(target) || popoverRef.current?.contains(target))) return;
            onClose();
        };
        const handleKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, onClose]);

    const popover = isOpen ? (
        <div
            ref={popoverRef}
            className={USAGE_POPOVER_CLASS}
            style={popoverStyle}
            role="dialog"
            aria-label="Context and usage details"
        >
            <div className="flex items-center justify-between px-3 py-2 border-b border-vscode-border bg-vscode-editor-background">
                <span className="text-[10px] font-medium text-vscode-fg/60">Context & usage</span>
                <span className="text-[10px] text-vscode-fg/40">
                    {display.popoverStatus}
                </span>
            </div>
            <div className="p-3 space-y-3">
                <div>
                    <div className="mb-1 flex items-center justify-between text-[10px] text-vscode-fg/45">
                        <span>Latest request context</span>
                        <span>{display.contextPercent || 0}%</span>
                    </div>
                    <div className="h-1.5 rounded bg-vscode-editor-background overflow-hidden">
                        <div className="h-full bg-vscode-button-bg" style={{ width: `${Math.min(100, Math.max(0, display.contextPercent || 0))}%` }} />
                    </div>
                    <div className="mt-1 text-[10px] text-vscode-fg/40">{display.contextLine}</div>
                </div>

                {(contextWarnings.length > 0 || contextSuggestions.length > 0) && (
                    <div className="space-y-1 rounded border border-vscode-border bg-vscode-editor-background px-2 py-1.5">
                        <div className="text-[10px] font-medium text-vscode-fg/55">Context health</div>
                        {contextWarnings.slice(0, 2).map((warning, index) => (
                            <div key={`context-warning-${index}`} className="text-[10px] leading-snug text-vscode-fg/55">{warning}</div>
                        ))}
                        {contextSuggestions.slice(0, 2).map((suggestion, index) => (
                            <div key={`context-suggestion-${index}`} className="text-[9px] leading-snug text-vscode-fg/35">{suggestion}</div>
                        ))}
                    </div>
                )}

                {compression?.saved_tokens ? (
                    <div className="space-y-1 rounded border border-vscode-border bg-vscode-editor-background px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                            <div className="text-[10px] font-medium text-vscode-fg/55">Context compression</div>
                            <div className="text-[10px] text-vscode-fg/45">
                                {formatTokens(compression.original_tokens)} → {formatTokens(compression.compressed_tokens)}
                            </div>
                        </div>
                        <div className="text-[9px] text-vscode-fg/35">
                            Saved {formatTokens(compression.saved_tokens)} across {compressedFragments.length} fragment{compressedFragments.length === 1 ? '' : 's'}.
                        </div>
                        {compressedFragments.slice(0, 3).map((fragment) => (
                            <div key={`${fragment.hash}-${fragment.id}`} className="flex items-center justify-between gap-2 text-[9px] text-vscode-fg/40">
                                <span className="min-w-0 truncate">{fragment.type} · {fragment.id}</span>
                                <span className="shrink-0">{formatTokens(fragment.saved_tokens)} saved</span>
                            </div>
                        ))}
                    </div>
                ) : null}

                {topContributors.length > 0 && (
                    <div className="space-y-1.5">
                        <div className="text-[10px] text-vscode-fg/45">Largest context contributors</div>
                        {topContributors.slice(0, 5).map((item) => (
                            <div key={`${item.id}-${item.type}`} className="flex items-center justify-between gap-2 rounded border border-vscode-border bg-vscode-editor-background px-2 py-1.5">
                                <div className="min-w-0">
                                    <div className="truncate text-[10px] text-vscode-fg/70">{item.id}</div>
                                    <div className="text-[9px] text-vscode-fg/35">{item.type}{item.source ? ` · ${item.source}` : ''}</div>
                                </div>
                                <div className="shrink-0 text-[10px] text-vscode-fg/45">{formatTokens(item.tokens)}</div>
                            </div>
                        ))}
                    </div>
                )}

                <div className="space-y-1.5">
                    <div className="text-[10px] text-vscode-fg/45">Session usage totals</div>
                    <div className="grid grid-cols-3 gap-2">
                        <div className="rounded border border-vscode-border bg-vscode-editor-background px-2 py-1.5">
                            <div className="text-[9px] text-vscode-fg/40">Input</div>
                            <div className="text-[11px] font-medium text-vscode-fg/80">{formatTokens(usageSnapshot?.inputTokens)}</div>
                        </div>
                        <div className="rounded border border-vscode-border bg-vscode-editor-background px-2 py-1.5">
                            <div className="text-[9px] text-vscode-fg/40">Output</div>
                            <div className="text-[11px] font-medium text-vscode-fg/80">{formatTokens(usageSnapshot?.outputTokens)}</div>
                        </div>
                        <div className="rounded border border-vscode-border bg-vscode-editor-background px-2 py-1.5">
                            <div className="text-[9px] text-vscode-fg/40">Cost</div>
                            <div className="text-[11px] font-medium text-vscode-fg/80">{display.hasUsageTotals ? formatCost(usageSnapshot?.estimatedCostUsd) : 'pending'}</div>
                        </div>
                    </div>
                </div>

                {usageExtraLabels.length > 0 ? (
                    <div className="flex flex-wrap gap-2 text-[10px] text-vscode-fg/45">
                        {usageExtraLabels.map(label => (
                            <span key={label}>{label}</span>
                        ))}
                    </div>
                ) : null}

                <div className="space-y-1.5">
                    <div className="text-[10px] text-vscode-fg/45">Models used</div>
                    {models.length === 0 ? (
                        <div className="text-[10px] text-vscode-fg/35">No completed model usage yet.</div>
                    ) : models.map(model => (
                        <div key={`${model.provider}-${model.model}-${model.keySource || 'none'}`} className="flex items-center justify-between gap-2 rounded border border-vscode-border bg-vscode-editor-background px-2 py-1.5">
                            <div className="min-w-0">
                                <div className="truncate text-[11px] text-vscode-fg/80">{model.model}</div>
                                <div className="text-[9px] text-vscode-fg/40">{model.provider} · {model.keySource === 'user' ? 'Key connected' : model.keySource === 'server' ? 'Included' : model.keySource === 'hosted' ? 'Grik Account' : 'No key'} · {usageSourceLabel(model.source)}</div>
                            </div>
                            <div className="shrink-0 text-right text-[10px] text-vscode-fg/45">
                                <div>{formatTokens(model.inputTokens)} / {formatTokens(model.outputTokens)}</div>
                                <div>{formatCost(model.estimatedCostUsd)}</div>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="text-[9px] leading-relaxed text-vscode-fg/35">
                    Context is the latest request window for this session. Input, output, and cost are cumulative session usage totals.
                </div>
            </div>
        </div>
    ) : null;

    return (
        <div className="relative shrink-0">
            <button
                ref={buttonRef}
                type="button"
                onClick={onToggle}
                className={USAGE_BADGE_BUTTON_CLASS}
                title="Context and session usage"
                aria-expanded={isOpen}
                aria-haspopup="dialog"
            >
                <Gauge className="h-3.5 w-3.5" />
                <span className="text-[11px] font-medium leading-none">
                    {display.buttonLabel}
                </span>
                <span className="hidden md:inline text-[10px] leading-none text-vscode-fg/35">
                    {display.buttonDetail}
                </span>
            </button>

            {popover && typeof document !== 'undefined' ? createPortal(popover, document.body) : popover}
        </div>
    );
}

interface ChoiceRequest {
    id: string;
    question: string;
    choices?: string[];
    choiceMetadata?: ChoiceOptionMetadata[];
}

interface ChoiceOptionMetadata {
    value: string;
    label?: string;
    description?: string;
    recommended?: boolean;
    danger?: boolean;
}

export type ApprovalMode = 'ask' | 'auto' | 'full';

export interface AutoApprovalSettings {
    enabled?: boolean;
    read_files?: boolean;
    read_files_external?: boolean;
    edit_files?: boolean;
    edit_files_external?: boolean;
    delete_files?: boolean;
    delete_files_external?: boolean;
    execute_safe_commands?: boolean;
    execute_all_commands?: boolean;
    use_browser?: boolean;
    use_mcp?: boolean;
    enable_notifications?: boolean;
    max_requests?: number;
    max_cost_usd?: number;
}

export const APPROVAL_PRESETS: Record<ApprovalMode, AutoApprovalSettings> = {
    ask: {
        enabled: false,
        read_files: false,
        read_files_external: false,
        edit_files: false,
        edit_files_external: false,
        delete_files: false,
        delete_files_external: false,
        execute_safe_commands: false,
        execute_all_commands: false,
        use_browser: false,
        use_mcp: false,
        enable_notifications: false,
    },
    auto: {
        enabled: true,
        read_files: true,
        read_files_external: false,
        edit_files: false,
        edit_files_external: false,
        delete_files: false,
        delete_files_external: false,
        execute_safe_commands: true,
        execute_all_commands: false,
        use_browser: false,
        use_mcp: false,
        enable_notifications: false,
    },
    full: {
        enabled: true,
        read_files: true,
        read_files_external: true,
        edit_files: true,
        edit_files_external: true,
        delete_files: true,
        delete_files_external: true,
        execute_safe_commands: true,
        execute_all_commands: true,
        use_browser: true,
        use_mcp: true,
        enable_notifications: false,
    },
};

const APPROVAL_OPTIONS: Array<{ id: ApprovalMode; label: string; description: string; icon: LucideIcon }> = [
    { id: 'ask', label: 'Ask approval', description: 'Ask before writes, commands, and external access.', icon: Hand },
    { id: 'auto', label: 'Auto safe', description: 'Auto-approve reads and safe commands only.', icon: ShieldCheck },
    { id: 'full', label: 'Full access', description: 'Allow edits, commands, browser, and MCP actions.', icon: ShieldAlert },
];

export function approvalModeFromSettings(settings?: AutoApprovalSettings): ApprovalMode {
    if (!settings?.enabled) return 'ask';
    if (
        settings.execute_all_commands ||
        settings.edit_files ||
        settings.edit_files_external ||
        settings.delete_files ||
        settings.delete_files_external ||
        settings.read_files_external ||
        settings.use_browser ||
        settings.use_mcp
    ) {
        return 'full';
    }
    return 'auto';
}

export function buildApprovalPresetPayload(mode: ApprovalMode, current?: AutoApprovalSettings): AutoApprovalSettings {
    return {
        ...(current || {}),
        ...APPROVAL_PRESETS[mode],
    };
}

const DEFAULT_COMMANDS = [
    { command: '/help', description: 'Show available Ricochet commands' },
    { command: '/status', description: 'Show session, provider, model, and Live status' },
    { command: '/login', description: 'Sign in to Grik in your browser' },
    { command: '/provider', description: 'Choose or inspect the default provider' },
    { command: '/model', description: 'Choose or inspect the default model' },
    { command: '/apikey', description: 'Manage BYOK provider keys' },
    { command: '/permissions', description: 'Show or change approval mode' },
    { command: '/mcp', description: 'Manage MCP servers' },
    { command: '/ether', description: 'Manage Live/Ether remote control' },
    { command: '/version', description: 'Show core version diagnostics' },
    { command: '/clear', description: 'Clear chat history' },
];

const DEFAULT_PLAN_CHOICE_DESCRIPTIONS: Record<string, string> = {
    proceed: 'Start implementation using the approved plan.',
    'revise plan': 'Keep planning and ask the agent to update the proposal.',
    'save only': 'Leave the plan as a document and stop the task.',
    cancel: 'Stop without starting implementation.',
};

function normalizeChoiceOption(choice: string, index: number, metadata?: ChoiceOptionMetadata) {
    const value = metadata?.value || choice;
    const rawLabel = metadata?.label || choice;
    const normalized = rawLabel.trim().toLowerCase();
    const description = metadata?.description
        || DEFAULT_PLAN_CHOICE_DESCRIPTIONS[normalized]
        || (normalized.includes('task') ? 'Create trackable tasks without starting execution.' : 'Send this decision to the agent.');

    return {
        value,
        label: rawLabel,
        description,
        recommended: metadata?.recommended || index === 0,
        danger: metadata?.danger || /cancel|stop|reject|deny/i.test(rawLabel),
    };
}

export function ChatInput(props: ChatInputProps) {
    const {
        value,
        onChange,
        onSend,
        onStartAgent,
        onCancel,
        isLoading = false,
        isStopping = false,
        placeholder = 'Ask anything or use /commands...',
        fileResults = [],
        searchFiles,
        liveStatus,
        isLiveModeLoading = false,
        onToggleLiveMode,
        currentMode,
        onModeChange,
        currentModel: propCurrentModel,
        onModelChange,
        recentlyEditedFiles,
        pendingChoice,
        onChoiceResponse,
        contextStatus,
        usageSnapshot,
        networkStatus,
        missionStatus,
        accountStatus,
        grikAccount,
        sessionId,
        onOpenSettings,
        onOpenAccount
    } = props;

    const isLiveMode = liveStatus?.enabled ?? false;
    const isRemoteProcessing = isLiveMode && (liveStatus?.stage === 'processing' || liveStatus?.stage === 'receiving');
    const hasUsageStatus = Boolean(sessionId || contextStatus || usageSnapshot);
    const hasMissionStatus = Boolean(missionStatus);
    const hasAccountStatus = Boolean(accountStatus);
    const hasInputStatusStrip = shouldRenderInputStatusStrip(networkStatus, contextStatus, usageSnapshot, hasMissionStatus, hasUsageStatus, hasAccountStatus);
    const planFirstToggle = getPlanFirstToggleState(currentMode);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const etherMenuRef = useRef<HTMLDivElement>(null);
    const etherButtonRef = useRef<HTMLButtonElement>(null);
    const etherPopoverRef = useRef<HTMLDivElement>(null);
    const etherCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contextButtonRef = useRef<HTMLButtonElement>(null);
    const contextPopoverRef = useRef<HTMLDivElement>(null);
    const approvalButtonRef = useRef<HTMLButtonElement>(null);
    const approvalPopoverRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const modelButtonRef = useRef<HTMLButtonElement>(null);
    const {
        isRecording,
        isRequesting,
        isTranscribing,
        audioError,
        lastTranscript,
        resetTranscript,
        toggleRecording
    } = useAudioRecorder();

    const [showModelMenu, setShowModelMenu] = useState(false);
    const [showContextMenu, setShowContextMenu] = useState(false);
    const [showUsageMenu, setShowUsageMenu] = useState(false);
    const [showEtherMenu, setShowEtherMenu] = useState(false);
    const [etherMenuStyle, setEtherMenuStyle] = useState<CSSProperties>({});
    const [contextMenuStyle, setContextMenuStyle] = useState<CSSProperties>({});
    const [approvalMenuStyle, setApprovalMenuStyle] = useState<CSSProperties>({});
    const [showApprovalMenu, setShowApprovalMenu] = useState(false);
    const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask');
    const [autoApprovalSettings, setAutoApprovalSettings] = useState<AutoApprovalSettings>({});
    const [currentModel, setCurrentModel] = useState(propCurrentModel ?? DEFAULT_MODEL);
    const [modelProviders, setModelProviders] = useState<ModelAccessProvider[]>([]);
    const [agentDraftEnabled, setAgentDraftEnabled] = useState(false);
    const [dragActive, setDragActive] = useState(false);

    const [contextFiles, setContextFiles] = useState<ContextFilePayload[]>([]);
    const contextFilesRef = useRef<ContextFilePayload[]>([]);
    const [showFileMenu, setShowFileMenu] = useState(false);
    const [showCommandMenu, setShowCommandMenu] = useState(false);
    const [filteredCommands, setFilteredCommands] = useState(DEFAULT_COMMANDS);
    const [availableCommands] = useState(DEFAULT_COMMANDS);
    const { postMessage, onMessage } = useVSCodeApi();

    const clearEtherCloseTimer = useCallback(() => {
        if (!etherCloseTimerRef.current) return;
        clearTimeout(etherCloseTimerRef.current);
        etherCloseTimerRef.current = null;
    }, []);

    const openEtherDetails = useCallback(() => {
        clearEtherCloseTimer();
        setShowEtherMenu(true);
        setShowContextMenu(false);
        setShowApprovalMenu(false);
        setShowModelMenu(false);
        setShowUsageMenu(false);
    }, [clearEtherCloseTimer]);

    const scheduleEtherDetailsClose = useCallback(() => {
        clearEtherCloseTimer();
        etherCloseTimerRef.current = setTimeout(() => {
            setShowEtherMenu(false);
            etherCloseTimerRef.current = null;
        }, 140);
    }, [clearEtherCloseTimer]);

    useEffect(() => {
        return () => clearEtherCloseTimer();
    }, [clearEtherCloseTimer]);

    useEffect(() => {
        contextFilesRef.current = contextFiles;
    }, [contextFiles]);

    useEffect(() => {
        const transcript = lastTranscript?.text.trim();
        if (!transcript) return;
        const separator = value && !/\s$/.test(value) ? ' ' : '';
        onChange(`${value}${separator}${transcript}`);
        resetTranscript();
        textareaRef.current?.focus();
    }, [lastTranscript, onChange, resetTranscript, value]);

    useEffect(() => {
        return () => {
            contextFilesRef.current.forEach(revokeAttachmentPreview);
        };
    }, []);

    const updateToolbarPopoverPositions = useCallback(() => {
        if (typeof window === 'undefined') return;
        const viewport = {
            width: window.innerWidth || 0,
            height: window.innerHeight || 0,
        };
        const contextRect = contextButtonRef.current?.getBoundingClientRect();
        if (showContextMenu && contextRect) {
            const size = contextPopoverRef.current?.getBoundingClientRect();
            setContextMenuStyle(computeToolbarPopoverPosition(contextRect, viewport, {
                width: 256,
                height: size?.height || 222,
                minWidth: 240,
                align: 'start',
            }));
        }
        const approvalRect = approvalButtonRef.current?.getBoundingClientRect();
        if (showApprovalMenu && approvalRect) {
            const size = approvalPopoverRef.current?.getBoundingClientRect();
            setApprovalMenuStyle(computeToolbarPopoverPosition(approvalRect, viewport, {
                width: 288,
                height: size?.height || 226,
                minWidth: 260,
                align: 'start',
            }));
        }
        const etherRect = etherButtonRef.current?.getBoundingClientRect();
        if (showEtherMenu && etherRect) {
            const size = etherPopoverRef.current?.getBoundingClientRect();
            setEtherMenuStyle(computeEtherMenuPosition(etherRect, viewport, {
                width: 226,
                height: size?.height || 44,
            }));
        }
    }, [showApprovalMenu, showContextMenu, showEtherMenu]);

    useEffect(() => {
        if ((!showContextMenu && !showApprovalMenu && !showEtherMenu) || typeof window === 'undefined') return;

        updateToolbarPopoverPositions();
        window.addEventListener('resize', updateToolbarPopoverPositions);
        window.addEventListener('scroll', updateToolbarPopoverPositions, true);
        return () => {
            window.removeEventListener('resize', updateToolbarPopoverPositions);
            window.removeEventListener('scroll', updateToolbarPopoverPositions, true);
        };
    }, [showApprovalMenu, showContextMenu, showEtherMenu, updateToolbarPopoverPositions]);

    useEffect(() => {
        if (!showContextMenu && !showApprovalMenu) return;

        const handleKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                setShowContextMenu(false);
                setShowApprovalMenu(false);
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [showApprovalMenu, showContextMenu]);

    useEffect(() => {
        if (!showEtherMenu) return;

        const handlePointerDown = (event: globalThis.MouseEvent) => {
            const target = event.target as Node | null;
            if (target && (
                etherMenuRef.current?.contains(target) ||
                etherButtonRef.current?.contains(target) ||
                etherPopoverRef.current?.contains(target)
            )) return;
            setShowEtherMenu(false);
        };
        const handleKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') setShowEtherMenu(false);
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [showEtherMenu]);

    const closeAllMenus = () => {
        setShowModelMenu(false);
        setShowContextMenu(false);
        setShowUsageMenu(false);
        setShowEtherMenu(false);
        setShowApprovalMenu(false);
        setShowFileMenu(false);
        setShowCommandMenu(false);
    };

    useEffect(() => {
        if (
            propCurrentModel?.id !== currentModel.id ||
            propCurrentModel?.provider !== currentModel.provider ||
            propCurrentModel?.name !== currentModel.name ||
            propCurrentModel?.mayTrainOnYourPrompts !== currentModel.mayTrainOnYourPrompts ||
            propCurrentModel?.credentialMode !== currentModel.credentialMode
        ) {
            setCurrentModel(propCurrentModel ?? DEFAULT_MODEL);
        }
    }, [propCurrentModel, currentModel.credentialMode, currentModel.id, currentModel.mayTrainOnYourPrompts, currentModel.name, currentModel.provider]);

    useEffect(() => {
        postMessage({ type: 'get_models' });
        postMessage({ type: 'get_settings' });
    }, [postMessage]);

    useEffect(() => {
        const unsubscribe = onMessage((msg: any) => {
            if (msg.type === 'settings_loaded') {
                const settings = msg.payload;
                if (settings?.provider && settings?.model) {
                    const nextModel = { id: settings.model, name: settings.model, provider: settings.provider };
                    setCurrentModel(nextModel);
                    onModelChange(nextModel);
                    postMessage({ type: 'get_models' });
                }
                setAutoApprovalSettings(settings?.auto_approval || {});
                setApprovalMode(approvalModeFromSettings(settings?.auto_approval));
            }
            if (msg.type === 'models') {
                const providers = (msg.payload?.providers || []) as ModelAccessProvider[];
                setModelProviders(providers);
                const bestModel = () => {
                    const selected = selectBestModel(providers, currentModel.id ? currentModel : null, grikAccount);
                    return selected ? selectedModelFromAccess(selected) : null;
                };
                if (currentModel.id && currentModel.provider) {
                    const provider = providers.find((p: any) => p.id === currentModel.provider);
                    const model = provider?.models?.find((m: any) => m.id === currentModel.id);
                    const currentAccess = deriveModelAccess(provider, model, grikAccount);
                    if (model && currentAccess.sendable) {
                        const nextModel = { ...currentModel, name: model.name, mayTrainOnYourPrompts: model.mayTrainOnYourPrompts === true, credentialMode: model.credentialMode };
                        setCurrentModel(nextModel);
                        onModelChange(nextModel);
                    } else {
                        const nextModel = bestModel();
                        if (nextModel) {
                            setCurrentModel(nextModel);
                            onModelChange(nextModel);
                            if (nextModel.provider !== currentModel.provider || nextModel.id !== currentModel.id) {
                                postMessage({ type: 'save_settings', payload: { provider: nextModel.provider, model: nextModel.id } });
                            }
                        }
                    }
                } else if (currentModel.id === '') {
                    const nextModel = bestModel();
                    if (nextModel) {
                        setCurrentModel(nextModel);
                        onModelChange(nextModel);
                        postMessage({ type: 'save_settings', payload: { provider: nextModel.provider, model: nextModel.id } });
                    }
                }
            }
            if (msg.type === 'attachments_staged') {
                const ready = new Map<string, ContextFilePayload>();
                const errors = new Map<string, string>();
                (msg.payload?.attachments || []).forEach((file: any) => {
                    if (!file?.id) return;
                    ready.set(String(file.id), {
                        id: String(file.id),
                        path: String(file.path || file.stagedPath || ''),
                        stagedPath: String(file.stagedPath || file.path || ''),
                        name: file.name ? String(file.name) : undefined,
                        kind: 'attachment',
                        source: 'attachment',
                        status: 'ready',
                        size: typeof file.size === 'number' ? file.size : undefined,
                        mime: file.mime ? String(file.mime) : undefined,
                    });
                });
                (msg.payload?.errors || []).forEach((error: any) => {
                    if (error?.id) errors.set(String(error.id), String(error.error || 'Failed to stage attachment'));
                });
                if (ready.size === 0 && errors.size === 0) return;
                setContextFiles(prev => prev.map(file => {
                    if (!file.id || file.source !== 'attachment') return file;
                    const staged = ready.get(file.id);
                    if (staged) return { ...file, ...staged, previewUrl: file.previewUrl };
                    const error = errors.get(file.id);
                    if (error) return { ...file, status: 'error', error };
                    return file;
                }));
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage, currentModel, grikAccount, onModelChange, postMessage]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
        }
    }, [value]);

    const MENTION_REGEX = /@([\w\-\.\/]*)$/;

    const handleInputChange = (newValue: string) => {
        onChange(newValue);
        if (newValue.startsWith('/')) {
            const query = newValue.substring(1).toLowerCase();
            const matches = availableCommands.filter(c => c.command.startsWith('/' + query));
            if (matches.length > 0) {
                setFilteredCommands(matches);
                setShowCommandMenu(true);
                setShowFileMenu(false);
                return;
            }
        }
        setShowCommandMenu(false);
        const match = newValue.match(MENTION_REGEX);
        if (match && searchFiles) {
            searchFiles(match[1]);
            setShowFileMenu(true);
        } else {
            setShowFileMenu(false);
        }
    };

    const activeAttachmentCount = contextFiles.filter(file => file.status !== 'error').length;

    const addContextFile = (file: FileSearchResult) => {
        const match = value.match(MENTION_REGEX);
        if (match) {
            const matchIndex = match.index!;
            onChange(value.substring(0, matchIndex) + value.substring(matchIndex + match[0].length));
        }
        if (activeAttachmentCount >= MAX_CHAT_ATTACHMENTS) {
            setContextFiles(prev => [...prev, {
                id: `limit-${Date.now()}`,
                path: file.path,
                name: file.name || file.path,
                kind: 'file',
                source: 'workspace',
                status: 'error',
                error: attachmentLimitError(1, activeAttachmentCount) || 'Attachment limit reached.',
            }]);
            setShowFileMenu(false);
            textareaRef.current?.focus();
            return;
        }
        if (!contextFiles.find(f => f.path === file.path)) {
            setContextFiles(prev => [...prev, {
                path: file.path,
                name: file.name,
                kind: 'file',
                source: 'workspace',
                status: 'ready',
                size: (file as any).size,
            }]);
        }
        setShowFileMenu(false);
        textareaRef.current?.focus();
    };

    const readFileAsBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
        reader.readAsDataURL(file);
    });

    const stageFiles = async (files: File[]) => {
        if (!files.length) return;
        closeAllMenus();
        const limitError = attachmentLimitError(files.length, activeAttachmentCount);
        const requestId = `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const accepted: { id: string; file: File }[] = [];
        const rejected: ContextFilePayload[] = [];

        files.forEach((file, index) => {
            const id = `${requestId}-${index}`;
            const sizeError = attachmentSizeError(file.size);
            if (limitError || sizeError) {
                rejected.push({
                    id,
                    requestId,
                    path: file.name || `attachment-${index + 1}`,
                    name: file.name || `attachment-${index + 1}`,
                    kind: 'attachment',
                    source: 'attachment',
                    status: 'error',
                    size: file.size,
                    mime: file.type || undefined,
                    error: limitError || sizeError || 'Attachment rejected.',
                });
                return;
            }
            accepted.push({ id, file });
        });

        if (rejected.length > 0) {
            setContextFiles(prev => [...prev, ...rejected]);
        }

        if (accepted.length === 0) {
            textareaRef.current?.focus();
            return;
        }

        const placeholders: ContextFilePayload[] = accepted.map(({ id, file }) => ({
            id,
            requestId,
            path: `staging://${id}`,
            name: file.name || 'attachment',
            kind: 'attachment',
            source: 'attachment',
            status: 'staging',
            size: file.size,
            mime: file.type || undefined,
            previewUrl: createAttachmentPreviewUrl(file),
        }));
        setContextFiles(prev => [...prev, ...placeholders]);

        try {
            const payloadFiles = await Promise.all(accepted.map(async ({ id, file }) => ({
                id,
                name: file.name || 'attachment',
                size: file.size,
                mime: file.type || '',
                data: await readFileAsBase64(file),
            })));
            postMessage({
                type: 'stage_attachments',
                payload: {
                    request_id: requestId,
                    session_id: sessionId || 'default',
                    files: payloadFiles,
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setContextFiles(prev => prev.map(file => file.requestId === requestId && file.status === 'staging'
                ? { ...file, status: 'error', error: message }
                : file
            ));
        } finally {
            textareaRef.current?.focus();
        }
    };

    const stageFileList = (files?: FileList | File[] | null) => {
        const nextFiles = Array.from(files || []);
        if (nextFiles.length === 0) return;
        void stageFiles(nextFiles);
    };

    const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length === 0) return;
        e.preventDefault();
        stageFileList(files);
    };

    const handleDrop = (e: DragEvent<HTMLDivElement>) => {
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length === 0) return;
        e.preventDefault();
        setDragActive(false);
        stageFileList(files);
    };

    const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
        if (Array.from(e.dataTransfer?.items || []).some(item => item.kind === 'file')) {
            e.preventDefault();
            setDragActive(true);
        }
    };

    const handleDragLeave = () => {
        setDragActive(false);
    };

    const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        stageFileList(e.target.files);
        e.target.value = '';
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            if (showCommandMenu && filteredCommands.length > 0) {
                e.preventDefault();
                onChange(filteredCommands[0].command);
                setShowCommandMenu(false);
                return;
            }
            if (showFileMenu && fileResults?.length > 0) {
                e.preventDefault();
                addContextFile(fileResults[0]);
                return;
            }
            e.preventDefault();
            handleSend();
        }
    };

    const buildMessageToSend = () => {
        return buildContextMessage(value, contextFiles);
    };

    const clearAttachments = () => {
        setContextFiles(prev => {
            prev.forEach(revokeAttachmentPreview);
            return [];
        });
    };

    const removeContextFile = (index: number) => {
        setContextFiles(prev => {
            const removed = prev[index];
            revokeAttachmentPreview(removed);
            return prev.filter((_, idx) => idx !== index);
        });
    };

    const sendableContextFiles = contextFiles.filter(isReadyContextFile);
    const modelCatalogLoaded = modelProviders.length > 0;
    const { provider: selectedModelProvider, model: selectedModelInfo } = findModelProvider(modelProviders, currentModel);
    const selectedModelAccess = deriveModelAccess(selectedModelProvider, selectedModelInfo, grikAccount);
    const showModelAccessWarning = modelCatalogLoaded && currentModel.id !== '' && !selectedModelAccess.sendable;
    const hasDraftContent = Boolean(value.trim() || sendableContextFiles.length > 0);
    const canSubmit = hasDraftContent && selectedModelAccess.sendable;

    const openModelAccessAction = () => {
        if (selectedModelAccess.action === 'account') {
            onOpenAccount?.();
            return;
        }
        if (selectedModelAccess.action === 'settings') {
            onOpenSettings?.(settingsTabForModelAccess(selectedModelAccess));
        }
    };

    const handleSend = () => {
        if (!isLoading && hasDraftContent && !selectedModelAccess.sendable) {
            openModelAccessAction();
            return;
        }
        if (!isLoading && canSubmit) {
            const messageToSend = buildMessageToSend();
            onSend(messageToSend, sendableContextFiles);
            clearAttachments();
            setAgentDraftEnabled(false);
        }
    };

    const handleStartAgent = () => {
        if (!isLoading && hasDraftContent && !selectedModelAccess.sendable) {
            openModelAccessAction();
            return;
        }
        if (!isLoading && canSubmit && onStartAgent) {
            const messageToSend = buildMessageToSend();
            onStartAgent(messageToSend, sendableContextFiles);
            clearAttachments();
            setAgentDraftEnabled(false);
            closeAllMenus();
        }
    };

    const handlePrepareAgent = () => {
        setAgentDraftEnabled(true);
        closeAllMenus();
        textareaRef.current?.focus();
    };

    const handleApprovalModeChange = (mode: ApprovalMode) => {
        setShowApprovalMenu(false);
        postMessage({ type: 'auto_approve_settings', payload: buildApprovalPresetPayload(mode, autoApprovalSettings) });
    };

    const selectedApproval = APPROVAL_OPTIONS.find(option => option.id === approvalMode) ?? APPROVAL_OPTIONS[0];
    const SelectedApprovalIcon = selectedApproval.icon;

    const handleRequestContext = () => {
        setShowContextMenu(false);
        const nextValue = value.endsWith('@') ? value : `${value}${value && !value.endsWith(' ') ? ' ' : ''}@`;
        onChange(nextValue);
        searchFiles?.('');
        setShowFileMenu(true);
        textareaRef.current?.focus();
    };

    const choiceOptions = (pendingChoice?.choices || []).map((choice, index) => {
        const metadata = pendingChoice?.choiceMetadata?.find(item => item.value === choice) || pendingChoice?.choiceMetadata?.[index];
        return normalizeChoiceOption(choice, index, metadata);
    });
    const connectedVia = String(liveStatus?.connectedVia || '');
    const connectedPlatforms = new Set(connectedVia.split('+').map(item => item.trim()).filter(Boolean));
    const telegramStatus = liveStatus?.channels?.telegram;
    const discordStatus = liveStatus?.channels?.discord;
    const etherAdapters = [
        {
            key: 'telegram' as const,
            label: etherAdapterDisplayName('telegram', telegramStatus?.label),
            Icon: TelegramIcon,
            brandClass: 'text-sky-400',
            configured: Boolean(telegramStatus?.configured || connectedPlatforms.has('telegram')),
            active: Boolean(telegramStatus?.active || (isLiveMode && connectedPlatforms.has('telegram'))),
            error: telegramStatus?.error,
        },
        {
            key: 'discord' as const,
            label: etherAdapterDisplayName('discord', discordStatus?.label),
            Icon: DiscordIcon,
            brandClass: 'text-indigo-300',
            configured: Boolean(discordStatus?.configured || connectedPlatforms.has('discord')),
            active: Boolean(discordStatus?.active || (isLiveMode && connectedPlatforms.has('discord'))),
            error: discordStatus?.error,
        },
    ];
    const hasConfiguredEtherAdapter = etherAdapters.some(adapter => adapter.configured);
    const hasEtherChannelError = etherAdapters.some(adapter => Boolean(adapter.error));
    const audioErrorMessage = audioError?.message || '';
    const audioErrorOpensSettings = audioError?.phase === 'setup' || Boolean(audioErrorMessage && /whisper|voice input requires|settings/i.test(audioErrorMessage));
    const audioErrorOpensMicrophonePermissions = audioError?.phase === 'permission';
    const showMicRetry = Boolean(audioError && audioError.retryable === true && audioError.phase === 'transcription');
    const micStatusTitle = isRecording
        ? 'Recording. Click to stop.'
        : isRequesting
            ? 'Waiting for microphone permission.'
            : isTranscribing
                ? 'Transcribing voice input.'
                : audioErrorMessage
                    ? audioErrorOpensSettings
                        ? `${audioErrorMessage} Open Integrations to configure voice input.`
                        : audioErrorOpensMicrophonePermissions
                            ? `${audioErrorMessage} Open microphone permission settings.`
                        : `${audioErrorMessage} Click the microphone to try again.`
                    : 'Record voice input';
    const micErrorTitle = audioErrorMessage
        ? `${audioErrorMessage}${audioErrorOpensSettings ? ' Open Integrations to configure voice input.' : audioErrorOpensMicrophonePermissions ? ' Open microphone permission settings.' : showMicRetry ? ' Click to retry recording.' : ''}`
        : 'Retry voice input';
    const micButtonAriaLabel = isRecording
        ? 'Recording. Click to stop.'
        : isRequesting
            ? 'Waiting for microphone permission'
            : isTranscribing
                ? 'Transcribing voice input'
            : 'Record voice input';
    const micStatusText = isRecording
        ? 'Recording microphone audio'
        : isRequesting
            ? 'Waiting for microphone permission'
            : isTranscribing
                ? 'Transcribing voice input'
                : audioErrorMessage
                    ? audioErrorOpensSettings
                        ? 'Voice input setup is required: ffmpeg, Whisper binary, and Whisper model.'
                        : audioErrorMessage
                    : '';
    const micStatusActionLabel = audioErrorOpensSettings
        ? 'Voice input settings'
        : audioErrorOpensMicrophonePermissions
            ? 'Microphone permissions'
            : showMicRetry
                ? 'Retry'
                : '';
    const micStatusBannerClass = audioError
        ? 'border-amber-400/25 bg-amber-400/10 text-amber-100/85'
        : isRecording
            ? 'border-red-400/25 bg-red-500/10 text-red-100/85'
            : 'border-vscode-border bg-vscode-editor-background text-vscode-fg/70';
    const showMicStatusBanner = Boolean(micStatusText);
    const handleMicButtonClick = () => {
        clearEtherCloseTimer();
        setShowEtherMenu(false);
        setShowContextMenu(false);
        setShowApprovalMenu(false);
        setShowModelMenu(false);
        setShowUsageMenu(false);
        toggleRecording();
    };
    const handleMicErrorAction = () => {
        clearEtherCloseTimer();
        setShowEtherMenu(false);
        if (audioErrorOpensSettings) {
            onOpenSettings?.('integrations');
            return;
        }
        if (audioErrorOpensMicrophonePermissions) {
            postMessage({ type: 'open_microphone_permissions' });
            return;
        }
        if (showMicRetry) {
            toggleRecording();
        }
    };
    const showRemoteStartChip = hasConfiguredEtherAdapter && liveStatus?.allowRemoteSessionStart === false;
    const handleEtherToggleClick = () => {
        setShowEtherMenu(false);
        setShowContextMenu(false);
        setShowApprovalMenu(false);
        setShowModelMenu(false);
        setShowUsageMenu(false);
        if (!hasConfiguredEtherAdapter) {
            onOpenSettings?.('integrations');
            return;
        }
        if (!isLiveModeLoading) {
            onToggleLiveMode?.();
        }
    };
    const handleEtherAdapterClick = (adapter: typeof etherAdapters[number]) => {
        if (!adapter.configured) {
            setShowEtherMenu(false);
            onOpenSettings?.('integrations');
            return;
        }
        if (adapter.error) {
            onOpenSettings?.('integrations');
            setShowEtherMenu(false);
        }
    };
    const etherMenu = showEtherMenu ? (
        <div
            ref={etherPopoverRef}
            className="fixed z-[2147483647] flex w-max items-center gap-1 overflow-y-auto rounded-md border border-vscode-border bg-vscode-input-bg p-1 shadow-2xl animate-in fade-in slide-in-from-bottom-2"
            style={etherMenuStyle}
            role="dialog"
            aria-label="Ether channels"
            onMouseEnter={openEtherDetails}
            onMouseLeave={scheduleEtherDetailsClose}
        >
            {etherAdapters.map(adapter => {
                const Icon = adapter.Icon;
                const statusLabel = etherAdapterStatusLabel(adapter);
                const adapterTitle = adapter.configured
                    ? `${adapter.label}: ${adapter.error || statusLabel}. Telegram and Discord can be active at the same time.`
                    : `${adapter.label}: not configured. Open Integrations to receive sent messages.`;
                return (
                    <button
                        key={adapter.key}
                        type="button"
                        onClick={() => handleEtherAdapterClick(adapter)}
                        title={adapterTitle}
                        aria-label={adapterTitle}
                        className={etherAdapterButtonClass(adapter)}
                    >
                        <Icon className={`h-4 w-4 shrink-0 ${adapter.configured ? adapter.brandClass : ''}`} />
                        <span className="min-w-0 flex items-center gap-1 leading-none">
                            <span className="block truncate text-[11px] font-medium">{adapter.label}</span>
                            <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${etherAdapterStatusDotClass(adapter)}`}
                                aria-hidden="true"
                            />
                        </span>
                    </button>
                );
            })}
            <button
                type="button"
                onClick={() => {
                    setShowEtherMenu(false);
                    onOpenSettings?.('integrations');
                }}
                title="Open Integrations"
                aria-label="Open Integrations"
                className="flex h-8 w-8 items-center justify-center rounded-md border border-transparent bg-transparent text-vscode-fg/55 transition-colors hover:bg-vscode-list-hoverBackground hover:text-vscode-fg"
            >
                <Settings className="h-4 w-4" />
            </button>
        </div>
    ) : null;
    const contextMenu = showContextMenu ? (
        <div
            ref={contextPopoverRef}
            className="fixed z-[2147483647] w-64 overflow-hidden rounded-md border border-vscode-border bg-vscode-input-bg shadow-2xl animate-in fade-in zoom-in-95"
            style={contextMenuStyle}
            role="dialog"
            aria-label="Insert context"
        >
            <button
                onClick={handleRequestContext}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-vscode-list-hoverBackground transition-colors"
            >
                <FileCode className="mt-0.5 h-4 w-4 text-vscode-fg/55" />
                <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-vscode-fg/85">Add workspace files</span>
                    <span className="block text-[10px] text-vscode-fg/45">Attach indexed project files to this turn.</span>
                </span>
            </button>
            <button
                onClick={() => {
                    setShowContextMenu(false);
                    fileInputRef.current?.click();
                }}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-vscode-list-hoverBackground transition-colors"
            >
                <Paperclip className="mt-0.5 h-4 w-4 text-vscode-fg/55" />
                <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-vscode-fg/85">Attach local files</span>
                    <span className="block text-[10px] text-vscode-fg/45">Paste, drop, or choose files for this turn.</span>
                </span>
            </button>
            <button
                onClick={handlePrepareAgent}
                disabled={isLoading}
                className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
                    agentDraftEnabled ? 'bg-vscode-list-hoverBackground' : 'hover:bg-vscode-list-hoverBackground'
                }`}
            >
                <Bot className={`mt-0.5 h-4 w-4 ${agentDraftEnabled ? 'text-vscode-button-bg' : 'text-vscode-fg/55'}`} />
                <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-vscode-fg/85">Prepare agent mission</span>
                    <span className="block text-[10px] text-vscode-fg/45">Show confirmation before autonomous launch.</span>
                </span>
                {agentDraftEnabled && <CheckCircle2 className="mt-0.5 ml-auto h-4 w-4 text-vscode-button-bg" />}
            </button>
            <div className="mx-3 border-t border-vscode-border/70" />
            <button
                onClick={() => onModeChange(planFirstToggle.nextMode)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-vscode-list-hoverBackground transition-colors"
                title="Plan first: read and reason before edits or commands"
            >
                <CheckCircle2 className={`h-4 w-4 ${planFirstToggle.active ? 'text-vscode-button-bg' : 'text-vscode-fg/45'}`} />
                <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium text-vscode-fg/85">Plan first</span>
                    <span className="block text-[10px] text-vscode-fg/45">Ask the agent to reason before edits or commands.</span>
                </span>
                <span className={`relative h-5 w-9 rounded-full transition-colors ${planFirstToggle.active ? 'bg-vscode-button-bg' : 'bg-vscode-border'}`}>
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${planFirstToggle.active ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                </span>
            </button>
        </div>
    ) : null;
    const approvalMenu = showApprovalMenu ? (
        <div
            ref={approvalPopoverRef}
            className="fixed z-[2147483647] w-72 overflow-hidden rounded-md border border-vscode-border bg-vscode-input-bg shadow-2xl animate-in fade-in zoom-in-95"
            style={approvalMenuStyle}
            role="dialog"
            aria-label="Approval policy"
        >
            <div className="px-3 py-2 border-b border-vscode-border bg-vscode-editor-background text-[10px] font-medium text-vscode-fg/55">Approval policy</div>
            {APPROVAL_OPTIONS.map(option => {
                const Icon = option.icon;
                const isSelected = option.id === approvalMode;
                return (
                    <button
                        key={option.id}
                        onClick={() => handleApprovalModeChange(option.id)}
                        className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-vscode-list-hoverBackground transition-colors"
                    >
                        <Icon className={`mt-0.5 h-4 w-4 ${isSelected ? 'text-vscode-button-bg' : 'text-vscode-fg/45'}`} />
                        <span className="min-w-0 flex-1">
                            <span className="block text-[12px] font-medium text-vscode-fg/85">{option.label}</span>
                            <span className="block text-[10px] text-vscode-fg/45">{option.description}</span>
                        </span>
                        {isSelected && <CheckCircle2 className="mt-0.5 h-4 w-4 text-vscode-button-bg" />}
                    </button>
                );
            })}
        </div>
    ) : null;
    const allowRemoteSessionStart = () => {
        postMessage({ type: 'set_remote_session_start', payload: { enabled: true } });
    };

    return (
        <div ref={rootRef} className="w-full relative">
            {(showModelMenu || showContextMenu || showApprovalMenu || showCommandMenu || showFileMenu) && (
                <div className="fixed inset-0 z-[9998]" onClick={closeAllMenus} />
            )}

            {showModelMenu && (
                <ModelPickerModal
                    isOpen={showModelMenu}
                    onClose={() => setShowModelMenu(false)}
                    currentModel={currentModel}
                    anchorRef={modelButtonRef}
                    containerRef={rootRef}
                    grikAccount={grikAccount}
                    onOpenAccount={onOpenAccount}
                    onOpenSettings={onOpenSettings}
                    onSelectModel={(model) => {
                        setCurrentModel(model);
                        onModelChange(model);
                        setShowModelMenu(false);
                        postMessage({ type: 'save_settings', payload: { provider: model.provider, model: model.id } });
                    }}
                />
            )}
            {contextMenu && (typeof document !== 'undefined' ? createPortal(contextMenu, document.body) : contextMenu)}
            {approvalMenu && (typeof document !== 'undefined' ? createPortal(approvalMenu, document.body) : approvalMenu)}

            {/* Chips Container */}
            {(contextFiles.length > 0 || agentDraftEnabled) && (
                <div className="flex gap-2 px-1 py-2 overflow-x-auto custom-scrollbar no-scrollbar scroll-smooth">
                    {agentDraftEnabled && (
                        <div className="flex items-center gap-2 px-2.5 py-1 bg-vscode-button-bg text-vscode-button-fg rounded-md text-[11px] border border-vscode-button-bg shrink-0">
                            <Bot className="h-3.5 w-3.5" />
                            <span className="font-medium">Agent mission prepared</span>
                            <button
                                onClick={() => setAgentDraftEnabled(false)}
                                className="ml-1 rounded p-0.5 opacity-75 hover:opacity-100 hover:bg-black/15 transition-colors"
                                title="Cancel agent mission"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    )}
                    {contextFiles.map((file, i) => {
                        const status = file.status || 'ready';
                        const errored = status === 'error';
                        const staging = status === 'staging';
                        const imageAttachment = isImageContextFile(file);
                        const displayName = attachmentDisplayName(file);
                        const metaLabel = attachmentMetaLabel(file);
                        const contentWarning = attachmentContentWarning(file);
                        const statusLabel = attachmentStatusBadgeLabel(file);
                        const statusTitle = file.error || attachmentStatusTitle(file);
                        const fileKind = attachmentFileKind(file);
                        const AttachmentIcon = fileKind === 'image'
                            ? ImageIcon
                            : fileKind === 'text' || fileKind === 'csv' || fileKind === 'pdf'
                                ? FileText
                                : file.source === 'attachment'
                                    ? Paperclip
                                    : FileCode;
                        return (
                        <div
                            key={`ctx-${file.path}-${i}`}
                            title={[displayName, statusTitle, contentWarning, file.stagedPath || file.path].filter(Boolean).join('\n')}
                            className={`group flex h-11 min-w-[190px] max-w-[250px] shrink-0 items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
                                errored
                                    ? 'bg-rose-500/10 text-rose-300/85 border-rose-500/25'
                                    : staging
                                        ? 'bg-vscode-input-bg text-vscode-fg/45 border-vscode-border'
                                        : 'bg-vscode-input-bg text-vscode-fg/70 border-vscode-border hover:bg-vscode-list-hoverBackground hover:text-vscode-fg'
                            }`}
                        >
                            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-vscode-editor-background text-vscode-fg/45">
                                {imageAttachment && file.previewUrl ? (
                                    <img
                                        src={file.previewUrl}
                                        alt={displayName}
                                        className="h-full w-full object-cover"
                                    />
                                ) : staging ? (
                                    <span className="codicon codicon-loading codicon-modifier-spin text-[13px]" />
                                ) : (
                                    <AttachmentIcon className={`h-4 w-4 ${errored ? 'text-rose-300/70' : ''}`} />
                                )}
                                {staging && imageAttachment && file.previewUrl && (
                                    <span className="absolute inset-0 flex items-center justify-center bg-vscode-editor-background/70">
                                        <span className="codicon codicon-loading codicon-modifier-spin text-[13px] text-vscode-fg/55" />
                                    </span>
                                )}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{displayName}</span>
                                <span className={`block truncate text-[10px] ${errored ? 'text-rose-300/70' : 'text-vscode-fg/40'}`}>{metaLabel}</span>
                            </span>
                            <span
                                className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${
                                    errored
                                        ? 'bg-rose-500/12 text-rose-300/80'
                                        : attachmentIngestionStatus(file) === 'included_text'
                                            ? 'bg-emerald-500/10 text-emerald-300/80'
                                            : 'bg-vscode-editor-background text-vscode-fg/45'
                                }`}
                            >
                                {statusLabel}
                            </span>
                            <button
                                onClick={() => removeContextFile(i)}
                                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-vscode-list-hoverBackground group-hover:opacity-100"
                                title="Remove attachment"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    );})}
                </div>
            )}

            {recentlyEditedFiles && recentlyEditedFiles.length > 0 && (
                <div className="px-1">
                    <AffectedFilesList files={recentlyEditedFiles as any} />
                </div>
            )}

            {pendingChoice && choiceOptions.length > 0 && (
                <div className="mb-2 rounded-md border border-vscode-border bg-vscode-input-bg animate-in fade-in slide-in-from-bottom-1">
                    <div className="flex items-center justify-between gap-3 border-b border-vscode-border px-3 py-2">
                        <div className="min-w-0">
                            <div className="text-[11px] font-medium text-vscode-fg/80">Choose next step</div>
                            <div className="truncate text-[10px] text-vscode-fg/45">{pendingChoice.question}</div>
                        </div>
                    </div>
                    <div className="grid gap-1 p-2">
                        {choiceOptions.map((option, index) => (
                            <button
                                key={`${pendingChoice.id}-${option.value}`}
                                onClick={() => onChoiceResponse?.(pendingChoice.id, option.value)}
                                className={`group flex items-start gap-2 rounded border px-2.5 py-2 text-left transition-colors ${
                                    option.danger
                                        ? 'border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/10'
                                        : option.recommended
                                            ? 'border-vscode-button-bg/35 bg-vscode-button-bg/10 hover:bg-vscode-button-bg/15'
                                            : 'border-vscode-border bg-vscode-editor-background hover:bg-vscode-list-hoverBackground'
                                }`}
                            >
                                <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-medium ${
                                    option.recommended
                                        ? 'bg-vscode-button-bg text-vscode-button-fg'
                                        : 'bg-vscode-input-bg text-vscode-fg/55 border border-vscode-border'
                                }`}>
                                    {index + 1}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5 text-[12px] font-medium text-vscode-fg/85">
                                        {option.label}
                                        {option.recommended && <span className="text-[9px] text-vscode-fg/45">Recommended</span>}
                                    </span>
                                    <span className="mt-0.5 block text-[10px] leading-relaxed text-vscode-fg/50">{option.description}</span>
                                </span>
                                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vscode-fg/35" />
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {hasInputStatusStrip && (
                <div className="flex flex-wrap items-center justify-between gap-1.5 px-1 pb-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                        {missionStatus}
                    </div>
                    <div className="ml-auto flex items-center justify-end gap-1.5">
                        {accountStatus}
                        {networkStatus && <NetworkStatusPill status={networkStatus} />}
                        {hasUsageStatus && (
                            <UsageBadge
                                contextStatus={contextStatus}
                                usageSnapshot={usageSnapshot}
                                isActive={isLoading || isRemoteProcessing}
                                isOpen={showUsageMenu}
                                onToggle={() => {
                                    setShowUsageMenu(prev => !prev);
                                    setShowContextMenu(false);
                                    setShowApprovalMenu(false);
                                    setShowModelMenu(false);
                                    setShowEtherMenu(false);
                                }}
                                onClose={() => setShowUsageMenu(false)}
                            />
                        )}
                    </div>
                </div>
            )}

            {showRemoteStartChip && (
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-100/85">
                    <span className="inline-flex min-w-0 items-center gap-2">
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                        <span className="truncate">Remote session start is blocked</span>
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        <button
                            type="button"
                            onClick={allowRemoteSessionStart}
                            className="rounded bg-amber-300/20 px-2 py-1 text-[10px] font-medium text-amber-100 transition-colors hover:bg-amber-300/30"
                        >
                            Allow
                        </button>
                        <button
                            type="button"
                            onClick={() => onOpenSettings?.('integrations')}
                            title="Open Integrations"
                            aria-label="Open Integrations"
                            className="rounded p-1 text-amber-100/65 transition-colors hover:bg-amber-300/15 hover:text-amber-100"
                        >
                            <Settings className="h-3.5 w-3.5" />
                        </button>
                    </span>
                </div>
            )}

            {showModelAccessWarning && (
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-vscode-border bg-vscode-editor-background px-2.5 py-2 text-[11px] text-vscode-fg/75">
                    <span className="inline-flex min-w-0 items-center gap-2">
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] ${modelAccessBadgeClass(selectedModelAccess)}`}>
                            {selectedModelAccess.label}
                        </span>
                        <span className="truncate">{selectedModelAccess.detail}</span>
                    </span>
                    {selectedModelAccess.action && (
                        <button
                            type="button"
                            onClick={openModelAccessAction}
                            className="ml-auto shrink-0 rounded border border-vscode-border px-2 py-1 text-[10px] font-medium text-vscode-fg/72 transition-colors hover:bg-vscode-list-hoverBackground hover:text-vscode-fg"
                        >
                            {selectedModelAccess.actionLabel || 'Open'}
                        </button>
                    )}
                </div>
            )}

            {showMicStatusBanner && (
                <div className={`mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-[11px] ${micStatusBannerClass}`}>
                    <span className="inline-flex min-w-0 items-center gap-2">
                        {isRecording ? <Square className="h-3.5 w-3.5 shrink-0" /> : <Mic className="h-3.5 w-3.5 shrink-0" />}
                        <span className="truncate">{micStatusText}</span>
                    </span>
                    {micStatusActionLabel && (
                        <button
                            type="button"
                            onClick={handleMicErrorAction}
                            className="ml-auto shrink-0 rounded border border-current/20 px-2 py-1 text-[10px] font-medium transition-colors hover:bg-current/10"
                            title={micErrorTitle}
                        >
                            {micStatusActionLabel}
                        </button>
                    )}
                </div>
            )}

            {/* Input Frame */}
            <div className={`
                relative flex flex-col rounded-md transition-colors duration-200 overflow-visible
                ${isLiveMode ? 'ether-active animate-ether-glow' : dragActive ? 'bg-vscode-input-bg border border-vscode-button-bg' : 'bg-vscode-input-bg border border-vscode-border'}
                hover:border-vscode-fg/25 focus-within:border-vscode-button-bg
            `}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileInputChange}
                />
                <textarea
                    ref={textareaRef}
                    value={value}
                    onChange={(e) => handleInputChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    placeholder={isRecording ? 'Listening...' : placeholder}
                    rows={1}
                    className="w-full resize-none py-3 px-3 bg-transparent text-vscode-input-fg text-sm focus:outline-none placeholder:text-vscode-fg/35 min-h-[52px] max-h-[240px]"
                />
                {dragActive && (
                    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-vscode-button-bg/10 text-[12px] font-medium text-vscode-fg/75">
                        Drop files to attach
                    </div>
                )}

                <div className="flex flex-wrap items-end gap-2 px-2.5 pb-2.5">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                        <div className="relative shrink-0">
                            <button
                                ref={contextButtonRef}
                                type="button"
                                onClick={() => {
                                    setShowContextMenu(prev => !prev);
                                    setShowApprovalMenu(false);
                                    setShowModelMenu(false);
                                    setShowUsageMenu(false);
                                    setShowEtherMenu(false);
                                }}
                                className="p-1.5 rounded text-vscode-fg/50 hover:text-vscode-fg/85 hover:bg-vscode-list-hoverBackground transition-colors"
                                title="Add context or start an agent"
                            >
                                <Plus className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="relative shrink-0">
                            <button
                                ref={approvalButtonRef}
                                type="button"
                                onClick={() => {
                                    setShowApprovalMenu(prev => !prev);
                                    setShowContextMenu(false);
                                    setShowModelMenu(false);
                                    setShowUsageMenu(false);
                                    setShowEtherMenu(false);
                                }}
                                className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-vscode-border bg-vscode-editor-background text-vscode-fg/65 hover:text-vscode-fg/90 hover:bg-vscode-list-hoverBackground transition-colors"
                                title="Approval policy"
                            >
                                <SelectedApprovalIcon className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline text-[10px] font-medium">{selectedApproval.label}</span>
                                <span className="sm:hidden text-[10px] font-medium">{approvalMode === 'ask' ? 'Ask' : approvalMode === 'auto' ? 'Auto' : 'Full'}</span>
                                <ChevronDown className="w-3 h-3 opacity-40" />
                            </button>
                        </div>

                        <button
                            ref={modelButtonRef}
                            onClick={() => {
                                setShowModelMenu(true);
                                setShowContextMenu(false);
                                setShowApprovalMenu(false);
                                setShowUsageMenu(false);
                                setShowEtherMenu(false);
                            }}
                            className="flex min-w-0 max-w-full items-center gap-2 px-2 py-1.5 rounded hover:bg-vscode-list-hoverBackground transition-colors text-vscode-fg/55 hover:text-vscode-fg/85"
                        >
                            <span className="truncate text-[10px] font-medium max-w-[min(36vw,120px)]">{currentModel.name}</span>
                            {(selectedModelAccess.state === 'anonymous_free' || !selectedModelAccess.sendable) && (
                                <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[9px] ${modelAccessBadgeClass(selectedModelAccess)}`} title={selectedModelAccess.detail}>
                                    {selectedModelAccess.label}
                                </span>
                            )}
                            {currentModel.mayTrainOnYourPrompts && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-300" title="This model may use prompts for training">
                                    <ShieldAlert className="h-3 w-3" />
                                    <span className="hidden min-[420px]:inline">May train</span>
                                </span>
                            )}
                            <ChevronDown className="w-3 h-3 shrink-0 opacity-30" />
                        </button>

                    </div>

                    <div className="ml-auto flex shrink-0 items-center gap-2">
                        <div ref={etherMenuRef} className="relative shrink-0">
                            <button
                                ref={etherButtonRef}
                                type="button"
                                onClick={handleEtherToggleClick}
                                onMouseEnter={openEtherDetails}
                                onMouseLeave={scheduleEtherDetailsClose}
                                onFocus={openEtherDetails}
                                disabled={isLiveModeLoading}
                                className={`relative p-2 rounded transition-colors disabled:cursor-wait ${
                                    isLiveMode
                                        ? 'bg-vscode-button-bg text-vscode-button-fg hover:bg-vscode-button-hover'
                                        : 'text-vscode-fg/40 hover:text-vscode-fg/75 hover:bg-vscode-list-hoverBackground'
                                } ${isLiveModeLoading ? 'opacity-70' : ''}`}
                                title={hasConfiguredEtherAdapter ? (isLiveMode ? 'Disable Ether' : 'Enable Ether') : 'Open Integrations to configure Ether'}
                                aria-label={hasConfiguredEtherAdapter ? (isLiveMode ? 'Disable Ether' : 'Enable Ether') : 'Configure Ether integrations'}
                                aria-haspopup="dialog"
                            >
                                <EtherIcon className={`w-4 h-4 ${isLiveModeLoading ? 'animate-pulse' : ''}`} />
                                <span
                                    className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${etherMainStatusDotClass(isLiveMode, hasConfiguredEtherAdapter, hasEtherChannelError)}`}
                                    aria-hidden="true"
                                />
                            </button>
                            {etherMenu && (typeof document !== 'undefined' ? createPortal(etherMenu, document.body) : etherMenu)}
                        </div>
                        <button
                            type="button"
                            onClick={handleMicButtonClick}
                            disabled={isRequesting || isTranscribing}
                            className={`relative p-2 rounded transition-colors disabled:cursor-wait disabled:opacity-65 ${
                                isRecording
                                    ? 'bg-red-500/15 text-red-400'
                                    : isRequesting || isTranscribing
                                        ? 'text-vscode-fg/55 bg-vscode-list-hoverBackground'
                                        : 'text-vscode-fg/40 hover:text-vscode-fg/75 hover:bg-vscode-list-hoverBackground'
                            }`}
                            title={micStatusTitle}
                            aria-label={micButtonAriaLabel}
                        >
                            {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                            {(isRequesting || isTranscribing) && (
                                <span
                                    className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-vscode-fg/50"
                                    aria-hidden="true"
                                />
                            )}
                        </button>
                        {audioError && (
                            <div className="group relative flex h-5 w-5 items-center justify-center">
                                <button
                                    type="button"
                                    onClick={handleMicErrorAction}
                                    className={`flex h-5 w-5 items-center justify-center rounded transition-colors ${
                                        audioErrorOpensSettings || audioErrorOpensMicrophonePermissions
                                            ? 'text-amber-200/78 hover:bg-amber-300/10 hover:text-amber-100'
                                            : showMicRetry
                                                ? 'text-vscode-fg/55 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg'
                                                : 'text-amber-200/72 hover:bg-amber-300/10 hover:text-amber-100'
                                    }`}
                                    title={micErrorTitle}
                                    aria-label={audioErrorOpensSettings ? 'Open voice input settings' : audioErrorOpensMicrophonePermissions ? 'Open microphone permission settings' : showMicRetry ? 'Retry voice input recording' : 'Voice input error details'}
                                >
                                    {showMicRetry ? (
                                        <RotateCcw className="h-3.5 w-3.5" />
                                    ) : audioErrorOpensSettings || audioErrorOpensMicrophonePermissions ? (
                                        <Settings className="h-3.5 w-3.5" />
                                    ) : (
                                        <Info className="h-3.5 w-3.5" />
                                    )}
                                </button>
                                <span className="pointer-events-none absolute right-0 top-full z-[2147483647] mt-1 hidden w-56 rounded-md border border-vscode-border bg-vscode-input-bg px-2 py-1.5 text-left text-[10px] leading-snug text-vscode-fg/75 shadow-2xl group-hover:block group-focus-within:block">
                                    {micErrorTitle}
                                </span>
                            </div>
                        )}

                        {agentDraftEnabled && !(isLoading || isRemoteProcessing) && (
                            <button
                                onClick={handleStartAgent}
                                disabled={!canSubmit}
                                className={`flex items-center gap-1.5 px-2.5 py-2 rounded text-[11px] font-medium transition-colors ${
                                    canSubmit
                                        ? 'bg-vscode-button-bg text-vscode-button-fg hover:bg-vscode-button-hover active:scale-95'
                                        : 'bg-vscode-editor-background text-vscode-fg/25 border border-vscode-border cursor-not-allowed'
                                }`}
                                title="Start autonomous agent mission"
                            >
                                <Play className="w-3.5 h-3.5" />
                                <span className="hidden sm:inline">Start mission</span>
                            </button>
                        )}

                        {isLoading || isRemoteProcessing ? (
                            <button
                                onClick={isStopping ? undefined : onCancel}
                                disabled={isStopping}
                                className={`flex items-center gap-1.5 p-2.5 rounded bg-red-600 text-white active:scale-95 ${isStopping ? 'opacity-70 cursor-wait' : 'animate-pulse'}`}
                                title={isStopping ? 'Stopping...' : 'Stop current run'}
                            >
                                <StopCircle className="w-4 h-4" />
                                {isStopping && <span className="hidden sm:inline text-[11px] font-medium">Stopping...</span>}
                            </button>
                        ) : (
                            <button onClick={handleSend} disabled={!canSubmit} className={`p-2.5 rounded transition-colors ${canSubmit ? 'bg-vscode-button-bg text-vscode-button-fg hover:bg-vscode-button-hover active:scale-95' : 'text-vscode-fg/20 bg-vscode-editor-background'}`}>
                                <Send className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Autocomplete Menus */}
            {showCommandMenu && (
                <div className="absolute bottom-full left-0 mb-2 w-full bg-vscode-input-bg border border-vscode-border rounded-md shadow-lg overflow-hidden z-[9999] animate-in fade-in slide-in-from-bottom-2">
                    <div className="px-3 py-2 border-b border-vscode-border text-[10px] font-medium text-vscode-fg/55 bg-vscode-editor-background">Commands</div>
                    <div className="max-h-60 overflow-y-auto custom-scrollbar">
                        {filteredCommands.map(cmd => (
                            <button key={cmd.command} onClick={() => { onChange(cmd.command); setShowCommandMenu(false); }} className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-vscode-list-hoverBackground transition-colors group">
                                <span className="font-mono text-sm text-vscode-link-foreground">{cmd.command}</span>
                                <span className="text-[10px] text-vscode-fg/45 font-medium">{cmd.description}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {showFileMenu && fileResults?.length > 0 && (
                <div className="absolute bottom-full left-0 mb-2 w-full bg-vscode-input-bg border border-vscode-border rounded-md shadow-lg overflow-hidden z-[9999] animate-in fade-in slide-in-from-bottom-2">
                    <div className="px-3 py-2 border-b border-vscode-border text-[10px] font-medium text-vscode-fg/55 bg-vscode-editor-background">Context files</div>
                    <div className="max-h-60 overflow-y-auto custom-scrollbar">
                        {fileResults.map(file => (
                            <button key={file.path} onClick={() => addContextFile(file)} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-vscode-list-hoverBackground transition-colors group">
                                <div className="w-7 h-7 rounded bg-vscode-editor-background flex items-center justify-center border border-vscode-border"><FileCode className="w-4 h-4 text-vscode-fg/45" /></div>
                                <div className="flex flex-col text-left">
                                    <span className="text-sm text-vscode-fg/75 group-hover:text-vscode-fg font-medium">{file.name}</span>
                                    <span className="text-[11px] text-vscode-fg/45 font-mono truncate max-w-[300px]">{file.path}</span>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
