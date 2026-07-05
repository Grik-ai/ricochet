import { CoreProcess } from '../../core-process';
import {
    NetworkHealthScope,
    NetworkHealthState,
    NetworkScopeStatusPayload,
    NetworkStatusPayload,
    ProviderNetworkEventPayload,
} from '../../protocol/coreMessages';
import { formatChatErrorInfo } from '../chat/chatErrors';

interface CoreHealthSnapshot {
    ok?: boolean;
    timestamp?: number;
    uptime_ms?: number;
    active_chat?: boolean;
    provider?: string;
    model?: string;
    base_url?: string;
    last_provider_request_at?: number;
    last_provider_success_at?: number;
    last_provider_error?: string;
    last_provider_category?: string;
    last_provider_latency_ms?: number;
}

interface HealthPart extends NetworkScopeStatusPayload {
    consecutiveFailures?: number;
}

export interface NetworkHealthServiceState {
    provider?: string;
    model?: string;
    scope: NetworkHealthScope;
    state: NetworkHealthState;
    pingMs?: number;
    attempt?: number;
    maxAttempts?: number;
    message?: string;
    errorCode?: string;
    details: Partial<Record<NetworkHealthScope, HealthPart>>;
}

const CORE_CHECK_INTERVAL_MS = 5000;
const PROVIDER_CHECK_INTERVAL_MS = 15000;
const PASSIVE_OFFLINE_CHECK_INTERVAL_MS = 30000;
const WEBVIEW_PING_TIMEOUT_MS = 2500;
const MAX_RECONNECT_ATTEMPTS = 5;

function providerStatusMessage(error: string | undefined, provider: string | undefined, category: string | undefined): Pick<NetworkScopeStatusPayload, 'message' | 'rawMessage' | 'diagnosticCode' | 'errorCode'> {
    if (!error) {
        return { message: undefined, errorCode: category };
    }
    const info = formatChatErrorInfo(error, { provider, category });
    return {
        message: info.message,
        rawMessage: info.rawMessage,
        diagnosticCode: info.diagnosticCode,
        errorCode: info.kind === 'provider_config' ? 'provider_config' : category || info.kind,
    };
}

export function deriveProviderProbeUrl(provider?: string, baseURL?: string): string | null {
    if (baseURL) {
        try {
            const parsed = new URL(baseURL);
            return `${parsed.origin}${parsed.pathname.replace(/\/chat\/completions\/?$/i, '') || '/'}`;
        } catch {
            return baseURL;
        }
    }

    switch ((provider || '').toLowerCase()) {
        case 'openai':
            return 'https://api.openai.com/v1';
        case 'openrouter':
            return 'https://openrouter.ai/api/v1';
        case 'anthropic':
            return 'https://api.anthropic.com/v1';
        case 'gemini':
            return 'https://generativelanguage.googleapis.com';
        case 'deepseek':
            return 'https://api.deepseek.com/v1';
        case 'zhipu':
        case 'glm':
        case 'zhipu-coding':
            return 'https://open.bigmodel.cn/api/paas/v4';
        case 'minimax':
            return 'https://api.minimax.chat/v1';
        case 'xai':
            return 'https://api.x.ai/v1';
        case 'mistral':
            return 'https://api.mistral.ai/v1';
        default:
            return null;
    }
}

export function classifyNetworkState(scope: NetworkHealthScope, part?: HealthPart): Pick<NetworkHealthServiceState, 'state' | 'scope' | 'attempt' | 'maxAttempts' | 'message' | 'errorCode' | 'pingMs'> {
    if (!part) {
        return { state: 'unknown', scope };
    }

    const failures = part.consecutiveFailures || 0;
    if (part.state === 'offline' || failures >= MAX_RECONNECT_ATTEMPTS) {
        return {
            state: 'offline',
            scope,
            attempt: failures || part.lastCheckedAt ? Math.min(Math.max(failures, 1), MAX_RECONNECT_ATTEMPTS) : undefined,
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
            message: part.message,
            errorCode: part.errorCode,
            pingMs: part.pingMs,
        };
    }
    if (part.state === 'reconnecting' || failures >= 2) {
        return {
            state: 'reconnecting',
            scope,
            attempt: Math.min(failures, MAX_RECONNECT_ATTEMPTS),
            maxAttempts: MAX_RECONNECT_ATTEMPTS,
            message: part.message,
            errorCode: part.errorCode,
            pingMs: part.pingMs,
        };
    }
    if (part.state === 'degraded' || failures === 1 || (part.pingMs !== undefined && part.pingMs > 300)) {
        return {
            state: 'degraded',
            scope,
            message: part.message,
            errorCode: part.errorCode,
            pingMs: part.pingMs,
        };
    }
    if (part.state === 'online') {
        return { state: 'online', scope, message: part.message, pingMs: part.pingMs };
    }
    return { state: 'unknown', scope, message: part.message };
}

