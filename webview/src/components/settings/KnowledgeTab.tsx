import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    Copy,
    Database,
    FileCode2,
    HardDrive,
    Info,
    Layers,
    Loader2,
    RefreshCw,
    Search,
} from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { WorkspaceIndexStatus } from '../../types/protocol';

export interface IndexingSettings {
    enable_code_index: boolean;
    workspace_index_enabled: boolean;
    max_fragment_tokens: number;
}

export interface IndexStatus {
    is_indexing: boolean;
    total_docs: number;
    provider_configured?: boolean;
    semantic_enabled?: boolean;
    workspace_enabled?: boolean;
    store_path?: string;
    last_indexed_at?: number;
    duration_ms?: number;
    error?: string;
    workspace?: WorkspaceIndexStatus;
}

interface KnowledgeTabProps {
    settings: IndexingSettings;
    onSettingsChange: (patch: Partial<IndexingSettings>) => void;
}

type HealthTone = 'good' | 'warn' | 'danger' | 'neutral' | 'progress';

export interface IndexHealth {
    label: string;
    tone: HealthTone;
    description: string;
}

export function semanticIndexHealth(status: IndexStatus | undefined, enabled: boolean): IndexHealth {
    if (!enabled) {
        return {
            label: 'Disabled',
            tone: 'neutral',
            description: 'Semantic retrieval is off. Deterministic file and grep tools still work.',
        };
    }
    if (status?.is_indexing) {
        return {
            label: 'Indexing',
            tone: 'progress',
            description: 'Embedding code chunks and refreshing vector storage.',
        };
    }
    if (status && status.provider_configured === false) {
        return {
            label: 'Needs embeddings',
            tone: 'warn',
            description: 'Configure an embedding provider before semantic vector search can build chunks.',
        };
    }
    if (status?.error) {
        return {
            label: 'Problem',
            tone: 'danger',
            description: status.error,
        };
    }
    if ((status?.total_docs || 0) > 0) {
        return {
            label: 'Ready',
            tone: 'good',
            description: 'Semantic vector search has indexed workspace chunks.',
        };
    }
    return {
        label: 'Empty',
        tone: 'warn',
        description: 'No vector chunks are stored yet. Run Re-index after embeddings are configured.',
    };
}

export function workspaceMapHealth(workspace: WorkspaceIndexStatus | undefined, enabled: boolean): IndexHealth {
    if (!enabled) {
        return {
            label: 'Disabled',
            tone: 'neutral',
            description: 'Workspace map is off. The agent will rely on direct file tools.',
        };
    }
    if (!workspace || workspace.status === 'disabled') {
        return {
            label: 'Not built',
            tone: 'warn',
            description: 'The local manifest has not been built for this workspace yet.',
        };
    }
    if (workspace.status === 'indexing') {
        return {
            label: 'Indexing',
            tone: 'progress',
            description: 'Scanning paths, imports, outlines, and definitions.',
        };
    }
    if (workspace.status === 'error') {
        return {
            label: 'Problem',
            tone: 'danger',
            description: workspace.error || 'Workspace map failed to refresh.',
        };
    }
    if ((workspace.files_indexed || 0) > 0) {
        return {
            label: 'Ready',
            tone: 'good',
            description: 'Local-only map is available for routing and code discovery.',
        };
    }
    return {
        label: 'Empty',
        tone: 'warn',
        description: 'Workspace map is enabled but no supported files were indexed.',
    };
}

