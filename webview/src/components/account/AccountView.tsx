import {
    AlertTriangle,
    ArrowLeft,
    CalendarClock,
    ExternalLink,
    Gauge,
    LogOut,
    RefreshCw,
    UserCircle,
    Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    budgetBoolean,
    budgetNumber,
    entitlementCancelAtPeriodEnd,
    entitlementCancellationEffectiveAt,
    entitlementPeriodEnd,
    formatGrikCredits,
    formatGrikDate,
    getPrimaryGrikEntitlement,
    getRicochetCreditBalance,
    type GrikAccountController,
    type GrikAccountTone,
} from '../../hooks/useGrikAccount';
import { useSessions } from '../../hooks/useSessions';
import {
    buildAccountUsageSummary,
    formatAccountUsageCost,
    formatAccountUsageTokens,
    type AccountUsageRange,
} from './accountUsage';
import {
    keySourceLabel,
    operationLabel,
    recentUsageEvents,
} from '../settings/usageUtils';
import type { UsageEvent, UsageModelTotal } from '../../types/protocol';

type AccountViewProps = {
    onBack: () => void;
    account: GrikAccountController;
};

type DetailRow = {
    label: string;
    value?: string;
    hint?: string;
};

const USAGE_RANGES: Array<{ value: AccountUsageRange; label: string }> = [
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: 'all', label: 'All' },
];

