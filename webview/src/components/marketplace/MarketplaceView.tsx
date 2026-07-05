import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    AlertTriangle,
    ExternalLink,
    FileText,
    Filter,
    Info,
    Loader2,
    PackageCheck,
    RefreshCw,
    Search,
    Server,
    ShieldCheck,
    Sparkles,
    Trash2,
    Wrench,
} from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '../ui/dialog';
import type {
    MarketplaceCatalogResponse,
    MarketplaceInstallPayload,
    MarketplaceInstalledMetadata,
    MarketplaceItem,
    MarketplaceItemType,
    MarketplaceMcpInstallMethod,
    MarketplaceParameter,
    MarketplaceScope,
} from '../../types/marketplace';

type StatusFilter = 'all' | 'installed' | 'not_installed';
type MarketplaceTab = Extract<MarketplaceItemType, 'mcp' | 'skill'>;

export interface MarketplaceFilters {
    type: MarketplaceTab;
    query: string;
    status: StatusFilter;
    tag: string;
}

const EMPTY_METADATA: MarketplaceInstalledMetadata = { project: [], global: [] };

export function marketplaceItemInstalledScopes(item: MarketplaceItem, metadata: MarketplaceInstalledMetadata): MarketplaceScope[] {
    const scopes: MarketplaceScope[] = [];
    if ((metadata.project || []).some((installed) => installed.id === item.id && installed.type === item.type)) {
        scopes.push('project');
    }
    if ((metadata.global || []).some((installed) => installed.id === item.id && installed.type === item.type)) {
        scopes.push('global');
    }
    return scopes;
}

