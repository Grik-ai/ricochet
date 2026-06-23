import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccountBadge } from './AccountBadge';
import type { GrikAccountController } from '../../hooks/useGrikAccount';

function account(label: string): GrikAccountController {
    return {
        authState: { authenticated: true },
        billingState: {},
        deviceAuth: null,
        error: null,
        isBusy: false,
        summary: {
            label,
            detail: 'Hosted Ricochet models are available',
            tone: 'success',
            actionLabel: 'Manage',
            authenticated: true,
            hostedAccess: true,
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
    };
}

function firstButtonClass(html: string): string {
    return html.match(/<button[^>]*class="([^"]*)"/)?.[1] || '';
}

describe('AccountBadge', () => {
    it('renders Pro plan as a quiet account chip without border or ring highlights', () => {
        const html = renderToStaticMarkup(createElement(AccountBadge, {
            account: account('Pro plan'),
            onOpenAccount: () => {},
        }));
        const className = firstButtonClass(html);

        expect(html).toContain('Pro plan');
        expect(className).not.toMatch(/\bborder\b|border-/);
        expect(className).not.toContain('ring-');
        expect(className).not.toContain('bg-emerald');
    });
});
