import * as vscode from 'vscode';

type PostMessage = (message: { type: string; payload?: any }) => void;

type StoredAuthTokens = {
    accessToken: string;
    refreshToken: string;
    expiresAt?: number | null;
};

type AuthSyncStatus = 'ready' | 'degraded';

type DeviceCodeResponse = {
    device_code?: string;
    deviceCode?: string;
    user_code?: string;
    userCode?: string;
    verification_uri?: string;
    verification_url?: string;
    verificationUri?: string;
    verificationUrl?: string;
    expires_in?: number;
    expiresIn?: number;
    interval?: number;
};

type TokenResponse = {
    access_token?: string;
    accessToken?: string;
    refresh_token?: string;
    refreshToken?: string;
    expires_in?: number;
    expiresIn?: number;
    expires_at?: number | string;
    expiresAt?: number | string;
    status?: string;
    error?: string;
};

const AUTH_SECRET_KEY = 'ricochet.grik.auth';
const DEFAULT_GRIK_API_BASE_URL = 'https://grik.io/api/v1';
const DEFAULT_GRIK_WEB_BASE_URL = 'https://grik.io';
const ACCOUNT_REQUEST_ATTEMPTS = 2;
const ACCOUNT_RETRY_DELAY_MS = 250;

export class AuthService {
    private pollTimer?: ReturnType<typeof setTimeout>;
    private pollAbort?: AbortController;
    private activeDeviceCode?: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly postMessage: PostMessage,
        private readonly onAccessTokenChanged?: (accessToken: string | null) => Promise<void> | void
    ) {}

    async startLogin() {
        this.cancelLogin();

        try {
            const response = await this.postJson<DeviceCodeResponse>('/auth/device/code', {
                client: 'ricochet-vscode',
                scope: 'ricochet_code',
            });

            const deviceCode = response.device_code || response.deviceCode;
            const userCode = response.user_code || response.userCode;
            const verificationUrl = response.verification_url || response.verification_uri || response.verificationUrl || response.verificationUri;
            const interval = Math.max(2, Number(response.interval || 5));
            const expiresIn = Number(response.expires_in || response.expiresIn || 900);

            if (!deviceCode || !userCode || !verificationUrl) {
                throw new Error('Grik API returned an incomplete device login response.');
            }

            this.activeDeviceCode = deviceCode;
            this.postMessage({
                type: 'device_auth_started',
                payload: {
                    userCode,
                    verificationUrl,
                    interval,
                    expiresAt: Date.now() + expiresIn * 1000,
                },
            });

            this.schedulePoll(deviceCode, interval, Date.now() + expiresIn * 1000);
            try {
                await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));
            } catch (error) {
                console.warn('[AuthService] Failed to open Grik verification URL:', error);
            }
        } catch (error: any) {
            this.failDeviceAuth(error);
        }
    }

    cancelLogin() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.pollAbort?.abort();
        this.pollAbort = undefined;
        this.activeDeviceCode = undefined;
    }

    async logout() {
        this.cancelLogin();
        await this.context.secrets.delete(AUTH_SECRET_KEY);
        await this.notifyAccessToken(null);
        this.postMessage({ type: 'auth_state', payload: this.loggedOutState() });
        this.postMessage({ type: 'billing_state', payload: { credits: [], entitlements: [], syncStatus: 'ready' } });
    }

    async syncState() {
        const tokens = await this.getTokens();
        if (!tokens?.accessToken) {
            this.postMessage({ type: 'auth_state', payload: this.loggedOutState() });
            this.postMessage({ type: 'billing_state', payload: { credits: [], entitlements: [], syncStatus: 'ready' } });
            return;
        }

        let activeTokens = tokens;
        if (tokens.expiresAt && tokens.expiresAt < Date.now() + 30_000) {
            const refreshed = await this.refreshTokens(tokens).catch((error) => {
                if (isUnauthorized(error)) {
                    return null;
                }
                this.postAuthenticatedState(tokens, null, 'degraded', errorMessage(error));
                return undefined;
            });
            if (refreshed === undefined) {
                await this.notifyAccessToken(activeTokens.accessToken);
                await this.syncBillingState(activeTokens.accessToken);
                return;
            }
            if (refreshed === null) {
                await this.logout();
                return;
            }
            activeTokens = refreshed;
        }

        await this.notifyAccessToken(activeTokens.accessToken);

        const me = await this.getJsonWithRetry('/users/me', activeTokens.accessToken).catch(async (error) => {
            if (isUnauthorized(error)) {
                const refreshed = await this.refreshTokens(activeTokens).catch(() => null);
                if (refreshed) {
                    activeTokens = refreshed;
                    await this.notifyAccessToken(activeTokens.accessToken);
                    return this.getJsonWithRetry('/users/me', activeTokens.accessToken);
                }
                await this.logout();
                return undefined;
            }
            this.postAuthenticatedState(activeTokens, null, 'degraded', errorMessage(error));
            await this.syncBillingState(activeTokens.accessToken);
            return undefined;
        });
        if (me === undefined) return;

        this.postAuthenticatedState(activeTokens, (me as any).user || me, 'ready');

        await this.syncBillingState(activeTokens.accessToken);
    }

    async openBilling(payload?: { target?: string; product?: string }) {
        const baseUrl = this.webBaseUrl();
        const rawProduct = payload?.product;
        const product = rawProduct === 'ricochet_code' && payload?.target !== 'subscription' ? 'ricochet-code' : rawProduct;
        const target = payload?.target === 'subscription'
            ? '/en/me/subscription'
            : product === 'ricochet-code' || payload?.target === 'credits' ? '/en/pricing' : '/en/me/settings';
        const url = new URL(target, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
        const productParam = payload?.target === 'subscription' ? rawProduct || product : product;
        if (productParam) {
            url.searchParams.set('product', productParam);
        }
        await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
    }

    async openExternal(url: string) {
        if (!/^https?:\/\//i.test(url)) return;
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    async cancelSubscription(subscriptionId: string, reason?: string) {
        if (!subscriptionId) {
            throw new Error('Subscription id is required.');
        }
        const accessToken = await this.activeAccessToken();
        const result = await this.postJson(`/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
            reason: reason || 'user_requested',
        }, accessToken);
        await this.syncBillingState(accessToken);
        return result;
    }

    async resumeSubscription(subscriptionId: string) {
        if (!subscriptionId) {
            throw new Error('Subscription id is required.');
        }
        const accessToken = await this.activeAccessToken();
        const result = await this.postJson(`/billing/subscriptions/${encodeURIComponent(subscriptionId)}/resume`, {}, accessToken);
        await this.syncBillingState(accessToken);
        return result;
    }

    private schedulePoll(deviceCode: string, intervalSeconds: number, expiresAt: number) {
        this.pollTimer = setTimeout(() => {
            this.pollDeviceToken(deviceCode, intervalSeconds, expiresAt).catch(error => this.failDeviceAuth(error));
        }, intervalSeconds * 1000);
    }

    private async pollDeviceToken(deviceCode: string, intervalSeconds: number, expiresAt: number): Promise<void> {
        if (this.activeDeviceCode !== deviceCode) return;
        if (Date.now() > expiresAt) {
            throw new Error('Device login expired. Start sign in again.');
        }

        this.pollAbort = new AbortController();
        const url = this.apiUrl('/auth/device/token');
        const response = await this.fetchWithDiagnostics(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_code: deviceCode, deviceCode }),
            signal: this.pollAbort.signal,
        });

        if (response.status === 202) {
            this.schedulePoll(deviceCode, intervalSeconds, expiresAt);
            return;
        }

        const payload = await readJson<TokenResponse>(response);
        if (!response.ok) {
            const error = payload?.error || (payload as any)?.message || `Device login failed with ${response.status}.`;
            throw new Error(error);
        }

        const accessToken = payload.access_token || payload.accessToken;
        const refreshToken = payload.refresh_token || payload.refreshToken;
        if (!accessToken || !refreshToken) {
            if (payload.status === 'pending') {
                this.schedulePoll(deviceCode, intervalSeconds, expiresAt);
                return;
            }
            throw new Error('Grik API returned no tokens for approved device login.');
        }

        const storedTokens = {
            accessToken,
            refreshToken,
            expiresAt: this.resolveExpiresAt(payload),
        };
        await this.storeTokens(storedTokens);

        this.cancelLogin();
        this.postMessage({ type: 'device_auth_complete', payload: { ok: true } });
        await this.syncState().catch((error) => {
            this.postAuthenticatedState(storedTokens, null, 'degraded', errorMessage(error));
        });
    }

    private async refreshTokens(tokens: StoredAuthTokens): Promise<StoredAuthTokens> {
        const payload = await this.postJson<TokenResponse>('/auth/refresh', {
            refresh_token: tokens.refreshToken,
            refreshToken: tokens.refreshToken,
        });
        const accessToken = payload.access_token || payload.accessToken;
        const refreshToken = payload.refresh_token || payload.refreshToken || tokens.refreshToken;
        if (!accessToken || !refreshToken) {
            throw new Error('Grik refresh response did not contain tokens.');
        }
        const nextTokens = {
            accessToken,
            refreshToken,
            expiresAt: this.resolveExpiresAt(payload),
        };
        await this.storeTokens(nextTokens);
        return nextTokens;
    }

    private async syncBillingState(accessToken: string) {
        const [creditsResult, entitlementsResult, budgetResult] = await Promise.allSettled([
            this.getJsonWithRetry('/billing/credits', accessToken),
            this.getJsonWithRetry('/billing/entitlements', accessToken),
            this.getJsonWithRetry('/ricochet/budget', accessToken),
        ]);
        const errors = [creditsResult, entitlementsResult]
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => errorMessage(result.reason));
        const budget = budgetResult.status === 'fulfilled'
            ? ((budgetResult.value as any).budget || budgetResult.value)
            : null;

        this.postMessage({
            type: 'billing_state',
            payload: {
                credits: creditsResult.status === 'fulfilled' ? ((creditsResult.value as any).credits || creditsResult.value) : [],
                entitlements: entitlementsResult.status === 'fulfilled' ? ((entitlementsResult.value as any).entitlements || entitlementsResult.value) : [],
                budget,
                syncStatus: errors.length > 0 ? 'degraded' : 'ready',
                ...(errors.length > 0 ? { error: Array.from(new Set(errors)).join(' ') } : {}),
            },
        });
    }

    private postAuthenticatedState(tokens: StoredAuthTokens, user: unknown, syncStatus: AuthSyncStatus, error?: string) {
        this.postMessage({
            type: 'auth_state',
            payload: {
                authenticated: true,
                user,
                expiresAt: tokens.expiresAt || null,
                apiBaseUrl: this.apiBaseUrl(),
                webBaseUrl: this.webBaseUrl(),
                syncStatus,
                ...(error ? { error } : {}),
            },
        });
    }

    private async postJson<T>(path: string, body: any, accessToken?: string): Promise<T> {
        const response = await this.fetchWithDiagnostics(this.apiUrl(path), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
            },
            body: JSON.stringify(body || {}),
        });
        const payload = await readJson<T>(response);
        if (!response.ok) {
            throw new HttpError(response.status, (payload as any)?.error || (payload as any)?.message || `Request failed with ${response.status}.`);
        }
        return payload;
    }

    private async getJson(path: string, accessToken?: string): Promise<unknown> {
        const response = await this.fetchWithDiagnostics(this.apiUrl(path), {
            method: 'GET',
            headers: {
                ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
            },
        });
        const payload = await readJson<unknown>(response);
        if (!response.ok) {
            throw new HttpError(response.status, (payload as any)?.error || (payload as any)?.message || `Request failed with ${response.status}.`);
        }
        return payload;
    }

    private async getJsonWithRetry(path: string, accessToken?: string): Promise<unknown> {
        return this.withTransientRetry(() => this.getJson(path, accessToken), ACCOUNT_REQUEST_ATTEMPTS);
    }

    private async activeAccessToken(): Promise<string> {
        const tokens = await this.getTokens();
        if (!tokens?.accessToken) {
            throw new Error('Sign in to Grik before managing subscriptions.');
        }
        if (tokens.expiresAt && tokens.expiresAt < Date.now() + 30_000) {
            const refreshed = await this.refreshTokens(tokens);
            return refreshed.accessToken;
        }
        return tokens.accessToken;
    }

    private async withTransientRetry<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (attempt >= attempts || !isTransientError(error)) {
                    throw error;
                }
                await delay(ACCOUNT_RETRY_DELAY_MS * attempt);
            }
        }
        throw lastError;
    }

    private async getTokens(): Promise<StoredAuthTokens | null> {
        const raw = await this.context.secrets.get(AUTH_SECRET_KEY);
        if (!raw) return null;
        try {
            return JSON.parse(raw) as StoredAuthTokens;
        } catch {
            await this.context.secrets.delete(AUTH_SECRET_KEY);
            return null;
        }
    }

    private async storeTokens(tokens: StoredAuthTokens) {
        await this.context.secrets.store(AUTH_SECRET_KEY, JSON.stringify(tokens));
        await this.notifyAccessToken(tokens.accessToken);
    }

    private async notifyAccessToken(accessToken: string | null) {
        try {
            await this.onAccessTokenChanged?.(accessToken);
        } catch (error) {
            console.warn('[AuthService] Failed to sync Grik access token to core:', error);
        }
    }

    private resolveExpiresAt(payload: TokenResponse) {
        const explicit = payload.expires_at || payload.expiresAt;
        if (typeof explicit === 'number') {
            return explicit > 10_000_000_000 ? explicit : explicit * 1000;
        }
        if (typeof explicit === 'string') {
            const numeric = Number(explicit);
            if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
            const parsed = Date.parse(explicit);
            if (Number.isFinite(parsed)) return parsed;
        }
        const expiresIn = Number(payload.expires_in || payload.expiresIn || 3600);
        return Date.now() + expiresIn * 1000;
    }

    private apiUrl(path: string) {
        const apiPath = path.replace(/^\/+/, '').replace(/^api\/v1\/?/i, '');
        return new URL(apiPath, this.normalizedApiBaseUrl(this.apiBaseUrl())).toString();
    }

    private async fetchWithDiagnostics(url: string, init: RequestInit) {
        try {
            return await fetch(url, init);
        } catch (error) {
            throw new FetchDiagnosticError(this.fetchErrorMessage(url, error), isTransientFetchFailure(error));
        }
    }

    private apiBaseUrl() {
        return String(
            vscode.workspace.getConfiguration('ricochet.grik').get('apiBaseUrl') ||
            process.env.GRIKAI_API_URL ||
            DEFAULT_GRIK_API_BASE_URL
        );
    }

    private webBaseUrl() {
        return String(
            vscode.workspace.getConfiguration('ricochet.grik').get('webBaseUrl') ||
            process.env.GRIKAI_WEB_URL ||
            DEFAULT_GRIK_WEB_BASE_URL
        );
    }

    private normalizedApiBaseUrl(baseUrl: string) {
        const url = new URL(this.normalizedBaseUrl(baseUrl));
        const pathname = url.pathname.replace(/\/+$/g, '');
        url.pathname = /\/api\/v1$/i.test(pathname)
            ? `${pathname}/`
            : `${pathname}/api/v1/`.replace(/\/{2,}/g, '/');
        return url.toString();
    }

    private normalizedBaseUrl(baseUrl: string) {
        return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    }

    private fetchErrorMessage(url: string, error: unknown) {
        let target = url;
        try {
            const parsed = new URL(url);
            target = `${parsed.origin}${parsed.pathname}`;
        } catch {
            // Keep the original URL for diagnostics.
        }

        const details = fetchFailureDetails(error);
        const suffix = details ? ` (${details})` : '';
        return `Cannot reach Grik API at ${target}${suffix}. Check ricochet.grik.apiBaseUrl or start the Grik API gateway.`;
    }

    private loggedOutState() {
        return {
            authenticated: false,
            user: null,
            expiresAt: null,
            apiBaseUrl: this.apiBaseUrl(),
            webBaseUrl: this.webBaseUrl(),
            syncStatus: 'ready',
        };
    }

    private failDeviceAuth(error: any) {
        this.cancelLogin();
        const message = error?.name === 'AbortError' ? 'Sign in was cancelled.' : error?.message || 'Sign in failed.';
        this.postMessage({ type: 'device_auth_failed', payload: { error: message } });
    }
}

class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

class FetchDiagnosticError extends Error {
    constructor(message: string, readonly transient: boolean) {
        super(message);
    }
}

function isUnauthorized(error: unknown) {
    return error instanceof HttpError && error.status === 401;
}

function isTransientError(error: unknown) {
    if (error instanceof FetchDiagnosticError) {
        return error.transient;
    }
    const message = errorMessage(error);
    return /UND_ERR_CONNECT_TIMEOUT|connect timeout|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|Cannot reach Grik API/i.test(message);
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error || 'Request failed.');
}

async function readJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!text) return {} as T;
    try {
        return JSON.parse(text) as T;
    } catch {
        return { error: text } as T;
    }
}

function fetchFailureDetails(error: unknown): string {
    const seen = new Set<unknown>();
    const parts: string[] = [];
    let current: any = error;

    while (current && !seen.has(current)) {
        seen.add(current);
        if (typeof current.code === 'string' && current.code) {
            parts.push(current.code);
        }
        if (typeof current.message === 'string' && current.message && current.message !== 'fetch failed') {
            parts.push(current.message);
        }
        current = current.cause;
    }

    return Array.from(new Set(parts)).join(': ');
}

function isTransientFetchFailure(error: unknown): boolean {
    const details = fetchFailureDetails(error);
    const message = error instanceof Error ? `${error.name} ${error.message} ${details}` : details;
    return /UND_ERR_CONNECT_TIMEOUT|connect timeout|fetch failed|AbortError|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message);
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
