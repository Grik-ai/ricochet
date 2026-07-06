import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
    Brain,
    CheckCircle,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Copy,
    CreditCard,
    Database,
    ExternalLink,
    Gauge,
    Github,
    Heart,
    HelpCircle,
    Info,
    Key,
    LayoutGrid,
    Linkedin,
    Loader2,
    Mail,
    Mic,
    RefreshCw,
    Search,
    Send,
    Shield,
    ShieldAlert,
    ShieldCheck,
    SlidersHorizontal,
    Terminal,
    Twitter,
    UserCircle,
    XCircle,
} from 'lucide-react';
import { RicochetLogo } from '../icons/RicochetLogo';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { MarketplaceView } from '../marketplace/MarketplaceView';
import { SkillsTab } from './SkillsTab';
import { KnowledgeTab } from './KnowledgeTab';
import { PermissionsTab } from './PermissionsTab';
import {
    deriveModelAccess,
    modelAccessBadgeClass,
    providerCredentialLabel,
    settingsTabForModelAccess,
    sortProvidersByDisplayOrder,
    type SelectedModelAccess,
} from '../chat/modelAccess';
import { useUsage } from '../../hooks/useUsage';
import { useSessions } from '../../hooks/useSessions';
import {
    budgetNumber,
    entitlementCancelAtPeriodEnd,
    entitlementCancellationEffectiveAt,
    entitlementPeriodEnd,
    formatGrikCredits,
    formatGrikDate,
    getPrimaryGrikEntitlement,
    getRicochetCreditBalance,
    isHostedSubscriptionAccess,
    type GrikAccountController,
    type GrikAccountSummary,
} from '../../hooks/useGrikAccount';
import {
    hasUsageData,
    keySourceLabel,
    mergeUsageSnapshots,
    operationLabel,
    recentUsageEvents,
    usageSourceLabel,
    type UsageScope,
} from './usageUtils';
import type { ContextCompactionEventPayload, ContextStatus } from '../../types/protocol';

interface SettingsProps {
    onClose: () => void;
    initialTab?: string;
    grikAccount?: GrikAccountController;
}

export interface ModelInfo {
    id: string;
    name: string;
    contextWindow: number;
    inputPrice: number;
    outputPrice: number;
    isFree: boolean;
    supportsTools: boolean;
    description?: string;
    recommended?: boolean;
    accessMode?: 'free' | 'byok' | 'subscription';
    keySource?: 'server' | 'user' | 'hosted' | 'none';
    credentialMode?: 'none' | 'grik_account' | 'provider_key';
    requiresSubscription?: boolean;
    billingSku?: string;
    limited?: boolean;
    deprecated?: boolean;
    apiType?: string;
    source?: string;
    launchState?: 'live' | 'soon' | string;
    ownedBy?: string;
    mayTrainOnYourPrompts?: boolean;
}

export interface CatalogStatusInfo {
    source?: 'curated' | 'live' | 'mixed' | string;
    refreshedAt?: string;
    error?: string;
}

export interface ProviderInfo {
    id: string;
    name: string;
    hasKey: boolean;
    hasUserKey?: boolean;
    keySource?: 'server' | 'user' | 'hosted' | 'none';
    accessMode?: 'free' | 'byok' | 'subscription';
    available: boolean;
    models: ModelInfo[];
    catalogStatus?: CatalogStatusInfo;
    promptTrainingModelCount?: number;
    hiddenPromptTrainingModelCount?: number;
}

interface ProviderKeyValidationResult {
    providerId?: string;
    ok: boolean;
    status: 'valid' | 'unauthorized' | 'no_key' | 'network_error' | 'unsupported' | string;
    message: string;
    checkedAt: number;
}

interface AutoApprovalSettings {
    enabled: boolean;
    read_files: boolean;
    read_files_external: boolean;
    edit_files: boolean;
    edit_files_external: boolean;
    execute_safe_commands: boolean;
    execute_all_commands: boolean;
    delete_files: boolean;
    delete_files_external: boolean;
    use_browser: boolean;
    use_mcp: boolean;
    enable_notifications: boolean;
    max_requests?: number;
    max_cost_usd?: number;
}

interface ContextSettings {
    auto_condense: boolean;
    condense_threshold: number;
    sliding_window_size: number;
    show_context_indicator: boolean;
    enable_checkpoints: boolean;
    checkpoint_on_writes: boolean;
    enable_code_index: boolean;
    workspace_index_enabled: boolean;
    workspace_index_auto_briefing: boolean;
    cloud_index_enabled: boolean;
    max_fragment_tokens: number;
    show_contributor_panel: boolean;
}

interface ModeModel {
    provider?: string;
    model?: string;
}

interface ModeModelSettings {
    enabled: boolean;
    plan: ModeModel;
    act: ModeModel;
}

interface TerminalSettings {
    output_line_limit: number;
}

interface BotInfo {
    ok: boolean;
    username?: string;
    firstName?: string;
    error?: string;
}

interface SettingsSnapshot {
    apiKeys: Record<string, string>;
    provider: string;
    model: string;
    modeModels: ModeModelSettings;
    terminal: TerminalSettings;
    telegramToken: string;
    telegramChatId: string;
    whisperBinary: string;
    whisperModel: string;
    discordToken: string;
    discordApplicationId: string;
    discordGuildId: string;
    discordAllowedUserIds: string;
    discordAllowedChannelIds: string;
    discordRequireMention: boolean;
    discordTextMode: boolean;
    discordTestChannelId: string;
    allowRemoteSessionStart: boolean;
    contextSettings: ContextSettings;
    autoApproval: AutoApprovalSettings;
    temperature: number;
    topP: number;
    maxTokens: number;
    customInstructions: string;
    hidePromptTrainingModels: boolean;
}

const TABS = [
    { id: 'models', label: 'Models', icon: Brain, keywords: 'api model provider plan act sampling free recommended' },
    { id: 'providers', label: 'Providers', icon: Key, keywords: 'api key byok server user provider' },
    { id: 'autoApprove', label: 'Auto-Approve', icon: ShieldCheck, keywords: 'approval edit delete read command browser mcp budget cost' },
    { id: 'permissions', label: 'Permissions', icon: Shield, keywords: 'rules allow deny audit command files' },
    { id: 'context', label: 'Context', icon: Database, keywords: 'condense window checkpoints context usage' },
    { id: 'indexing', label: 'Indexing', icon: SlidersHorizontal, keywords: 'knowledge semantic workspace map index reindex' },
    { id: 'terminal', label: 'Terminal', icon: Terminal, keywords: 'command output terminal limit' },
    { id: 'usage', label: 'Usage', icon: Gauge, keywords: 'tokens cost requests billing usage' },
    { id: 'marketplace', label: 'Marketplace', icon: LayoutGrid, keywords: 'b2p marketplace mcp servers agent skills install catalog registry' },
    { id: 'skills', label: 'Skills', icon: Shield, keywords: 'skills knowledge instructions prompt' },
    { id: 'integrations', label: 'Integrations', icon: LayoutGrid, keywords: 'ether telegram discord mcp marketplace bot' },
    { id: 'about', label: 'About', icon: Info, keywords: 'version github support donate' },
] as const;

type TabId = typeof TABS[number]['id'];
type ModelFilter = 'all' | 'free' | 'recommended';

const FALLBACK_MODELS: Record<string, ModelInfo[]> = {
    gemini: [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1_000_000, inputPrice: 0, outputPrice: 0, isFree: true, supportsTools: true, recommended: true }],
    anthropic: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1_000_000, inputPrice: 3, outputPrice: 15, isFree: false, supportsTools: true, recommended: true, accessMode: 'byok' }],
    openai: [{ id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, inputPrice: 5, outputPrice: 30, isFree: false, supportsTools: true, recommended: true, accessMode: 'byok', apiType: 'responses' }],
    xai: [{ id: 'grok-4.3', name: 'Grok 4.3', contextWindow: 1_000_000, inputPrice: 1.25, outputPrice: 2.5, isFree: false, supportsTools: true, recommended: true, accessMode: 'byok' }],
    deepseek: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, inputPrice: 0.14, outputPrice: 0.28, isFree: false, supportsTools: true, recommended: true, accessMode: 'byok' }],
    minimax: [{ id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1_000_000, inputPrice: 1, outputPrice: 2, isFree: false, supportsTools: true, accessMode: 'byok' }],
    mistral: [
        { id: 'codestral-latest', name: 'Codestral', contextWindow: 32_000, inputPrice: 0, outputPrice: 0, isFree: true, supportsTools: true },
        { id: 'ministral-8b-latest', name: 'Ministral 8B', contextWindow: 128_000, inputPrice: 0, outputPrice: 0, isFree: true, supportsTools: true },
    ],
    openrouter: [{ id: 'qwen/qwen3-coder:free', name: 'Qwen 3 Coder (Free)', contextWindow: 262_000, inputPrice: 0, outputPrice: 0, isFree: true, supportsTools: true, recommended: true, accessMode: 'free', credentialMode: 'provider_key' }],
    grik: [
        { id: 'qwen/qwen3-coder:free', name: 'Qwen 3 Coder (Anonymous Free)', contextWindow: 262_000, inputPrice: 0, outputPrice: 0, isFree: true, supportsTools: true, recommended: true, accessMode: 'free', credentialMode: 'none' },
        { id: 'ricochet-code', name: 'Grik Ricochet Code', contextWindow: 200_000, inputPrice: 5, outputPrice: 20, isFree: false, supportsTools: true, recommended: true, accessMode: 'subscription', keySource: 'hosted', credentialMode: 'grik_account', requiresSubscription: true, launchState: 'soon', ownedBy: 'grik' },
        { id: 'openai/gpt-5.5', name: 'GPT-5.5 (Subscription)', contextWindow: 1_000_000, inputPrice: 5, outputPrice: 30, isFree: false, supportsTools: true, recommended: true, accessMode: 'subscription', keySource: 'hosted', credentialMode: 'grik_account', requiresSubscription: true, apiType: 'responses' },
    ],
};

const FALLBACK_PROVIDER_NAMES: Record<string, string> = {
    grik: 'Grik',
    openrouter: 'OpenRouter',
    anthropic: 'Anthropic (Claude)',
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    gemini: 'Google Gemini',
    xai: 'xAI (Grok)',
    zhipu: 'Zhipu AI (GLM)',
    'zhipu-coding': 'Zhipu Coding (GLM)',
    minimax: 'MiniMax',
    mistral: 'Mistral AI',
};

const DEFAULT_AUTO_APPROVAL: AutoApprovalSettings = {
    enabled: false,
    read_files: true,
    read_files_external: false,
    edit_files: false,
    edit_files_external: false,
    execute_safe_commands: false,
    execute_all_commands: false,
    delete_files: false,
    delete_files_external: false,
    use_browser: false,
    use_mcp: false,
    enable_notifications: false,
    max_requests: 0,
    max_cost_usd: 0,
};

const DEFAULT_CONTEXT: ContextSettings = {
    auto_condense: true,
    condense_threshold: 70,
    sliding_window_size: 20,
    show_context_indicator: true,
    enable_checkpoints: true,
    checkpoint_on_writes: true,
    enable_code_index: true,
    workspace_index_enabled: true,
    workspace_index_auto_briefing: false,
    cloud_index_enabled: false,
    max_fragment_tokens: 10000,
    show_contributor_panel: true,
};

const DEFAULT_MODE_MODELS: ModeModelSettings = {
    enabled: false,
    plan: {},
    act: {},
};

function formatUsageTokens(tokens?: number): string {
    const value = tokens || 0;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
    return String(value);
}

function formatUsageCost(cost?: number): string {
    const value = cost || 0;
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
}