export function aggregateNetworkHealth(state: NetworkHealthServiceState): NetworkStatusPayload {
    const priority: NetworkHealthScope[] = ['internet', 'core', 'provider', 'webview', 'agent'];
    for (const scope of priority) {
        const candidate = classifyNetworkState(scope, state.details[scope]);
        if (candidate.state === 'offline' || candidate.state === 'reconnecting' || candidate.state === 'degraded') {
            return {
                state: candidate.state,
                scope,
                provider: state.provider,
                model: state.model,
                pingMs: candidate.pingMs,
                lastCheckedAt: Date.now(),
                lastSuccessAt: state.details[scope]?.lastSuccessAt,
                lastActivityAt: state.details.agent?.lastActivityAt,
                attempt: candidate.attempt,
                maxAttempts: candidate.maxAttempts,
                message: candidate.message,
                errorCode: candidate.errorCode,
                details: state.details,
            };
        }
    }

    const provider = classifyNetworkState('provider', state.details.provider);
    const core = classifyNetworkState('core', state.details.core);
    const webview = classifyNetworkState('webview', state.details.webview);
    const verified = [provider, core, webview].find(candidate => candidate.state === 'online');
    if (!verified) {
        return {
            state: 'unknown',
            scope: 'core',
            provider: state.provider,
            model: state.model,
            lastCheckedAt: Date.now(),
            lastActivityAt: state.details.agent?.lastActivityAt,
            message: 'Checking connection',
            details: state.details,
        };
    }

    return {
        state: 'online',
        scope: verified.scope,
        provider: state.provider,
        model: state.model,
        pingMs: verified.pingMs,
        lastCheckedAt: Date.now(),
        lastSuccessAt: state.details[verified.scope]?.lastSuccessAt,
        lastActivityAt: state.details.agent?.lastActivityAt,
        message: verified.message || (
            verified.scope === 'provider'
                ? 'Provider reachable'
                : verified.scope === 'core'
                    ? 'Core reachable'
                    : 'Webview bridge reachable'
        ),
        details: state.details,
    };
}