export function filterMarketplaceItems(
    items: MarketplaceItem[],
    filters: MarketplaceFilters,
    metadata: MarketplaceInstalledMetadata,
): MarketplaceItem[] {
    const query = filters.query.trim().toLowerCase();
    return items.filter((item) => {
        if (item.type !== filters.type) return false;
        const scopes = marketplaceItemInstalledScopes(item, metadata);
        if (filters.status === 'installed' && scopes.length === 0) return false;
        if (filters.status === 'not_installed' && scopes.length > 0) return false;
        if (filters.tag && filters.tag !== 'all' && !(item.tags || []).includes(filters.tag) && item.category !== filters.tag) return false;
        if (!query) return true;
        const haystack = [
            item.name,
            item.description,
            item.author,
            item.category,
            item.trust,
            ...(item.tags || []),
            ...(item.mcp?.tools || []),
            ...(item.mcp?.resources || []),
            ...(item.mcp?.prompts || []),
            ...(item.skill?.allowed_tools || []),
            item.skill?.skill_name,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(query);
    }).sort((a, b) => {
        const scopeRank = marketplaceItemInstalledScopes(b, metadata).length - marketplaceItemInstalledScopes(a, metadata).length;
        if (scopeRank !== 0) return scopeRank;
        return a.name.localeCompare(b.name);
    });
}

export function marketplaceRequiredParameters(item: MarketplaceItem, methodName?: string): MarketplaceParameter[] {
    const method = selectedMcpMethod(item, methodName);
    const parameters = [
        ...(item.mcp?.parameters || []),
        ...(method?.parameters || []),
        ...(item.mcp?.env_vars || []).map((name): MarketplaceParameter => ({ name, secret: true, required: true })),
        ...(method?.env_vars || []).map((name): MarketplaceParameter => ({ name, secret: true, required: true })),
    ];
    const seen = new Set<string>();
    return parameters.filter((param) => {
        const key = parameterKey(param);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return param.required || (!param.optional && !param.default);
    });
}

export function buildMarketplaceInstallPayload(
    item: MarketplaceItem,
    scope: MarketplaceScope,
    parameters: Record<string, string> = {},
    method?: string,
): MarketplaceInstallPayload {
    return {
        id: item.id,
        type: item.type,
        scope,
        method,
        parameters,
    };
}

export function validateMarketplaceInstall(
    item: MarketplaceItem,
    parameters: Record<string, string>,
    method?: string,
): string[] {
    return marketplaceRequiredParameters(item, method)
        .filter((param) => !String(parameters[parameterKey(param)] || parameters[param.name] || parameters[param.env_var || ''] || '').trim())
        .map((param) => parameterKey(param));
}

export function MarketplaceView() {
    const { postMessage, onMessage } = useVSCodeApi();
    const [catalog, setCatalog] = useState<MarketplaceCatalogResponse>({ items: [] });
    const [metadata, setMetadata] = useState<MarketplaceInstalledMetadata>(EMPTY_METADATA);
    const [activeType, setActiveType] = useState<MarketplaceTab>('mcp');
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState<StatusFilter>('all');
    const [tag, setTag] = useState('all');
    const [syncing, setSyncing] = useState(false);
    const [busyItem, setBusyItem] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [inspectItem, setInspectItem] = useState<MarketplaceItem | null>(null);
    const [installItem, setInstallItem] = useState<MarketplaceItem | null>(null);
    const [installScope, setInstallScope] = useState<MarketplaceScope>('project');
    const [installMethod, setInstallMethod] = useState<string>('');
    const [parameterValues, setParameterValues] = useState<Record<string, string>>({});

    useEffect(() => {
        postMessage({ type: 'get_marketplace_catalog' });
        postMessage({ type: 'get_marketplace_installed_metadata' });
        const unsubscribe = onMessage((message) => {
            if (message.type === 'marketplace_catalog') {
                setCatalog((message.payload || { items: [] }) as MarketplaceCatalogResponse);
                setSyncing(false);
            }
            if (message.type === 'marketplace_installed_metadata') {
                setMetadata((message.payload || EMPTY_METADATA) as MarketplaceInstalledMetadata);
            }
            if (message.type === 'marketplace_install_result') {
                const payload = message.payload as { metadata?: MarketplaceInstalledMetadata; message?: string };
                if (payload?.metadata) setMetadata(payload.metadata);
                setBusyItem(null);
                setInstallItem(null);
                setParameterValues({});
                setNotice(payload?.message || 'Installed.');
                postMessage({ type: 'get_mcp_servers' });
                postMessage({ type: 'rescan_skills' });
            }
            if (message.type === 'marketplace_remove_result') {
                const payload = message.payload as { metadata?: MarketplaceInstalledMetadata; message?: string };
                if (payload?.metadata) setMetadata(payload.metadata);
                setBusyItem(null);
                setNotice(payload?.message || 'Removed.');
                postMessage({ type: 'get_mcp_servers' });
                postMessage({ type: 'rescan_skills' });
            }
            if (message.type === 'marketplace_error') {
                const payload = (message.payload || {}) as { error?: string };
                setError(payload.error || 'Marketplace action failed.');
                setSyncing(false);
                setBusyItem(null);
            }
        });
        return () => unsubscribe();
    }, [onMessage, postMessage]);

    const items = catalog.items || [];
    const filteredItems = useMemo(() => filterMarketplaceItems(items, {
        type: activeType,
        query,
        status,
        tag,
    }, metadata), [items, activeType, query, status, tag, metadata]);
    const tags = useMemo(() => {
        const values = new Set<string>();
        for (const item of items) {
            if (item.type !== activeType) continue;
            if (item.category) values.add(item.category);
            for (const itemTag of item.tags || []) values.add(itemTag);
        }
        return Array.from(values).sort((a, b) => a.localeCompare(b));
    }, [items, activeType]);
    const installedCount = (metadata.project || []).length + (metadata.global || []).length;
    const requiredParameters = installItem ? marketplaceRequiredParameters(installItem, installMethod || undefined) : [];
    const validationErrors = installItem ? validateMarketplaceInstall(installItem, parameterValues, installMethod || undefined) : [];

    const refreshCatalog = () => {
        setSyncing(true);
        setError(null);
        postMessage({ type: 'refresh_marketplace_catalog' });
    };

    const openInstall = (item: MarketplaceItem) => {
        setInstallItem(item);
        setInstallScope('project');
        setInstallMethod(item.mcp?.install_methods?.[0]?.name || '');
        setParameterValues({});
        setError(null);
    };

    const confirmInstall = () => {
        if (!installItem || validationErrors.length > 0) return;
        const payload = buildMarketplaceInstallPayload(installItem, installScope, parameterValues, installMethod || undefined);
        setBusyItem(itemKey(installItem));
        setError(null);
        postMessage({ type: 'install_marketplace_item', payload });
    };

    const removeInstalled = (item: MarketplaceItem, scope?: MarketplaceScope) => {
        const scopes = marketplaceItemInstalledScopes(item, metadata);
        const targetScope = scope || (scopes.includes('project') ? 'project' : scopes[0]);
        if (!targetScope) return;
        const ok = window.confirm(`Remove ${item.name} from ${targetScope} scope?`);
        if (!ok) return;
        setBusyItem(itemKey(item));
        setError(null);
        postMessage({
            type: 'remove_marketplace_item',
            payload: { id: item.id, type: item.type, scope: targetScope },
        });
    };

    return (
        <div className="mx-auto max-w-5xl space-y-5">
            <section className="rounded border border-white/10 bg-white/[0.035] p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-[#eee]">B2P / Ricochet curated marketplace</h3>
                            <TrustPill trust="verified" />
                            {catalog.stale && <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">stale/offline</span>}
                        </div>
                        <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-[#888]">
                            MCP servers add external tools, data, APIs, resources, and prompts. Agent Skills add portable SKILL.md workflow packages with declared tools and invocation policy.
                        </p>
                    </div>
                    <div className="grid min-w-[260px] grid-cols-3 gap-2 text-[10.5px] text-[#888]">
                        <Metric label="items" value={catalog.item_count ?? items.length} />
                        <Metric label="installed" value={catalog.installed_count ?? installedCount} />
                        <Metric label="sync" value={formatSync(catalog.last_synced, catalog.source)} />
                    </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-[#777]">
                        <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3 text-emerald-300" /> Verified</span>
                        <span>Community reviewed</span>
                        <span>Experimental requires extra review</span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={refreshCatalog} disabled={syncing} className="h-8 gap-1.5 text-xs">
                        {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        Refresh
                    </Button>
                </div>
                {(error || catalog.error || notice) && (
                    <div className={`mt-3 rounded px-3 py-2 text-[11px] ${error || catalog.error ? 'bg-amber-500/10 text-amber-200' : 'bg-emerald-500/10 text-emerald-200'}`}>
                        {error || catalog.error || notice}
                    </div>
                )}
            </section>

            <section className="space-y-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="inline-flex w-fit rounded border border-white/10 bg-white/[0.03] p-0.5">
                        <SegmentButton active={activeType === 'mcp'} icon={<Server className="h-3.5 w-3.5" />} label="MCP Servers" onClick={() => { setActiveType('mcp'); setTag('all'); }} />
                        <SegmentButton active={activeType === 'skill'} icon={<Sparkles className="h-3.5 w-3.5" />} label="Agent Skills" onClick={() => { setActiveType('skill'); setTag('all'); }} />
                    </div>
                    <div className="grid gap-2 lg:grid-cols-[260px_150px_150px]">
                        <label className="relative">
                            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#777]" />
                            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search catalog..." className="h-8 pl-8 text-xs" />
                        </label>
                        <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} className="h-8 rounded border border-white/10 bg-white/[0.03] px-2 text-xs text-[#ddd] outline-none">
                            <option value="all">All status</option>
                            <option value="installed">Installed</option>
                            <option value="not_installed">Not installed</option>
                        </select>
                        <select value={tag} onChange={(event) => setTag(event.target.value)} className="h-8 rounded border border-white/10 bg-white/[0.03] px-2 text-xs text-[#ddd] outline-none">
                            <option value="all">All tags</option>
                            {tags.map((item) => <option key={item} value={item}>{item}</option>)}
                        </select>
                    </div>
                </div>

                {filteredItems.length === 0 ? (
                    <div className="rounded border border-white/10 bg-white/[0.025] p-8 text-center">
                        <Filter className="mx-auto h-5 w-5 text-[#777]" />
                        <p className="mt-2 text-sm text-[#ddd]">No marketplace items match these filters.</p>
                    </div>
                ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                        {filteredItems.map((item) => (
                            <MarketplaceCard
                                key={itemKey(item)}
                                item={item}
                                scopes={marketplaceItemInstalledScopes(item, metadata)}
                                busy={busyItem === itemKey(item)}
                                onInspect={() => setInspectItem(item)}
                                onInstall={() => openInstall(item)}
                                onRemove={(scope) => removeInstalled(item, scope)}
                            />
                        ))}
                    </div>
                )}
            </section>

            <Dialog open={!!inspectItem} onOpenChange={() => setInspectItem(null)}>
                <DialogContent className="sm:max-w-[640px] max-h-[82vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            {inspectItem?.type === 'mcp' ? <Server className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                            {inspectItem?.name}
                        </DialogTitle>
                        <DialogDescription>{inspectItem?.description}</DialogDescription>
                    </DialogHeader>
                    {inspectItem && <InspectContent item={inspectItem} />}
                    <DialogFooter>
                        {inspectItem?.docs_url && (
                            <a href={inspectItem.docs_url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded border border-white/10 px-3 text-xs text-[#ddd] hover:bg-white/[0.06]">
                                <ExternalLink className="h-3.5 w-3.5" />
                                Docs
                            </a>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setInspectItem(null)}>Close</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!installItem} onOpenChange={() => setInstallItem(null)}>
                <DialogContent className="sm:max-w-[520px]">
                    <DialogHeader>
                        <DialogTitle>Install {installItem?.name}</DialogTitle>
                        <DialogDescription>
                            Project scope writes to this workspace. Global scope writes to your Ricochet home.
                        </DialogDescription>
                    </DialogHeader>
                    {installItem && (
                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-2">
                                {(['project', 'global'] as MarketplaceScope[]).map((scope) => (
                                    <button
                                        key={scope}
                                        type="button"
                                        onClick={() => setInstallScope(scope)}
                                        className={`rounded border px-3 py-2 text-left text-xs ${installScope === scope ? 'border-[#0e639c] bg-[#0e639c]/15 text-[#dcefff]' : 'border-white/10 bg-white/[0.03] text-[#aaa] hover:bg-white/[0.06]'}`}
                                    >
                                        <span className="block font-medium capitalize">{scope}</span>
                                        <span className="mt-0.5 block text-[10.5px] opacity-70">{scope === 'project' ? '.ricochet' : '~/.ricochet'}</span>
                                    </button>
                                ))}
                            </div>
                            {(installItem.mcp?.install_methods?.length || 0) > 1 && (
                                <div className="space-y-1.5">
                                    <label className="text-[11px] text-[#888]">Install method</label>
                                    <select value={installMethod} onChange={(event) => setInstallMethod(event.target.value)} className="h-8 w-full rounded border border-white/10 bg-white/[0.03] px-2 text-xs text-[#ddd] outline-none">
                                        {installItem.mcp?.install_methods?.map((method) => (
                                            <option key={method.name || 'default'} value={method.name || ''}>{method.name || 'default'}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            {requiredParameters.length > 0 && (
                                <div className="space-y-3">
                                    {requiredParameters.map((param) => {
                                        const key = parameterKey(param);
                                        return (
                                            <label key={key} className="block space-y-1.5">
                                                <span className="text-[11px] text-[#888]">{param.label || key}</span>
                                                <Input
                                                    type={param.secret ? 'password' : 'text'}
                                                    value={parameterValues[key] || ''}
                                                    onChange={(event) => setParameterValues((prev) => ({ ...prev, [key]: event.target.value }))}
                                                    placeholder={param.placeholder || key}
                                                    className="h-8 text-xs"
                                                />
                                                {param.description && <span className="block text-[10.5px] text-[#777]">{param.description}</span>}
                                            </label>
                                        );
                                    })}
                                </div>
                            )}
                            {installItem.type === 'mcp' && (
                                <div className="rounded border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-100">
                                    Marketplace install does not create Auto-Approve or Permissions rules.
                                </div>
                            )}
                            {validationErrors.length > 0 && (
                                <div className="text-[11px] text-amber-200">Missing required values: {validationErrors.join(', ')}</div>
                            )}
                        </div>
                    )}
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setInstallItem(null)}>Cancel</Button>
                        <Button size="sm" onClick={confirmInstall} disabled={validationErrors.length > 0 || !!busyItem} className="gap-1.5">
                            {busyItem ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
                            Install
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function MarketplaceCard({
    item,
    scopes,
    busy,
    onInspect,
    onInstall,
    onRemove,
}: {
    item: MarketplaceItem;
    scopes: MarketplaceScope[];
    busy: boolean;
    onInspect: () => void;
    onInstall: () => void;
    onRemove: (scope?: MarketplaceScope) => void;
}) {
    const installed = scopes.length > 0;
    return (
        <article className={`rounded border p-3 ${installed ? 'border-emerald-400/20 bg-emerald-400/[0.04]' : 'border-white/10 bg-white/[0.025] hover:bg-white/[0.04]'}`}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-start gap-2.5">
                    <div className="mt-0.5 rounded bg-white/[0.06] p-2">
                        {item.type === 'mcp' ? <Server className="h-4 w-4 text-[#8bd5ff]" /> : <FileText className="h-4 w-4 text-[#c6e48b]" />}
                    </div>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <h4 className="truncate text-sm font-medium text-[#eee]">{item.name}</h4>
                            <TrustPill trust={item.trust || 'community'} />
                            {scopes.map((scope) => <span key={scope} className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[9.5px] text-emerald-200">{scope}</span>)}
                        </div>
                        <p className="mt-1 line-clamp-2 min-h-[32px] text-[11px] leading-relaxed text-[#888]">{item.description}</p>
                    </div>
                </div>
                {busy && <Loader2 className="mt-1 h-4 w-4 animate-spin text-[#888]" />}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {item.category && <Token>{item.category}</Token>}
                {(item.tags || []).slice(0, 4).map((tag) => <Token key={tag}>{tag}</Token>)}
            </div>
            <div className="mt-3 grid gap-2 text-[10.5px] text-[#777] sm:grid-cols-2">
                <CapabilityLine icon={<Wrench className="h-3 w-3" />} label={item.type === 'mcp' ? 'Tools' : 'Allowed'} values={item.type === 'mcp' ? item.mcp?.tools : item.skill?.allowed_tools} />
                <CapabilityLine icon={<AlertTriangle className="h-3 w-3" />} label="Auth" values={[...(item.mcp?.env_vars || []), ...(item.mcp?.parameters || []).map(parameterKey)]} />
            </div>
            <div className="mt-4 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                    <button type="button" onClick={onInspect} className={iconButtonClass} title="Inspect">
                        <Info className="h-3.5 w-3.5" />
                    </button>
                    {item.docs_url && (
                        <a href={item.docs_url} target="_blank" rel="noreferrer" className={iconButtonClass} title="Docs">
                            <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                    )}
                </div>
                {installed ? (
                    <div className="flex items-center gap-1">
                        {scopes.map((scope) => (
                            <button key={scope} type="button" onClick={() => onRemove(scope)} className="inline-flex h-7 items-center gap-1 rounded border border-red-400/20 px-2 text-[11px] text-red-200 hover:bg-red-400/10">
                                <Trash2 className="h-3 w-3" />
                                {scope}
                            </button>
                        ))}
                    </div>
                ) : (
                    <Button size="sm" onClick={onInstall} disabled={busy} className="h-7 gap-1.5 px-2 text-[11px]">
                        <PackageCheck className="h-3.5 w-3.5" />
                        Install
                    </Button>
                )}
            </div>
        </article>
    );
}

function InspectContent({ item }: { item: MarketplaceItem }) {
    return (
        <div className="space-y-4 text-[11px] text-[#aaa]">
            <div className="grid gap-2 sm:grid-cols-3">
                <Metric label="type" value={item.type === 'mcp' ? 'MCP server' : 'Agent skill'} />
                <Metric label="trust" value={item.trust || 'community'} />
                <Metric label="version" value={item.version || '1.0.0'} />
            </div>
            {item.type === 'mcp' ? (
                <>
                    <InspectRow label="Transport" value={item.mcp?.transport || item.mcp?.install_methods?.[0]?.transport || 'stdio'} />
                    <InspectRow label="Command / URL" value={item.mcp?.command || item.mcp?.url || item.mcp?.install_methods?.[0]?.command || item.mcp?.install_methods?.[0]?.url || 'declared by method'} />
                    <TokenBlock title="Expected tools" values={item.mcp?.tools || []} />
                    <TokenBlock title="Resources" values={item.mcp?.resources || []} />
                    <TokenBlock title="Prompts" values={item.mcp?.prompts || []} />
                    <TokenBlock title="Required auth/env" values={[...(item.mcp?.env_vars || []), ...(item.mcp?.parameters || []).map(parameterKey)]} />
                </>
            ) : (
                <>
                    <InspectRow label="Skill name" value={item.skill?.skill_name || item.id} />
                    <InspectRow label="Invocation" value={`${item.skill?.implicit_invocation === false ? 'manual' : 'automatic + manual'}${item.skill?.user_invocable === false ? ', hidden from slash use' : ''}`} />
                    <TokenBlock title="Allowed tools" values={item.skill?.allowed_tools || []} />
                    <TokenBlock title="Files" values={(item.skill?.files || []).map((file) => file.path)} />
                    {(item.skill?.files || []).some((file) => file.path.startsWith('scripts/')) && (
                        <div className="rounded border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-amber-100">This skill bundles scripts. Review files before enabling broad tool access.</div>
                    )}
                </>
            )}
        </div>
    );
}

function selectedMcpMethod(item: MarketplaceItem, methodName?: string): MarketplaceMcpInstallMethod | undefined {
    const methods = item.mcp?.install_methods || [];
    if (methods.length === 0) return undefined;
    if (!methodName) return methods[0];
    return methods.find((method) => method.name === methodName) || methods[0];
}

function parameterKey(param: MarketplaceParameter): string {
    return param.key || param.name || param.env_var || '';
}

function itemKey(item: MarketplaceItem): string {
    return `${item.type}:${item.id}`;
}

function formatSync(value?: string, source?: string): string {
    if (!value) return source || 'bundled';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return source || value;
    return date.toLocaleDateString();
}

function SegmentButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs ${active ? 'bg-[#0e639c] text-white' : 'text-[#aaa] hover:bg-white/[0.06] hover:text-white'}`}
        >
            {icon}
            {label}
        </button>
    );
}

function Metric({ label, value }: { label: string; value: string | number }) {
    return (
        <div className="rounded bg-white/[0.03] px-2 py-1.5">
            <div className="text-[9.5px] uppercase tracking-wide text-[#666]">{label}</div>
            <div className="mt-0.5 truncate text-[11px] font-medium text-[#ddd]">{value}</div>
        </div>
    );
}

function TrustPill({ trust }: { trust: string }) {
    const cls = trust === 'verified'
        ? 'bg-emerald-400/10 text-emerald-200'
        : trust === 'experimental'
            ? 'bg-amber-400/10 text-amber-200'
            : 'bg-white/[0.06] text-[#aaa]';
    return <span className={`rounded px-1.5 py-0.5 text-[9.5px] ${cls}`}>{trust}</span>;
}

function Token({ children }: { children: ReactNode }) {
    return <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9.5px] text-[#888]">{children}</span>;
}

function CapabilityLine({ icon, label, values }: { icon: ReactNode; label: string; values?: string[] }) {
    const clean = (values || []).filter(Boolean);
    return (
        <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-[#666]">{icon}</span>
            <span className="text-[#777]">{label}:</span>
            <span className="truncate text-[#aaa]">{clean.length ? clean.slice(0, 3).join(', ') : 'none declared'}</span>
        </div>
    );
}

function InspectRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="grid gap-1 sm:grid-cols-[120px_1fr]">
            <span className="text-[#777]">{label}</span>
            <span className="break-all text-[#ddd]">{value}</span>
        </div>
    );
}

function TokenBlock({ title, values }: { title: string; values: string[] }) {
    return (
        <div>
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-[#777]">{title}</div>
            {values.length === 0 ? (
                <div className="text-[#777]">None declared</div>
            ) : (
                <div className="flex flex-wrap gap-1">
                    {values.map((value) => <Token key={value}>{value}</Token>)}
                </div>
            )}
        </div>
    );
}

const iconButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded text-[#888] hover:bg-white/[0.07] hover:text-white';
