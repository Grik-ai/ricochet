import { useMemo, useState } from 'react';
import { Activity, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { NetworkDisplayStatus } from '../../hooks/useNetworkHealth';
import { NetworkHealthScope, NetworkScopeStatus } from '../../types/protocol';

function scopeLabel(scope: NetworkHealthScope): string {
    switch (scope) {
        case 'webview':
            return 'Webview → Extension';
        case 'core':
            return 'Extension → Core';
        case 'provider':
            return 'Core → Provider';
        case 'internet':
            return 'Internet';
        case 'agent':
            return 'Agent activity';
        default:
            return scope;
    }
}

function formatTime(value?: number): string {
    if (!value) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
    if (seconds < 2) return 'now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    return `${minutes}m ago`;
}

function formatPing(value?: number): string {
    if (value === undefined) return '';
    return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)} ms`;
}

function statusToneClass(_tone: NetworkDisplayStatus['tone']) {
    return 'text-vscode-fg/58 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/84';
}

function statusIconToneClass(tone: NetworkDisplayStatus['tone']) {
    switch (tone) {
        case 'good':
            return 'text-emerald-300/82';
        case 'slow':
            return 'text-amber-200/86';
        case 'bad':
            return 'text-rose-200/88';
        case 'working':
            return 'text-sky-200/86';
        default:
            return 'text-vscode-fg/45';
    }
}

function StatusIcon({ status }: { status: NetworkDisplayStatus }) {
    if (status.state === 'offline') return <WifiOff className="h-3 w-3" />;
    if (status.state === 'reconnecting') return <RefreshCw className="h-3 w-3 animate-spin" />;
    if (status.scope === 'agent') return <Activity className="h-3 w-3" />;
    return <Wifi className="h-3 w-3" />;
}

function DiagnosticsCopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            onClick={(event) => {
                event.stopPropagation();
                navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-vscode-fg/38 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/75"
            title={copied ? 'Copied' : 'Copy diagnostics'}
        >
            <span className={`codicon ${copied ? 'codicon-check text-emerald-400' : 'codicon-copy'} text-[12px]`} />
        </button>
    );
}

function DetailRow({ scope, detail }: { scope: NetworkHealthScope; detail?: NetworkScopeStatus }) {
    if (!detail) return null;
    const ping = formatPing(detail.pingMs);
    return (
        <div className="flex items-start justify-between gap-3 rounded px-2 py-1.5 hover:bg-vscode-list-hoverBackground/60 transition-colors">
            <div className="min-w-0">
                <div className="text-[10px] text-vscode-fg/70">{scopeLabel(scope)}</div>
                <div className="truncate text-[9px] text-vscode-fg/40">{detail.message || detail.errorCode || detail.state}</div>
            </div>
            <div className="shrink-0 text-right text-[9px] text-vscode-fg/45">
                <div className="capitalize">{detail.state}{ping ? ` · ${ping}` : ''}</div>
                <div>{formatTime(detail.lastSuccessAt || detail.lastCheckedAt || detail.lastActivityAt)}</div>
            </div>
        </div>
    );
}

export function NetworkStatusPill({ status }: { status: NetworkDisplayStatus }) {
    const [open, setOpen] = useState(false);
    const detailEntries = useMemo(() => {
        const details = status.details || {};
        return (['webview', 'core', 'provider', 'internet', 'agent'] as NetworkHealthScope[])
            .map(scope => ({ scope, detail: details[scope] }))
            .filter(item => Boolean(item.detail));
    }, [status.details]);
    const diagnosticEntries = useMemo(() => {
        return detailEntries
            .filter(({ detail }) => Boolean(detail?.rawMessage))
            .map(({ scope, detail }) => ({
                scope,
                label: scopeLabel(scope),
                rawMessage: detail!.rawMessage!,
                diagnosticCode: detail!.diagnosticCode || detail!.errorCode,
            }));
    }, [detailEntries]);

    return (
        <div className="relative shrink-0">
            <button
                type="button"
                onClick={() => setOpen(prev => !prev)}
                className={`inline-flex h-6 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[11px] leading-none transition-colors ${statusToneClass(status.tone)}`}
                title={status.message || 'Network status'}
            >
                <span className={statusIconToneClass(status.tone)}>
                    <StatusIcon status={status} />
                </span>
                <span className="truncate font-medium">{status.label}</span>
            </button>

            <div
                className={`absolute bottom-full right-0 z-[9999] mb-2 w-80 max-w-[calc(100vw-32px)] origin-bottom-right overflow-hidden rounded-md border border-vscode-border bg-vscode-input-bg shadow-lg transition-[opacity,transform,max-height] duration-200 ease-out motion-reduce:transition-none ${
                    open ? 'max-h-96 translate-y-0 opacity-100' : 'pointer-events-none max-h-0 translate-y-1 opacity-0'
                }`}
            >
                <div className="flex items-center justify-between gap-3 border-b border-vscode-border bg-vscode-editor-background px-3 py-2">
                    <div className="min-w-0">
                        <div className="text-[11px] font-medium text-vscode-fg/80">Connection</div>
                        <div className="truncate text-[10px] text-vscode-fg/45">{status.provider || 'Provider'}{status.model ? ` · ${status.model}` : ''}</div>
                    </div>
                    <div className="shrink-0 text-right text-[10px] text-vscode-fg/45">
                        <div className="capitalize">{status.state}</div>
                        <div>{formatTime(status.lastCheckedAt)}</div>
                    </div>
                </div>
                <div className="space-y-0.5 p-2">
                    {detailEntries.map(({ scope, detail }) => (
                        <DetailRow key={scope} scope={scope} detail={detail} />
                    ))}
                    {status.message && (
                        <div className="px-2 pt-1.5 text-[9px] leading-relaxed text-vscode-fg/35">
                            {status.message}
                        </div>
                    )}
                    {diagnosticEntries.length > 0 && (
                        <div className="mt-1.5 space-y-1 border-t border-vscode-border/70 px-2 pt-2">
                            <div className="text-[9px] font-medium text-vscode-fg/35">Diagnostics</div>
                            {diagnosticEntries.map(entry => (
                                <details key={`${entry.scope}-${entry.diagnosticCode || 'raw'}`} className="group rounded bg-vscode-editor-background/55 px-2 py-1">
                                    <summary className="flex cursor-pointer list-none items-center gap-2 text-[9px] text-vscode-fg/45">
                                        <span className="codicon codicon-chevron-right text-[10px] transition-transform group-open:rotate-90" />
                                        <span className="min-w-0 flex-1 truncate">{entry.label}{entry.diagnosticCode ? ` · ${entry.diagnosticCode}` : ''}</span>
                                        <DiagnosticsCopyButton text={entry.rawMessage} />
                                    </summary>
                                    <pre className="custom-scrollbar mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[9px] leading-relaxed text-vscode-fg/38">
                                        {entry.rawMessage}
                                    </pre>
                                </details>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
