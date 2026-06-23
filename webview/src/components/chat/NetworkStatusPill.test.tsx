import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NetworkStatusPill } from './NetworkStatusPill';
import type { NetworkDisplayStatus } from '../../hooks/useNetworkHealth';

function firstButtonClass(html: string): string {
    return html.match(/<button[^>]*class="([^"]*)"/)?.[1] || '';
}

describe('NetworkStatusPill', () => {
    it('renders Checking network without a highlighted border badge', () => {
        const html = renderToStaticMarkup(createElement(NetworkStatusPill, {
            status: {
                label: 'Checking network',
                state: 'unknown',
                tone: 'working',
                scope: 'provider',
                message: 'Checking provider reachability',
            } as NetworkDisplayStatus,
        }));
        const className = firstButtonClass(html);

        expect(html).toContain('Checking network');
        expect(className).not.toMatch(/\bborder\b|border-/);
        expect(className).not.toMatch(/\bbg-(sky|emerald|amber|rose)-/);
        expect(className).toContain('hover:bg-vscode-list-hoverBackground');
    });
});