export class NetworkHealthService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastProviderProbeAt = 0;
    private lastOfflineProbeAt = 0;
    private activeWebviewPing: { id: string; sentAt: number } | null = null;
    private state: NetworkHealthServiceState = {
        scope: 'core',
        state: 'unknown',
        details: {
            core: { state: 'unknown' },
            provider: { state: 'unknown' },
            webview: { state: 'unknown' },
            internet: { state: 'unknown' },
            agent: { state: 'unknown' },
        },
    };

    constructor(
        private readonly core: CoreProcess,
        private readonly postMessage: (message: any) => void,
    ) {}

    public start(): void {
        if (this.timer) return;
        this.checkNow().catch(error => this.markCoreFailure(error));
        this.timer = setInterval(() => {
            this.checkNow().catch(error => this.markCoreFailure(error));
        }, CORE_CHECK_INTERVAL_MS);
    }

    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    public handleWebviewPong(payload: any): void {
        if (!payload?.id || !this.activeWebviewPing || payload.id !== this.activeWebviewPing.id) return;
        const pingMs = Date.now() - this.activeWebviewPing.sentAt;
        this.activeWebviewPing = null;
        this.state.details.webview = {
            state: pingMs > 300 ? 'degraded' : 'online',
            pingMs,
            lastCheckedAt: Date.now(),
            lastSuccessAt: Date.now(),
            consecutiveFailures: 0,
            message: pingMs > 300 ? 'Webview bridge is slow' : 'Webview bridge reachable',
        };
        this.publish();
    }

    public handleBrowserStatus(payload: any): void {
        const online = payload?.online !== false;
        this.state.details.internet = {
            ...this.state.details.internet,
            state: online ? 'online' : 'offline',
            lastCheckedAt: Date.now(),
            lastSuccessAt: online ? Date.now() : this.state.details.internet?.lastSuccessAt,
            message: online ? 'Browser network available' : 'Browser is offline',
            errorCode: online ? undefined : 'browser_offline',
            consecutiveFailures: online ? 0 : MAX_RECONNECT_ATTEMPTS,
        };
        this.publish();
    }

    public recordActivity(timestamp = Date.now()): void {
        this.state.details.agent = {
            state: 'online',
            lastActivityAt: timestamp,
            lastCheckedAt: timestamp,
            lastSuccessAt: timestamp,
            consecutiveFailures: 0,
            message: 'Agent activity received',
        };
        this.publish();
    }

    public recordProviderEvent(event: ProviderNetworkEventPayload): void {
        const now = event.timestamp || Date.now();
        this.state.provider = event.provider || this.state.provider;
        this.state.model = event.model || this.state.model;

        if (event.type === 'provider_request_succeeded') {
            this.state.details.provider = {
                state: (event.latency_ms || 0) > 300 ? 'degraded' : 'online',
                pingMs: event.latency_ms,
                lastCheckedAt: now,
                lastSuccessAt: now,
                consecutiveFailures: 0,
                message: (event.latency_ms || 0) > 300 ? 'Provider responded slowly' : 'Provider request succeeded',
            };
        } else if (event.type === 'provider_request_retrying') {
            const attempt = event.attempt || 1;
            const statusMessage = providerStatusMessage(event.error, event.provider || this.state.provider, event.category || 'network');
            this.state.details.provider = {
                state: attempt >= 2 ? 'reconnecting' : 'degraded',
                pingMs: event.latency_ms,
                lastCheckedAt: now,
                lastSuccessAt: this.state.details.provider?.lastSuccessAt,
                consecutiveFailures: Math.max(attempt, this.state.details.provider?.consecutiveFailures || 0),
                message: statusMessage.message || 'Provider request retrying',
                errorCode: statusMessage.errorCode,
                rawMessage: statusMessage.rawMessage,
                diagnosticCode: statusMessage.diagnosticCode,
            };
        } else if (event.type === 'provider_request_failed') {
            const category = event.category || 'network';
            const statusMessage = providerStatusMessage(event.error, event.provider || this.state.provider, category);
            if (category === 'config') {
                this.state.details.provider = {
                    state: 'degraded',
                    pingMs: event.latency_ms,
                    lastCheckedAt: now,
                    lastSuccessAt: this.state.details.provider?.lastSuccessAt,
                    consecutiveFailures: 0,
                    message: statusMessage.message || 'Provider configuration issue',
                    errorCode: statusMessage.errorCode || 'provider_config',
                    rawMessage: statusMessage.rawMessage,
                    diagnosticCode: statusMessage.diagnosticCode,
                };
                this.publish();
                return;
            }
            const failures = Math.max(event.attempt || 1, (this.state.details.provider?.consecutiveFailures || 0) + 1);
            this.state.details.provider = {
                state: category === 'server' || category === 'rate_limit' || category === 'http'
                    ? 'degraded'
                    : failures >= MAX_RECONNECT_ATTEMPTS ? 'offline' : 'reconnecting',
                pingMs: event.latency_ms,
                lastCheckedAt: now,
                lastSuccessAt: this.state.details.provider?.lastSuccessAt,
                consecutiveFailures: category === 'server' || category === 'rate_limit' || category === 'http' ? 1 : failures,
                message: statusMessage.message || 'Provider request failed',
                errorCode: statusMessage.errorCode || category,
                rawMessage: statusMessage.rawMessage,
                diagnosticCode: statusMessage.diagnosticCode,
            };
        } else if (event.type === 'provider_request_started') {
            this.state.details.provider = {
                ...this.state.details.provider,
                state: this.state.details.provider?.state || 'unknown',
                lastCheckedAt: now,
                message: 'Provider request started',
            };
        }
        this.publish();
    }

    private async checkNow(): Promise<void> {
        this.sendWebviewPing();
        const health = await this.checkCore();
        const now = Date.now();
        const providerInterval = this.state.details.provider?.state === 'offline'
            ? PASSIVE_OFFLINE_CHECK_INTERVAL_MS
            : PROVIDER_CHECK_INTERVAL_MS;
        if (health.provider && now - this.lastProviderProbeAt >= providerInterval && now - this.lastOfflineProbeAt >= providerInterval) {
            this.lastProviderProbeAt = now;
            await this.checkProvider(health.provider, health.base_url);
        }
        this.publish();
    }

    private async checkCore(): Promise<CoreHealthSnapshot> {
        const started = Date.now();
        const result = await this.core.send('health_check', {}, 2500) as CoreHealthSnapshot;
        const pingMs = Date.now() - started;
        this.state.provider = result.provider || this.state.provider;
        this.state.model = result.model || this.state.model;
        this.state.details.core = {
            state: pingMs > 300 ? 'degraded' : 'online',
            pingMs,
            lastCheckedAt: Date.now(),
            lastSuccessAt: Date.now(),
            consecutiveFailures: 0,
            message: result.active_chat ? 'Core reachable; run active' : 'Core reachable',
        };
        if (result.last_provider_error) {
            const category = result.last_provider_category || 'provider_error';
            const statusMessage = providerStatusMessage(result.last_provider_error, result.provider || this.state.provider, category);
            this.state.details.provider = {
                ...this.state.details.provider,
                state: category === 'network' && this.state.details.provider?.state === 'offline' ? 'offline' : 'degraded',
                pingMs: result.last_provider_latency_ms,
                lastCheckedAt: result.last_provider_request_at || Date.now(),
                lastSuccessAt: result.last_provider_success_at || this.state.details.provider?.lastSuccessAt,
                message: statusMessage.message || 'Provider request failed',
                errorCode: statusMessage.errorCode || (category === 'config' ? 'provider_config' : category),
                rawMessage: statusMessage.rawMessage,
                diagnosticCode: statusMessage.diagnosticCode,
                consecutiveFailures: category === 'config' ? 0 : this.state.details.provider?.consecutiveFailures || 1,
            };
        }
        return result;
    }

    private async checkProvider(provider: string, baseURL?: string): Promise<void> {
        const probeUrl = deriveProviderProbeUrl(provider, baseURL);
        if (!probeUrl) return;

        const started = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        try {
            const response = await fetch(probeUrl, {
                method: 'HEAD',
                signal: controller.signal,
            });
            const pingMs = Date.now() - started;
            const state: NetworkHealthState = response.status >= 500 || pingMs > 300 ? 'degraded' : 'online';
            this.state.details.provider = {
                state,
                pingMs,
                lastCheckedAt: Date.now(),
                lastSuccessAt: Date.now(),
                consecutiveFailures: 0,
                message: response.status >= 500 ? `Provider returned HTTP ${response.status}` : 'Provider endpoint reachable',
                errorCode: response.status >= 500 ? 'provider_5xx' : undefined,
            };
        } catch (error: any) {
            const failures = (this.state.details.provider?.consecutiveFailures || 0) + 1;
            const statusMessage = providerStatusMessage(error?.message, provider, error?.name === 'AbortError' ? 'timeout' : 'network');
            this.lastOfflineProbeAt = failures >= MAX_RECONNECT_ATTEMPTS ? Date.now() : 0;
            this.state.details.provider = {
                state: failures >= MAX_RECONNECT_ATTEMPTS ? 'offline' : failures >= 2 ? 'reconnecting' : 'degraded',
                pingMs: Date.now() - started,
                lastCheckedAt: Date.now(),
                lastSuccessAt: this.state.details.provider?.lastSuccessAt,
                consecutiveFailures: failures,
                message: statusMessage.message || 'Provider endpoint probe failed',
                errorCode: statusMessage.errorCode,
                rawMessage: statusMessage.rawMessage,
                diagnosticCode: statusMessage.diagnosticCode,
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    private markCoreFailure(error: any): void {
        const failures = (this.state.details.core?.consecutiveFailures || 0) + 1;
        this.state.details.core = {
            state: failures >= MAX_RECONNECT_ATTEMPTS ? 'offline' : failures >= 2 ? 'reconnecting' : 'degraded',
            lastCheckedAt: Date.now(),
            lastSuccessAt: this.state.details.core?.lastSuccessAt,
            consecutiveFailures: failures,
            message: error?.message || 'Core health check failed',
            errorCode: 'core_unreachable',
        };
        this.publish();
    }

    private sendWebviewPing(): void {
        const now = Date.now();
        if (this.activeWebviewPing && now - this.activeWebviewPing.sentAt > WEBVIEW_PING_TIMEOUT_MS) {
            const failures = (this.state.details.webview?.consecutiveFailures || 0) + 1;
            this.state.details.webview = {
                state: failures >= 2 ? 'reconnecting' : 'degraded',
                lastCheckedAt: now,
                lastSuccessAt: this.state.details.webview?.lastSuccessAt,
                consecutiveFailures: failures,
                message: 'Webview bridge ping timed out',
                errorCode: 'webview_timeout',
            };
        }

        const id = `wv-${now}`;
        this.activeWebviewPing = { id, sentAt: now };
        this.postMessage({ type: 'webview_ping', payload: { id, sentAt: now } });
    }

    private publish(): void {
        this.postMessage({ type: 'network_status', payload: aggregateNetworkHealth(this.state) });
    }
}