export function AccountView({ onBack, account }: AccountViewProps) {
    const {
        authState,
        billingState,
        deviceAuth,
        error,
        isBusy,
        summary,
        signIn,
        cancelSignIn,
        refresh,
        logout,
        openBilling,
        openExternal,
    } = account;
    const { sessions } = useSessions();
    const [usageRange, setUsageRange] = useState<AccountUsageRange>('7d');

    const usageSummary = useMemo(
        () => buildAccountUsageSummary(sessions, usageRange),
        [sessions, usageRange],
    );

    const ricochetCredits = getRicochetCreditBalance(billingState);
    const videoCredits = billingState.credits?.find(item => item.product === 'video') || null;
    const primaryEntitlement = getPrimaryGrikEntitlement(billingState);
    const primaryEntitlementCanceling = entitlementCancelAtPeriodEnd(primaryEntitlement);
    const primaryEntitlementPeriodEnd = primaryEntitlementCanceling
        ? entitlementCancellationEffectiveAt(primaryEntitlement)
        : entitlementPeriodEnd(primaryEntitlement);
    const accountDegraded = authState.authenticated && authState.syncStatus === 'degraded';
    const billingDegraded = authState.authenticated && billingState.syncStatus === 'degraded';
    const hasSyncIssue = accountDegraded || billingDegraded;
    const accountSettingsUrl = `${(authState.webBaseUrl || 'https://grik.io').replace(/\/$/, '')}/en/me/settings`;
    const windowUsed = budgetNumber(billingState.budget, 'window_used', 'windowUsed');
    const windowLimit = budgetNumber(billingState.budget, 'window_limit', 'windowLimit');
    const windowRemaining = budgetNumber(billingState.budget, 'window_remaining', 'windowRemaining');
    const taskUsed = budgetNumber(billingState.budget, 'task_used', 'taskUsed');
    const taskLimit = budgetNumber(billingState.budget, 'task_limit', 'taskLimit');
    const taskRemaining = budgetNumber(billingState.budget, 'task_remaining', 'taskRemaining');
    const monthlyCredits = budgetNumber(billingState.budget, 'monthly_credits', 'monthlyCredits');
    const balance = budgetNumber(billingState.budget, 'balance', 'balance');
    const premiumApprovalRequired = budgetBoolean(billingState.budget, 'premium_approval_required', 'premiumApprovalRequired');
    const statusValue = hasSyncIssue
        ? 'Needs refresh'
        : (summary.status || primaryEntitlement?.status || (summary.hostedAccess ? 'active' : 'free'));

    const subscriptionRows: DetailRow[] = [
        { label: 'Plan', value: summary.plan || (summary.label === 'Sync issue' ? 'Unavailable' : summary.label) },
        { label: 'Status', value: statusValue },
        primaryEntitlementPeriodEnd ? { label: primaryEntitlementCanceling ? 'Ends' : 'Renews / ends', value: formatGrikDate(primaryEntitlementPeriodEnd) } : null,
        monthlyCredits !== undefined ? { label: 'Monthly credits', value: formatGrikCredits(monthlyCredits) } : null,
    ].filter(Boolean) as DetailRow[];

    const creditRows: DetailRow[] = [
        {
            label: 'Ricochet Code',
            value: billingDegraded && !ricochetCredits
                ? 'Unavailable'
                : formatGrikCredits(ricochetCredits?.balance ?? balance ?? 0),
        },
        {
            label: 'Video',
            value: billingDegraded && !videoCredits
                ? 'Unavailable'
                : formatGrikCredits(videoCredits?.balance ?? 0),
        },
    ];

    const limitRows: DetailRow[] = [
        windowLimit !== undefined ? { label: 'Window usage', value: formatBudgetUsage(windowUsed, windowLimit, windowRemaining) } : null,
        windowRemaining !== undefined ? { label: 'Window remaining', value: formatGrikCredits(windowRemaining) } : null,
        taskLimit !== undefined ? { label: 'Task usage', value: formatBudgetUsage(taskUsed, taskLimit, taskRemaining) } : null,
        taskRemaining !== undefined ? { label: 'Task remaining', value: formatGrikCredits(taskRemaining) } : null,
        premiumApprovalRequired ? { label: 'Premium approval', value: 'Required' } : null,
    ].filter(Boolean) as DetailRow[];

    return (
        <div className="h-full flex flex-col bg-vscode-editor-background text-vscode-fg">
            <div className="h-11 px-3 border-b border-vscode-border/70 flex items-center justify-between gap-3">
                <button
                    onClick={onBack}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-vscode-list-hoverBackground text-vscode-fg/75 transition-colors"
                    title="Back"
                    aria-label="Back"
                >
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="min-w-0 text-center">
                    <div className="text-[12px] font-medium text-vscode-fg/82">Grik account</div>
                    <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[10px] text-vscode-fg/42">
                        <StatusDot tone={summary.tone} />
                        <span className="truncate">{summary.label}</span>
                    </div>
                </div>
                <button
                    onClick={refresh}
                    disabled={isBusy}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-vscode-list-hoverBackground text-vscode-fg/65 disabled:opacity-50 transition-colors"
                    title="Refresh account"
                    aria-label="Refresh account"
                >
                    <RefreshCw className={`w-4 h-4 ${isBusy ? 'animate-spin' : ''}`} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="mx-auto flex w-full max-w-3xl flex-col px-5 py-6 sm:px-7">
                    {error && (
                        <Notice tone="error" title="Sign in failed" body={error} />
                    )}

                    {!authState.authenticated && !deviceAuth && (
                        <SignedOutState isBusy={isBusy} onSignIn={signIn} />
                    )}

                    {deviceAuth && (
                        <DeviceLoginState
                            userCode={deviceAuth.userCode}
                            verificationUrl={deviceAuth.verificationUrl}
                            expiresAt={deviceAuth.expiresAt}
                            onOpenExternal={openExternal}
                            onCancel={cancelSignIn}
                        />
                    )}

                    {authState.authenticated && (
                        <div className="space-y-0">
                            <section className="pb-6">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 text-[11px] text-vscode-fg/50">
                                            <StatusDot tone={summary.tone} />
                                            <span>{hasSyncIssue ? 'Grik account connected' : summary.label}</span>
                                        </div>
                                        <h1 className="mt-2 truncate text-[24px] font-semibold tracking-normal text-vscode-fg/92">
                                            {authState.user?.name || authState.user?.email || 'Grik account'}
                                        </h1>
                                        {authState.user?.email && (
                                            <div className="mt-1 truncate text-[12px] text-vscode-fg/48">{authState.user.email}</div>
                                        )}
                                    </div>
                                    <button
                                        onClick={logout}
                                        className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md hover:bg-vscode-list-hoverBackground text-vscode-fg/58 transition-colors"
                                        title="Log out"
                                        aria-label="Log out"
                                    >
                                        <LogOut className="w-4 h-4" />
                                    </button>
                                </div>
                            </section>

                            {hasSyncIssue && (
                                <SyncIssueNotice
                                    body={authState.error || billingState.error || 'Grik account connected, billing details need refresh.'}
                                    isBusy={isBusy}
                                    onRetry={refresh}
                                    onOpenDashboard={() => openBilling({ target: 'dashboard' })}
                                />
                            )}

                            <SoftSection
                                icon={<CalendarClock className="h-3.5 w-3.5" />}
                                title="Subscription"
                                caption={primaryEntitlementCanceling ? 'Plan is scheduled to end at period close.' : primaryEntitlementPeriodEnd ? 'Current hosted Ricochet access.' : 'Renewal and payment history stay in Grik.'}
                            >
                                <DetailRows rows={subscriptionRows} />
                            </SoftSection>

                            <SoftSection
                                icon={<Wallet className="h-3.5 w-3.5" />}
                                title="Credits"
                                caption="Billing balance is managed by Grik."
                            >
                                <DetailRows rows={creditRows} />
                            </SoftSection>

                            {(limitRows.length > 0 || summary.quotaWarning) && (
                                <SoftSection
                                    icon={<Gauge className="h-3.5 w-3.5" />}
                                    title="Hosted model limits"
                                    caption="Available limits reported by Grik for Ricochet hosted models."
                                >
                                    {summary.quotaWarning && <QuotaNotice warning={summary.quotaWarning} />}
                                    <DetailRows rows={limitRows} />
                                </SoftSection>
                            )}

                            <UsageSection
                                range={usageRange}
                                onRangeChange={setUsageRange}
                                usageSummary={usageSummary}
                            />

                            <SoftSection title="Dashboard" caption="Invoices, payment details and account settings stay in the Grik web dashboard.">
                                <div className="mt-4 flex flex-wrap items-center gap-2">
                                    <ActionButton onClick={() => openBilling({ target: 'dashboard' })} icon={<ExternalLink className="h-3.5 w-3.5" />}>
                                        Open Grik dashboard
                                    </ActionButton>
                                    <ActionButton primary onClick={() => openBilling({ target: 'subscription', product: 'ricochet_code' })}>
                                        Manage subscription
                                    </ActionButton>
                                    <ActionButton onClick={() => openExternal(accountSettingsUrl)} icon={<ExternalLink className="h-3.5 w-3.5" />}>
                                        Settings
                                    </ActionButton>
                                </div>
                            </SoftSection>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function SignedOutState({ isBusy, onSignIn }: { isBusy: boolean; onSignIn: () => void }) {
    return (
        <section className="mx-auto flex min-h-[56vh] w-full max-w-xl flex-col justify-center py-8">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.04] text-vscode-fg/68">
                <UserCircle className="h-6 w-6" />
            </div>
            <h1 className="mt-5 text-[28px] font-semibold tracking-normal text-vscode-fg/94">Sign in to Grik</h1>
            <p className="mt-3 max-w-lg text-[13px] leading-6 text-vscode-fg/56">
                Hosted Ricochet models use your Grik subscription and credits. Continue with Google in the browser; BYOK providers stay separate in Provider Access.
            </p>
            <button
                onClick={onSignIn}
                disabled={isBusy}
                className="mt-6 h-9 w-fit inline-flex items-center gap-2 rounded-md bg-vscode-button-background px-3.5 text-[12px] font-medium text-vscode-button-foreground hover:bg-vscode-button-hoverBackground disabled:opacity-50 transition-colors"
            >
                <ExternalLink className="h-3.5 w-3.5" />
                Sign in with Grik
            </button>
        </section>
    );
}

function DeviceLoginState({
    userCode,
    verificationUrl,
    expiresAt,
    onOpenExternal,
    onCancel,
}: {
    userCode: string;
    verificationUrl: string;
    expiresAt?: number;
    onOpenExternal: (url: string) => void;
    onCancel: () => void;
}) {
    const remaining = useDeviceLoginCountdown(expiresAt);
    return (
        <section className="mx-auto flex min-h-[56vh] w-full max-w-xl flex-col justify-center py-8">
            <div className="text-[11px] font-medium uppercase tracking-wide text-vscode-fg/45">Grik browser sign in</div>
            <h1 className="mt-3 text-[24px] font-semibold tracking-normal text-vscode-fg/92">Finish sign in in your browser</h1>
            <p className="mt-2 text-[13px] leading-6 text-vscode-fg/56">
                Continue with Google on Grik, then approve this code. Ricochet will connect automatically after approval.
            </p>
            <div className="mt-5 rounded-lg bg-white/[0.04] px-4 py-4 text-center font-mono text-[24px] tracking-[0.2em] text-vscode-fg/92">
                {userCode}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-vscode-fg/45">
                <span>{remaining ? `Expires in ${remaining}` : 'Waiting for browser approval'}</span>
                <span className="inline-flex items-center gap-1.5 text-amber-200/80">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Never share this code.
                </span>
            </div>
            <div className="mt-3 break-all text-[12px] leading-5 text-vscode-fg/48">
                {verificationUrl}
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2">
                <ActionButton primary onClick={() => onOpenExternal(verificationUrl)} icon={<ExternalLink className="h-3.5 w-3.5" />}>
                    Continue with Google
                </ActionButton>
                <ActionButton onClick={onCancel}>
                    Cancel
                </ActionButton>
            </div>
        </section>
    );
}

function QuotaNotice({ warning }: { warning: NonNullable<GrikAccountController['summary']['quotaWarning']> }) {
    const danger = warning.tone === 'danger';
    return (
        <div className={`mt-4 rounded-lg px-3 py-2.5 ${danger ? 'bg-rose-400/10 text-rose-100/88' : 'bg-amber-400/10 text-amber-100/88'}`}>
            <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                    <div className="text-[12px] font-medium">{warning.label}</div>
                    <p className="mt-0.5 text-[11px] leading-5 opacity-82">{warning.detail}</p>
                </div>
            </div>
        </div>
    );
}

function SyncIssueNotice({
    body,
    isBusy,
    onRetry,
    onOpenDashboard,
}: {
    body: string;
    isBusy: boolean;
    onRetry: () => void;
    onOpenDashboard: () => void;
}) {
    return (
        <section className="mb-2 rounded-lg bg-amber-400/10 px-3 py-3 text-amber-100/90">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-200/90" />
                    <span className="min-w-0 text-[12px] leading-5">{body}</span>
                </div>
                <button
                    onClick={onRetry}
                    disabled={isBusy}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-amber-100 hover:bg-white/10 disabled:opacity-50 transition-colors"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? 'animate-spin' : ''}`} />
                    Retry
                </button>
                <button
                    onClick={onOpenDashboard}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-amber-100 hover:bg-white/10 transition-colors"
                >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open dashboard
                </button>
            </div>
        </section>
    );
}

function UsageSection({
    range,
    onRangeChange,
    usageSummary,
}: {
    range: AccountUsageRange;
    onRangeChange: (range: AccountUsageRange) => void;
    usageSummary: ReturnType<typeof buildAccountUsageSummary>;
}) {
    const snapshot = usageSummary.snapshot;
    const events = recentUsageEvents(snapshot, 5);
    const models = snapshot.models || [];

    return (
        <SoftSection
            title="Usage"
            caption="Local Ricochet estimate. Billing balance is managed by Grik."
        >
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-lg bg-white/[0.035] p-0.5">
                    {USAGE_RANGES.map(item => (
                        <button
                            key={item.value}
                            type="button"
                            onClick={() => onRangeChange(item.value)}
                            className={`h-7 rounded-md px-2.5 text-[11px] transition-colors ${range === item.value ? 'bg-vscode-button-background text-vscode-button-foreground' : 'text-vscode-fg/52 hover:bg-white/[0.05] hover:text-vscode-fg/82'}`}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
                <div className="text-[11px] text-vscode-fg/42">
                    {usageSummary.hasData
                        ? `${usageSummary.sessionsWithUsage} sessions · ${usageSummary.sourceLabel}`
                        : 'No local usage recorded yet'}
                </div>
            </div>

            {!usageSummary.hasData ? (
                <div className="mt-5 rounded-lg bg-white/[0.025] px-4 py-8 text-center">
                    <div className="text-[13px] font-medium text-vscode-fg/78">No local usage recorded yet</div>
                    <p className="mx-auto mt-2 max-w-md text-[12px] leading-5 text-vscode-fg/45">
                        Usage appears here after Ricochet completes model requests in saved sessions.
                    </p>
                </div>
            ) : (
                <div className="mt-5 space-y-5">
                    <div className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">
                        <UsageStat label="Requests" value={String(snapshot.requestCount || 0)} />
                        <UsageStat label="Input" value={formatAccountUsageTokens(snapshot.inputTokens)} />
                        <UsageStat label="Output" value={formatAccountUsageTokens(snapshot.outputTokens)} />
                        <UsageStat label="Cached" value={formatAccountUsageTokens((snapshot.cachedInputTokens || 0) + (snapshot.cacheCreationTokens || 0))} />
                        <UsageStat label="Reasoning" value={formatAccountUsageTokens(snapshot.reasoningOutputTokens)} />
                        <UsageStat label="Cost" value={formatAccountUsageCost(snapshot.estimatedCostUsd)} />
                    </div>

                    {models.length > 0 && (
                        <ModelUsageList models={models} />
                    )}

                    {events.length > 0 && (
                        <RecentRequests events={events} />
                    )}
                </div>
            )}
        </SoftSection>
    );
}

function ModelUsageList({ models }: { models: UsageModelTotal[] }) {
    const maxTokens = Math.max(...models.map(model => totalModelTokens(model)), 1);
    return (
        <div>
            <div className="mb-2 text-[11px] font-medium text-vscode-fg/48">Models</div>
            <div className="space-y-2">
                {models.slice(0, 5).map(model => {
                    const tokens = totalModelTokens(model);
                    return (
                        <div key={`${model.provider}-${model.model}-${model.keySource || 'none'}`} className="min-w-0">
                            <div className="flex items-center justify-between gap-3 text-[12px]">
                                <div className="min-w-0">
                                    <div className="truncate text-vscode-fg/82" title={model.model}>{model.model}</div>
                                    <div className="mt-0.5 truncate text-[10px] text-vscode-fg/38">
                                        {model.provider} · {keySourceLabel(model.keySource)} · {model.requestCount} req
                                    </div>
                                </div>
                                <div className="shrink-0 text-[11px] text-vscode-fg/48">{formatAccountUsageTokens(tokens)}</div>
                            </div>
                            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.055]">
                                <div
                                    className="h-full rounded-full bg-vscode-button-background/70"
                                    style={{ width: `${Math.max(4, Math.round((tokens / maxTokens) * 100))}%` }}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function RecentRequests({ events }: { events: UsageEvent[] }) {
    return (
        <div>
            <div className="mb-2 text-[11px] font-medium text-vscode-fg/48">Recent requests</div>
            <div className="divide-y divide-white/5">
                {events.map((event, index) => (
                    <div key={`${event.sessionId}-${event.turnId || event.runId || index}-${event.timestamp || index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2">
                        <div className="min-w-0">
                            <div className="truncate text-[12px] text-vscode-fg/78" title={event.model}>
                                {operationLabel(event.operation)} · {event.model}
                            </div>
                            <div className="mt-0.5 truncate text-[10px] text-vscode-fg/38">
                                {event.provider} · {formatUsageTime(event.timestamp)}
                            </div>
                        </div>
                        <div className="text-right text-[11px] text-vscode-fg/48">
                            <div>{formatAccountUsageTokens((event.inputTokens || 0) + (event.outputTokens || 0))}</div>
                            <div className="mt-0.5">{formatAccountUsageCost(event.estimatedCostUsd)}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SoftSection({
    title,
    caption,
    icon,
    children,
}: {
    title: string;
    caption?: string;
    icon?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="border-t border-white/5 py-5">
            <div className="flex items-start gap-2.5">
                {icon && <div className="mt-0.5 text-vscode-fg/40">{icon}</div>}
                <div className="min-w-0">
                    <div className="text-[12px] font-semibold text-vscode-fg/82">{title}</div>
                    {caption && <p className="mt-1 text-[11px] leading-5 text-vscode-fg/45">{caption}</p>}
                </div>
            </div>
            {children}
        </section>
    );
}

function DetailRows({ rows }: { rows: DetailRow[] }) {
    return (
        <div className="mt-4 divide-y divide-white/5">
            {rows.map(row => (
                <div key={row.label} className="grid grid-cols-[minmax(110px,0.85fr)_minmax(0,1.15fr)] gap-4 py-2.5">
                    <div className="text-[11px] text-vscode-fg/42">{row.label}</div>
                    <div className="min-w-0 text-[12px] font-medium text-vscode-fg/82">
                        <div className="truncate" title={row.value}>{row.value || '-'}</div>
                        {row.hint && <div className="mt-0.5 text-[10px] font-normal text-vscode-fg/38">{row.hint}</div>}
                    </div>
                </div>
            ))}
        </div>
    );
}

function UsageStat({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-vscode-fg/36">{label}</div>
            <div className="mt-1 truncate text-[18px] font-semibold text-vscode-fg/88" title={value}>{value}</div>
        </div>
    );
}

function ActionButton({
    children,
    onClick,
    icon,
    primary = false,
}: {
    children: ReactNode;
    onClick: () => void;
    icon?: ReactNode;
    primary?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-[12px] font-medium transition-colors ${primary ? 'bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground' : 'text-vscode-fg/62 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/88'}`}
        >
            {icon}
            {children}
        </button>
    );
}

function Notice({ tone, title, body, action }: { tone: 'warning' | 'error'; title: string; body: string; action?: ReactNode }) {
    const error = tone === 'error';
    return (
        <section className={`mb-4 rounded-lg ${error ? 'bg-vscode-errorForeground/10 text-vscode-errorForeground' : 'bg-amber-400/10 text-amber-100/90'} px-3 py-3`}>
            <div className="flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{title}</div>
                    <p className="mt-1 break-words text-[12px] leading-5 opacity-80">{body}</p>
                    {action && <div className="mt-3">{action}</div>}
                </div>
            </div>
        </section>
    );
}

function StatusDot({ tone }: { tone: GrikAccountTone }) {
    const className = tone === 'success'
        ? 'bg-emerald-300'
        : tone === 'warning'
            ? 'bg-amber-300'
            : tone === 'danger'
                ? 'bg-rose-300'
                : tone === 'info'
                    ? 'bg-sky-300'
                    : 'bg-vscode-fg/34';
    return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} aria-hidden="true" />;
}

function totalModelTokens(model: UsageModelTotal): number {
    return (model.inputTokens || 0)
        + (model.outputTokens || 0)
        + (model.cachedInputTokens || 0)
        + (model.cacheCreationTokens || 0)
        + (model.reasoningOutputTokens || 0);
}

function formatUsageTime(timestamp?: number): string {
    if (!timestamp) return 'unknown time';
    const normalized = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
    return new Date(normalized).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatBudgetUsage(used?: number, limit?: number, remaining?: number): string {
    if (typeof limit !== 'number') return '-';
    const resolvedUsed = typeof used === 'number'
        ? used
        : typeof remaining === 'number'
            ? Math.max(0, limit - remaining)
            : undefined;
    if (typeof resolvedUsed !== 'number') return `0 / ${formatGrikCredits(limit)}`;
    return `${formatGrikCredits(resolvedUsed)} / ${formatGrikCredits(limit)}`;
}

function useDeviceLoginCountdown(expiresAt?: number): string {
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        if (!expiresAt) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [expiresAt]);

    if (!expiresAt) return '';
    const remainingMs = Math.max(0, expiresAt - now);
    const minutes = Math.floor(remainingMs / 60_000);
    const seconds = Math.floor((remainingMs % 60_000) / 1000);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
