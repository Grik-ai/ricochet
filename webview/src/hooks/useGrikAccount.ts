import { useCallback, useEffect, useMemo, useState } from 'react';
import { useVSCodeApi } from './useVSCodeApi';

export type GrikAuthUser = {
    id?: string;
    email?: string;
    name?: string;
};

export type GrikAuthState = {
    authenticated: boolean;
    user?: GrikAuthUser | null;
    expiresAt?: number | null;
    apiBaseUrl?: string;
    webBaseUrl?: string;
    syncStatus?: 'ready' | 'degraded';
    error?: string;
};

export type GrikDeviceAuthState = {
    userCode: string;
    verificationUrl: string;
    expiresAt?: number;
    interval?: number;
};

export type GrikCreditBalance = {
    product: string;
    balance: number;
    updatedAt?: string;
};

export type GrikEntitlement = {
    id?: string;
    product: string;
    plan?: string;
    status?: string;
    currentPeriodEnd?: string;
    current_period_end?: string;
    cancelAtPeriodEnd?: boolean;
    cancel_at_period_end?: boolean;
    canceledAt?: string;
    canceled_at?: string;
    cancellationEffectiveAt?: string;
    cancellation_effective_at?: string;
};

export type GrikBudgetState = {
    allowed?: boolean;
    product?: string;
    plan?: string;
    hosted_ai?: boolean;
    hostedAI?: boolean;
    balance?: number;
    monthly_credits?: number;
    monthlyCredits?: number;
    window_used?: number;
    windowUsed?: number;
    window_limit?: number;
    windowLimit?: number;
    window_remaining?: number;
    windowRemaining?: number;
    task_used?: number;
    taskUsed?: number;
    task_limit?: number;
    taskLimit?: number;
    task_remaining?: number;
    taskRemaining?: number;
    premium_approval_required?: boolean;
    premiumApprovalRequired?: boolean;
    upgrade_url?: string;
    upgradeUrl?: string;
};

export type GrikBillingState = {
    credits?: GrikCreditBalance[];
    entitlements?: GrikEntitlement[];
    budget?: GrikBudgetState | null;
    syncStatus?: 'ready' | 'degraded';
    error?: string;
};

export type GrikAccountTone = 'idle' | 'success' | 'warning' | 'danger' | 'info';
export type GrikAccountAccessState = 'signed_out' | 'available' | 'upgrade_required' | 'sync_issue' | 'expired' | 'limit_reached' | 'approval_required';

export type GrikQuotaWarning = {
    label: string;
    detail: string;
    tone: 'warning' | 'danger';
    percent?: number;
    kind: 'window' | 'task' | 'approval' | 'blocked';
};

export type GrikAccountSummary = {
    label: string;
    detail: string;
    tone: GrikAccountTone;
    actionLabel: string;
    authenticated: boolean;
    hostedAccess: boolean;
    plan?: string;
    status?: string;
    accessState: GrikAccountAccessState;
    accessLabel: string;
    quotaWarning?: GrikQuotaWarning;
};

export type GrikAccountController = {
    authState: GrikAuthState;
    billingState: GrikBillingState;
    deviceAuth: GrikDeviceAuthState | null;
    error: string | null;
    isBusy: boolean;
    summary: GrikAccountSummary;
    signIn: () => void;
    cancelSignIn: () => void;
    refresh: () => void;
    logout: () => void;
    openBilling: (payload?: { target?: string; product?: string }) => void;
    cancelSubscription: (subscriptionId: string, reason?: string) => void;
    resumeSubscription: (subscriptionId: string) => void;
    openExternal: (url: string) => void;
};

const LOGGED_OUT_AUTH_STATE: GrikAuthState = { authenticated: false, syncStatus: 'ready' };
const EMPTY_BILLING_STATE: GrikBillingState = { credits: [], entitlements: [], syncStatus: 'ready' };

export function isHostedSubscriptionAccess(accessMode?: string, keySource?: string): boolean {
    return keySource === 'hosted' || accessMode === 'subscription';
}

export function isRicochetProduct(product?: string): boolean {
    const normalized = String(product || '').toLowerCase().replace(/[-\s]+/g, '_');
    return normalized === 'ricochet_code' || normalized.includes('ricochet');
}

export function getRicochetCreditBalance(billingState: GrikBillingState): GrikCreditBalance | null {
    return billingState.credits?.find(item => isRicochetProduct(item.product)) || null;
}