function formatUsageTime(timestamp?: number): string {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export type ContextThresholdPreset = 'early' | 'balanced' | 'late' | 'custom';

export function contextThresholdPreset(value: number): ContextThresholdPreset {
    if (value === 60) return 'early';
    if (value === 70) return 'balanced';
    if (value === 85) return 'late';
    return 'custom';
}

export function contextThresholdPresetValue(preset: ContextThresholdPreset, current: number): number {
    if (preset === 'early') return 60;
    if (preset === 'balanced') return 70;
    if (preset === 'late') return 85;
    return current;
}

export function buildContextHealth(status: ContextStatus | null | undefined, threshold = 70) {
    const percent = Math.round(status?.percentage || 0);
    const lastEvent = status?.last_compaction?.event || '';
    if (status?.was_truncated || lastEvent === 'context_truncated') {
        return { label: 'Emergency trimmed', tone: 'text-red-300 bg-red-400/10 border-red-400/20', percent };
    }
    if (status?.was_condensed || lastEvent === 'context_condensed') {
        return { label: 'Compacted', tone: 'text-blue-300 bg-blue-400/10 border-blue-400/20', percent };
    }
    if (percent >= threshold) {
        return { label: 'Compact soon', tone: 'text-amber-300 bg-amber-400/10 border-amber-400/20', percent };
    }
    if (percent >= 60) {
        return { label: 'Watch', tone: 'text-yellow-300 bg-yellow-400/10 border-yellow-400/20', percent };
    }
    return { label: status ? 'Good' : 'No snapshot', tone: 'text-green-300 bg-green-400/10 border-green-400/20', percent };
}

export function buildContextReportText(status: ContextStatus | null | undefined): string {
    if (!status) return 'No context snapshot yet.';
    const lines = [
        `Context: ${status.tokens_used || 0}/${status.tokens_max || 0} tokens (${Math.round(status.percentage || 0)}%)`,
        `Policy: auto-compact ${status.effective_policy?.auto_condense ? 'on' : 'off'}, threshold ${status.condense_threshold || status.effective_policy?.condense_threshold || 70}%`,
        `Emergency fallback: keep ${status.fallback_window || status.effective_policy?.sliding_window_size || 20} recent messages`,
    ];
    if (status.compression_saved_tokens) {
        lines.push(`Compression saved: ${status.compression_saved_tokens} tokens`);
    }
    if (status.last_compaction?.event) {
        lines.push(`Last compaction: ${status.last_compaction.event} (${status.last_compaction.tokens_before || 0} -> ${status.last_compaction.tokens_after || 0})`);
    }
    if (status.checkpoint_status) {
        lines.push(`Restore points: ${status.checkpoint_status.enabled ? 'on' : 'off'}, ${status.checkpoint_status.checkpoint_count || 0} saved`);
        if (status.checkpoint_status.error) lines.push(`Restore point error: ${status.checkpoint_status.error}`);
    }
    (status.warnings || []).forEach((warning) => lines.push(`Warning: ${warning}`));
    (status.suggestions || []).forEach((suggestion) => lines.push(`Suggestion: ${suggestion}`));
    return lines.join('\n');
}

function formatContextWindow(tokens?: number): string {
    if (!tokens) return 'n/a';
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
    return `${Math.round(tokens / 1000)}k`;
}

export function keyStatusLabel(p: ProviderInfo): string {
    return providerCredentialLabel(p);
}

function keyStatusTone(p: ProviderInfo): string {
    if (p.keySource === 'hosted' || p.accessMode === 'subscription') return 'text-violet-300 bg-violet-400/10';
    if (p.keySource === 'user' || p.hasUserKey) return 'text-green-400 bg-green-400/10';
    if (p.keySource === 'server' || p.hasKey) return 'text-blue-400 bg-blue-400/10';
    return 'text-[#888] bg-white/5';
}

export function settingsModelAccess(provider: ProviderInfo | undefined, model: ModelInfo | undefined, grikAccount?: GrikAccountController): SelectedModelAccess {
    return deriveModelAccess(provider, model, grikAccount);
}

export function settingsModelAccessLabel(provider: ProviderInfo | undefined, model: ModelInfo | undefined, grikAccount?: GrikAccountController): string {
    return settingsModelAccess(provider, model, grikAccount).label;
}

function modelAccessTone(access: SelectedModelAccess): string {
    return modelAccessBadgeClass(access);
}

function isComingSoonAccess(access: SelectedModelAccess): boolean {
    return access.state === 'coming_soon';
}

function providerKeyCheckTone(result?: ProviderKeyValidationResult): string {
    if (!result) return 'text-[#777]';
    if (result.ok || result.status === 'valid') return 'text-green-400';
    if (result.status === 'network_error') return 'text-amber-300';
    return 'text-red-300';
}

function providerKeyCheckMessage(result?: ProviderKeyValidationResult): string {
    if (!result) return '';
    return result.message || 'Key check finished.';
}

export function catalogStatusText(provider: ProviderInfo): string | null {
    if (provider.id !== 'openrouter') return null;
    const status = provider.catalogStatus;
    const error = status?.error?.trim();
    if (error) {
        if (error.toLowerCase().includes('disabled')) {
            return 'Using bundled catalog; live sync disabled.';
        }
        return 'Using bundled catalog; refresh failed.';
    }
    if (status?.source === 'live' || status?.source === 'mixed') {
        return status.refreshedAt ? 'Free models synced from OpenRouter.' : 'Free models include OpenRouter live catalog entries.';
    }
    return 'Using bundled catalog.';
}

export function isCatalogProviderOpen(providerId: string, openProviderIds: Set<string>, isSearchActive: boolean): boolean {
    return isSearchActive || openProviderIds.has(providerId);
}

export function isAccessProviderOpen(providerId: string, openProviderIds: Set<string>): boolean {
    return openProviderIds.has(providerId);
}

export function isPromptTrainingModel(model: Pick<ModelInfo, 'mayTrainOnYourPrompts'>): boolean {
    return model.mayTrainOnYourPrompts === true;
}

export function filterPromptTrainingModelsForStealth<T extends Pick<ModelInfo, 'mayTrainOnYourPrompts'>>(models: T[], hidePromptTrainingModels: boolean): T[] {
    if (!hidePromptTrainingModels) return models;
    return models.filter(model => !isPromptTrainingModel(model));
}

function normalizeContext(value: Partial<ContextSettings>): ContextSettings {
    return {
        ...DEFAULT_CONTEXT,
        ...value,
        workspace_index_auto_briefing: false,
        cloud_index_enabled: false,
    };
}

function normalizeAutoApproval(value: Partial<AutoApprovalSettings>): AutoApprovalSettings {
    return {
        ...DEFAULT_AUTO_APPROVAL,
        ...value,
        read_files: true,
        enable_notifications: false,
        max_requests: Number(value.max_requests || 0),
        max_cost_usd: Number(value.max_cost_usd || 0),
    };
}

function stableStringify(value: unknown): string {
    return JSON.stringify(value);
}

function splitDiscordIds(value: string): string[] {
    return value
        .split(/[,\s]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

const DISCORD_INSTALL_PERMISSIONS = '311385246720';

export function buildDiscordInstallUrl(applicationId: string): string {
    const clientId = applicationId.trim();
    if (!clientId) return '';
    return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${DISCORD_INSTALL_PERMISSIONS}&scope=bot%20applications.commands`;
}

export function buildDiscordSetupSteps(applicationId: string): string {
    const installUrl = buildDiscordInstallUrl(applicationId);
    return [
        'Ricochet Discord setup',
        '',
        installUrl ? `1. Install the bot in your Discord server: ${installUrl}` : '1. Paste the Discord Application ID in Ricochet Settings, then open the generated install link.',
        '2. In Ricochet Settings, save the Discord Bot Token and enable Live Mode.',
        '3. In Discord, run /ricochet new in the server channel where you want Ricochet to work.',
        '4. Open the Ricochet-created thread and write directly there; no @Ricochet mention is needed inside that thread.',
        '5. In normal server channels, use /ricochet commands or @Ricochet when Require mention is enabled.',
        '',
        'DMs are also supported when Discord allows the user to open a direct message with the bot.',
    ].join('\n');
}

function HostedProviderAccess({ provider, account }: { provider: ProviderInfo; account?: GrikAccountController }) {
    const fallbackSummary: GrikAccountSummary = {
        label: provider.available ? 'Grik Account' : 'Sign in required',
        detail: 'Hosted Ricochet models use your Grik account subscription.',
        tone: provider.available ? 'success' : 'idle',
        actionLabel: provider.available ? 'Manage' : 'Sign in',
        hostedAccess: provider.available,
        authenticated: provider.available,
        accessState: provider.available ? 'available' : 'signed_out',
        accessLabel: provider.available ? 'Available' : 'Sign in required',
    };
    const summary = account?.summary || fallbackSummary;
    const credits = account ? getRicochetCreditBalance(account.billingState) : null;
    const entitlement = account ? getPrimaryGrikEntitlement(account.billingState) : null;
    const cancelingAtPeriodEnd = entitlementCancelAtPeriodEnd(entitlement);
    const periodEndValue = cancelingAtPeriodEnd ? entitlementCancellationEffectiveAt(entitlement) : entitlementPeriodEnd(entitlement);
    const periodEnd = periodEndValue ? formatGrikDate(periodEndValue) : '';
    const windowRemaining = account ? budgetNumber(account.billingState.budget, 'window_remaining', 'windowRemaining') : undefined;
    const entitlementStatus = String(entitlement?.status || '').toLowerCase();
    const canManageSubscription = Boolean(account?.authState.authenticated && entitlement?.id && ['active', 'trialing'].includes(entitlementStatus));

    const handlePrimaryAction = () => {
        if (!account) return;
        if (summary.hostedAccess) {
            account.openBilling({ target: 'subscription', product: 'ricochet_code' });
            return;
        }
        if (account.authState.authenticated) {
            account.openBilling({ target: 'credits', product: 'ricochet_code' });
            return;
        }
        account.signIn();
    };
    const handleSubscriptionAction = () => {
        if (!account || !entitlement?.id) return;
        if (cancelingAtPeriodEnd) {
            account.resumeSubscription(entitlement.id);
            return;
        }
        account.cancelSubscription(entitlement.id, 'user_requested');
    };

    return (
        <div className="rounded-md bg-white/[0.025] px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex items-start gap-3">
                    <UserCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#9cc7ff]" />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-[#ddd]">Grik Account</span>
                            <span className="text-[10px] text-[#9aa]">{summary.label}</span>
                        </div>
                        <p className="mt-1 text-[11px] leading-5 text-[#888]">{summary.detail}</p>
                        {summary.quotaWarning && (
                            <p className={`mt-1 text-[11px] leading-5 ${summary.quotaWarning.tone === 'danger' ? 'text-rose-200/85' : 'text-amber-200/85'}`}>
                                {summary.quotaWarning.label}: {summary.quotaWarning.detail}
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        onClick={account?.refresh}
                        disabled={!account || account.isBusy}
                        className="h-7 w-7 inline-flex items-center justify-center rounded text-[#888] hover:bg-white/[0.05] hover:text-[#ddd] disabled:opacity-50"
                        title="Refresh Grik Account"
                        aria-label="Refresh Grik Account"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${account?.isBusy ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        type="button"
                        onClick={handlePrimaryAction}
                        disabled={!account}
                        className="h-7 rounded bg-[#0e639c] px-2.5 text-[11px] font-medium text-white hover:bg-[#1177bb] disabled:opacity-50"
                    >
                        {summary.hostedAccess ? 'Manage subscription' : account?.authState.authenticated ? 'Upgrade' : 'Sign in'}
                    </button>
                    {canManageSubscription && (
                        <button
                            type="button"
                            onClick={handleSubscriptionAction}
                            disabled={!account || account.isBusy}
                            className="h-7 inline-flex items-center gap-1 rounded border border-white/10 px-2.5 text-[11px] font-medium text-[#ccc] hover:border-white/25 hover:bg-white/[0.04] disabled:opacity-50"
                        >
                            {cancelingAtPeriodEnd ? <CheckCircle className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                            {cancelingAtPeriodEnd ? 'Resume plan' : 'Cancel plan'}
                        </button>
                    )}
                </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <ProviderMetric icon={<CreditCard className="h-3.5 w-3.5" />} label="Credits" value={formatGrikCredits(credits?.balance)} />
                <ProviderMetric label="Access" value={summary.accessLabel} />
                <ProviderMetric label="Models" value={`${provider.models.length}`} />
                <ProviderMetric label={cancelingAtPeriodEnd ? 'Ends' : 'Renews / ends'} value={periodEnd || 'Dashboard'} />
                {windowRemaining !== undefined && <ProviderMetric label="Window left" value={formatGrikCredits(windowRemaining)} />}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-[#777]">
                <span>API keys are not required for hosted Grik models.</span>
                <button
                    type="button"
                    onClick={() => account?.openBilling({ target: 'dashboard' })}
                    disabled={!account?.authState.authenticated}
                    className="inline-flex items-center gap-1 text-[#9cc7ff] hover:underline disabled:pointer-events-none disabled:opacity-45"
                >
                    <ExternalLink className="h-3 w-3" />
                    Open Grik dashboard
                </button>
            </div>
        </div>
    );
}

function ProviderMetric({ icon, label, value }: { icon?: ReactNode; label: string; value: string }) {
    return (
        <div className="rounded bg-white/[0.025] px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[10px] text-[#777]">
                {icon}
                {label}
            </div>
            <div className="mt-1 truncate text-[12px] font-medium text-[#ddd]">{value}</div>
        </div>
    );
}

export function Settings({ onClose, initialTab, grikAccount }: SettingsProps) {
    const [activeTab, setActiveTab] = useState<TabId>(
        TABS.some(tab => tab.id === initialTab) ? initialTab as TabId : 'models'
    );
    const [settingsSearch, setSettingsSearch] = useState('');
    const [modelSearch, setModelSearch] = useState('');
    const [modelFilter, setModelFilter] = useState<ModelFilter>('recommended');
    const [openProviderIds, setOpenProviderIds] = useState<Set<string>>(() => new Set(['deepseek']));
    const [openAccessProviderIds, setOpenAccessProviderIds] = useState<Set<string>>(() => new Set(['grik', 'deepseek']));
    const [modelsRefreshing, setModelsRefreshing] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);

    useEffect(() => {
        if (TABS.some(tab => tab.id === initialTab)) {
            setActiveTab(initialTab as TabId);
        }
    }, [initialTab]);

    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [provider, setProvider] = useState<string>('deepseek');
    const [model, setModel] = useState('');
    const [providerKeyChecks, setProviderKeyChecks] = useState<Record<string, ProviderKeyValidationResult>>({});
    const [checkingProviderIds, setCheckingProviderIds] = useState<Set<string>>(() => new Set());
    const [modeModels, setModeModels] = useState<ModeModelSettings>(DEFAULT_MODE_MODELS);
    const [terminal, setTerminal] = useState<TerminalSettings>({ output_line_limit: 500 });
    const [temperature, setTemperature] = useState(0);
    const [topP, setTopP] = useState(1);
    const [maxTokens, setMaxTokens] = useState(4096);
    const [customInstructions, setCustomInstructions] = useState('');
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [hidePromptTrainingModels, setHidePromptTrainingModels] = useState(false);

    const [telegramToken, setTelegramToken] = useState('');
    const [telegramChatId, setTelegramChatId] = useState('');
    const [whisperBinary, setWhisperBinary] = useState('');
    const [whisperModel, setWhisperModel] = useState('');
    const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
    const [isVerifying, setIsVerifying] = useState(false);
    const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
    const [discordToken, setDiscordToken] = useState('');
    const [discordApplicationId, setDiscordApplicationId] = useState('');
    const [discordGuildId, setDiscordGuildId] = useState('');
    const [discordAllowedUserIds, setDiscordAllowedUserIds] = useState('');
    const [discordAllowedChannelIds, setDiscordAllowedChannelIds] = useState('');
    const [discordRequireMention, setDiscordRequireMention] = useState(true);
    const [discordTextMode, setDiscordTextMode] = useState(false);
    const [discordTestChannelId, setDiscordTestChannelId] = useState('');
    const [discordBotInfo, setDiscordBotInfo] = useState<BotInfo | null>(null);
    const [isVerifyingDiscord, setIsVerifyingDiscord] = useState(false);
    const [discordTestStatus, setDiscordTestStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
    const [discordSetupNotice, setDiscordSetupNotice] = useState<string | null>(null);
    const [allowRemoteSessionStart, setAllowRemoteSessionStart] = useState(false);

    const [autoApproval, setAutoApproval] = useState<AutoApprovalSettings>(DEFAULT_AUTO_APPROVAL);
    const [contextSettings, setContextSettings] = useState<ContextSettings>(DEFAULT_CONTEXT);
    const [mcpServers, setMcpServers] = useState<any[]>([]);
    const [savedNotice, setSavedNotice] = useState<string | null>(null);
    const [usageScope, setUsageScope] = useState<UsageScope>('current');
    const [contextSnapshot, setContextSnapshot] = useState<ContextStatus | null>(null);
    const [contextAction, setContextAction] = useState<'idle' | 'loading' | 'compacting' | 'copied' | 'cleared' | 'error'>('idle');
    const [contextActionMessage, setContextActionMessage] = useState<string | null>(null);
    const [contextBreakdownOpen, setContextBreakdownOpen] = useState(false);
    const [contextAdvancedOpen, setContextAdvancedOpen] = useState(false);

    const initialSnapshotRef = useRef<SettingsSnapshot | null>(null);
    const { sessions, currentSessionId } = useSessions();
    const { usageSnapshot, contextStatus } = useUsage(currentSessionId);
    const { postMessage, onMessage } = useVSCodeApi();

    const currentSession = useMemo(
        () => sessions.find(session => session.id === (usageSnapshot?.sessionId || currentSessionId)) || null,
        [currentSessionId, sessions, usageSnapshot?.sessionId]
    );
    const allSessionsUsage = useMemo(
        () => mergeUsageSnapshots(sessions.flatMap(session => session.usage ? [session.usage] : [])),
        [sessions]
    );
    const activeUsageSnapshot = usageScope === 'all' ? allSessionsUsage : usageSnapshot;
    const activeUsageHasData = hasUsageData(activeUsageSnapshot);
    const usageEvents = useMemo(() => recentUsageEvents(activeUsageSnapshot), [activeUsageSnapshot]);
    const usageContextTokens = usageScope === 'current'
        ? (contextStatus?.tokens_used ?? activeUsageSnapshot?.contextTokens ?? 0)
        : 0;
    const usageContextWindow = usageScope === 'current'
        ? (contextStatus?.tokens_max ?? activeUsageSnapshot?.contextWindow ?? 0)
        : 0;
    const usageContextPercent = usageContextWindow > 0
        ? Math.min(100, Math.round((usageContextTokens / usageContextWindow) * 100))
        : Math.min(100, Math.round(contextStatus?.percentage || 0));
    const activeContextStatus = contextStatus || contextSnapshot;
    const activeContextThreshold = contextSettings.condense_threshold || activeContextStatus?.condense_threshold || activeContextStatus?.effective_policy?.condense_threshold || 70;
    const activeContextHealth = buildContextHealth(activeContextStatus, activeContextThreshold);
    const activeContextTokens = activeContextStatus?.tokens_used || 0;
    const activeContextWindow = activeContextStatus?.tokens_max || 0;
    const activeContextPercent = activeContextWindow > 0
        ? Math.min(100, Math.round((activeContextTokens / activeContextWindow) * 100))
        : activeContextHealth.percent;
    const activeContextContributors = activeContextStatus?.report?.top_contributors || [];
    const activeContextWarnings = activeContextStatus?.warnings || activeContextStatus?.report?.warnings || [];
    const activeContextSuggestions = activeContextStatus?.suggestions || activeContextStatus?.report?.suggestions || [];
    const activeCheckpointStatus = activeContextStatus?.checkpoint_status;
    const thresholdPreset = contextThresholdPreset(contextSettings.condense_threshold);
    const discordInstallUrl = useMemo(() => buildDiscordInstallUrl(discordApplicationId), [discordApplicationId]);
    const discordSetupSteps = useMemo(() => buildDiscordSetupSteps(discordApplicationId), [discordApplicationId]);

    const providerOptions = useMemo<ProviderInfo[]>(() => {
        if (providers.length > 0) return sortProvidersByDisplayOrder(providers);
        return sortProvidersByDisplayOrder(Object.keys(FALLBACK_MODELS).map(id => ({
            id,
            name: FALLBACK_PROVIDER_NAMES[id] || id,
            hasKey: false,
            keySource: 'none',
            available: false,
            models: FALLBACK_MODELS[id],
        })));
    }, [providers]);

    const currentProvider = providerOptions.find(p => p.id === provider);
    const availableModels = useMemo(() => filterPromptTrainingModelsForStealth(
        currentProvider?.models?.length ? currentProvider.models : (FALLBACK_MODELS[provider] || []),
        hidePromptTrainingModels
    ), [currentProvider, hidePromptTrainingModels, provider]);
    const currentModel = availableModels.find(item => item.id === model)
        || currentProvider?.models?.find(item => item.id === model);
    const currentModelAccess = settingsModelAccess(currentProvider, currentModel, grikAccount);

    const catalogGroups = useMemo(() => {
        const query = modelSearch.trim().toLowerCase();
        const groups = providerOptions.map(p => {
            const providerMatches = query
                ? p.name.toLowerCase().includes(query) || p.id.toLowerCase().includes(query)
                : false;
            const rawModels = p.models.map(m => ({
                ...m,
                recommended: Boolean(m.recommended || (m.supportsTools && (p.available || m.isFree))),
            }));
            const rawPromptTrainingCount = rawModels.filter(isPromptTrainingModel).length;
            const serverHiddenPromptTrainingCount = p.hiddenPromptTrainingModelCount || 0;
            const hiddenPromptTrainingCount = serverHiddenPromptTrainingCount + (hidePromptTrainingModels ? rawPromptTrainingCount : 0);
            const visibleModels = filterPromptTrainingModelsForStealth(rawModels, hidePromptTrainingModels);
            const models = visibleModels
                .filter(item => {
                    if (modelFilter === 'free' && !item.isFree) return false;
                    if (modelFilter === 'recommended' && !item.recommended) return false;
                    if (!query || providerMatches) return true;
                    return item.name.toLowerCase().includes(query) || item.id.toLowerCase().includes(query);
                });

            return {
                provider: p,
                models,
                totalCount: p.models.length + serverHiddenPromptTrainingCount,
                freeCount: visibleModels.filter(item => item.isFree).length,
                subscriptionCount: visibleModels.filter(item => item.requiresSubscription || item.accessMode === 'subscription').length,
                limitedCount: visibleModels.filter(item => item.limited).length,
                deprecatedCount: visibleModels.filter(item => item.deprecated).length,
                paidCount: visibleModels.filter(item => !item.isFree && item.accessMode !== 'subscription').length,
                promptTrainingCount: p.promptTrainingModelCount || rawPromptTrainingCount + serverHiddenPromptTrainingCount,
                hiddenPromptTrainingCount,
            };
        });

        const visibleGroups = query
            ? groups.filter(group => group.models.length > 0 || (group.hiddenPromptTrainingCount > 0 && (group.provider.name.toLowerCase().includes(query) || group.provider.id.toLowerCase().includes(query))))
            : groups;

        return visibleGroups.sort((a, b) => {
            const sorted = sortProvidersByDisplayOrder([a.provider, b.provider]);
            if (sorted[0].id === sorted[1]?.id) return 0;
            return sorted[0].id === a.provider.id ? -1 : 1;
        });
    }, [hidePromptTrainingModels, modelFilter, modelSearch, providerOptions]);

    const visibleTabs = useMemo(() => {
        const query = settingsSearch.trim().toLowerCase();
        if (!query) return TABS;
        return TABS.filter(tab => tab.label.toLowerCase().includes(query) || tab.keywords.includes(query));
    }, [settingsSearch]);

    const buildSnapshot = (): SettingsSnapshot => ({
        apiKeys,
        provider,
        model,
        modeModels,
        terminal,
        telegramToken,
        telegramChatId,
        whisperBinary,
        whisperModel,
        discordToken,
        discordApplicationId,
        discordGuildId,
        discordAllowedUserIds,
        discordAllowedChannelIds,
        discordRequireMention,
        discordTextMode,
        discordTestChannelId,
        allowRemoteSessionStart,
        contextSettings: normalizeContext(contextSettings),
        autoApproval: normalizeAutoApproval(autoApproval),
        temperature,
        topP,
        maxTokens,
        customInstructions,
        hidePromptTrainingModels,
    });

    const currentSnapshot = buildSnapshot();
    const isDirty = initialSnapshotRef.current
        ? stableStringify(currentSnapshot) !== stableStringify(initialSnapshotRef.current)
        : false;

    const handleProviderChange = (nextProvider: string) => {
        const nextModels = providerOptions.find(p => p.id === nextProvider)?.models || FALLBACK_MODELS[nextProvider] || [];
        setProvider(nextProvider);
        if (nextModels.length > 0 && !nextModels.some(item => item.id === model)) {
            setModel(nextModels[0].id);
        }
        setOpenProviderIds(prev => new Set(prev).add(nextProvider));
    };

    const handleSelectCatalogModel = (nextProvider: string, nextModel: string) => {
        setProvider(nextProvider);
        setModel(nextModel);
        setOpenProviderIds(prev => new Set(prev).add(nextProvider));
    };

    const copyDiscordSetupText = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setDiscordSetupNotice(`${label} copied.`);
        } catch (error) {
            setDiscordSetupNotice(error instanceof Error ? error.message : `Could not copy ${label.toLowerCase()}.`);
        }
    };

    const toggleProviderGroup = (providerId: string) => {
        setOpenProviderIds(prev => {
            const next = new Set(prev);
            if (next.has(providerId)) {
                next.delete(providerId);
            } else {
                next.add(providerId);
            }
            return next;
        });
    };

    const toggleAccessProviderGroup = (providerId: string) => {
        setOpenAccessProviderIds(prev => {
            const next = new Set(prev);
            if (next.has(providerId)) {
                next.delete(providerId);
            } else {
                next.add(providerId);
            }
            return next;
        });
    };

    const refreshModels = () => {
        setModelsRefreshing(true);
        postMessage({ type: 'get_models', payload: { force: true } });
    };

    const checkProviderKey = (providerId: string) => {
        setProviderKeyChecks(prev => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        setCheckingProviderIds(prev => new Set(prev).add(providerId));
        postMessage({
            type: 'validate_provider_key',
            payload: {
                providerId,
                apiKey: apiKeys[providerId] || '',
            },
        });
    };

    useEffect(() => {
        postMessage({ type: 'get_settings' });
        postMessage({ type: 'get_models' });
        postMessage({ type: 'get_mcp_servers' });
    }, [postMessage]);

    useEffect(() => {
        if (activeTab !== 'context') return;
        setContextAction(prev => prev === 'idle' ? 'loading' : prev);
        postMessage({ type: 'get_context_status', payload: currentSessionId ? { session_id: currentSessionId } : {} });
    }, [activeTab, currentSessionId, postMessage]);

    useEffect(() => {
        if (visibleTabs.length > 0 && !visibleTabs.some(tab => tab.id === activeTab)) {
            setActiveTab(visibleTabs[0].id);
        }
    }, [activeTab, visibleTabs]);

    useEffect(() => {
        if (availableModels.length > 0 && (!model || !availableModels.find(m => m.id === model))) {
            setModel(availableModels[0].id);
        }
    }, [availableModels, model]);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            if (message.type === 'settings_loaded') {
                const s = message.payload as Record<string, unknown>;
                const loadedContext = normalizeContext((s.context || {}) as Partial<ContextSettings>);
                const loadedAutoApproval = normalizeAutoApproval((s.auto_approval || {}) as Partial<AutoApprovalSettings>);
                const loadedModeModels = {
                    ...DEFAULT_MODE_MODELS,
                    ...((s.mode_models || {}) as Partial<ModeModelSettings>),
                    plan: { ...(((s.mode_models as ModeModelSettings | undefined)?.plan) || {}) },
                    act: { ...(((s.mode_models as ModeModelSettings | undefined)?.act) || {}) },
                };
                const loadedTerminal = {
                    output_line_limit: Number(((s.terminal as TerminalSettings | undefined)?.output_line_limit) || 500),
                };
                const snapshot: SettingsSnapshot = {
                    apiKeys: (s.apiKeys as Record<string, string>) || {},
                    provider: (s.provider as string) || 'deepseek',
                    model: (s.model as string) || '',
                    modeModels: loadedModeModels,
                    terminal: loadedTerminal,
                    telegramToken: (s.telegramToken as string) || '',
                    telegramChatId: s.telegramChatId ? String(s.telegramChatId) : '',
                    whisperBinary: (s.whisperBinary as string) || '',
                    whisperModel: (s.whisperModel as string) || '',
                    discordToken: (s.discordToken as string) || '',
                    discordApplicationId: (s.discordApplicationId as string) || '',
                    discordGuildId: (s.discordGuildId as string) || '',
                    discordAllowedUserIds: Array.isArray(s.discordAllowedUserIds) ? (s.discordAllowedUserIds as string[]).join(', ') : '',
                    discordAllowedChannelIds: Array.isArray(s.discordAllowedChannelIds) ? (s.discordAllowedChannelIds as string[]).join(', ') : '',
                    discordRequireMention: Boolean(s.discordRequireMention ?? true),
                    discordTextMode: Boolean(s.discordTextMode ?? false),
                    discordTestChannelId: '',
                    allowRemoteSessionStart: Boolean(s.allowRemoteSessionStart ?? false),
                    contextSettings: loadedContext,
                    autoApproval: loadedAutoApproval,
                    temperature: Number(s.temperature ?? 0),
                    topP: Number(s.topP ?? 1),
                    maxTokens: Number(s.maxTokens ?? 4096),
                    customInstructions: (s.custom_instructions as string) || '',
                    hidePromptTrainingModels: Boolean(s.hide_prompt_training_models ?? false),
                };
                setApiKeys(snapshot.apiKeys);
                setProvider(snapshot.provider);
                setModel(snapshot.model);
                setOpenProviderIds(prev => new Set(prev).add(snapshot.provider));
                setOpenAccessProviderIds(prev => new Set(prev).add(snapshot.provider));
                setModeModels(snapshot.modeModels);
                setTerminal(snapshot.terminal);
                setTelegramToken(snapshot.telegramToken);
                setTelegramChatId(snapshot.telegramChatId);
                setWhisperBinary(snapshot.whisperBinary);
                setWhisperModel(snapshot.whisperModel);
                setDiscordToken(snapshot.discordToken);
                setDiscordApplicationId(snapshot.discordApplicationId);
                setDiscordGuildId(snapshot.discordGuildId);
                setDiscordAllowedUserIds(snapshot.discordAllowedUserIds);
                setDiscordAllowedChannelIds(snapshot.discordAllowedChannelIds);
                setDiscordRequireMention(snapshot.discordRequireMention);
                setDiscordTextMode(snapshot.discordTextMode);
                setDiscordTestChannelId(snapshot.discordTestChannelId);
                setAllowRemoteSessionStart(snapshot.allowRemoteSessionStart);
                setContextSettings(snapshot.contextSettings);
                setAutoApproval(snapshot.autoApproval);
                setTemperature(snapshot.temperature);
                setTopP(snapshot.topP);
                setMaxTokens(snapshot.maxTokens);
                setCustomInstructions(snapshot.customInstructions);
                setHidePromptTrainingModels(snapshot.hidePromptTrainingModels);
                initialSnapshotRef.current = snapshot;
                setSavedNotice(null);
            }
            if (message.type === 'models') {
                const result = message.payload as { providers: ProviderInfo[]; hide_prompt_training_models?: boolean };
                setProviders(result.providers || []);
                setModelsRefreshing(false);
                if (typeof result.hide_prompt_training_models === 'boolean') {
                    setHidePromptTrainingModels(result.hide_prompt_training_models);
                }
            }
            if (message.type === 'provider_key_validation') {
                const result = message.payload as ProviderKeyValidationResult;
                const providerId = result.providerId || '';
                if (providerId) {
                    setProviderKeyChecks(prev => ({ ...prev, [providerId]: result }));
                    setCheckingProviderIds(prev => {
                        const next = new Set(prev);
                        next.delete(providerId);
                        return next;
                    });
                } else {
                    setCheckingProviderIds(new Set());
                }
            }
            if (message.type === 'bot_verification_result') {
                setBotInfo(message.payload as BotInfo);
                setIsVerifying(false);
            }
            if (message.type === 'test_telegram_result') {
                const result = message.payload as { ok: boolean };
                setTestStatus(result.ok ? 'success' : 'error');
            }
            if (message.type === 'discord_bot_verification_result') {
                setDiscordBotInfo(message.payload as BotInfo);
                setIsVerifyingDiscord(false);
            }
            if (message.type === 'test_discord_result') {
                const result = message.payload as { ok: boolean };
                setDiscordTestStatus(result.ok ? 'success' : 'error');
            }
            if (message.type === 'mcp_servers') {
                const result = message.payload as { servers: any[] };
                setMcpServers(result.servers || []);
            }
            if (message.type === 'context_status') {
                setContextSnapshot(message.payload as ContextStatus);
                setContextAction(prev => prev === 'loading' || prev === 'compacting' ? 'idle' : prev);
                if (contextAction === 'compacting') {
                    setContextActionMessage('Context snapshot updated.');
                }
            }
            if (message.type === 'context_compaction') {
                const payload = message.payload as ContextCompactionEventPayload;
                setContextSnapshot(prev => prev ? { ...prev, last_compaction: payload } : prev);
                if (payload.event === 'context_compaction_failed') {
                    setContextAction('error');
                    setContextActionMessage(payload.error || 'Compact failed.');
                } else {
                    setContextAction('idle');
                    setContextActionMessage(payload.event === 'context_truncated' ? 'Emergency trim completed.' : 'Context compacted.');
                }
            }
            if (message.type === 'context_action_error') {
                const payload = message.payload as { error?: string };
                setContextAction('error');
                setContextActionMessage(payload.error || 'Context action failed.');
            }
        });
        return () => { unsubscribe(); };
    }, [contextAction, onMessage]);

    useEffect(() => {
        if (!telegramToken || telegramToken.length < 20) {
            setBotInfo(null);
            return;
        }
        const timeout = setTimeout(() => {
            setIsVerifying(true);
            postMessage({ type: 'verify_telegram_token', payload: { token: telegramToken } });
        }, 500);
        return () => clearTimeout(timeout);
    }, [postMessage, telegramToken]);

    useEffect(() => {
        if (!discordToken || discordToken.length < 20) {
            setDiscordBotInfo(null);
            return;
        }
        const timeout = setTimeout(() => {
            setIsVerifyingDiscord(true);
            postMessage({ type: 'verify_discord_token', payload: { token: discordToken } });
        }, 500);
        return () => clearTimeout(timeout);
    }, [discordToken, postMessage]);

    const saveSnapshot = () => {
        const snapshot = buildSnapshot();
        postMessage({
            type: 'save_settings',
            payload: {
                apiKeys: snapshot.apiKeys,
                provider: snapshot.provider,
                model: snapshot.model,
                mode_models: snapshot.modeModels,
                terminal: snapshot.terminal,
                telegramToken: snapshot.telegramToken,
                telegramChatId: snapshot.telegramChatId ? parseInt(snapshot.telegramChatId, 10) : 0,
                whisperBinary: snapshot.whisperBinary,
                whisperModel: snapshot.whisperModel,
                discordToken: snapshot.discordToken,
                discordApplicationId: snapshot.discordApplicationId,
                discordGuildId: snapshot.discordGuildId,
                discordAllowedUserIds: splitDiscordIds(snapshot.discordAllowedUserIds),
                discordAllowedChannelIds: splitDiscordIds(snapshot.discordAllowedChannelIds),
                discordRequireMention: snapshot.discordRequireMention,
                discordTextMode: snapshot.discordTextMode,
                allowRemoteSessionStart: snapshot.allowRemoteSessionStart,
                context: snapshot.contextSettings,
                auto_approval: snapshot.autoApproval,
                temperature: snapshot.temperature,
                topP: snapshot.topP,
                maxTokens: snapshot.maxTokens,
                customInstructions: snapshot.customInstructions,
                hide_prompt_training_models: snapshot.hidePromptTrainingModels,
            },
        });
        postMessage({ type: 'get_models' });
        initialSnapshotRef.current = snapshot;
        setSavedNotice('Saved');
    };

    const applySnapshot = (snapshot: SettingsSnapshot) => {
        setApiKeys(snapshot.apiKeys);
        setProvider(snapshot.provider);
        setModel(snapshot.model);
        setOpenProviderIds(prev => new Set(prev).add(snapshot.provider));
        setOpenAccessProviderIds(prev => new Set(prev).add(snapshot.provider));
        setModeModels(snapshot.modeModels);
        setTerminal(snapshot.terminal);
        setTelegramToken(snapshot.telegramToken);
        setTelegramChatId(snapshot.telegramChatId);
        setWhisperBinary(snapshot.whisperBinary);
        setWhisperModel(snapshot.whisperModel);
        setDiscordToken(snapshot.discordToken);
        setDiscordApplicationId(snapshot.discordApplicationId);
        setDiscordGuildId(snapshot.discordGuildId);
        setDiscordAllowedUserIds(snapshot.discordAllowedUserIds);
        setDiscordAllowedChannelIds(snapshot.discordAllowedChannelIds);
        setDiscordRequireMention(snapshot.discordRequireMention);
        setDiscordTextMode(snapshot.discordTextMode);
        setDiscordTestChannelId(snapshot.discordTestChannelId);
        setAllowRemoteSessionStart(snapshot.allowRemoteSessionStart);
        setContextSettings(snapshot.contextSettings);
        setAutoApproval(snapshot.autoApproval);
        setTemperature(snapshot.temperature);
        setTopP(snapshot.topP);
        setMaxTokens(snapshot.maxTokens);
        setCustomInstructions(snapshot.customInstructions);
        setHidePromptTrainingModels(snapshot.hidePromptTrainingModels);
        setSavedNotice(null);
    };

    const handleContextPresetChange = (preset: ContextThresholdPreset) => {
        setContextSettings(prev => ({
            ...prev,
            condense_threshold: preset === 'custom' && contextThresholdPreset(prev.condense_threshold) !== 'custom'
                ? 75
                : contextThresholdPresetValue(preset, prev.condense_threshold),
        }));
    };

    const refreshContextStatus = () => {
        setContextAction('loading');
        setContextActionMessage(null);
        postMessage({ type: 'get_context_status', payload: currentSessionId ? { session_id: currentSessionId } : {} });
    };

    const compactContextNow = () => {
        setContextAction('compacting');
        setContextActionMessage(null);
        postMessage({ type: 'compact_context_now', payload: currentSessionId ? { session_id: currentSessionId } : {} });
    };

    const clearContextForNewTask = () => {
        const ok = window.confirm('Clear the current chat context for a new task? This does not delete workspace files.');
        if (!ok) return;
        postMessage({ type: 'clear_chat' });
        setContextAction('cleared');
        setContextActionMessage('Clear requested. Start a new task with a fresh context.');
        setTimeout(() => refreshContextStatus(), 250);
    };

    const copyContextReport = async () => {
        try {
            await navigator.clipboard.writeText(buildContextReportText(activeContextStatus));
            setContextAction('copied');
            setContextActionMessage('Context report copied.');
        } catch (error) {
            setContextAction('error');
            setContextActionMessage(error instanceof Error ? error.message : 'Unable to copy context report.');
        }
    };

    const samplingSupport = provider === 'gemini'
        ? 'Gemini applies temperature and max tokens. Top P is not wired for this provider.'
        : 'Temperature, Top P, and max tokens are sent to this provider.';

    const updateModeProvider = (mode: 'plan' | 'act', nextProvider: string) => {
        const providerModels = providerOptions.find(p => p.id === nextProvider)?.models || FALLBACK_MODELS[nextProvider] || [];
        setModeModels(prev => ({
            ...prev,
            [mode]: {
                provider: nextProvider,
                model: providerModels[0]?.id || '',
            },
        }));
    };

    const modeAccessSummary = (mode: 'plan' | 'act') => {
        const modeProviderId = modeModels[mode].provider || provider;
        const modeModelId = modeModels[mode].model || model;
        const selectedProvider = providerOptions.find(p => p.id === modeProviderId);
        const selectedModel = selectedProvider?.models.find(item => item.id === modeModelId);
        const access = settingsModelAccess(selectedProvider, selectedModel, grikAccount);
        return {
            providerName: selectedProvider?.name || modeProviderId || 'Default provider',
            modelName: selectedModel?.name || modeModelId || 'Default model',
            inherited: !modeModels[mode].provider && !modeModels[mode].model,
            access,
        };
    };

    const renderProviderSelect = (value: string | undefined, onChange: (value: string) => void) => (
        <Select value={value || 'inherit'} onValueChange={(next) => onChange(next === 'inherit' ? '' : next)}>
            <SelectTrigger>
                <SelectValue placeholder="Inherit default provider" />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="inherit">Inherit default provider</SelectItem>
                {providerOptions.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
            </SelectContent>
        </Select>
    );

    const renderModelSelect = (providerId: string | undefined, value: string | undefined, onChange: (value: string) => void) => {
        const models = providerOptions.find(p => p.id === providerId)?.models || (providerId ? FALLBACK_MODELS[providerId] : []) || [];
        return (
            <Select value={value || 'inherit'} onValueChange={(next) => onChange(next === 'inherit' ? '' : next)}>
                <SelectTrigger>
                    <SelectValue placeholder="Inherit default model" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="inherit">Inherit default model</SelectItem>
                    {models.map(m => {
                        const selectedProvider = providerOptions.find(p => p.id === providerId);
                        const access = settingsModelAccess(selectedProvider, m, grikAccount);
                        return (
                            <SelectItem key={m.id} value={m.id} disabled={isComingSoonAccess(access)}>
                                {m.name}{isComingSoonAccess(access) ? ' (Soon)' : ''}
                            </SelectItem>
                        );
                    })}
                </SelectContent>
            </Select>
        );
    };

    return (
        <div className="flex h-full flex-col bg-[#1e1e1e] text-[#ccc]">
            <div className="flex items-center justify-between border-b border-[#333] px-4 py-3">
                <div className="flex items-center gap-2">
                    <button
                        onClick={onClose}
                        className="rounded p-1 text-[#888] transition-colors hover:bg-[#2a2d2e] hover:text-[#ccc]"
                        title="Back"
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </button>
                    <h2 className="text-sm font-medium">Settings</h2>
                </div>
                <div className="flex items-center gap-2">
                    {savedNotice && !isDirty && <span className="text-[11px] text-green-400">{savedNotice}</span>}
                    <button
                        onClick={saveSnapshot}
                        disabled={!isDirty}
                        className="rounded bg-[#0e639c] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#1177bb] disabled:cursor-not-allowed disabled:opacity-45"
                    >
                        Save
                    </button>
                </div>
            </div>

            <div className="flex min-h-0 flex-1 overflow-hidden">
                <aside className="flex w-52 shrink-0 flex-col border-r border-[#333]">
                    <div className="border-b border-[#333] p-3">
                        <div className="flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1.5">
                            <Search className="h-3.5 w-3.5 text-[#777]" />
                            <input
                                value={settingsSearch}
                                onChange={(event) => setSettingsSearch(event.target.value)}
                                placeholder="Search settings"
                                className="min-w-0 flex-1 bg-transparent text-xs text-[#ddd] outline-none placeholder:text-[#666]"
                            />
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto py-2">
                        {visibleTabs.map(({ id, label, icon: Icon }) => (
                            <button
                                key={id}
                                onClick={() => setActiveTab(id)}
                                className={`flex w-full items-center gap-2 border-l-2 px-3 py-2.5 text-left text-sm transition-colors ${activeTab === id
                                    ? 'border-[#0e639c] bg-[#04395e]/30 text-[#ddd]'
                                    : 'border-transparent text-[#888] hover:bg-[#2a2d2e] hover:text-[#ccc]'
                                    }`}
                            >
                                <Icon className="h-4 w-4 shrink-0" />
                                <span className="truncate">{label}</span>
                            </button>
                        ))}
                    </div>
                </aside>

                <main className="min-w-0 flex-1 overflow-y-auto p-5 pb-20">
                    {activeTab === 'models' && (
                        <div className="mx-auto max-w-4xl space-y-6">
                            <section className="space-y-4">
                                <div>
                                    <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Active Model</h3>
                                    <p className="mt-1 text-[11px] text-[#777]">The default model used for normal chat turns.</p>
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <label className="text-xs text-[#888]">Provider</label>
                                        <Select value={provider} onValueChange={handleProviderChange}>
                                            <SelectTrigger>
                                                <SelectValue placeholder="Select provider" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {providerOptions.map(p => (
                                                    <SelectItem key={p.id} value={p.id}>
                                                        {p.name} {p.available ? '' : isHostedSubscriptionAccess(p.accessMode, p.keySource) ? '(Grik Account)' : '(No key)'}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs text-[#888]">Model</label>
                                        {availableModels.length > 0 ? (
                                            <Select value={model} onValueChange={setModel}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Select model" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {availableModels.map(m => {
                                                        const access = settingsModelAccess(currentProvider, m, grikAccount);
                                                        return (
                                                            <SelectItem key={m.id} value={m.id} disabled={isComingSoonAccess(access)}>
                                                                {m.name}{isComingSoonAccess(access) ? ' (Soon)' : ''}
                                                            </SelectItem>
                                                        );
                                                    })}
                                                </SelectContent>
                                            </Select>
                                        ) : (
                                            <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider-model-id" />
                                        )}
                                    </div>
                                </div>
                                <div className={`rounded border px-3 py-2 text-xs ${currentModelAccess.sendable ? 'border-white/10 bg-white/[0.03]' : 'border-amber-400/20 bg-amber-400/10'}`}>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className={`rounded px-2 py-0.5 text-[10px] ${modelAccessTone(currentModelAccess)}`}>{currentModelAccess.label}</span>
                                        <span className={currentModelAccess.sendable ? 'text-[#aaa]' : 'text-amber-200'}>{currentModelAccess.detail}</span>
                                        {!currentModelAccess.sendable && currentModelAccess.action && (
                                            <button
                                                type="button"
                                                onClick={() => setActiveTab(currentModelAccess.action === 'settings' ? settingsTabForModelAccess(currentModelAccess) : 'providers')}
                                                className="ml-auto text-[11px] text-[#9cc7ff] hover:underline"
                                            >
                                                Open Providers
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </section>

                            <section className="rounded border border-white/10 bg-white/[0.03] p-4">
                                <label className="flex cursor-pointer items-start gap-3">
                                    <input
                                        type="checkbox"
                                        checked={hidePromptTrainingModels}
                                        onChange={(event) => setHidePromptTrainingModels(event.target.checked)}
                                        className="mt-0.5 h-4 w-4 accent-[#0e639c]"
                                    />
                                    <span className="min-w-0">
                                        <span className="flex items-center gap-2 text-sm font-medium text-[#ddd]">
                                            <ShieldAlert className="h-4 w-4 text-amber-300" />
                                            Stealth Mode
                                        </span>
                                        <span className="mt-1 block text-[11px] text-[#888]">Hide models that may use prompts for training.</span>
                                    </span>
                                </label>
                            </section>

                            <section className="space-y-4 border-t border-[#333] pt-5">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Available Models</h3>
                                        <p className="mt-1 text-[11px] text-[#777]">
                                            {hidePromptTrainingModels ? 'Stealth Mode hides explicitly flagged prompt-training models.' : 'Models are grouped by provider. OpenRouter free models can include live catalog entries.'}
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={refreshModels}
                                            disabled={modelsRefreshing}
                                            className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-[#aaa] hover:border-white/20 hover:text-[#ddd] disabled:opacity-50"
                                        >
                                            {modelsRefreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                                            Refresh models
                                        </button>
                                        <div className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] p-1">
                                            {(['recommended', 'free', 'all'] as ModelFilter[]).map(filter => (
                                                <button
                                                    key={filter}
                                                    onClick={() => setModelFilter(filter)}
                                                    className={`rounded px-2 py-1 text-[11px] capitalize ${modelFilter === filter ? 'bg-[#0e639c] text-white' : 'text-[#888] hover:text-[#ddd]'}`}
                                                >
                                                    {filter}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-3 py-2">
                                    <Search className="h-4 w-4 text-[#777]" />
                                    <input
                                        value={modelSearch}
                                        onChange={(event) => setModelSearch(event.target.value)}
                                        placeholder="Search models"
                                        className="flex-1 bg-transparent text-sm outline-none placeholder:text-[#666]"
                                    />
                                </div>
                                <div className="space-y-2">
                                    {catalogGroups.length === 0 && (
                                        <div className="rounded border border-white/10 bg-white/[0.03] px-3 py-4 text-sm text-[#888]">
                                            No providers match the current model filters.
                                        </div>
                                    )}
                                    {catalogGroups.map(group => {
                                        const isSearchActive = modelSearch.trim().length > 0;
                                        const isOpen = isCatalogProviderOpen(group.provider.id, openProviderIds, isSearchActive);
                                        const providerActive = group.provider.id === provider;
                                        const providerModelActive = providerActive && group.provider.models.some(item => item.id === model);
                                        const catalogText = catalogStatusText(group.provider);

                                        return (
                                            <div
                                                key={group.provider.id}
                                                className={`overflow-hidden rounded border transition-colors ${providerActive ? 'border-[#0e639c]/70 bg-[#04395e]/18' : 'border-white/10 bg-white/[0.025]'}`}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => toggleProviderGroup(group.provider.id)}
                                                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-white/[0.03]"
                                                >
                                                    <span className="flex min-w-0 items-center gap-2">
                                                        {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-[#888]" /> : <ChevronRight className="h-4 w-4 shrink-0 text-[#888]" />}
                                                        <span className="min-w-0">
                                                            <span className="flex items-center gap-2">
                                                                <span className="truncate text-sm font-medium text-[#ddd]">{group.provider.name}</span>
                                                                {providerModelActive && <CheckCircle className="h-3.5 w-3.5 shrink-0 text-green-400" />}
                                                            </span>
                                                            <span className="mt-0.5 block truncate text-[11px] text-[#777]">{group.provider.id}</span>
                                                        </span>
                                                    </span>
                                                    <span className="flex shrink-0 flex-wrap justify-end gap-1.5 text-[10px]">
                                                        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[#999]">{group.models.length}/{group.totalCount} models</span>
                                                        {hidePromptTrainingModels && group.hiddenPromptTrainingCount > 0 && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-300">{group.hiddenPromptTrainingCount} hidden</span>}
                                                        {!hidePromptTrainingModels && group.promptTrainingCount > 0 && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-300">{group.promptTrainingCount} may train</span>}
                                                        {group.freeCount > 0 && <span className="rounded bg-green-400/10 px-1.5 py-0.5 text-green-400">{group.freeCount} free</span>}
                                                        {group.subscriptionCount > 0 && <span className="rounded bg-violet-400/10 px-1.5 py-0.5 text-violet-300">{group.subscriptionCount} sub</span>}
                                                        {group.limitedCount > 0 && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-300">{group.limitedCount} limited</span>}
                                                        {group.deprecatedCount > 0 && <span className="rounded bg-red-400/10 px-1.5 py-0.5 text-red-300">{group.deprecatedCount} old</span>}
                                                        {group.paidCount > 0 && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[#999]">{group.paidCount} byok</span>}
                                                        <span className={`rounded px-1.5 py-0.5 ${keyStatusTone(group.provider)}`}>{keyStatusLabel(group.provider)}</span>
                                                        {catalogText && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[#999]">{group.provider.catalogStatus?.source || 'curated'}</span>}
                                                    </span>
                                                </button>

                                                {isOpen && (
                                                    <div className="border-t border-white/10 p-2">
                                                        {catalogText && (
                                                            <div className="mb-2 rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-[#888]">
                                                                {catalogText}
                                                            </div>
                                                        )}
                                                        {group.models.length > 0 ? (
                                                            <div className="grid gap-2 md:grid-cols-2">
                                                                {group.models.map(item => {
                                                                    const active = group.provider.id === provider && item.id === model;
                                                                    const itemAccess = settingsModelAccess(group.provider, item, grikAccount);
                                                                    const comingSoon = isComingSoonAccess(itemAccess);
                                                                    return (
                                                                        <button
                                                                            key={`${group.provider.id}:${item.id}`}
                                                                            onClick={() => !comingSoon && handleSelectCatalogModel(group.provider.id, item.id)}
                                                                            disabled={comingSoon}
                                                                            className={`rounded border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${active ? 'border-[#0e639c] bg-[#04395e]/30' : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'}`}
                                                                        >
                                                                            <div className="flex items-start justify-between gap-3">
                                                                                <div className="min-w-0">
                                                                                    <div className="truncate text-sm font-medium text-[#ddd]">{item.name}</div>
                                                                                    <div className="mt-0.5 truncate text-[11px] text-[#777]">{item.id}</div>
                                                                                </div>
                                                                                {active && <CheckCircle className="h-4 w-4 shrink-0 text-green-400" />}
                                                                            </div>
                                                                            <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                                                                                <span className="rounded bg-white/5 px-1.5 py-0.5 text-[#999]">{formatContextWindow(item.contextWindow)} ctx</span>
                                                                                <span className={`rounded px-1.5 py-0.5 ${modelAccessTone(itemAccess)}`}>
                                                                                    {itemAccess.label}
                                                                                </span>
                                                                                {(item.ownedBy === 'grik' || (group.provider.id === 'grik' && item.id === 'ricochet-code')) && (
                                                                                    <span className="rounded bg-sky-400/10 px-1.5 py-0.5 text-sky-300">
                                                                                        Grik model
                                                                                    </span>
                                                                                )}
                                                                                {!item.isFree && item.inputPrice > 0 && (
                                                                                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[#999]">
                                                                                        ${item.inputPrice}/${item.outputPrice}
                                                                                    </span>
                                                                                )}
                                                                                {item.apiType && (
                                                                                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[#999]">
                                                                                        {item.apiType}
                                                                                    </span>
                                                                                )}
                                                                                {item.mayTrainOnYourPrompts && (
                                                                                    <span className="inline-flex items-center gap-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-300" title="This model may use prompts for training">
                                                                                        <ShieldAlert className="h-3 w-3" />
                                                                                        May train
                                                                                    </span>
                                                                                )}
                                                                                {item.deprecated && (
                                                                                    <span className="rounded bg-red-400/10 px-1.5 py-0.5 text-red-300">
                                                                                        deprecated
                                                                                    </span>
                                                                                )}
                                                                                <span className={`rounded px-1.5 py-0.5 ${item.supportsTools ? 'bg-blue-400/10 text-blue-400' : 'bg-white/5 text-[#999]'}`}>
                                                                                    {item.supportsTools ? 'Tools' : 'No tools'}
                                                                                </span>
                                                                                {item.source && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[#999]">{item.source === 'openrouter-live' ? 'Live' : item.source}</span>}
                                                                            </div>
                                                                            {!itemAccess.sendable && (
                                                                                <div className="mt-2 text-[11px] text-amber-200">{itemAccess.detail}</div>
                                                                            )}
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        ) : (
                                                            <div className="rounded border border-dashed border-white/10 px-3 py-4 text-sm text-[#888]">
                                                                {hidePromptTrainingModels && group.hiddenPromptTrainingCount > 0
                                                                    ? `Stealth Mode is hiding ${group.hiddenPromptTrainingCount} prompt-training ${group.hiddenPromptTrainingCount === 1 ? 'model' : 'models'} from this provider.`
                                                                    : 'No models from this provider match the current filters.'}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </section>

                            <section className="space-y-4 border-t border-[#333] pt-5">
                                <div className="flex items-start gap-3">
                                    <input
                                        id="mode-models"
                                        type="checkbox"
                                        checked={modeModels.enabled}
                                        onChange={(event) => setModeModels(prev => ({ ...prev, enabled: event.target.checked }))}
                                        className="mt-1 accent-[#0e639c]"
                                    />
                                    <div>
                                        <label htmlFor="mode-models" className="cursor-pointer text-sm font-medium">Advanced model routing</label>
                                        <p className="mt-0.5 text-xs text-[#888]">Plan and Act overrides inherit the active provider and model when unset.</p>
                                    </div>
                                </div>
                                {modeModels.enabled && (
                                    <div className="grid gap-4 md:grid-cols-2">
                                        {(['plan', 'act'] as const).map(mode => {
                                            const summary = modeAccessSummary(mode);
                                            return (
                                                <div key={mode} className="space-y-3 rounded border border-white/10 bg-white/[0.03] p-3">
                                                    <h4 className="text-xs font-medium uppercase tracking-wide text-[#888]">{mode} model</h4>
                                                    {renderProviderSelect(modeModels[mode].provider, (next) => updateModeProvider(mode, next))}
                                                    {renderModelSelect(modeModels[mode].provider, modeModels[mode].model, (next) => setModeModels(prev => ({ ...prev, [mode]: { ...prev[mode], model: next } })))}
                                                    <div className={`rounded border px-2.5 py-2 text-[11px] ${summary.access.sendable ? 'border-white/10 bg-white/[0.03] text-[#888]' : 'border-amber-400/20 bg-amber-400/10 text-amber-200'}`}>
                                                        <div className="flex flex-wrap items-center gap-1.5">
                                                            <span>{summary.inherited ? 'Inherited' : 'Resolved'}: {summary.providerName} / {summary.modelName}</span>
                                                            <span className={`rounded px-1.5 py-0.5 text-[10px] ${modelAccessTone(summary.access)}`}>{summary.access.label}</span>
                                                        </div>
                                                        {!summary.access.sendable && <div className="mt-1">{summary.access.detail}</div>}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </section>

                            <section className="space-y-4 border-t border-[#333] pt-5">
                                <button type="button" onClick={() => setAdvancedOpen(open => !open)} className="flex w-full items-center justify-between text-left">
                                    <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[#888]">
                                        {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        Advanced Sampling
                                    </span>
                                    <span className="text-[11px] text-[#777]">T {temperature.toFixed(2)} / P {topP.toFixed(2)} / {maxTokens}</span>
                                </button>
                                {advancedOpen && (
                                    <div className="space-y-4">
                                        <p className="rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-[#888]">{samplingSupport}</p>
                                        <div className="space-y-2">
                                            <div className="flex justify-between text-xs text-[#888]"><span>Temperature</span><span>{temperature.toFixed(2)}</span></div>
                                            <input type="range" min="0" max="2" step="0.05" value={temperature} onChange={(event) => setTemperature(parseFloat(event.target.value))} className="w-full accent-[#0e639c]" />
                                        </div>
                                        <div className="space-y-2">
                                            <div className="flex justify-between text-xs text-[#888]"><span>Top P</span><span>{topP.toFixed(2)}</span></div>
                                            <input type="range" min="0" max="1" step="0.01" value={topP} onChange={(event) => setTopP(parseFloat(event.target.value))} className="w-full accent-[#0e639c]" />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-xs text-[#888]">Max tokens</label>
                                            <Input type="number" min={1} value={maxTokens} onChange={(event) => setMaxTokens(parseInt(event.target.value, 10) || 4096)} className="h-8 text-xs" />
                                        </div>
                                    </div>
                                )}
                            </section>
                        </div>
                    )}

                    {activeTab === 'providers' && (
                        <div className="mx-auto max-w-3xl space-y-5">
                            <section>
                                <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Provider Access</h3>
                                <p className="mt-1 text-[11px] text-[#777]">Grik Account unlocks hosted models. BYOK providers use your local API keys.</p>
                            </section>
                            <div className="space-y-3">
                                {providerOptions.map(p => {
                                    const usesAccount = isHostedSubscriptionAccess(p.accessMode, p.keySource);
                                    const isOpen = isAccessProviderOpen(p.id, openAccessProviderIds);
                                    return (
                                        <div key={p.id} className="rounded border border-white/10 bg-white/[0.03] p-3">
                                            <button
                                                type="button"
                                                onClick={() => toggleAccessProviderGroup(p.id)}
                                                className="flex w-full cursor-pointer items-center justify-between gap-3 text-left"
                                            >
                                                <span className="flex min-w-0 items-center gap-2">
                                                    {isOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-[#888]" /> : <ChevronRight className="h-4 w-4 shrink-0 text-[#888]" />}
                                                    <span className={`h-2 w-2 rounded-full ${p.available ? 'bg-green-500' : 'bg-[#555]'}`} />
                                                    <span className="truncate text-sm font-medium text-[#ddd]">{p.name}</span>
                                                </span>
                                                <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] ${keyStatusTone(p)}`}>{keyStatusLabel(p)}</span>
                                            </button>
                                            {isOpen && (
                                                <div className="mt-3 space-y-2">
                                                    {usesAccount ? (
                                                        <HostedProviderAccess provider={p} account={grikAccount} />
                                                    ) : (
                                                        <>
                                                            <div className="flex gap-2">
                                                                <Input
                                                                    type="password"
                                                                    value={apiKeys[p.id] || ''}
                                                                    onChange={(event) => {
                                                                        setApiKeys(prev => ({ ...prev, [p.id]: event.target.value }));
                                                                        setProviderKeyChecks(prev => {
                                                                            if (!prev[p.id]) return prev;
                                                                            const next = { ...prev };
                                                                            delete next[p.id];
                                                                            return next;
                                                                        });
                                                                    }}
                                                                    placeholder={`Enter ${p.name} API key`}
                                                                    className="min-w-0 flex-1 text-xs"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => checkProviderKey(p.id)}
                                                                    disabled={checkingProviderIds.has(p.id)}
                                                                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-2.5 text-[11px] text-[#ddd] hover:bg-white/[0.07] disabled:opacity-50"
                                                                >
                                                                    {checkingProviderIds.has(p.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Key className="h-3.5 w-3.5" />}
                                                                    Check key
                                                                </button>
                                                            </div>
                                                            {providerKeyChecks[p.id] && (
                                                                <p className={`text-[10px] ${providerKeyCheckTone(providerKeyChecks[p.id])}`}>
                                                                    {providerKeyCheckMessage(providerKeyChecks[p.id])}
                                                                </p>
                                                            )}
                                                            <p className="text-[10px] text-[#777]">{p.models.length} models listed. Empty user key uses included access when available.</p>
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {activeTab === 'autoApprove' && (
                        <div className="mx-auto max-w-3xl space-y-6">
                            <section className="space-y-4">
                                <div className="flex items-start gap-3">
                                    <input id="aa-enabled" type="checkbox" checked={autoApproval.enabled} onChange={(event) => setAutoApproval(prev => ({ ...prev, enabled: event.target.checked }))} className="mt-1 accent-[#0e639c]" />
                                    <div>
                                        <label htmlFor="aa-enabled" className="cursor-pointer text-sm font-medium">Enable auto-approval</label>
                                        <p className="mt-0.5 text-xs text-[#888]">When disabled, writes, commands, browser and MCP tools ask first.</p>
                                    </div>
                                </div>
                                <div className="rounded border border-white/10 bg-white/[0.03] p-3">
                                    <div className="flex items-start gap-3">
                                        <input type="checkbox" checked disabled className="mt-1 opacity-60" />
                                        <div>
                                            <div className="text-sm text-[#bbb]">Read workspace files</div>
                                            <p className="text-[10px] text-[#777]">Read-only workspace tools are always allowed silently by core.</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                    {[
                                        ['read_files_external', 'Read external files', 'Outside the current workspace.'],
                                        ['edit_files', 'Edit workspace files', 'Write tools inside the project.'],
                                        ['edit_files_external', 'Edit external files', 'Absolute paths outside the project.'],
                                        ['delete_files', 'Delete workspace files', 'Handled separately from edits.'],
                                        ['delete_files_external', 'Delete external files', 'Highest file-system risk.'],
                                        ['execute_safe_commands', 'Run safe commands', 'Commands classified as safe.'],
                                        ['execute_all_commands', 'Run all commands', 'Uses allow and deny command rules.'],
                                        ['use_browser', 'Use browser tools', 'Open, click, type and screenshot.'],
                                        ['use_mcp', 'Use MCP tools', 'External MCP server tools.'],
                                    ].map(([id, label, note]) => (
                                        <label key={id} className="flex cursor-pointer items-start gap-3 rounded border border-white/10 bg-white/[0.03] p-3">
                                            <input
                                                type="checkbox"
                                                checked={Boolean((autoApproval as any)[id])}
                                                onChange={(event) => setAutoApproval(prev => ({ ...prev, [id]: event.target.checked }))}
                                                className="mt-1 accent-[#0e639c]"
                                            />
                                            <span>
                                                <span className="block text-sm text-[#ddd]">{label}</span>
                                                <span className="block text-[10px] text-[#777]">{note}</span>
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </section>
                            <section className="space-y-3 border-t border-[#333] pt-5">
                                <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Auto-approval budget</h3>
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <label className="text-xs text-[#888]">Max auto-approved requests</label>
                                        <Input type="number" min={0} value={autoApproval.max_requests || 0} onChange={(event) => setAutoApproval(prev => ({ ...prev, max_requests: parseInt(event.target.value, 10) || 0 }))} className="h-8 text-xs" />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs text-[#888]">Max auto-approved cost USD</label>
                                        <Input type="number" min={0} step="0.01" value={autoApproval.max_cost_usd || 0} onChange={(event) => setAutoApproval(prev => ({ ...prev, max_cost_usd: parseFloat(event.target.value) || 0 }))} className="h-8 text-xs" />
                                    </div>
                                </div>
                                <p className="text-[10px] text-[#777]">Use 0 for unlimited. Limits reset per active session budget window.</p>
                            </section>
                        </div>
                    )}

                    {activeTab === 'permissions' && <PermissionsTab />}

                    {activeTab === 'context' && (
                        <div className="mx-auto max-w-3xl space-y-6">
                            <section className="space-y-3">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Context health</h3>
                                        <p className="mt-1 text-[11px] text-[#777]">Live view of what the active session sends to the model.</p>
                                    </div>
                                    <span className={`rounded border px-2 py-1 text-[11px] font-medium ${activeContextHealth.tone}`}>
                                        {activeContextHealth.label}
                                    </span>
                                </div>

                                <div className="rounded border border-white/10 bg-white/[0.03] p-3">
                                    <div className="grid gap-3 md:grid-cols-4">
                                        {[
                                            ['Session', currentSession?.title || activeContextStatus?.session_id || 'No active session'],
                                            ['Context', activeContextWindow > 0 ? `${formatUsageTokens(activeContextTokens)} / ${formatContextWindow(activeContextWindow)}` : 'No snapshot yet'],
                                            ['Threshold', `${activeContextThreshold}%`],
                                            ['Restore points', activeCheckpointStatus?.enabled ? `${activeCheckpointStatus.checkpoint_count || 0} saved` : 'Off'],
                                        ].map(([label, value]) => (
                                            <div key={label} className="min-w-0">
                                                <div className="text-[10px] uppercase tracking-wide text-[#777]">{label}</div>
                                                <div className="mt-1 truncate text-[12px] font-medium text-[#ddd]" title={value}>{value}</div>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="mt-3 flex items-center gap-3">
                                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                                            <div
                                                className={`h-full rounded-full ${activeContextPercent >= 90 ? 'bg-red-400' : activeContextPercent >= activeContextThreshold ? 'bg-amber-400' : activeContextPercent >= 60 ? 'bg-yellow-400' : 'bg-[#0e639c]'}`}
                                                style={{ width: `${activeContextPercent}%` }}
                                            />
                                        </div>
                                        <span className="w-10 text-right text-[11px] font-medium text-[#bbb]">{activeContextPercent}%</span>
                                    </div>
                                    {(activeContextWarnings.length > 0 || activeContextSuggestions.length > 0 || activeContextStatus?.last_compaction) && (
                                        <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                                            {activeContextStatus?.last_compaction?.event && (
                                                <span className="rounded bg-blue-400/10 px-2 py-1 text-blue-300">
                                                    Last: {activeContextStatus.last_compaction.event === 'context_truncated' ? 'Emergency trim' : activeContextStatus.last_compaction.event === 'context_compaction_failed' ? 'Compact failed' : 'Compact'}
                                                </span>
                                            )}
                                            {activeContextWarnings.slice(0, 2).map((warning) => (
                                                <span key={warning} className="rounded bg-amber-400/10 px-2 py-1 text-amber-300">{warning}</span>
                                            ))}
                                            {activeContextSuggestions.slice(0, 2).map((suggestion) => (
                                                <span key={suggestion} className="rounded bg-white/5 px-2 py-1 text-[#aaa]">{suggestion}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="flex flex-wrap gap-2">
                                    <button type="button" onClick={compactContextNow} disabled={contextAction === 'compacting'} className="inline-flex h-8 items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-3 text-[12px] text-[#ddd] hover:bg-white/[0.07] disabled:opacity-50">
                                        {contextAction === 'compacting' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Brain className="h-3.5 w-3.5" />}
                                        Compact now
                                    </button>
                                    <button type="button" onClick={clearContextForNewTask} className="inline-flex h-8 items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-3 text-[12px] text-[#ddd] hover:bg-white/[0.07]">
                                        <XCircle className="h-3.5 w-3.5" />
                                        Clear for new task
                                    </button>
                                    <button type="button" onClick={copyContextReport} className="inline-flex h-8 items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-3 text-[12px] text-[#ddd] hover:bg-white/[0.07]">
                                        <Copy className="h-3.5 w-3.5" />
                                        Copy report
                                    </button>
                                    <button type="button" onClick={() => setActiveTab('usage')} className="inline-flex h-8 items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-3 text-[12px] text-[#ddd] hover:bg-white/[0.07]">
                                        <Gauge className="h-3.5 w-3.5" />
                                        Open Usage
                                    </button>
                                    <button type="button" onClick={refreshContextStatus} disabled={contextAction === 'loading'} className="inline-flex h-8 items-center gap-2 rounded border border-white/10 bg-white/[0.04] px-3 text-[12px] text-[#ddd] hover:bg-white/[0.07] disabled:opacity-50">
                                        {contextAction === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gauge className="h-3.5 w-3.5" />}
                                        Refresh
                                    </button>
                                </div>
                                {contextActionMessage && (
                                    <div className={`rounded border px-3 py-2 text-[11px] ${contextAction === 'error' ? 'border-red-400/20 bg-red-400/10 text-red-300' : 'border-white/10 bg-white/[0.03] text-[#aaa]'}`}>
                                        {contextActionMessage}
                                    </div>
                                )}
                            </section>

                            <section className="space-y-4 border-t border-[#333] pt-5">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Compaction</h3>
                                        <p className="mt-1 text-[11px] text-[#777]">Auto-compact keeps long sessions usable without ending the task.</p>
                                    </div>
                                </div>
                                <label className="flex cursor-pointer items-start gap-3">
                                    <input type="checkbox" checked={contextSettings.auto_condense} onChange={(event) => setContextSettings(prev => ({ ...prev, auto_condense: event.target.checked }))} className="mt-1 accent-[#0e639c]" />
                                    <span>
                                        <span className="block text-sm font-medium">Auto-compact long sessions</span>
                                        <span className="block text-xs text-[#888]">Summarize older turns near the selected threshold.</span>
                                    </span>
                                </label>
                                {contextSettings.auto_condense && (
                                    <div className="space-y-3 pl-7">
                                        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                                            {[
                                                ['early', 'Early', '60%'],
                                                ['balanced', 'Balanced', '70%'],
                                                ['late', 'Late', '85%'],
                                                ['custom', 'Custom', `${contextSettings.condense_threshold}%`],
                                            ].map(([value, label, meta]) => (
                                                <button
                                                    key={value}
                                                    type="button"
                                                    onClick={() => handleContextPresetChange(value as ContextThresholdPreset)}
                                                    className={`rounded border px-3 py-2 text-left ${thresholdPreset === value ? 'border-[#0e639c] bg-[#0e639c]/20 text-[#e6f4ff]' : 'border-white/10 bg-white/[0.03] text-[#aaa] hover:bg-white/[0.06]'}`}
                                                >
                                                    <span className="block text-[12px] font-medium">{label}</span>
                                                    <span className="block text-[10px] text-[#777]">{meta}</span>
                                                </button>
                                            ))}
                                        </div>
                                        {thresholdPreset === 'custom' && (
                                            <div className="space-y-2">
                                                <div className="flex justify-between text-[10px] text-[#888]"><span>Custom threshold</span><span>{contextSettings.condense_threshold}%</span></div>
                                                <input type="range" min="50" max="95" step="5" value={contextSettings.condense_threshold} onChange={(event) => setContextSettings(prev => ({ ...prev, condense_threshold: parseInt(event.target.value, 10) }))} className="w-full accent-[#0e639c]" />
                                            </div>
                                        )}
                                    </div>
                                )}
                                <label className="flex cursor-pointer items-start gap-3">
                                    <input type="checkbox" checked={contextSettings.show_context_indicator} onChange={(event) => setContextSettings(prev => ({ ...prev, show_context_indicator: event.target.checked }))} className="mt-1 accent-[#0e639c]" />
                                    <span>
                                        <span className="block text-sm font-medium">Show context indicator</span>
                                        <span className="block text-xs text-[#888]">Show live context usage near the chat input.</span>
                                    </span>
                                </label>
                            </section>

                            <section className="space-y-4 border-t border-[#333] pt-5">
                                <button type="button" onClick={() => setContextBreakdownOpen(value => !value)} className="flex w-full items-center justify-between gap-3 text-left">
                                    <span>
                                        <span className="block text-xs font-medium uppercase tracking-wide text-[#888]">Context breakdown</span>
                                        <span className="block text-[11px] text-[#777]">Top contributors, warnings, suggestions, and compression savings.</span>
                                    </span>
                                    <ChevronDown className={`h-4 w-4 text-[#888] transition-transform ${contextBreakdownOpen ? 'rotate-180' : ''}`} />
                                </button>
                                <label className="flex cursor-pointer items-start gap-3">
                                    <input type="checkbox" checked={contextSettings.show_contributor_panel} onChange={(event) => setContextSettings(prev => ({ ...prev, show_contributor_panel: event.target.checked }))} className="mt-1 accent-[#0e639c]" />
                                    <span className="text-sm">Show context breakdown in chat</span>
                                </label>
                                {contextBreakdownOpen && (
                                    <div className="space-y-3 rounded border border-white/10 bg-white/[0.03] p-3">
                                        {activeContextStatus?.report?.compression?.enabled && (
                                            <div className="rounded bg-white/[0.03] px-3 py-2 text-[11px] text-[#aaa]">
                                                Compression saved {formatUsageTokens(activeContextStatus.report.compression.saved_tokens)} tokens across {(activeContextStatus.report.compression.fragments || []).length} fragments.
                                            </div>
                                        )}
                                        {activeContextContributors.length === 0 ? (
                                            <div className="rounded border border-dashed border-white/15 px-3 py-6 text-center text-[11px] text-[#777]">No contributor diagnostics yet.</div>
                                        ) : (
                                            <div className="overflow-hidden rounded border border-white/10">
                                                <table className="w-full text-left text-[11px]">
                                                    <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wide text-[#777]">
                                                        <tr>
                                                            <th className="px-3 py-2 font-medium">Contributor</th>
                                                            <th className="px-3 py-2 font-medium">Type</th>
                                                            <th className="px-3 py-2 font-medium">Tokens</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-white/10">
                                                        {activeContextContributors.slice(0, 8).map((item) => (
                                                            <tr key={`${item.id}-${item.type}`} className="text-[#bbb]">
                                                                <td className="max-w-[300px] px-3 py-2">
                                                                    <div className="truncate text-[#ddd]" title={item.id}>{item.id}</div>
                                                                    {item.source && <div className="truncate text-[10px] text-[#777]">{item.source}</div>}
                                                                </td>
                                                                <td className="px-3 py-2">{item.type}</td>
                                                                <td className="px-3 py-2">{formatUsageTokens(item.tokens)}{item.percent ? ` (${Math.round(item.percent)}%)` : ''}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                        {[...activeContextWarnings, ...activeContextSuggestions].length > 0 && (
                                            <div className="space-y-1.5">
                                                {activeContextWarnings.map((warning) => (
                                                    <div key={warning} className="rounded bg-amber-400/10 px-2 py-1.5 text-[11px] text-amber-300">{warning}</div>
                                                ))}
                                                {activeContextSuggestions.map((suggestion) => (
                                                    <div key={suggestion} className="rounded bg-white/5 px-2 py-1.5 text-[11px] text-[#aaa]">{suggestion}</div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </section>

                            <section className="space-y-4 border-t border-[#333] pt-5">
                                <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Restore points</h3>
                                <label className="flex cursor-pointer items-start gap-3">
                                    <input type="checkbox" checked={contextSettings.enable_checkpoints} onChange={(event) => setContextSettings(prev => ({ ...prev, enable_checkpoints: event.target.checked }))} className="mt-1 accent-[#0e639c]" />
                                    <span>
                                        <span className="block text-sm font-medium">Workspace restore points</span>
                                        <span className="block text-xs text-[#888]">Restore points let you roll back workspace edits.</span>
                                    </span>
                                </label>
                                {contextSettings.enable_checkpoints && (
                                    <label className="flex cursor-pointer items-start gap-3 pl-7">
                                        <input type="checkbox" checked={contextSettings.checkpoint_on_writes} onChange={(event) => setContextSettings(prev => ({ ...prev, checkpoint_on_writes: event.target.checked }))} className="mt-1 accent-[#0e639c]" />
                                        <span>
                                            <span className="block text-sm">Create restore point after edits</span>
                                            <span className="block text-xs text-[#888]">Automatically save a workspace snapshot after write tools finish.</span>
                                        </span>
                                    </label>
                                )}
                                {activeCheckpointStatus && (
                                    <div className="rounded border border-white/10 bg-white/[0.03] p-3 text-[11px] text-[#aaa]">
                                        <div className="grid gap-2 md:grid-cols-3">
                                            <div><span className="text-[#777]">State</span><div className="mt-1 text-[#ddd]">{activeCheckpointStatus.initialized ? 'Ready' : activeCheckpointStatus.enabled ? 'Initializing' : 'Disabled'}</div></div>
                                            <div><span className="text-[#777]">Latest</span><div className="mt-1 font-mono text-[#ddd]">{activeCheckpointStatus.last_checkpoint_hash ? activeCheckpointStatus.last_checkpoint_hash.slice(0, 8) : '-'}</div></div>
                                            <div><span className="text-[#777]">Base</span><div className="mt-1 font-mono text-[#ddd]">{activeCheckpointStatus.base_hash ? activeCheckpointStatus.base_hash.slice(0, 8) : '-'}</div></div>
                                        </div>
                                        {(activeCheckpointStatus.error || activeCheckpointStatus.warning || activeCheckpointStatus.slow) && (
                                            <div className={`mt-3 rounded px-2 py-1.5 ${activeCheckpointStatus.error ? 'bg-red-400/10 text-red-300' : 'bg-amber-400/10 text-amber-300'}`}>
                                                {activeCheckpointStatus.error || activeCheckpointStatus.warning || 'Checkpoint operation is slow in this workspace.'}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </section>

                            <section className="space-y-4 border-t border-[#333] pt-5">
                                <button type="button" onClick={() => setContextAdvancedOpen(value => !value)} className="flex w-full items-center justify-between gap-3 text-left">
                                    <span>
                                        <span className="block text-xs font-medium uppercase tracking-wide text-[#888]">Advanced</span>
                                        <span className="block text-[11px] text-[#777]">Emergency fallback and hard per-fragment budgets.</span>
                                    </span>
                                    <ChevronDown className={`h-4 w-4 text-[#888] transition-transform ${contextAdvancedOpen ? 'rotate-180' : ''}`} />
                                </button>
                                {contextAdvancedOpen && (
                                    <div className="grid gap-3 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <label className="text-xs text-[#888]">Emergency fallback: keep recent messages</label>
                                            <Input type="number" min={4} max={100} value={contextSettings.sliding_window_size} onChange={(event) => setContextSettings(prev => ({ ...prev, sliding_window_size: parseInt(event.target.value, 10) || 20 }))} className="h-8 text-xs" />
                                            <p className="text-[10px] leading-4 text-[#777]">Only runs near the hard limit if summarization cannot make enough room.</p>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-xs text-[#888]">Max tokens per context fragment</label>
                                            <Input type="number" min={1000} max={50000} value={contextSettings.max_fragment_tokens} onChange={(event) => setContextSettings(prev => ({ ...prev, max_fragment_tokens: parseInt(event.target.value, 10) || 10000 }))} className="h-8 text-xs" />
                                            <p className="text-[10px] leading-4 text-[#777]">Caps oversized tool results and file fragments before they enter the model context.</p>
                                        </div>
                                    </div>
                                )}
                            </section>
                        </div>
                    )}

                    {activeTab === 'indexing' && (
                        <KnowledgeTab
                            settings={{
                                enable_code_index: contextSettings.enable_code_index,
                                workspace_index_enabled: contextSettings.workspace_index_enabled,
                                max_fragment_tokens: contextSettings.max_fragment_tokens,
                            }}
                            onSettingsChange={(patch) => setContextSettings(prev => ({ ...prev, ...patch }))}
                        />
                    )}

                    {activeTab === 'terminal' && (
                        <div className="mx-auto max-w-3xl space-y-4">
                            <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Command Output</h3>
                            <div className="space-y-2">
                                <div className="flex justify-between text-xs text-[#888]"><span>Terminal output line limit</span><span>{terminal.output_line_limit}</span></div>
                                <input
                                    type="range"
                                    min="100"
                                    max="2000"
                                    step="50"
                                    value={terminal.output_line_limit}
                                    onChange={(event) => setTerminal({ output_line_limit: parseInt(event.target.value, 10) || 500 })}
                                    className="w-full accent-[#0e639c]"
                                />
                                <p className="text-[11px] text-[#777]">Command logs remain available; chat output is truncated from the middle after this line count.</p>
                            </div>
                        </div>
                    )}

                    {activeTab === 'usage' && (
                        <div className="mx-auto max-w-3xl space-y-6">
                            <section className="space-y-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Usage Meter</h3>
                                        <p className="mt-1 text-[11px] text-[#777]">Local transparency meter. Cost is estimated unless marked provider-reported. This is not your Grik credits balance.</p>
                                    </div>
                                    <div className="inline-flex overflow-hidden rounded border border-white/10 bg-white/[0.03] p-0.5">
                                        {[
                                            ['current', 'Current session'],
                                            ['all', 'All saved sessions'],
                                        ].map(([value, label]) => (
                                            <button
                                                key={value}
                                                type="button"
                                                onClick={() => setUsageScope(value as UsageScope)}
                                                className={`h-7 rounded px-2.5 text-[11px] ${usageScope === value ? 'bg-[#0e639c] text-white' : 'text-[#888] hover:bg-white/5 hover:text-[#ddd]'}`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-2 rounded border border-white/10 bg-white/[0.03] p-3 md:grid-cols-6">
                                    {[
                                        ['Scope', usageScope === 'all' ? `${sessions.filter(session => session.usage).length} saved sessions` : (currentSession?.title || usageSnapshot?.sessionId || 'Active session')],
                                        ['Requests', activeUsageHasData ? String(activeUsageSnapshot?.requestCount || 0) : '-'],
                                        ['Input', activeUsageHasData ? formatUsageTokens(activeUsageSnapshot?.inputTokens) : '-'],
                                        ['Output', activeUsageHasData ? formatUsageTokens(activeUsageSnapshot?.outputTokens) : '-'],
                                        ['Cost', activeUsageHasData ? formatUsageCost(activeUsageSnapshot?.estimatedCostUsd) : '-'],
                                        ['Source', usageSourceLabel(activeUsageSnapshot)],
                                    ].map(([label, value]) => (
                                        <div key={label} className="min-w-0">
                                            <div className="text-[10px] uppercase tracking-wide text-[#777]">{label}</div>
                                            <div className="mt-1 truncate text-[12px] font-medium text-[#ddd]" title={value}>{value}</div>
                                        </div>
                                    ))}
                                </div>

                                {!activeUsageHasData ? (
                                    <div className="rounded border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center">
                                        <div className="text-sm font-medium text-[#ddd]">No usage recorded</div>
                                        <p className="mx-auto mt-2 max-w-md text-[11px] leading-5 text-[#777]">
                                            Usage appears after a model request completes for this {usageScope === 'all' ? 'workspace history' : 'session'}.
                                        </p>
                                    </div>
                                ) : (
                                    <>
                                        {usageScope === 'current' && usageContextWindow > 0 && (
                                            <div className="rounded border border-white/10 bg-white/[0.03] p-3">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="text-[11px] font-medium text-[#bbb]">Context window</div>
                                                        <div className="mt-1 text-[10px] text-[#777]">
                                                            {formatUsageTokens(usageContextTokens)} / {formatUsageTokens(usageContextWindow)} tokens
                                                        </div>
                                                    </div>
                                                    <div className="text-[12px] font-medium text-[#ddd]">{usageContextPercent}%</div>
                                                </div>
                                                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                                                    <div
                                                        className={`h-full rounded-full ${usageContextPercent >= 85 ? 'bg-red-400' : usageContextPercent >= 70 ? 'bg-amber-400' : 'bg-[#0e639c]'}`}
                                                        style={{ width: `${usageContextPercent}%` }}
                                                    />
                                                </div>
                                                {(contextStatus?.was_condensed || contextStatus?.was_truncated || contextStatus?.warnings?.length || contextStatus?.suggestions?.length || contextStatus?.report?.compression?.enabled) && (
                                                    <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-[#888]">
                                                        {contextStatus?.was_condensed && <span className="rounded bg-blue-400/10 px-2 py-1 text-blue-300">Auto-condensed</span>}
                                                        {contextStatus?.was_truncated && <span className="rounded bg-amber-400/10 px-2 py-1 text-amber-300">Truncated</span>}
                                                        {contextStatus?.report?.compression?.enabled && (
                                                            <span className="rounded bg-white/5 px-2 py-1">
                                                                Compression saved {formatUsageTokens(contextStatus.report.compression.saved_tokens)}
                                                            </span>
                                                        )}
                                                        {contextStatus?.warnings?.slice(0, 2).map((warning) => (
                                                            <span key={warning} className="rounded bg-amber-400/10 px-2 py-1 text-amber-300">{warning}</span>
                                                        ))}
                                                        {contextStatus?.suggestions?.slice(0, 2).map((suggestion) => (
                                                            <span key={suggestion} className="rounded bg-white/5 px-2 py-1">{suggestion}</span>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                                            {[
                                                ['Input', activeUsageSnapshot?.inputTokens],
                                                ['Output', activeUsageSnapshot?.outputTokens],
                                                ['Cached read', activeUsageSnapshot?.cachedInputTokens],
                                                ['Cache write', activeUsageSnapshot?.cacheCreationTokens],
                                                ['Reasoning', activeUsageSnapshot?.reasoningOutputTokens],
                                            ].map(([label, value]) => (
                                                <div key={label} className="rounded border border-white/10 bg-white/[0.03] p-3">
                                                    <div className="text-[10px] uppercase tracking-wide text-[#777]">{label}</div>
                                                    <div className="mt-1 text-base font-medium text-[#ddd]">{formatUsageTokens(Number(value) || 0)}</div>
                                                </div>
                                            ))}
                                        </div>

                                        <div className="overflow-hidden rounded border border-white/10 bg-white/[0.03]">
                                            <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                                                <span className="text-[11px] font-medium text-[#bbb]">Models</span>
                                                <span className="text-[10px] text-[#777]">{usageSourceLabel(activeUsageSnapshot)}</span>
                                            </div>
                                            <div className="overflow-x-auto">
                                                <table className="w-full min-w-[720px] text-left text-[11px]">
                                                    <thead className="bg-white/[0.02] text-[10px] uppercase tracking-wide text-[#777]">
                                                        <tr>
                                                            <th className="px-3 py-2 font-medium">Model</th>
                                                            <th className="px-3 py-2 font-medium">Req</th>
                                                            <th className="px-3 py-2 font-medium">Input</th>
                                                            <th className="px-3 py-2 font-medium">Output</th>
                                                            <th className="px-3 py-2 font-medium">Cache</th>
                                                            <th className="px-3 py-2 font-medium">Reasoning</th>
                                                            <th className="px-3 py-2 font-medium">Cost</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-white/10">
                                                        {(activeUsageSnapshot?.models || []).map(item => (
                                                            <tr key={`${item.provider}-${item.model}-${item.keySource || 'none'}`} className="text-[#bbb]">
                                                                <td className="max-w-[260px] px-3 py-2">
                                                                    <div className="truncate text-[#ddd]" title={item.model}>{item.model}</div>
                                                                    <div className="truncate text-[10px] text-[#777]">{item.provider} / {keySourceLabel(item.keySource)} / {item.source}</div>
                                                                </td>
                                                                <td className="px-3 py-2">{item.requestCount}</td>
                                                                <td className="px-3 py-2">{formatUsageTokens(item.inputTokens)}</td>
                                                                <td className="px-3 py-2">{formatUsageTokens(item.outputTokens)}</td>
                                                                <td className="px-3 py-2">{formatUsageTokens(item.cachedInputTokens)} read / {formatUsageTokens(item.cacheCreationTokens)} write</td>
                                                                <td className="px-3 py-2">{formatUsageTokens(item.reasoningOutputTokens)}</td>
                                                                <td className="px-3 py-2">{formatUsageCost(item.estimatedCostUsd)}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>

                                        <div className="overflow-hidden rounded border border-white/10 bg-white/[0.03]">
                                            <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                                                <span className="text-[11px] font-medium text-[#bbb]">Recent requests</span>
                                                <span className="text-[10px] text-[#777]">Last {usageEvents.length}</span>
                                            </div>
                                            {usageEvents.length ? (
                                                <div className="max-h-72 overflow-auto">
                                                    <table className="w-full min-w-[760px] text-left text-[11px]">
                                                        <thead className="sticky top-0 bg-[#1e1e1e] text-[10px] uppercase tracking-wide text-[#777]">
                                                            <tr>
                                                                <th className="px-3 py-2 font-medium">Time</th>
                                                                <th className="px-3 py-2 font-medium">Operation</th>
                                                                <th className="px-3 py-2 font-medium">Model</th>
                                                                <th className="px-3 py-2 font-medium">Input</th>
                                                                <th className="px-3 py-2 font-medium">Output</th>
                                                                <th className="px-3 py-2 font-medium">Cache</th>
                                                                <th className="px-3 py-2 font-medium">Reasoning</th>
                                                                <th className="px-3 py-2 font-medium">Cost</th>
                                                                <th className="px-3 py-2 font-medium">Source</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-white/10">
                                                            {usageEvents.map((event, index) => (
                                                                <tr key={`${event.turnId || event.runId || event.timestamp || index}-${index}`} className="text-[#bbb]">
                                                                    <td className="whitespace-nowrap px-3 py-2 text-[#888]">{formatUsageTime(event.timestamp)}</td>
                                                                    <td className="px-3 py-2">{operationLabel(event.operation)}</td>
                                                                    <td className="max-w-[220px] px-3 py-2">
                                                                        <div className="truncate text-[#ddd]" title={event.model}>{event.model}</div>
                                                                        <div className="truncate text-[10px] text-[#777]">{event.provider} / {keySourceLabel(event.keySource)}</div>
                                                                    </td>
                                                                    <td className="px-3 py-2">{formatUsageTokens(event.inputTokens)}</td>
                                                                    <td className="px-3 py-2">{formatUsageTokens(event.outputTokens)}</td>
                                                                    <td className="px-3 py-2">{formatUsageTokens(event.cachedInputTokens)} read / {formatUsageTokens(event.cacheCreationTokens)} write</td>
                                                                    <td className="px-3 py-2">{formatUsageTokens(event.reasoningOutputTokens)}</td>
                                                                    <td className="px-3 py-2">{formatUsageCost(event.estimatedCostUsd)}</td>
                                                                    <td className="px-3 py-2">{event.source === 'actual' ? 'Provider tokens' : event.source}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            ) : (
                                                <div className="px-3 py-4 text-[11px] text-[#777]">No recent request events retained.</div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </section>
                        </div>
                    )}

                    {activeTab === 'marketplace' && (
                        <MarketplaceView />
                    )}

                    {activeTab === 'skills' && (
                        <div className="mx-auto max-w-3xl">
                            <SkillsTab
                                customInstructions={customInstructions}
                                setCustomInstructions={setCustomInstructions}
                                onOpenMarketplace={() => setActiveTab('marketplace')}
                            />
                        </div>
                    )}

                    {activeTab === 'integrations' && (
                        <div className="mx-auto max-w-3xl space-y-8">
                            <section className="space-y-4">
                                <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Ether</h3>
                                <div className="rounded border border-white/10 bg-white/[0.03] p-3">
                                    <div className="flex items-start gap-2">
                                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#888]" />
                                        <p className="text-xs text-[#888]">Ether Gateway lets Telegram and Discord control Ricochet through sent messages and explicit button actions. It does not read drafts or typing in other apps.</p>
                                    </div>
                                </div>
                                <div className="rounded border border-white/10 bg-white/[0.03] p-3">
                                    <label className="flex items-start gap-3">
                                        <input
                                            type="checkbox"
                                            checked={allowRemoteSessionStart}
                                            onChange={(event) => setAllowRemoteSessionStart(event.target.checked)}
                                            className="mt-0.5"
                                        />
                                        <span className="min-w-0">
                                            <span className="flex items-center gap-1.5 text-xs font-medium text-[#ddd]">
                                                <span>Allow remote messages to wake Ether and start sessions</span>
                                                <span title="When disabled, Telegram and Discord can only control already linked sessions. /new or first unbound sent messages will be rejected.">
                                                    <HelpCircle className="h-3 w-3 text-[#777]" />
                                                </span>
                                            </span>
                                            <span className="mt-1 block text-[11px] leading-relaxed text-[#888]">Keep this off until Telegram chat IDs or Discord user/channel allowlists are set. Remote start uses sent messages only, never draft text or typing activity.</span>
                                        </span>
                                    </label>
                                </div>
                                <div id="voice-input-settings" className="space-y-3 rounded border border-white/10 bg-white/[0.03] p-3">
                                    <div className="flex items-start gap-2">
                                        <Mic className="mt-0.5 h-4 w-4 shrink-0 text-[#888]" />
                                        <div>
                                            <h4 className="text-xs font-medium text-[#ddd]">Voice input</h4>
                                            <p className="mt-1 text-[11px] leading-relaxed text-[#888]">Microphone transcription runs locally through ffmpeg and Whisper. Keep ffmpeg on PATH, then set the Whisper binary and ggml model below. The mic button records local webview audio; Ether handles remote Telegram/Discord voice messages separately. Audio is not uploaded to model providers.</p>
                                        </div>
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <label className="text-xs text-[#888]">Whisper binary</label>
                                            <Input value={whisperBinary} onChange={(event) => setWhisperBinary(event.target.value)} placeholder="/path/to/main or whisper-cli" />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-xs text-[#888]">Whisper model</label>
                                            <Input value={whisperModel} onChange={(event) => setWhisperModel(event.target.value)} placeholder="/path/to/ggml-model.bin" />
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs text-[#888]">Telegram Bot Token</label>
                                    <Input type="password" value={telegramToken} onChange={(event) => setTelegramToken(event.target.value)} placeholder="123456789:ABCdef..." />
                                    {isVerifying && <div className="flex items-center gap-2 text-xs text-blue-400"><Loader2 className="h-3 w-3 animate-spin" /><span>Verifying token...</span></div>}
                                    {botInfo && !isVerifying && (
                                        <div className={`flex items-center gap-2 text-xs ${botInfo.ok ? 'text-green-400' : 'text-red-400'}`}>
                                            {botInfo.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                                            <span>{botInfo.ok ? `Connected: @${botInfo.username} (${botInfo.firstName})` : botInfo.error}</span>
                                        </div>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs text-[#888]">Your Telegram Chat ID</label>
                                    <div className="flex gap-2">
                                        <Input value={telegramChatId} onChange={(event) => setTelegramChatId(event.target.value)} placeholder="123456789" className="flex-1" />
                                        <button
                                            onClick={() => {
                                                if (!telegramToken || !telegramChatId) return;
                                                setTestStatus('sending');
                                                postMessage({ type: 'test_telegram', payload: { token: telegramToken, chatId: parseInt(telegramChatId, 10) } });
                                            }}
                                            disabled={!telegramToken || !telegramChatId || testStatus === 'sending'}
                                            className="whitespace-nowrap rounded bg-[#0e639c] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#1177bb] disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {testStatus === 'sending' ? '...' : 'Send Test'}
                                        </button>
                                    </div>
                                    {testStatus === 'success' && <div className="flex items-center gap-2 text-xs text-green-400"><CheckCircle className="h-3 w-3" /><span>Test message sent.</span></div>}
                                    {testStatus === 'error' && <div className="flex items-center gap-2 text-xs text-red-400"><XCircle className="h-3 w-3" /><span>Failed to send. Check Chat ID.</span></div>}
                                </div>
                                <div className="space-y-3 border-t border-[#333] pt-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-medium uppercase tracking-wide text-[#888]">Discord</h4>
                                            <span title="Install Ricochet into a Discord server, then use /ricochet new to create a session thread. Server channels require /ricochet commands or @Ricochet when Require mention is enabled. Ricochet-created threads and DMs accept direct text. Allowed User IDs use Discord user IDs; Allowed Channel IDs use the channel ID or parent channel ID for threads.">
                                                <HelpCircle className="h-3.5 w-3.5 text-[#777]" />
                                            </span>
                                        </div>
                                        {discordBotInfo?.ok && <span className="text-[10px] text-[#777]">Installed separately through Discord OAuth link</span>}
                                    </div>
                                    <div className="rounded border border-[#5865f2]/25 bg-[#5865f2]/10 p-3">
                                        <div className="flex items-start gap-2">
                                            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#9aa3ff]" />
                                            <div className="min-w-0 flex-1 space-y-2">
                                                <p className="text-xs text-[#d9dcff]">Best path: install bot to your Discord server, run <span className="font-mono">/ricochet new</span>, then write directly in the created thread.</p>
                                                <div className="flex flex-wrap gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => discordInstallUrl && postMessage({ type: 'open_external', payload: { url: discordInstallUrl } })}
                                                        disabled={!discordInstallUrl}
                                                        title={discordInstallUrl ? 'Open Discord bot install flow' : 'Paste the Discord Application ID from Discord Developer Portal first.'}
                                                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded bg-[#5865f2] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#6c75f4] disabled:cursor-not-allowed disabled:opacity-50"
                                                    >
                                                        <ExternalLink className="h-3 w-3" />
                                                        Install in Discord
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => discordInstallUrl && copyDiscordSetupText(discordInstallUrl, 'Install URL')}
                                                        disabled={!discordInstallUrl}
                                                        title={discordInstallUrl ? 'Copy generated Discord install URL' : 'Paste the Discord Application ID first.'}
                                                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-[#ddd] transition-colors hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-50"
                                                    >
                                                        <Copy className="h-3 w-3" />
                                                        Copy Install URL
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => copyDiscordSetupText(discordSetupSteps, 'Setup steps')}
                                                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-[#ddd] transition-colors hover:bg-white/[0.07]"
                                                    >
                                                        <Copy className="h-3 w-3" />
                                                        Copy My Setup Steps
                                                    </button>
                                                </div>
                                                {discordSetupNotice && <div className="text-[11px] text-[#9aa3ff]">{discordSetupNotice}</div>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs text-[#888]">Discord Bot Token</label>
                                        <Input type="password" value={discordToken} onChange={(event) => setDiscordToken(event.target.value)} placeholder="Bot token from Discord Developer Portal" />
                                        {isVerifyingDiscord && <div className="flex items-center gap-2 text-xs text-blue-400"><Loader2 className="h-3 w-3 animate-spin" /><span>Verifying Discord token...</span></div>}
                                        {discordBotInfo && !isVerifyingDiscord && (
                                            <div className={`flex items-center gap-2 text-xs ${discordBotInfo.ok ? 'text-green-400' : 'text-red-400'}`}>
                                                {discordBotInfo.ok ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                                                <span>{discordBotInfo.ok ? `Connected: @${discordBotInfo.username} (${discordBotInfo.firstName})` : discordBotInfo.error}</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="grid gap-3 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <label className="flex items-center gap-1.5 text-xs text-[#888]">
                                                <span>Discord Application ID</span>
                                                <span title="Required for the Install in Discord link. Copy it from Discord Developer Portal → Applications → Ricochet → General Information.">
                                                    <HelpCircle className="h-3 w-3 text-[#777]" />
                                                </span>
                                            </label>
                                            <Input value={discordApplicationId} onChange={(event) => setDiscordApplicationId(event.target.value)} placeholder="optional" />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-xs text-[#888]">Discord Guild ID</label>
                                            <Input value={discordGuildId} onChange={(event) => setDiscordGuildId(event.target.value)} placeholder="optional server restriction" />
                                        </div>
                                    </div>
                                    <div className="grid gap-3 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <label className="text-xs text-[#888]">Allowed Discord User IDs</label>
                                            <Input value={discordAllowedUserIds} onChange={(event) => setDiscordAllowedUserIds(event.target.value)} placeholder="comma separated, blank allows all" />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-xs text-[#888]">Allowed Discord Channel IDs</label>
                                            <Input value={discordAllowedChannelIds} onChange={(event) => setDiscordAllowedChannelIds(event.target.value)} placeholder="comma separated, blank allows all" />
                                        </div>
                                    </div>
                                    {allowRemoteSessionStart && (
                                        <div className="rounded border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                                            Remote session start is enabled. Sent Telegram or Discord messages can wake Ether and start agent sessions. Use chat restrictions and user/channel allowlists so only trusted people can control this IDE.
                                        </div>
                                    )}
                                    <div className="flex flex-wrap gap-4 text-xs text-[#ccc]">
                                        <label className="flex items-center gap-2">
                                            <input type="checkbox" checked={discordRequireMention} onChange={(event) => setDiscordRequireMention(event.target.checked)} />
                                            <span>Require mention in guild text mode</span>
                                        </label>
                                        <label className="flex items-center gap-2">
                                            <input type="checkbox" checked={discordTextMode} onChange={(event) => setDiscordTextMode(event.target.checked)} />
                                            <span>Enable ordinary message text mode</span>
                                        </label>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="flex items-center gap-1.5 text-xs text-[#888]">
                                            <span>Discord Test Channel ID</span>
                                            <span title="Use a channel or thread where the installed bot can Send Messages. For Ricochet-created threads, the parent channel can be allowlisted.">
                                                <HelpCircle className="h-3 w-3 text-[#777]" />
                                            </span>
                                        </label>
                                        <div className="flex gap-2">
                                            <Input value={discordTestChannelId} onChange={(event) => setDiscordTestChannelId(event.target.value)} placeholder="channel id for test message" className="flex-1" />
                                            <button
                                                onClick={() => {
                                                    if (!discordToken || !discordTestChannelId) return;
                                                    setDiscordTestStatus('sending');
                                                    postMessage({ type: 'test_discord', payload: { token: discordToken, channelId: discordTestChannelId } });
                                                }}
                                                disabled={!discordToken || !discordTestChannelId || discordTestStatus === 'sending'}
                                                className="whitespace-nowrap rounded bg-[#5865f2] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#6c75f4] disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {discordTestStatus === 'sending' ? '...' : 'Send Test'}
                                            </button>
                                        </div>
                                        {discordTestStatus === 'success' && <div className="flex items-center gap-2 text-xs text-green-400"><CheckCircle className="h-3 w-3" /><span>Discord test message sent.</span></div>}
                                        {discordTestStatus === 'error' && <div className="flex items-center gap-2 text-xs text-red-400"><XCircle className="h-3 w-3" /><span>Failed to send. Check bot permissions and channel ID.</span></div>}
                                    </div>
                                </div>
                            </section>
                            <section className="space-y-4 border-t border-[#333] pt-6">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">MCP Servers</h3>
                                        <p className="mt-1 text-[11px] text-[#888]">Configured MCP runtime status. Discovery and install now live in Marketplace.</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setActiveTab('marketplace')}
                                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-3 text-xs font-medium text-[#ddd] transition-colors hover:bg-white/[0.07]"
                                    >
                                        <LayoutGrid className="h-3.5 w-3.5" />
                                        Open Marketplace
                                    </button>
                                </div>
                                <div className="space-y-2 rounded border border-white/10 bg-white/[0.03] p-3">
                                    {mcpServers.length === 0 ? (
                                        <p className="text-[11px] text-[#888]">No MCP servers are currently connected.</p>
                                    ) : (
                                        mcpServers.map((server) => (
                                            <div key={server.name || server.id} className="flex items-center justify-between gap-3 rounded bg-white/[0.03] px-3 py-2">
                                                <div className="min-w-0">
                                                    <div className="truncate text-xs font-medium text-[#ddd]">{server.name || server.id}</div>
                                                    {server.error && <div className="mt-0.5 truncate text-[10.5px] text-red-300">{server.error}</div>}
                                                </div>
                                                <span className={`rounded px-2 py-0.5 text-[10px] ${server.status === 'connected' ? 'bg-emerald-400/10 text-emerald-200' : server.status === 'error' ? 'bg-red-400/10 text-red-200' : 'bg-white/[0.06] text-[#888]'}`}>
                                                    {server.status || 'configured'}
                                                </span>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </section>
                        </div>
                    )}

                    {activeTab === 'about' && (
                        <div className="mx-auto max-w-3xl space-y-6">
                            <section className="space-y-4">
                                <div className="flex items-center gap-4">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-[#0e639c] shadow-lg">
                                        <RicochetLogo className="h-8 w-8 text-white" />
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold tracking-tight text-white">Ricochet</h3>
                                        <p className="text-sm text-[#888]">Version 0.0.1</p>
                                        <div className="mt-2 flex gap-2">
                                            <a href="https://github.com/Grik-ai/ricochet" target="_blank" rel="noreferrer" className="text-[#888] transition-colors hover:text-white"><Github className="h-4 w-4" /></a>
                                            <a href="https://www.linkedin.com/in/igoryan34/" target="_blank" rel="noreferrer" className="text-[#888] transition-colors hover:text-white"><Linkedin className="h-4 w-4" /></a>
                                            <a href="https://x.com/genecental" target="_blank" rel="noreferrer" className="text-[#888] transition-colors hover:text-white"><Twitter className="h-4 w-4" /></a>
                                        </div>
                                    </div>
                                </div>
                                <p className="text-sm leading-relaxed text-[#ccc]">Ricochet is a hybrid AI coding agent with local control, provider choice and transparent autonomy settings.</p>
                            </section>
                            <section className="space-y-3 border-t border-[#333] pt-4">
                                <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[#888]"><HelpCircle className="h-3 w-3 text-sky-300" /> Support & Feedback</h3>
                                <p className="text-xs leading-relaxed text-[#888]">Questions, issues, or feature requests? Email support, or message the CEO on Telegram for urgent help.</p>
                                <div className="grid gap-2 sm:grid-cols-2">
                                    <a
                                        href="mailto:support@grik.io"
                                        className="flex min-w-0 items-center justify-between gap-3 rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-left transition-colors hover:bg-white/[0.06]"
                                    >
                                        <span className="flex min-w-0 items-center gap-2">
                                            <Mail className="h-3.5 w-3.5 shrink-0 text-[#888]" />
                                            <span className="min-w-0">
                                                <span className="block text-xs font-medium text-[#aaa]">Email Support</span>
                                                <span className="block truncate text-[10px] text-[#666]">support@grik.io</span>
                                            </span>
                                        </span>
                                        <ExternalLink className="h-3 w-3 shrink-0 text-[#666]" />
                                    </a>
                                    <a
                                        href="https://t.me/igoryan_dao"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="flex min-w-0 items-center justify-between gap-3 rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-left transition-colors hover:bg-white/[0.06]"
                                    >
                                        <span className="flex min-w-0 items-center gap-2">
                                            <Send className="h-3.5 w-3.5 shrink-0 text-[#888]" />
                                            <span className="min-w-0">
                                                <span className="block text-xs font-medium text-[#aaa]">Telegram CEO</span>
                                                <span className="block truncate text-[10px] text-[#666]">@igoryan_dao</span>
                                            </span>
                                        </span>
                                        <ExternalLink className="h-3 w-3 shrink-0 text-[#666]" />
                                    </a>
                                </div>
                            </section>
                            <section className="space-y-3 border-t border-[#333] pt-4">
                                <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[#888]"><Heart className="h-3 w-3 text-red-400" /> Support the Project</h3>
                                <div className="space-y-2">
                                    <p className="text-xs text-[#666]">Crypto wallets</p>
                                    {[
                                        { label: 'TON', value: 'UQB93GTsF6ZI7ljBViLr-IHIf93HpqwolC51jR5Und7GAwm4' },
                                        { label: 'USDT TRC20', value: 'TH1ZvpbmNKtArQ2zNyoeAq4zvU3koNTFhj' },
                                        { label: 'EVM BEP20', value: '0x048911b8690cd7c85a0898dffbd5e3b9ba50dd10' },
                                        { label: 'Bitcoin', value: '13fC3C2yRq4i8meaUqHWK6H5UQ2V1Bk8Ct' },
                                    ].map(wallet => (
                                        <button key={wallet.label} onClick={() => navigator.clipboard.writeText(wallet.value)} className="flex w-full items-center justify-between gap-3 rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-left transition-colors hover:bg-white/[0.06]">
                                            <span className="text-xs font-medium text-[#aaa]">{wallet.label}</span>
                                            <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-[#666]">{wallet.value}</span>
                                            <Copy className="h-3 w-3 shrink-0 text-[#666]" />
                                        </button>
                                    ))}
                                </div>
                            </section>
                        </div>
                    )}
                </main>
            </div>

            {isDirty && (
                <div className="sticky bottom-0 flex items-center justify-between border-t border-[#333] bg-[#1e1e1e] px-4 py-3 shadow-lg">
                    <span className="text-xs text-[#888]">Unsaved settings changes</span>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => initialSnapshotRef.current && applySnapshot(initialSnapshotRef.current)}
                            className="rounded border border-white/10 px-3 py-1.5 text-xs text-[#bbb] transition-colors hover:bg-white/[0.06]"
                        >
                            Discard
                        </button>
                        <button onClick={saveSnapshot} className="rounded bg-[#0e639c] px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#1177bb]">
                            Save Changes
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
