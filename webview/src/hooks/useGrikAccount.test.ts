import { describe, expect, it } from 'vitest';
import {
    deriveQuotaWarning,
    deriveGrikAccountSummary,
    formatGrikCredits,
    getRicochetCreditBalance,
    isHostedSubscriptionAccess,
    type GrikBillingState,
} from './useGrikAccount';

describe('Grik account state helpers', () => {
    it('derives a signed-out Free account badge', () => {
        expect(deriveGrikAccountSummary({ authenticated: false }, {}).label).toBe('Free account');
        expect(deriveGrikAccountSummary({ authenticated: false }, {}).actionLabel).toBe('Sign in');
    });

    it('derives an active plan from Ricochet entitlements', () => {
        const summary = deriveGrikAccountSummary(
            { authenticated: true, syncStatus: 'ready' },
            {
                entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'active', currentPeriodEnd: '2026-07-01T00:00:00Z' }],
                syncStatus: 'ready',
            }
        );

        expect(summary.label).toBe('Pro plan');
        expect(summary.hostedAccess).toBe(true);
        expect(summary.accessState).toBe('available');
        expect(summary.accessLabel).toBe('Available');
        expect(summary.detail).toContain('Renews or ends');
    });

    it('derives period-end cancellation from backend snake_case fields', () => {
        const summary = deriveGrikAccountSummary(
            { authenticated: true, syncStatus: 'ready' },
            {
                entitlements: [{
                    id: 'sub_1',
                    product: 'ricochet_code',
                    plan: 'pro',
                    status: 'active',
                    current_period_end: '2026-07-01T00:00:00Z',
                    cancel_at_period_end: true,
                    cancellation_effective_at: '2026-07-01T00:00:00Z',
                }],
                syncStatus: 'ready',
            }
        );

        expect(summary.hostedAccess).toBe(true);
        expect(summary.detail).toContain('Ends');
    });

    it('uses optional budget to show hosted access when entitlement details are absent', () => {
        const summary = deriveGrikAccountSummary(
            { authenticated: true, syncStatus: 'ready' },
            { budget: { allowed: true, plan: 'pro' }, syncStatus: 'ready' }
        );

        expect(summary.label).toBe('Pro plan');
        expect(summary.hostedAccess).toBe(true);
    });

    it('derives expired and sync issue states explicitly', () => {
        expect(deriveGrikAccountSummary(
            { authenticated: true, syncStatus: 'ready' },
            { entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'expired' }] }
        ).label).toBe('Expired');

        expect(deriveGrikAccountSummary(
            { authenticated: true, syncStatus: 'degraded', error: 'offline' },
            {}
        ).label).toBe('Sync issue');
    });

    it('keeps known hosted metadata during a degraded billing sync', () => {
        const summary = deriveGrikAccountSummary(
            { authenticated: true, syncStatus: 'ready' },
            { budget: { allowed: true, plan: 'pro' }, syncStatus: 'degraded', error: 'billing offline' }
        );

        expect(summary).toMatchObject({
            label: 'Sync issue',
            authenticated: true,
            hostedAccess: true,
            plan: 'Pro',
            accessState: 'sync_issue',
            accessLabel: 'Sync issue',
        });
        expect(summary.detail).toContain('billing offline');
    });

    it('maps Grik budget blocks and approval requirements into model access states', () => {
        expect(deriveGrikAccountSummary(
            { authenticated: true, syncStatus: 'ready' },
            { budget: { allowed: false, plan: 'pro' }, syncStatus: 'ready' }
        )).toMatchObject({
            label: 'Limit reached',
            hostedAccess: false,
            accessState: 'limit_reached',
            accessLabel: 'Limit reached',
        });

        expect(deriveGrikAccountSummary(
            { authenticated: true, syncStatus: 'ready' },
            { budget: { allowed: true, plan: 'pro', premium_approval_required: true }, syncStatus: 'ready' }
        )).toMatchObject({
            label: 'Approval required',
            hostedAccess: false,
            accessState: 'approval_required',
            accessLabel: 'Approval required',
        });
    });

    it('derives quota warning thresholds from window and task budgets', () => {
        expect(deriveQuotaWarning({ window_used: 760, window_limit: 1000 })).toMatchObject({
            label: 'Window limit usage high',
            tone: 'warning',
            kind: 'window',
        });
        expect(deriveQuotaWarning({ task_remaining: 30, task_limit: 1000 })).toMatchObject({
            label: 'Task limit almost exhausted',
            tone: 'danger',
            kind: 'task',
        });
    });

    it('detects hosted subscription access separately from BYOK providers', () => {
        expect(isHostedSubscriptionAccess('subscription', 'none')).toBe(true);
        expect(isHostedSubscriptionAccess('byok', 'hosted')).toBe(true);
        expect(isHostedSubscriptionAccess('byok', 'user')).toBe(false);
    });

    it('finds Ricochet credits and formats balances', () => {
        const billing: GrikBillingState = {
            credits: [
                { product: 'video', balance: 5 },
                { product: 'ricochet_code', balance: 1234.5 },
            ],
        };

        expect(getRicochetCreditBalance(billing)?.balance).toBe(1234.5);
        expect(formatGrikCredits(1234.5)).toBe('1,234.5');
    });
});