export function getPrimaryGrikEntitlement(billingState: GrikBillingState): GrikEntitlement | null {
    return billingState.entitlements?.find(item => isRicochetProduct(item.product)) || billingState.entitlements?.[0] || null;
}

export function entitlementPeriodEnd(entitlement: GrikEntitlement | null | undefined): string | undefined {
    return entitlement?.currentPeriodEnd || entitlement?.current_period_end;
}

export function entitlementCancelAtPeriodEnd(entitlement: GrikEntitlement | null | undefined): boolean {
    return Boolean(entitlement?.cancelAtPeriodEnd ?? entitlement?.cancel_at_period_end);
}

export function entitlementCancellationEffectiveAt(entitlement: GrikEntitlement | null | undefined): string | undefined {
    return entitlement?.cancellationEffectiveAt || entitlement?.cancellation_effective_at || entitlementPeriodEnd(entitlement);
}

export function budgetNumber(budget: GrikBudgetState | null | undefined, snakeKey: keyof GrikBudgetState, camelKey: keyof GrikBudgetState): number | undefined {
    const value = budget?.[snakeKey] ?? budget?.[camelKey];
    return typeof value === 'number' ? value : undefined;
}

export function budgetBoolean(budget: GrikBudgetState | null | undefined, snakeKey: keyof GrikBudgetState, camelKey: keyof GrikBudgetState): boolean | undefined {
    const value = budget?.[snakeKey] ?? budget?.[camelKey];
    return typeof value === 'boolean' ? value : undefined;
}

