import { useState, useRef, useEffect, useMemo } from 'react';
import { Search, Check, Cpu, X, Loader2, Key } from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';

interface ModelInfo {
    id: string;
    name: string;
    contextWindow: number;
    inputPrice: number;
    outputPrice: number;
    isFree: boolean;
    supportsTools: boolean;
    description?: string;
}

interface ProviderInfo {
    id: string;
    name: string;
    hasKey: boolean;
    hasUserKey?: boolean;
    keySource?: 'server' | 'user' | 'none';
    available: boolean; // Changed from isAvailable to match Go backend
    models: ModelInfo[];
}

interface ModelPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    currentModel: { id: string; name: string; provider: string };
    onSelectModel: (model: { id: string; name: string; provider: string }) => void;
}

/**
 * ModelPickerModal — Dynamic model selection with provider filtering.
 */
export function ModelPickerModal({
    isOpen,
    onClose,
    currentModel,
    onSelectModel,
}: ModelPickerModalProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [selectedProvider, setSelectedProvider] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);

    const searchInputRef = useRef<HTMLInputElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const { postMessage, onMessage } = useVSCodeApi();

    // Fetch models on mount
    useEffect(() => {
        if (isOpen) {
            setIsLoading(true);
            postMessage({ type: 'get_models' });
        }
    }, [isOpen, postMessage]);

    // Listen for models response
    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            if (message.type === 'models') {
                const result = message.payload as { providers: ProviderInfo[] };
                if (!result || !result.providers) {
                    setIsLoading(false);
                    return;
                }

                // Rely on backend - no hardcoded filters
                setProviders(result.providers);
                setIsLoading(false);

                // If current model is selected, try to match provider
                if (result.providers.length > 0 && !selectedProvider) {
                    const match = result.providers.find(p => p.id === currentModel.provider);
                    if (match) {
                        setSelectedProvider(match.id);
                    } else {
                        setSelectedProvider(result.providers[0].id);
                    }
                }
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage, currentModel.provider, selectedProvider]);

    // Get all models flattened with provider info
    const allModels = useMemo(() => {
        return providers.flatMap(p =>
            p.models.map(m => ({
                id: m.id,
                name: m.name,
                provider: p.name,
                providerId: p.id,
                hasKey: p.hasKey,
                hasUserKey: p.hasUserKey,
                keySource: p.keySource,
                isFree: m.isFree,
                description: m.description,
                contextWindow: m.contextWindow,
                inputPrice: m.inputPrice,
                outputPrice: m.outputPrice
            }))
        );
    }, [providers]);

    // Filter models by search and provider
    const filteredModels = useMemo(() => {
        let models = allModels;

        // No hardcoded filters - strictly what backend provides
        if (selectedProvider) {
            models = models.filter(m => m.providerId === selectedProvider);
        }

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            models = models.filter(
                m => m.name.toLowerCase().includes(query) ||
                    m.provider.toLowerCase().includes(query)
            );
        }

        return models;
    }, [allModels, searchQuery, selectedProvider]);

    // Get current provider info
    const currentProviderInfo = providers.find(p => p.id === selectedProvider);

    // Focus search on open
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => searchInputRef.current?.focus(), 100);
            setSearchQuery('');
            setSelectedIndex(-1);
        }
    }, [isOpen]);

    // Click outside to close
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
                onClose();
            }
        };

        setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen, onClose]);

    // Keyboard navigation
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => Math.min(prev + 1, filteredModels.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            const model = filteredModels[selectedIndex];
            onSelectModel({ id: model.id, name: model.name, provider: model.providerId });
            onClose();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div
            ref={modalRef}
            className="absolute bottom-0 left-0 right-0 rounded-md border border-vscode-border bg-vscode-input-bg shadow-lg overflow-hidden z-[9999] w-full animate-in fade-in slide-in-from-bottom-5 duration-200"
            style={{
                maxHeight: 'calc(100vh - 150px)',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            <div className="flex items-center justify-between px-4 py-3 border-b border-vscode-border bg-vscode-editor-background">
                <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-vscode-fg/45" />
                    <span className="text-[11px] font-medium text-vscode-fg/65">Model</span>
                </div>
                <button onClick={onClose} className="p-1 hover:bg-vscode-list-hoverBackground rounded transition-colors">
                    <X className="w-4 h-4 text-vscode-fg/40" />
                </button>
            </div>

            {/* Search bar */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-vscode-border">
                <Search className="w-3.5 h-3.5 text-vscode-fg/45" />
                <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search models..."
                    className="flex-1 bg-transparent text-sm text-vscode-input-fg placeholder:text-vscode-fg/35 outline-none"
                />
            </div>

            {/* Provider selector */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-vscode-border">
                <div className="flex items-center gap-2">
                    <span className="text-[11px] text-vscode-fg/45">Provider:</span>
                    <select
                        value={selectedProvider}
                        onChange={(e) => setSelectedProvider(e.target.value)}
                        className="bg-transparent text-[11px] text-vscode-fg/75 outline-none cursor-pointer"
                    >
                        {providers.map(p => (
                            <option key={p.id} value={p.id} className="bg-vscode-input-bg">
                                {p.name} {p.available ? '✓' : ''}
                            </option>
                        ))}
                    </select>
                    {currentProviderInfo?.available && (
                        <span title={currentProviderInfo.keySource === 'user' ? 'User API key configured' : 'Server API key configured'}>
                            <Key className="w-3 h-3 text-green-400" />
                        </span>
                    )}
                </div>
            </div>

            {/* Model list */}
            <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
                {isLoading ? (
                    <div className="flex items-center justify-center py-8 text-vscode-fg/45">
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        <span className="text-xs">Loading models...</span>
                    </div>
                ) : filteredModels.length === 0 ? (
                    <div className="text-center py-8 text-xs text-vscode-fg/40">
                        No models found
                    </div>
                ) : (
                    filteredModels.map((model, index) => (
                        <button
                            key={`${model.providerId}-${model.id}`}
                            onClick={() => {
                                onSelectModel({ id: model.id, name: model.name, provider: model.providerId });
                                onClose();
                            }}
                            className={`w-full flex items-center justify-between px-3 py-2.5 transition-colors ${index === selectedIndex ? 'bg-vscode-list-hoverBackground' :
                                model.id === currentModel.id ? 'bg-vscode-list-hoverBackground' : 'hover:bg-vscode-list-hoverBackground'
                                }`}
                        >
                            <div className="flex-1 text-left">
                                <div className="flex items-center gap-2">
                                    <span className="text-[11px] text-vscode-fg/85">{model.name}</span>
                                    {model.isFree && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">FREE</span>
                                    )}
                                    {(model.hasUserKey || model.hasKey) && (
                                        <span className="text-[9px] text-blue-400">✓</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 text-[10px] text-vscode-fg/45">
                                    <span>{model.provider}</span>
                                    {model.contextWindow && (
                                        <span>• {(model.contextWindow / 1000).toFixed(0)}k ctx</span>
                                    )}
                                    {model.inputPrice > 0 && (
                                        <span>• ${model.inputPrice.toFixed(2)}/M in</span>
                                    )}
                                </div>
                            </div>
                            {model.id === currentModel.id && (
                                <Check className="w-3.5 h-3.5 text-green-400" />
                            )}
                        </button>
                    ))
                )}
            </div>
        </div>
    );
}