export function formatIndexBytes(bytes?: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatIndexDuration(durationMs?: number): string {
    if (!durationMs || durationMs <= 0) return '-';
    if (durationMs < 1000) return `${durationMs}ms`;
    return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

function formatIndexTime(value?: number): string {
    if (!value) return 'Never';
    return new Date(value).toLocaleString();
}

function toneClass(tone: HealthTone): string {
    switch (tone) {
        case 'good':
            return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300';
        case 'warn':
            return 'border-amber-500/25 bg-amber-500/10 text-amber-300';
        case 'danger':
            return 'border-red-500/25 bg-red-500/10 text-red-300';
        case 'progress':
            return 'border-blue-500/25 bg-blue-500/10 text-blue-300';
        default:
            return 'border-white/10 bg-white/[0.04] text-[#aaa]';
    }
}

function HealthIcon({ tone }: { tone: HealthTone }) {
    if (tone === 'good') return <CheckCircle2 className="h-3.5 w-3.5" />;
    if (tone === 'danger' || tone === 'warn') return <AlertTriangle className="h-3.5 w-3.5" />;
    if (tone === 'progress') return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
    return <Info className="h-3.5 w-3.5" />;
}

function StatusPill({ health }: { health: IndexHealth }) {
    return (
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass(health.tone)}`}>
            <HealthIcon tone={health.tone} />
            {health.label}
        </span>
    );
}

function ToggleRow({
    checked,
    onChange,
    icon,
    title,
    description,
    footnote,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    icon: ReactNode;
    title: string;
    description: string;
    footnote?: string;
}) {
    return (
        <label className="flex cursor-pointer items-start justify-between gap-4 rounded border border-white/10 bg-white/[0.025] p-3 hover:bg-white/[0.04]">
            <span className="flex min-w-0 gap-3">
                <span className="mt-0.5 text-[#888]">{icon}</span>
                <span className="min-w-0">
                    <span className="block text-sm font-medium text-[#ddd]">{title}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-[#888]">{description}</span>
                    {footnote && <span className="mt-1 block text-[10px] leading-4 text-[#777]">{footnote}</span>}
                </span>
            </span>
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                className="mt-1 accent-[#0e639c]"
            />
        </label>
    );
}

export function KnowledgeTab({ settings, onSettingsChange }: KnowledgeTabProps) {
    const { postMessage, onMessage } = useVSCodeApi();
    const [status, setStatus] = useState<IndexStatus>({ is_indexing: false, total_docs: 0 });
    const [loading, setLoading] = useState(true);
    const [manualRefreshPending, setManualRefreshPending] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        postMessage({ type: 'get_index_status' });

        const unsubscribe = onMessage((message) => {
            if (message.type === 'index_status') {
                setStatus(message.payload as IndexStatus);
                setLoading(false);
                setManualRefreshPending(false);
            }
            if (message.type === 'reindex_started') {
                setActionError(null);
                setManualRefreshPending(true);
            }
            if (message.type === 'reindex_failed') {
                const payload = message.payload as { error?: string } | undefined;
                setActionError(payload?.error || 'Failed to start re-index.');
                setManualRefreshPending(false);
            }
        });

        const timer = setInterval(() => {
            postMessage({ type: 'get_index_status' });
        }, 3000);

        return () => {
            unsubscribe();
            clearInterval(timer);
        };
    }, [onMessage, postMessage]);

    const semanticEnabled = settings.enable_code_index;
    const workspaceEnabled = settings.workspace_index_enabled;
    const semanticHealth = useMemo(() => semanticIndexHealth(status, semanticEnabled), [status, semanticEnabled]);
    const workspaceHealth = useMemo(() => workspaceMapHealth(status.workspace, workspaceEnabled), [status.workspace, workspaceEnabled]);
    const isWorking = status.is_indexing || status.workspace?.status === 'indexing' || manualRefreshPending;
    const topFiles = status.workspace?.sample_files?.slice(0, 8) || [];
    const summaryCards: Array<{ label: string; value: string; icon: ReactNode; health: IndexHealth }> = [
        { label: 'Workspace map', value: workspaceHealth.label, icon: <Database className="h-3.5 w-3.5" />, health: workspaceHealth },
        { label: 'Vector chunks', value: (status.total_docs || 0).toLocaleString(), icon: <Layers className="h-3.5 w-3.5" />, health: semanticHealth },
        { label: 'Files', value: (status.workspace?.files_indexed || 0).toLocaleString(), icon: <FileCode2 className="h-3.5 w-3.5" />, health: workspaceHealth },
        { label: 'Definitions', value: (status.workspace?.definitions || 0).toLocaleString(), icon: <HardDrive className="h-3.5 w-3.5" />, health: workspaceHealth },
    ];

    const handleReindex = () => {
        setActionError(null);
        setManualRefreshPending(true);
        postMessage({ type: 'reindex_project' });
    };

    const handleRefresh = () => {
        setManualRefreshPending(true);
        postMessage({ type: 'get_index_status' });
    };

    const handleCopyPath = async () => {
        if (!status.store_path) return;
        try {
            await navigator.clipboard.writeText(status.store_path);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (error) {
            setActionError(error instanceof Error ? error.message : 'Failed to copy path.');
        }
    };

    if (loading) {
        return (
            <div className="flex min-h-[220px] items-center justify-center rounded border border-white/10 bg-white/[0.02]">
                <Loader2 className="h-5 w-5 animate-spin text-[#888]" />
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-3xl space-y-5">
            <section className="space-y-1">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Local Indexing</h3>
                        <p className="mt-1 text-xs leading-5 text-[#888]">
                            Local workspace map plus optional semantic vectors for code discovery. This is local retrieval, not billing or cloud sync.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={handleRefresh} disabled={manualRefreshPending}>
                            <RefreshCw className={`h-3.5 w-3.5 ${manualRefreshPending && !isWorking ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                        <Button type="button" variant="default" size="sm" onClick={handleReindex} disabled={isWorking || (!semanticEnabled && !workspaceEnabled)}>
                            {isWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                            {isWorking ? 'Working...' : 'Re-index'}
                        </Button>
                    </div>
                </div>
            </section>

            <section className="grid gap-2 md:grid-cols-4">
                {summaryCards.map(({ label, value, icon, health }) => (
                    <div key={label} className="min-w-0 rounded border border-white/10 bg-white/[0.025] p-3">
                        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[#777]">
                            {icon}
                            {label}
                        </div>
                        <div className="mt-2 truncate text-[15px] font-semibold text-[#ddd]" title={value}>{value}</div>
                        <div className="mt-2">
                            <StatusPill health={health} />
                        </div>
                    </div>
                ))}
            </section>

            {(actionError || semanticHealth.tone === 'danger' || workspaceHealth.tone === 'danger' || semanticHealth.tone === 'warn' || workspaceHealth.tone === 'warn') && (
                <section className={`rounded border p-3 text-xs leading-5 ${actionError || semanticHealth.tone === 'danger' || workspaceHealth.tone === 'danger' ? 'border-red-500/25 bg-red-500/10 text-red-200' : 'border-amber-500/25 bg-amber-500/10 text-amber-100'}`}>
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="space-y-1">
                            {actionError && <p>{actionError}</p>}
                            {semanticHealth.tone !== 'good' && semanticHealth.tone !== 'neutral' && <p>{semanticHealth.description}</p>}
                            {workspaceHealth.tone !== 'good' && workspaceHealth.tone !== 'neutral' && <p>{workspaceHealth.description}</p>}
                        </div>
                    </div>
                </section>
            )}

            <section className="grid gap-3">
                <ToggleRow
                    checked={settings.workspace_index_enabled}
                    onChange={(checked) => onSettingsChange({ workspace_index_enabled: checked })}
                    icon={<Database className="h-4 w-4" />}
                    title="Workspace map on open"
                    description="Build a local-only manifest of paths, imports, outlines, and definitions."
                    footnote="Fast routing for file discovery. Does not require embeddings."
                />
                <ToggleRow
                    checked={settings.enable_code_index}
                    onChange={(checked) => onSettingsChange({ enable_code_index: checked, workspace_index_enabled: checked ? true : settings.workspace_index_enabled })}
                    icon={<Layers className="h-4 w-4" />}
                    title="Semantic vector index"
                    description="Embeddings-backed retrieval for high-level code questions and fuzzy concepts."
                    footnote="Best for concepts. Use grep/search for exact identifiers."
                />
            </section>

            <section className="rounded border border-white/10 bg-white/[0.02]">
                <button type="button" onClick={() => setDetailsOpen(value => !value)} className="flex w-full items-center justify-between gap-3 p-3 text-left">
                    <span>
                        <span className="block text-xs font-medium uppercase tracking-wide text-[#888]">Index Details</span>
                        <span className="block text-[11px] text-[#777]">Top files, storage, last refresh, and runtime notes.</span>
                    </span>
                    <ChevronDown className={`h-4 w-4 text-[#888] transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
                </button>
                {detailsOpen && (
                    <div className="space-y-4 border-t border-white/10 p-3">
                        <div className="grid gap-2 md:grid-cols-3">
                            <div>
                                <div className="text-[10px] uppercase tracking-wide text-[#777]">Workspace refresh</div>
                                <div className="mt-1 text-xs text-[#ddd]">{formatIndexTime(status.workspace?.last_indexed_at)}</div>
                                <div className="mt-0.5 text-[10px] text-[#777]">{formatIndexDuration(status.workspace?.duration_ms)}</div>
                            </div>
                            <div>
                                <div className="text-[10px] uppercase tracking-wide text-[#777]">Semantic refresh</div>
                                <div className="mt-1 text-xs text-[#ddd]">{formatIndexTime(status.last_indexed_at)}</div>
                                <div className="mt-0.5 text-[10px] text-[#777]">{formatIndexDuration(status.duration_ms)}</div>
                            </div>
                            <div>
                                <div className="text-[10px] uppercase tracking-wide text-[#777]">Coverage</div>
                                <div className="mt-1 text-xs text-[#ddd]">{formatIndexBytes(status.workspace?.bytes_indexed)}</div>
                                <div className="mt-0.5 text-[10px] text-[#777]">Local files only</div>
                            </div>
                        </div>

                        <div className="rounded border border-white/10">
                            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
                                <span className="text-[10px] font-medium uppercase tracking-wide text-[#777]">Top files by definitions</span>
                                <span className="text-[10px] text-[#777]">{topFiles.length ? `${topFiles.length} shown` : 'No files yet'}</span>
                            </div>
                            {topFiles.length ? (
                                <div className="max-h-44 overflow-auto">
                                    {topFiles.map(file => (
                                        <div key={file.path} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-white/5 px-3 py-2 last:border-b-0">
                                            <span className="min-w-0 truncate text-[11px] text-[#ccc]" title={file.path}>{file.path}</span>
                                            <span className="text-[10px] text-[#777]">{file.language || 'file'}</span>
                                            <span className="text-[10px] text-[#aaa]">{file.definitions || 0} defs</span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="px-3 py-4 text-xs text-[#777]">Build the workspace map to see indexed files and definitions.</div>
                            )}
                        </div>

                        <div className="grid gap-2 md:grid-cols-2">
                            <div className="rounded border border-white/10 bg-white/[0.02] p-3">
                                <div className="flex items-center gap-2 text-xs font-medium text-[#ddd]">
                                    <Info className="h-3.5 w-3.5 text-[#888]" />
                                    Retrieval guidance
                                </div>
                                <p className="mt-2 text-[11px] leading-5 text-[#888]">Semantic search is best for concepts. Grep and symbol search stay better for exact identifiers.</p>
                            </div>
                            <div className="rounded border border-white/10 bg-white/[0.02] p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="text-xs font-medium text-[#ddd]">Vector store</div>
                                        <div className="mt-1 truncate text-[11px] text-[#888]" title={status.store_path || 'index.vdb'}>{status.store_path || 'index.vdb'}</div>
                                    </div>
                                    <Button type="button" variant="outline" size="sm" onClick={handleCopyPath} disabled={!status.store_path}>
                                        <Copy className="h-3.5 w-3.5" />
                                        {copied ? 'Copied' : 'Copy path'}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </section>

            <section className="rounded border border-white/10 bg-white/[0.02]">
                <button type="button" onClick={() => setAdvancedOpen(value => !value)} className="flex w-full items-center justify-between gap-3 p-3 text-left">
                    <span>
                        <span className="block text-xs font-medium uppercase tracking-wide text-[#888]">Advanced</span>
                        <span className="block text-[11px] text-[#777]">Fragment budget for retrieved context.</span>
                    </span>
                    <ChevronDown className={`h-4 w-4 text-[#888] transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                </button>
                {advancedOpen && (
                    <div className="border-t border-white/10 p-3">
                        <label className="text-xs text-[#888]">Max context fragment tokens</label>
                        <Input
                            type="number"
                            min={1000}
                            max={50000}
                            value={settings.max_fragment_tokens}
                            onChange={(event) => onSettingsChange({ max_fragment_tokens: parseInt(event.target.value, 10) || 10000 })}
                            className="mt-2 h-8 text-xs"
                        />
                        <p className="mt-2 text-[10px] leading-4 text-[#777]">Caps oversized retrieved files and chunks before they enter model context.</p>
                    </div>
                )}
            </section>
        </div>
    );
}
