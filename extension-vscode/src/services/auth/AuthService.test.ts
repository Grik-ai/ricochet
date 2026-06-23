import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

vi.mock('vscode', () => ({
    env: {
        openExternal: vi.fn(async () => undefined),
    },
    Uri: {
        parse: (value: string) => ({ toString: () => value }),
    },
    workspace: {
        getConfiguration: () => ({
            get: () => undefined,
        }),
    },
}));

import { AuthService } from './AuthService';

const AUTH_SECRET_KEY = 'ricochet.grik.auth';

describe('AuthService account sync', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('keeps device login connected when /users/me temporarily fails', async () => {
        const messages: Array<{ type: string; payload?: any }> = [];
        const coreSync = vi.fn(async () => undefined);
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/auth/device/token')) {
                return jsonResponse({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
            }
            if (url.includes('/users/me')) {
                throw transientFetchFailure();
            }
            if (url.includes('/billing/credits')) {
                return jsonResponse({ credits: [{ product: 'ricochet_code', balance: 12 }] });
            }
            if (url.includes('/billing/entitlements')) {
                return jsonResponse({ entitlements: [] });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const service = new AuthService(createContext(), (message) => messages.push(message), coreSync);
        (service as any).activeDeviceCode = 'device-code';

        await (service as any).pollDeviceToken('device-code', 1, Date.now() + 60_000);

        expect(messages.some((message) => message.type === 'device_auth_complete')).toBe(true);
        expect(coreSync).toHaveBeenCalledWith('access-token');
        expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/users/me'))).toHaveLength(2);

        const authState = latestPayload(messages, 'auth_state');
        expect(authState).toMatchObject({
            authenticated: true,
            user: null,
            syncStatus: 'degraded',
        });
        expect(authState.error).toContain('Cannot reach Grik API');
    });

    it('posts degraded billing state without logging out when billing sync fails', async () => {
        const messages: Array<{ type: string; payload?: any }> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/users/me')) {
                return jsonResponse({ user: { id: 'user_1', email: 'dev@example.com', plan: 'pro' } });
            }
            if (url.includes('/billing/credits') || url.includes('/billing/entitlements')) {
                throw transientFetchFailure();
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const service = new AuthService(createContext({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
        }), (message) => messages.push(message));

        await service.syncState();

        expect(latestPayload(messages, 'auth_state')).toMatchObject({
            authenticated: true,
            syncStatus: 'ready',
        });
        expect(latestPayload(messages, 'billing_state')).toMatchObject({
            credits: [],
            entitlements: [],
            syncStatus: 'degraded',
        });
    });

    it('keeps billing ready when optional budget sync fails', async () => {
        const messages: Array<{ type: string; payload?: any }> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/users/me')) {
                return jsonResponse({ user: { id: 'user_1', email: 'dev@example.com' } });
            }
            if (url.includes('/billing/credits')) {
                return jsonResponse({ credits: [{ product: 'ricochet_code', balance: 42 }] });
            }
            if (url.includes('/billing/entitlements')) {
                return jsonResponse({ entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'active' }] });
            }
            if (url.includes('/ricochet/budget')) {
                return jsonResponse({ error: 'budget unavailable' }, 404);
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const service = new AuthService(createContext({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
        }), (message) => messages.push(message));

        await service.syncState();

        expect(latestPayload(messages, 'billing_state')).toMatchObject({
            credits: [{ product: 'ricochet_code', balance: 42 }],
            entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'active' }],
            budget: null,
            syncStatus: 'ready',
        });
    });

    it('cancels subscriptions with a user token and refreshes billing state', async () => {
        const messages: Array<{ type: string; payload?: any }> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/billing/subscriptions/sub_1/cancel')) {
                expect(init?.method).toBe('POST');
                expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer access-token');
                expect(JSON.parse(String(init?.body))).toMatchObject({ reason: 'too_expensive' });
                return jsonResponse({ subscription: { id: 'sub_1', cancel_at_period_end: true } });
            }
            if (url.includes('/billing/credits')) {
                return jsonResponse({ credits: [{ product: 'ricochet_code', balance: 42 }] });
            }
            if (url.includes('/billing/entitlements')) {
                return jsonResponse({ entitlements: [{ id: 'sub_1', product: 'ricochet_code', plan: 'pro', status: 'active', cancel_at_period_end: true }] });
            }
            if (url.includes('/ricochet/budget')) {
                return jsonResponse({ allowed: true, plan: 'pro' });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const service = new AuthService(createContext({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
        }), (message) => messages.push(message));

        await service.cancelSubscription('sub_1', 'too_expensive');

        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/billing/subscriptions/sub_1/cancel'))).toBe(true);
        expect(latestPayload(messages, 'billing_state')).toMatchObject({
            entitlements: [{ id: 'sub_1', cancel_at_period_end: true }],
            syncStatus: 'ready',
        });
    });

    it('resumes subscriptions and refreshes billing state', async () => {
        const messages: Array<{ type: string; payload?: any }> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/billing/subscriptions/sub_1/resume')) {
                expect(init?.method).toBe('POST');
                expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer access-token');
                return jsonResponse({ subscription: { id: 'sub_1', cancel_at_period_end: false } });
            }
            if (url.includes('/billing/credits')) {
                return jsonResponse({ credits: [{ product: 'ricochet_code', balance: 42 }] });
            }
            if (url.includes('/billing/entitlements')) {
                return jsonResponse({ entitlements: [{ id: 'sub_1', product: 'ricochet_code', plan: 'pro', status: 'active', cancel_at_period_end: false }] });
            }
            if (url.includes('/ricochet/budget')) {
                return jsonResponse({ allowed: true, plan: 'pro' });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const service = new AuthService(createContext({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
        }), (message) => messages.push(message));

        await service.resumeSubscription('sub_1');

        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/billing/subscriptions/sub_1/resume'))).toBe(true);
        expect(latestPayload(messages, 'billing_state')).toMatchObject({
            entitlements: [{ id: 'sub_1', cancel_at_period_end: false }],
            syncStatus: 'ready',
        });
    });

    it('logs out when refresh returns unauthorized', async () => {
        const messages: Array<{ type: string; payload?: any }> = [];
        const coreSync = vi.fn(async () => undefined);
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/auth/refresh')) {
                return jsonResponse({ error: 'Invalid refresh token' }, 401);
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const service = new AuthService(createContext({
            accessToken: 'expired-access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() - 1000,
        }), (message) => messages.push(message), coreSync);

        await service.syncState();

        expect(latestPayload(messages, 'auth_state')).toMatchObject({
            authenticated: false,
            user: null,
            syncStatus: 'ready',
        });
        expect(coreSync).toHaveBeenCalledWith(null);
    });
});

function createContext(initialTokens?: unknown) {
    const secrets = new Map<string, string>();
    if (initialTokens) {
        secrets.set(AUTH_SECRET_KEY, JSON.stringify(initialTokens));
    }
    return {
        secrets: {
            get: vi.fn(async (key: string) => secrets.get(key)),
            store: vi.fn(async (key: string, value: string) => {
                secrets.set(key, value);
            }),
            delete: vi.fn(async (key: string) => {
                secrets.delete(key);
            }),
        },
    } as unknown as vscode.ExtensionContext;
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function transientFetchFailure() {
    return Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error' },
    });
}

function latestPayload(messages: Array<{ type: string; payload?: any }>, type: string) {
    return [...messages].reverse().find((message) => message.type === type)?.payload;
}
