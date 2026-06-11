import { useState, useMemo, useEffect } from 'react';
import { Search, Plus, Trash2, ExternalLink, Settings2, ShieldCheck, Globe, Info, Loader2, Server, Check, RefreshCw } from 'lucide-react';
import { McpRegistryItem } from '../../data/mcpRegistry';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../ui/dialog";

interface McpMarketplaceProps {
    installedServers: any[];
}

interface ProbeResult {
    name: string;
    tools: { name: string; description: string }[];
    resources: any[];
    prompts: any[];
    error?: string;
}

export function McpMarketplace({ installedServers }: McpMarketplaceProps) {
    const { postMessage, onMessage } = useVSCodeApi();
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedMcp, setSelectedMcp] = useState<McpRegistryItem | null>(null);
    const [configValues, setConfigValues] = useState<Record<string, string>>({});

    // Registry state
    const [registryServers, setRegistryServers] = useState<McpRegistryItem[]>([]);
    const [lastSynced, setLastSynced] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);

    // Probing state
    const [probingMcp, setProbingMcp] = useState<McpRegistryItem | null>(null);
    const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
    const [isProbing, setIsProbing] = useState(false);

    useEffect(() => {
        postMessage({ type: 'get_mcp_registry' });

        const unsubscribe = onMessage((message) => {
            if (message.type === 'mcp_probe_result') {
                setProbeResult(message.payload as ProbeResult);
                setIsProbing(false);
            }
            if (message.type === 'mcp_registry') {
                const payload = message.payload as { servers: McpRegistryItem[], lastSynced: string };
                setRegistryServers(payload.servers || []);
                if (payload.lastSynced && payload.lastSynced !== '0001-01-01T00:00:00Z') {
                    setLastSynced(new Date(payload.lastSynced).toLocaleString());
                }
                setIsSyncing(false);
            }
        });
        return () => unsubscribe();
    }, [onMessage, postMessage]);

    const handleRefreshRegistry = () => {
        setIsSyncing(true);
        postMessage({ type: 'refresh_mcp_registry' });
    };

    const filteredRegistry = useMemo(() => {
        return registryServers.filter((item: McpRegistryItem) =>
            item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            item.description.toLowerCase().includes(searchQuery.toLowerCase())
        );
    }, [searchQuery, registryServers]);

    const handleProbe = (mcp: McpRegistryItem) => {
        setProbingMcp(mcp);
        setProbeResult(null);
        setIsProbing(true);
        postMessage({
            type: 'probe_mcp_server',
            payload: {
                command: mcp.command,
                args: mcp.args
            }
        });
    };

    const isInstalled = (id: string) => {
        return installedServers.some(s => s.name === id);
    };

    const handleInstall = (mcp: McpRegistryItem) => {
        if (mcp.envVars && mcp.envVars.length > 0) {
            setSelectedMcp(mcp);
            setConfigValues({});
        } else {
            postMessage({
                type: 'install_mcp',
                payload: {
                    id: mcp.id,
                    name: mcp.name,
                    command: mcp.command,
                    args: mcp.args
                }
            });
        }
    };

    const confirmInstall = () => {
        if (!selectedMcp) return;
        postMessage({
            type: 'install_mcp',
            payload: {
                id: selectedMcp.id,
                name: selectedMcp.name,
                command: selectedMcp.command,
                args: selectedMcp.args,
                env: configValues
            }
        });
        setSelectedMcp(null);
    };

    const handleUninstall = (mcp: McpRegistryItem) => {
        postMessage({
            type: 'uninstall_mcp',
            payload: {
                id: mcp.id,
                name: mcp.name
            }
        });
    };

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Search Header */}
            <div className="flex items-center justify-between gap-4">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
                    <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search MCP Marketplace..."
                        className="pl-10 h-10 border-white/5 bg-white/[0.02] focus:bg-white/[0.05] transition-all"
                    />
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5">
                    <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" />
                    <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest whitespace-nowrap">Verified Protocol</span>
                </div>

                <div className="flex items-center gap-2">
                    {lastSynced && (
                        <span className="text-[10px] text-white/20 whitespace-nowrap hidden sm:inline">
                            Synced: {lastSynced}
                        </span>
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRefreshRegistry}
                        disabled={isSyncing}
                        className="h-9 w-9 p-0 text-white/40 hover:text-white"
                        title="Refresh Registry"
                    >
                        <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    </Button>
                    <span className="hidden rounded border border-white/10 px-2 py-1 text-[10px] text-white/35 sm:inline">
                        Remote SSE unavailable
                    </span>
                </div>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredRegistry.map((item) => {
                    const installed = isInstalled(item.id);
                    return (
                        <div
                            key={item.id}
                            className={`group relative p-4 rounded-xl border transition-all duration-300 ${
                                installed
                                ? 'bg-cyan-500/5 border-cyan-500/20'
                                : 'bg-white/[0.02] border-white/5 hover:border-white/10 hover:bg-white/[0.04]'
                            }`}
                        >
                            <div className="flex justify-between items-start mb-3">
                                <div className="p-2 rounded-lg bg-white/5 group-hover:bg-white/10 transition-colors">
                                    {item.category === 'search' ? <Globe className="w-5 h-5 text-cyan-400" /> : <Settings2 className="w-5 h-5 text-purple-400" />}
                                </div>
                                <div className="flex items-center gap-2">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-8 w-8 p-0 text-white/40 hover:text-white"
                                        onClick={() => handleProbe(item)}
                                        title="Inspect Tools"
                                    >
                                        <Info className="w-4 h-4" />
                                    </Button>
                                    {installed ? (
                                        <button
                                            onClick={() => handleUninstall(item)}
                                            className="p-1.5 text-red-400/50 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                                            title="Uninstall"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    ) : (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => handleInstall(item)}
                                            className="h-8 px-3 text-xs bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500 hover:text-white transition-all rounded-lg"
                                        >
                                            <Plus className="w-3.5 h-3.5 mr-1" />
                                            Connect
                                        </Button>
                                    )}
                                </div>
                            </div>

                            <h4 className="text-sm font-bold text-white mb-1">{item.name}</h4>
                            <p className="text-xs text-white/40 leading-relaxed line-clamp-2 h-8">
                                {item.description}
                            </p>

                            <div className="mt-4 flex items-center justify-between">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-white/20">
                                    {item.category}
                                </span>
                                {item.githubUrl && (
                                    <a
                                        href={item.githubUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-[9px] text-cyan-400/50 hover:text-cyan-400 flex items-center gap-1"
                                    >
                                        DOCS <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Config Modal */}
            <Dialog open={!!selectedMcp} onOpenChange={() => setSelectedMcp(null)}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>Configure {selectedMcp?.name}</DialogTitle>
                        <DialogDescription>
                            This MCP server requires configuration parameters to connect.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-wrap gap-2">
                        {selectedMcp?.envVars?.map((env: string) => (
                            <div key={env} className="w-full space-y-2">
                                <label className="text-xs text-white/40">{env}</label>
                                <Input
                                    type="password"
                                    placeholder={`Enter ${env}...`}
                                    className="bg-black/20 border-white/5 h-9"
                                    value={configValues[env] || ''}
                                    onChange={(e) => setConfigValues(v => ({ ...v, [env]: e.target.value }))}
                                />
                            </div>
                        ))}
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setSelectedMcp(null)}>Cancel</Button>
                        <Button
                            onClick={confirmInstall}
                            className="bg-cyan-500 hover:bg-cyan-600 text-white"
                        >
                            Complete Connection
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {/* Tool Inspector Modal */}
            <Dialog open={!!probingMcp} onOpenChange={() => { setProbingMcp(null); setProbeResult(null); }}>
                <DialogContent className="sm:max-w-[500px] max-h-[80vh] flex flex-col">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Info className="w-5 h-5 text-cyan-400" />
                            {probingMcp?.name} Inspector
                        </DialogTitle>
                        <DialogDescription>
                            Probing server capabilities and tool definitions...
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex-1 overflow-y-auto py-4 space-y-4">
                        {isProbing ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-3">
                                <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
                                <span className="text-sm text-white/40 tracking-widest uppercase font-bold">Connecting...</span>
                            </div>
                        ) : probeResult ? (
                            <>
                                {probeResult.error ? (
                                    <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
                                        Error: {probeResult.error}
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        <div className="space-y-2">
                                            <h5 className="text-[10px] font-bold text-white/40 uppercase tracking-widest flex items-center gap-2">
                                                <Server className="w-3 h-3" />
                                                Available Tools ({probeResult.tools?.length || 0})
                                            </h5>
                                            <div className="space-y-3">
                                                {probeResult.tools?.map((tool: { name: string; description: string }) => (
                                                    <div key={tool.name} className="p-3 rounded-lg bg-white/[0.02] border border-white/5">
                                                        <div className="font-medium text-sm text-white/80 mb-1">{tool.name}</div>
                                                        <div className="text-xs text-white/40 leading-relaxed">{tool.description}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : null}
                    </div>

                    <DialogFooter className="pt-4 border-t border-white/5">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setProbingMcp(null)}
                            className="text-white/40 hover:text-white"
                        >
                            Close
                        </Button>
                        {probingMcp && !isInstalled(probingMcp.id) && !probeResult?.error && (
                            <Button
                                size="sm"
                                onClick={() => {
                                    handleInstall(probingMcp);
                                    setProbingMcp(null);
                                }}
                                className="bg-cyan-500 hover:bg-cyan-600 text-white gap-2"
                            >
                                <Check className="w-4 h-4" />
                                Install Now
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

        </div>
    );
}
