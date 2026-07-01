import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountView } from './AccountView';
import type { GrikAccountController } from '../../hooks/useGrikAccount';

function account(overrides: Partial<GrikAccountController> = {}): GrikAccountController {
    return {
        authState: {
            authenticated: true,
            user: { name: 'Igor', email: 'igor@example.com' },
            syncStatus: 'ready',
        },
        billingState: {
            credits: [{ product: 'ricochet_code', balance: 1200 }],
            entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'active', currentPeriodEnd: '2026-07-01T00:00:00Z' }],
            budget: { allowed: true, plan: 'pro', monthly_credits: 5000 },
            syncStatus: 'ready',
        },
        deviceAuth: null,
        error: null,
        isBusy: false,
        summary: {
            label: 'Pro plan',
            detail: 'Hosted Ricochet models are available',
            tone: 'success',
            actionLabel: 'Manage',
            authenticated: true,
            hostedAccess: true,
            plan: 'Pro',
            status: 'active',
            accessState: 'available',
            accessLabel: 'Available',
        },
        signIn: () => {},
        cancelSignIn: () => {},
        refresh: () => {},
        logout: () => {},
        openBilling: () => {},
        cancelSubscription: () => {},
        resumeSubscription: () => {},
        openExternal: () => {},
        ...overrides,
    };
}

function renderAccount(controller: GrikAccountController): string {
    return renderToStaticMarkup(createElement(AccountView, {
        account: controller,
        onBack: () => {},
    }));
}

describe('AccountView', () => {
    it('renders a clean pro account view without the old heavy account cards', () => {
        const html = renderAccount(account());

        expect(html).toContain('Grik account');
        expect(html).toContain('Pro plan');
        expect(html).toContain('Subscription');
        expect(html).toContain('Account settings');
        expect(html).toContain('Open account settings');
        expect(html).toContain('Local Ricochet estimate');
        expect(html).toContain('No local usage recorded yet');
        expect(html).not.toContain('border border-vscode-border bg-vscode-input-bg');
        expect(html).not.toContain('border border-vscode-border bg-vscode-editor-background px-3 py-3');
    });

    it('keeps sync issue as a connected account warning with retry actions', () => {
        const html = renderAccount(account({
            authState: {
                authenticated: true,
                user: { email: 'igor@example.com' },
                syncStatus: 'ready',
            },
            billingState: {
                credits: [],
                entitlements: [],
                syncStatus: 'degraded',
            },
            summary: {
                label: 'Sync issue',
                detail: 'Grik account is connected, but billing details are temporarily unavailable',
                tone: 'warning',
                actionLabel: 'Retry',
                authenticated: true,
                hostedAccess: false,
                accessState: 'sync_issue',
                accessLabel: 'Sync issue',
            },
        }));

        expect(html).toContain('Grik account connected');
        expect(html).toContain('billing details need refresh');
        expect(html).toContain('Retry');
        expect(html).toContain('Open account settings');
    });

    it('renders logged out sign-in without a bordered setup card', () => {
        const html = renderAccount(account({
            authState: { authenticated: false, syncStatus: 'ready' },
            billingState: { credits: [], entitlements: [], syncStatus: 'ready' },
            summary: {
                label: 'Free account',
                detail: 'Sign in to unlock hosted Ricochet models',
                tone: 'idle',
                actionLabel: 'Sign in',
                authenticated: false,
                hostedAccess: false,
                accessState: 'signed_out',
                accessLabel: 'Sign in required',
            },
        }));

        expect(html).toContain('Sign in to Grik');
        expect(html).toContain('Hosted Ricochet models use your Grik subscription');
        expect(html).toContain('choose Google or email');
        expect(html).not.toContain('border border-vscode-border bg-vscode-input-bg');
    });

    it('renders device login with expiry and anti-phishing copy', () => {
        const html = renderAccount(account({
            authState: { authenticated: false, syncStatus: 'ready' },
            billingState: { credits: [], entitlements: [], syncStatus: 'ready' },
            deviceAuth: {
                userCode: 'GRIK-TEST',
                verificationUrl: 'https://grik.io/device',
                expiresAt: Date.now() + 900_000,
            },
            summary: {
                label: 'Free account',
                detail: 'Sign in to unlock hosted Ricochet models',
                tone: 'idle',
                actionLabel: 'Sign in',
                authenticated: false,
                hostedAccess: false,
                accessState: 'signed_out',
                accessLabel: 'Sign in required',
            },
        }));

        expect(html).toContain('GRIK-TEST');
        expect(html).toContain('Expires in');
        expect(html).toContain('Never share this code');
        expect(html).toContain('Open Grik login');
        expect(html).toContain('Copy link');
        expect(html).toContain('Grik browser sign in');
    });

    it('renders quota warnings and model limit rows when Grik budget is constrained', () => {
        const html = renderAccount(account({
            billingState: {
                credits: [{ product: 'ricochet_code', balance: 8 }],
                entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'active' }],
                budget: {
                    allowed: true,
                    plan: 'pro',
                    window_used: 960,
                    window_limit: 1000,
                    window_remaining: 40,
                    task_used: 90,
                    task_limit: 100,
                    task_remaining: 10,
                },
                syncStatus: 'ready',
            },
            summary: {
                label: 'Pro plan',
                detail: 'Hosted Ricochet models are available',
                tone: 'success',
                actionLabel: 'Manage',
                authenticated: true,
                hostedAccess: true,
                plan: 'Pro',
                status: 'active',
                accessState: 'available',
                accessLabel: 'Available',
                quotaWarning: {
                    label: 'Window limit almost exhausted',
                    detail: '96% of the Grik window budget has been used.',
                    tone: 'danger',
                    percent: 96,
                    kind: 'window',
                },
            },
        }));

        expect(html).toContain('Window limit almost exhausted');
        expect(html).toContain('Window usage');
        expect(html).toContain('960 / 1,000');
        expect(html).toContain('Task usage');
    });
});
