import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { computeNetworkPopoverStyle, formatNetworkDetailState, formatNetworkDetailTime, NetworkStatusPill } from './NetworkStatusPill';
import type { NetworkDisplayStatus } from '../../hooks/useNetworkHealth';
import { readFileSync } from 'node:fs';

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

    it('positions connection details below the network button', () => {
        const style = computeNetworkPopoverStyle(
            { top: 660, right: 780, bottom: 692 },
            { width: 800, height: 720 },
            { width: 320, height: 384, gap: 6, margin: 12 },
        );

        expect(style.position).toBe('fixed');
        expect(Number(style.top)).toBeGreaterThan(692);
        expect(Number(style.left)).toBeGreaterThanOrEqual(12);
        expect(Number(style.left)).toBeLessThanOrEqual(800 - 320 - 12);
        expect(Number(style.maxHeight)).toBeGreaterThan(0);
        expect(Number(style.top) + Number(style.maxHeight)).toBeLessThanOrEqual(720 - 12);
    });

    it('uses a fixed portaled popover instead of the old upward absolute menu', () => {
        const source = readFileSync(new URL('./NetworkStatusPill.tsx', import.meta.url), 'utf8');

        expect(source).toContain('createPortal');
        expect(source).toContain("className=\"fixed z-[2147483647]");
        expect(source).toContain("transformOrigin: 'top right'");
        expect(source).not.toContain('absolute bottom-full');
        expect(source).not.toContain('origin-bottom-right');
    });

    it('formats browser internet detail without the old unknown online state', () => {
        expect(formatNetworkDetailState({
            state: 'online',
            message: 'Browser network available',
            lastCheckedAt: 1_000,
        })).toBe('online');
        expect(formatNetworkDetailState({
            state: 'offline',
            message: 'Browser is offline',
            lastCheckedAt: 1_000,
        })).toBe('offline');
    });

    it('uses the latest browser check time for internet detail rows', () => {
        const now = Date.now();

        expect(formatNetworkDetailTime('internet', {
            state: 'offline',
            lastCheckedAt: now,
            lastSuccessAt: now - 600_000,
        })).toBe('now');
    });
});
