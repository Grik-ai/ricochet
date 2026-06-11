import { ChatErrorInfo, ChatErrorKind, NetworkScopeStatus, NetworkStatusPayload } from '../types/protocol';

function providerDisplayName(message: string, explicitProvider?: string): string {
    if (explicitProvider) {
        if (/zhipu|glm|bigmodel/i.test(explicitProvider)) return 'Zhipu/BigModel';
        return explicitProvider;
    }
    return /bigmodel|zhipu|glm|open\.bigmodel\.cn/i.test(message)
        ? 'Zhipu/BigModel'
        : 'the provider';
}

function diagnosticCodeFor(message: string, category?: string): string {
    if (/no such host|enotfound|dns|lookup/i.test(message)) return 'dns_lookup_failed';
    if (/can't assign requested address|cannot assign requested address/i.test(message)) return 'local_socket_unavailable';
    if (/i\/o timeout|timeout|deadline exceeded|etimedout|tls handshake timeout/i.test(message)) return 'provider_timeout';
    if (/connection reset|econnreset|broken pipe|eof/i.test(message)) return 'connection_reset';
    if (/connection refused|econnrefused/i.test(message)) return 'connection_refused';
    if (/network is unreachable|temporary failure/i.test(message)) return 'network_unreachable';
    if (/\b429\b|rate limit/i.test(message) || category === 'rate_limit') return 'rate_limited';
    if (/\b5\d\d\b/.test(message) || category === 'server') return 'provider_server_error';
    if (/\b(?:400|401|403)\b|unauthorized|authentication|forbidden|api key|invalid model|unknown model|model .*not found/i.test(message) || category === 'config') return 'provider_config';
    if (/session .*not found/i.test(message)) return 'session_unavailable';
    return category || 'unknown_error';
}

function kindFor(message: string, category?: string): ChatErrorKind {
    if (/session .*not found/i.test(message)) return 'session';
    if (category === 'config' || /\b(?:400|401|403)\b|unauthorized|authentication|forbidden|api key|invalid model|unknown model|model .*not found/i.test(message)) {
        return 'provider_config';
    }
    if (category === 'rate_limit' || /\b429\b|rate limit/i.test(message)) return 'rate_limit';
    if (category === 'server' || /\b5\d\d\b/.test(message)) return 'provider_server';
    if (/can't assign requested address|cannot assign requested address|i\/o timeout|timeout|deadline exceeded|no such host|dns|lookup|connection reset|connection refused|network is unreachable|temporary failure|tls handshake timeout|econnreset|econnrefused|enotfound|etimedout/i.test(message)) {
        return 'network';
    }
    return 'unknown';
}

export function chatErrorInfoFromRaw(rawMessage: string, options: { provider?: string; category?: string } = {}): ChatErrorInfo {
    const raw = rawMessage || 'Unknown error';
    const kind = kindFor(raw, options.category);
    const provider = providerDisplayName(raw, options.provider);
    const diagnosticCode = diagnosticCodeFor(raw, options.category);

    if (kind === 'network') {
        return {
            kind,
            title: 'Connection problem',
            message: diagnosticCode === 'dns_lookup_failed'
                ? 'The model server is not reachable right now. Check DNS, VPN, or proxy settings.'
                : `Could not connect to ${provider}. Check your internet connection, VPN, or proxy settings.`,
            provider,
            retryable: true,
            rawMessage: raw,
            diagnosticCode,
            timestamp: Date.now(),
        };
    }

    if (kind === 'provider_config') {
        return {
            kind,
            title: 'Model configuration problem',
            message: 'Check the selected model and API key. The request was not completed.',
            provider,
            retryable: false,
            rawMessage: raw,
            diagnosticCode,
            timestamp: Date.now(),
        };
    }

    if (kind === 'rate_limit') {
        return {
            kind,
            title: 'Provider rate limit',
            message: 'Too many requests were sent to the model. Wait a moment and retry.',
            provider,
            retryable: true,
            rawMessage: raw,
            diagnosticCode,
            timestamp: Date.now(),
        };
    }

    if (kind === 'provider_server') {
        return {
            kind,
            title: 'Provider temporarily unavailable',
            message: `${provider} returned a server error. Try again later.`,
            provider,
            retryable: true,
            rawMessage: raw,
            diagnosticCode,
            timestamp: Date.now(),
        };
    }

    if (kind === 'session') {
        return {
            kind,
            title: 'Session problem',
            message: 'The current chat session is unavailable. Open history or start a new request.',
            retryable: false,
            rawMessage: raw,
            diagnosticCode,
            timestamp: Date.now(),
        };
    }

    return {
        kind: 'unknown',
        title: 'Request failed',
        message: 'An internal error occurred. Technical details are available in the expandable diagnostics.',
        provider,
        retryable: false,
        rawMessage: raw,
        diagnosticCode,
        timestamp: Date.now(),
    };
}

function needsSanitization(message?: string): boolean {
    return Boolean(message && /https?:\/\/|dial tcp|lookup |no such host|can't assign requested address|cannot assign requested address|open\.bigmodel\.cn|api\/paas|chat\/completions/i.test(message));
}

export function sanitizeNetworkScopeStatus(scope: NetworkScopeStatus | undefined, provider?: string): NetworkScopeStatus | undefined {
    if (!scope) return scope;
    if (!needsSanitization(scope.message)) return scope;
    const info = chatErrorInfoFromRaw(scope.rawMessage || scope.message || '', { provider, category: scope.errorCode });
    return {
        ...scope,
        message: info.message,
        rawMessage: scope.rawMessage || scope.message,
        diagnosticCode: scope.diagnosticCode || info.diagnosticCode,
        errorCode: info.kind === 'provider_config' ? 'provider_config' : scope.errorCode || info.kind,
    };
}

export function sanitizeNetworkStatusPayload(status: NetworkStatusPayload): NetworkStatusPayload {
    const provider = status.provider;
    const details = status.details
        ? Object.fromEntries(
            Object.entries(status.details).map(([scope, detail]) => [
                scope,
                sanitizeNetworkScopeStatus(detail, provider),
            ])
        ) as NetworkStatusPayload['details']
        : undefined;
    const sanitizedMain = sanitizeNetworkScopeStatus({
        state: status.state,
        message: status.message,
        errorCode: status.errorCode,
        rawMessage: (status as any).rawMessage,
        diagnosticCode: (status as any).diagnosticCode,
    }, provider);
    const nextDetails = details ? { ...details } : {};
    if (sanitizedMain?.rawMessage && !nextDetails[status.scope]?.rawMessage) {
        nextDetails[status.scope] = {
            ...(nextDetails[status.scope] || { state: status.state }),
            message: sanitizedMain.message,
            errorCode: sanitizedMain.errorCode,
            rawMessage: sanitizedMain.rawMessage,
            diagnosticCode: sanitizedMain.diagnosticCode,
        } as NetworkScopeStatus;
    }

    return {
        ...status,
        message: sanitizedMain?.message || status.message,
        errorCode: sanitizedMain?.errorCode || status.errorCode,
        details: Object.keys(nextDetails).length > 0 ? nextDetails : undefined,
    };
}

export function findRetryPromptBefore<T extends { role?: string; content?: string; timestamp?: number }>(
    messages: T[],
    failedMessage: T,
): string | null {
    const failedAt = failedMessage.timestamp || Date.now();
    const previous = [...messages]
        .filter(message => message.role === 'user' && (message.timestamp || 0) <= failedAt && Boolean((message.content || '').trim()))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
    return previous?.content?.trim() || null;
}