export function deriveQuotaWarning(budget: GrikBudgetState | null | undefined): GrikQuotaWarning | undefined {
    if (!budget) return undefined;
    if (budget.allowed === false) {
        return {
            label: 'Quota exceeded',
            detail: 'Grik is blocking hosted Ricochet usage for this account.',
            tone: 'danger',
            kind: 'blocked',
        };
    }
    if (budgetBoolean(budget, 'premium_approval_required', 'premiumApprovalRequired') === true) {
        return {
            label: 'Approval required',
            detail: 'This hosted model request requires Grik premium approval.',
            tone: 'warning',
            kind: 'approval',
        };
    }

    const candidates = [
        {
            kind: 'window' as const,
            label: 'Window limit',
            used: budgetNumber(budget, 'window_used', 'windowUsed'),
            limit: budgetNumber(budget, 'window_limit', 'windowLimit'),
            remaining: budgetNumber(budget, 'window_remaining', 'windowRemaining'),
        },
        {
            kind: 'task' as const,
            label: 'Task limit',
            used: budgetNumber(budget, 'task_used', 'taskUsed'),
            limit: budgetNumber(budget, 'task_limit', 'taskLimit'),
            remaining: budgetNumber(budget, 'task_remaining', 'taskRemaining'),
        },
    ];

    const usage = candidates
        .map(candidate => {
            if (typeof candidate.limit !== 'number' || candidate.limit <= 0) return null;
            const used = typeof candidate.used === 'number'
                ? candidate.used
                : typeof candidate.remaining === 'number'
                    ? Math.max(0, candidate.limit - candidate.remaining)
                    : undefined;
            if (typeof used !== 'number') return null;
            return {
                ...candidate,
                percent: Math.max(0, Math.min(100, (used / candidate.limit) * 100)),
            };
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
        .sort((a, b) => b.percent - a.percent)[0];

    if (!usage || usage.percent < 75) return undefined;
    if (usage.percent >= 95) {
        return {
            label: `${usage.label} almost exhausted`,
            detail: `${Math.round(usage.percent)}% of the Grik ${usage.kind} budget has been used.`,
            tone: 'danger',
            percent: usage.percent,
            kind: usage.kind,
        };
    }
    return {
        label: `${usage.label} usage high`,
        detail: `${Math.round(usage.percent)}% of the Grik ${usage.kind} budget has been used.`,
        tone: 'warning',
        percent: usage.percent,
        kind: usage.kind,
    };
}

export function deriveGrikAccountSummary(authState: GrikAuthState, billingState: GrikBillingState): GrikAccountSummary {
    if (!authState.authenticated) {
        return {
            label: 'Free account',
            detail: 'Sign in to unlock hosted Ricochet models',
            tone: 'idle',
            actionLabel: 'Sign in',
            authenticated: false,
            hostedAccess: false,
            accessState: 'signed_out',
            accessLabel: 'Sign in required',
        };
    }

    const entitlement = getPrimaryGrikEntitlement(billingState);
    const budget = billingState.budget || null;
    const rawStatus = String(entitlement?.status || '').toLowerCase();
    const rawPlan = budget?.plan || entitlement?.plan || '';
    const planLabel = rawPlan ? planName(rawPlan) : '';
    const budgetAllowsHosted = budget?.allowed === true;
    const activeEntitlement = ['active', 'trialing', 'paid'].includes(rawStatus);
    const hasKnownHostedAccess = activeEntitlement || budgetAllowsHosted;
    const quotaWarning = deriveQuotaWarning(budget);

    const accountDegraded = authState.syncStatus === 'degraded' || billingState.syncStatus === 'degraded';
    if (accountDegraded) {
        return {
            label: 'Sync issue',
            detail: authState.error || billingState.error || 'Grik account is connected, but billing details are temporarily unavailable',
            tone: 'warning',
            actionLabel: 'Retry',
            authenticated: true,
            hostedAccess: hasKnownHostedAccess,
            plan: planLabel || rawPlan || undefined,
            status: rawStatus || undefined,
            accessState: 'sync_issue',
            accessLabel: 'Sync issue',
            quotaWarning,
        };
    }

    if (['expired', 'canceled', 'cancelled', 'past_due', 'inactive', 'unpaid'].includes(rawStatus)) {
        return {
            label: 'Expired',
            detail: `${entitlement?.product || 'Subscription'} is ${rawStatus.replace('_', ' ')}`,
            tone: 'danger',
            actionLabel: 'Manage',
            authenticated: true,
            hostedAccess: false,
            plan: planLabel || rawPlan,
            status: rawStatus,
            accessState: 'expired',
            accessLabel: 'Expired',
            quotaWarning,
        };
    }

    if (quotaWarning?.kind === 'blocked') {
        return {
            label: 'Limit reached',
            detail: quotaWarning.detail,
            tone: 'danger',
            actionLabel: 'Manage',
            authenticated: true,
            hostedAccess: false,
            plan: planLabel || rawPlan || undefined,
            status: rawStatus || 'limited',
            accessState: 'limit_reached',
            accessLabel: 'Limit reached',
            quotaWarning,
        };
    }

    if (quotaWarning?.kind === 'approval') {
        return {
            label: 'Approval required',
            detail: quotaWarning.detail,
            tone: 'warning',
            actionLabel: 'Manage',
            authenticated: true,
            hostedAccess: false,
            plan: planLabel || rawPlan || undefined,
            status: rawStatus || 'approval_required',
            accessState: 'approval_required',
            accessLabel: 'Approval required',
            quotaWarning,
        };
    }

    if (activeEntitlement || budgetAllowsHosted) {
        const periodEnd = entitlementPeriodEnd(entitlement);
        const canceling = entitlementCancelAtPeriodEnd(entitlement);
        const effectiveAt = entitlementCancellationEffectiveAt(entitlement);
        return {
            label: planLabel ? `${planLabel} plan` : 'Active plan',
            detail: canceling && effectiveAt
                ? `Ends ${formatGrikDate(effectiveAt)}`
                : periodEnd ? `Renews or ends ${formatGrikDate(periodEnd)}` : 'Hosted Ricochet models are available',
            tone: 'success',
            actionLabel: 'Manage',
            authenticated: true,
            hostedAccess: true,
            plan: planLabel || rawPlan,
            status: rawStatus || 'active',
            accessState: 'available',
            accessLabel: 'Available',
            quotaWarning,
        };
    }

    return {
        label: 'Free account',
        detail: 'Signed in without an active Ricochet subscription',
        tone: 'info',
        actionLabel: 'Upgrade',
        authenticated: true,
        hostedAccess: false,
        plan: planLabel || rawPlan || undefined,
        status: rawStatus || undefined,
        accessState: 'upgrade_required',
        accessLabel: 'Upgrade required',
        quotaWarning,
    };
}

export function formatGrikCredits(value?: number): string {
    if (typeof value !== 'number') return '0';
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

export function formatGrikDate(value?: string): string {
    if (!value) return '';
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(parsed));
}

function planName(plan: string): string {
    const cleaned = plan
        .replace(/^ricochet[_-]?/i, '')
        .replace(/[_-]+/g, ' ')
        .trim();
    if (!cleaned) return '';
    return cleaned
        .split(/\s+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

export function useGrikAccount(): GrikAccountController {
    const { postMessage, onMessage } = useVSCodeApi();
    const [authState, setAuthState] = useState<GrikAuthState>(LOGGED_OUT_AUTH_STATE);
    const [billingState, setBillingState] = useState<GrikBillingState>(EMPTY_BILLING_STATE);
    const [deviceAuth, setDeviceAuth] = useState<GrikDeviceAuthState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isBusy, setIsBusy] = useState(false);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'auth_state': {
                    const next = (message.payload || LOGGED_OUT_AUTH_STATE) as GrikAuthState;
                    setAuthState(next);
                    setIsBusy(false);
                    postMessage({ type: 'get_models' });
                    break;
                }
                case 'billing_state':
                    setBillingState(normalizeBillingState((message.payload || EMPTY_BILLING_STATE) as GrikBillingState));
                    setIsBusy(false);
                    break;
                case 'billing_subscription_action_result':
                    setIsBusy(false);
                    if (!(message.payload as { ok?: boolean })?.ok) {
                        setError(((message.payload as { error?: string })?.error) || 'Failed to update subscription.');
                    } else {
                        setError(null);
                    }
                    break;
                case 'device_auth_started':
                    setDeviceAuth((message.payload || null) as GrikDeviceAuthState | null);
                    setError(null);
                    setIsBusy(false);
                    break;
                case 'device_auth_complete':
                    setDeviceAuth(null);
                    setError(null);
                    setIsBusy(false);
                    postMessage({ type: 'get_models' });
                    break;
                case 'device_auth_failed':
                    setDeviceAuth(null);
                    setError(((message.payload as { error?: string })?.error) || 'Sign in failed.');
                    setIsBusy(false);
                    break;
            }
        });

        postMessage({ type: 'auth_refresh' });
        return () => { unsubscribe(); };
    }, [onMessage, postMessage]);

    const signIn = useCallback(() => {
        setIsBusy(true);
        setError(null);
        postMessage({ type: 'auth_login' });
    }, [postMessage]);

    const cancelSignIn = useCallback(() => {
        setIsBusy(false);
        setDeviceAuth(null);
        postMessage({ type: 'auth_cancel' });
    }, [postMessage]);

    const refresh = useCallback(() => {
        setIsBusy(true);
        postMessage({ type: 'auth_refresh' });
    }, [postMessage]);

    const logout = useCallback(() => {
        setIsBusy(true);
        setBillingState(EMPTY_BILLING_STATE);
        postMessage({ type: 'auth_logout' });
    }, [postMessage]);

    const openBilling = useCallback((payload?: { target?: string; product?: string }) => {
        postMessage({ type: 'open_billing', payload });
    }, [postMessage]);

    const cancelSubscription = useCallback((subscriptionId: string, reason?: string) => {
        setIsBusy(true);
        setError(null);
        postMessage({ type: 'billing_subscription_cancel', payload: { subscriptionId, reason } });
    }, [postMessage]);

    const resumeSubscription = useCallback((subscriptionId: string) => {
        setIsBusy(true);
        setError(null);
        postMessage({ type: 'billing_subscription_resume', payload: { subscriptionId } });
    }, [postMessage]);

    const openExternal = useCallback((url: string) => {
        postMessage({ type: 'open_external', payload: { url } });
    }, [postMessage]);

    const summary = useMemo(() => deriveGrikAccountSummary(authState, billingState), [authState, billingState]);

    return {
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
        cancelSubscription,
        resumeSubscription,
        openExternal,
    };
}

function normalizeBillingState(state: GrikBillingState): GrikBillingState {
    return {
        ...state,
        entitlements: state.entitlements?.map((entitlement) => ({
            ...entitlement,
            currentPeriodEnd: entitlement.currentPeriodEnd || entitlement.current_period_end,
            cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd ?? entitlement.cancel_at_period_end,
            canceledAt: entitlement.canceledAt || entitlement.canceled_at,
            cancellationEffectiveAt: entitlement.cancellationEffectiveAt || entitlement.cancellation_effective_at,
        })),
    };
}
