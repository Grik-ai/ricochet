import { useState, useRef, useEffect, useMemo, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Search, Check, Cpu, X, Loader2, Key, UserCircle, ShieldAlert } from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { isHostedSubscriptionAccess, type GrikAccountController } from '../../hooks/useGrikAccount';
import { deriveModelAccess, modelAccessBadgeClass, type ModelCredentialMode } from './modelAccess';

interface ModelInfo {
    id: string;
    name: string;
    contextWindow: number;
    inputPrice: number;
    outputPrice: number;
    isFree: boolean;
    supportsTools: boolean;
    description?: string;
    recommended?: boolean;
    accessMode?: 'free' | 'byok' | 'subscription';
    keySource?: 'server' | 'user' | 'hosted' | 'none';
    credentialMode?: ModelCredentialMode;
    requiresSubscription?: boolean;
    limited?: boolean;
    deprecated?: boolean;
    apiType?: string;
    mayTrainOnYourPrompts?: boolean;
}

interface ProviderInfo {
    id: string;
    name: string;
    hasKey: boolean;
    hasUserKey?: boolean;
    keySource?: 'server' | 'user' | 'hosted' | 'none';
    accessMode?: 'free' | 'byok' | 'subscription';
    available: boolean; // Changed from isAvailable to match Go backend
    models: ModelInfo[];
    hiddenPromptTrainingModelCount?: number;
}

interface ModelPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    currentModel: { id: string; name: string; provider: string; mayTrainOnYourPrompts?: boolean };
    onSelectModel: (model: { id: string; name: string; provider: string; mayTrainOnYourPrompts?: boolean; credentialMode?: ModelCredentialMode }) => void;
    anchorRef?: RefObject<HTMLElement>;
    containerRef?: RefObject<HTMLElement>;
    grikAccount?: GrikAccountController;
    onOpenAccount?: () => void;
    onOpenSettings?: (tab?: string) => void;
}

export interface PickerViewport {
    width: number;
    height: number;
}

export function modelMayTrainOnPrompts(model: Pick<ModelInfo, 'mayTrainOnYourPrompts'>): boolean {
    return model.mayTrainOnYourPrompts === true;
}

export function modelPrivacyBadgeLabel(model: Pick<ModelInfo, 'mayTrainOnYourPrompts'>): string | null {
    return modelMayTrainOnPrompts(model) ? 'May train' : null;
}

export function computeModelPickerPosition(
    anchorRect: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'>,
    containerRect: Pick<DOMRect, 'left' | 'right' | 'width'> | null,
    viewport: PickerViewport,
): CSSProperties {
    const margin = 12;
    const gap = 8;
    const safeTop = 12;
    const preferredHeight = 460;
    const minUsefulHeight = 260;
    const availableWidth = Math.max(240, viewport.width - margin * 2);
    const rawWidth = containerRect?.width || Math.max(320, anchorRect.width);
    const width = Math.min(Math.max(320, rawWidth), availableWidth);
    const anchorCenter = (containerRect ? containerRect.left + containerRect.width / 2 : anchorRect.left + anchorRect.width / 2);
    const left = Math.max(margin, Math.min(anchorCenter - width / 2, viewport.width - width - margin));
    const spaceAbove = Math.max(0, anchorRect.top - safeTop - gap);
    const spaceBelow = Math.max(0, viewport.height - anchorRect.bottom - margin - gap);
    const placeBelow = spaceAbove < preferredHeight && spaceBelow >= Math.min(minUsefulHeight, spaceAbove);
    const maxHeight = Math.max(180, Math.min(preferredHeight, placeBelow ? spaceBelow : spaceAbove));
    const top = placeBelow
        ? Math.min(anchorRect.bottom + gap, viewport.height - maxHeight - margin)
        : Math.max(safeTop, anchorRect.top - gap - maxHeight);

    return {
        position: 'fixed',
        left,
        top,
        width,
        maxHeight,
    };
}

/**
 * ModelPickerModal — Dynamic model selection with provider filtering.
 */
export function ModelPickerModal({
    isOpen,
    onClose,
    currentModel,
    onSelectModel,
    anchorRef,
    containerRef,
    grikAccount,
    onOpenAccount,
    onOpenSettings,
}: ModelPickerModalProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [selectedProvider, setSelectedProvider] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const [hidePromptTrainingModels, setHidePromptTrainingModels] = useState(false);
    const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});

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
                const result = message.payload as { providers: ProviderInfo[]; hide_prompt_training_models?: boolean; hidePromptTrainingModels?: boolean };
                if (!result || !result.providers) {
                    setIsLoading(false);
                    return;
                }

                // Rely on backend - no hardcoded filters
                setProviders(result.providers);
                setHidePromptTrainingModels(Boolean(result.hide_prompt_training_models ?? result.hidePromptTrainingModels ?? false));
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
                providerAvailable: p.available,
                isFree: m.isFree,
                description: m.description,
                contextWindow: m.contextWindow,
                inputPrice: m.inputPrice,
                outputPrice: m.outputPrice,
                providerKeySource: p.keySource,
                accessMode: m.accessMode,
                keySource: m.keySource || p.keySource,
                credentialMode: m.credentialMode,
                requiresSubscription: m.requiresSubscription,
                limited: m.limited,
                deprecated: m.deprecated,
                apiType: m.apiType,
                mayTrainOnYourPrompts: m.mayTrainOnYourPrompts
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
    const selectedProviderUsesGrikAccount = isHostedSubscriptionAccess(currentProviderInfo?.accessMode, currentProviderInfo?.keySource);
    const selectedProviderAccountLabel = grikAccount?.summary.label || (currentProviderInfo?.available ? 'Subscription' : 'Sign in required');
    const selectedProviderAccessLabel = grikAccount?.summary.accessLabel || (currentProviderInfo?.available ? 'Available' : 'Sign in required');

    const accessForModel = (model: typeof allModels[number]) => {
        const provider = providers.find(p => p.id === model.providerId);
        return deriveModelAccess(provider, model, grikAccount);
    };

    const openAccessAction = (access: ReturnType<typeof accessForModel>) => {
        if (access.action === 'account') {
            onOpenAccount?.();
        } else if (access.action === 'settings') {
            onOpenSettings?.('models');
        }
    };

    // Focus search on open
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => searchInputRef.current?.focus(), 100);
            setSearchQuery('');
            setSelectedIndex(-1);
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || typeof window === 'undefined') return;

        const updatePosition = () => {
            const anchorRect = anchorRef?.current?.getBoundingClientRect();
            if (!anchorRect) return;
            const containerRect = containerRef?.current?.getBoundingClientRect() || null;
            setPopoverStyle(computeModelPickerPosition(anchorRect, containerRect, {
                width: window.innerWidth || 0,
                height: window.innerHeight || 0,
            }));
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [anchorRef, containerRef, isOpen]);

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
            const access = accessForModel(model);
            if (!access.sendable) {
                openAccessAction(access);
                onClose();
                return;
            }
            onSelectModel({ id: model.id, name: model.name, provider: model.providerId, mayTrainOnYourPrompts: model.mayTrainOnYourPrompts, credentialMode: model.credentialMode });
            onClose();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    };

    if (!isOpen) return null;

    const modal = (
        <div
            ref={modalRef}
            className="fixed rounded-md border border-vscode-border bg-vscode-input-bg shadow-lg overflow-hidden z-[9999] animate-in fade-in slide-in-from-bottom-5 duration-200"
            style={{
                display: 'flex',
                flexDirection: 'column',
                visibility: popoverStyle.left === undefined ? 'hidden' : undefined,
                ...popoverStyle,
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
                    {currentProviderInfo?.available && !selectedProviderUsesGrikAccount && (
                        <span title={currentProviderInfo.keySource === 'user' ? 'User API key configured' : 'Server API key configured'}>
                            <Key className="w-3 h-3 text-green-400" />
                        </span>
                    )}
                    {selectedProviderUsesGrikAccount && (
                        <span className="inline-flex items-center gap-1 rounded bg-white/[0.04] px-1.5 py-0.5 text-[9px] text-vscode-fg/62" title={grikAccount?.summary.detail || 'Hosted models use your Grik account'}>
                            <UserCircle className="h-3 w-3" />
                            {selectedProviderAccountLabel}
                        </span>
                    )}
                </div>
            </div>

            {selectedProviderUsesGrikAccount && (
                <div className="flex items-center justify-between gap-3 border-b border-vscode-border px-3 py-2 text-[11px]">
                    <div className="min-w-0">
                        <div className="font-medium text-vscode-fg/78">Grik account</div>
                        <div className="truncate text-vscode-fg/45">{grikAccount?.summary.detail || 'Sign in to use Ricochet hosted subscription models.'}</div>
                        {grikAccount?.summary.quotaWarning && (
                            <div className={`mt-0.5 truncate ${grikAccount.summary.quotaWarning.tone === 'danger' ? 'text-rose-200/80' : 'text-amber-200/80'}`}>
                                {grikAccount.summary.quotaWarning.label}
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            if (grikAccount?.summary.hostedAccess) {
                                grikAccount.openBilling({ target: 'dashboard' });
                            } else if (onOpenAccount) {
                                onOpenAccount();
                            } else {
                                grikAccount?.signIn();
                            }
                            onClose();
                        }}
                        className="h-7 shrink-0 rounded-md border border-vscode-border px-2 text-[10px] text-vscode-fg/72 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg transition-colors"
                    >
                        {modelPickerAccountActionLabel(grikAccount)}
                    </button>
                </div>
            )}

            {/* Model list */}
            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                {isLoading ? (
                    <div className="flex items-center justify-center py-8 text-vscode-fg/45">
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        <span className="text-xs">Loading models...</span>
                    </div>
                ) : filteredModels.length === 0 ? (
                    <div className="text-center py-8 text-xs text-vscode-fg/40">
                        {hidePromptTrainingModels && currentProviderInfo?.hiddenPromptTrainingModelCount
                            ? `Stealth Mode is hiding ${currentProviderInfo.hiddenPromptTrainingModelCount} prompt-training ${currentProviderInfo.hiddenPromptTrainingModelCount === 1 ? 'model' : 'models'} from this provider.`
                            : 'No models found'}
                    </div>
                ) : (
                    filteredModels.map((model, index) => {
                        const usesGrikAccount = isHostedSubscriptionAccess(model.accessMode, model.keySource) || model.requiresSubscription;
                        const access = accessForModel(model);
                        const locked = !access.sendable;
                        return (
                        <button
                            key={`${model.providerId}-${model.id}`}
                            onClick={() => {
                                if (locked) {
                                    openAccessAction(access);
                                    onClose();
                                    return;
                                }
                                onSelectModel({ id: model.id, name: model.name, provider: model.providerId, mayTrainOnYourPrompts: model.mayTrainOnYourPrompts, credentialMode: model.credentialMode });
                                onClose();
                            }}
                            aria-disabled={locked}
                            className={`w-full flex items-center justify-between px-3 py-2.5 transition-colors ${locked ? 'opacity-70' : ''} ${index === selectedIndex ? 'bg-vscode-list-hoverBackground' :
                                model.id === currentModel.id ? 'bg-vscode-list-hoverBackground' : 'hover:bg-vscode-list-hoverBackground'
                                }`}
                        >
                            <div className="flex-1 text-left">
                                <div className="flex items-center gap-2">
                                    <span className="text-[11px] text-vscode-fg/85">{model.name}</span>
                                    {model.isFree && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">FREE</span>
                                    )}
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${modelAccessBadgeClass(access)}`} title={access.detail}>
                                        {access.label}
                                    </span>
                                    {(model.requiresSubscription || model.accessMode === 'subscription') && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300">SUB</span>
                                    )}
                                    {model.limited && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">LIMITED</span>
                                    )}
                                    {model.deprecated && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">OLD</span>
                                    )}
                                    {modelMayTrainOnPrompts(model) && (
                                        <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300" title="This model may use prompts for training">
                                            <ShieldAlert className="w-3 h-3" />
                                            {modelPrivacyBadgeLabel(model)}
                                        </span>
                                    )}
                                    {locked && usesGrikAccount && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200">{selectedProviderAccessLabel.toUpperCase()}</span>
                                    )}
                                    {!usesGrikAccount && (model.hasUserKey || model.hasKey) && (
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
                    );
                    })
                )}
            </div>
        </div>
    );

    return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}

function modelPickerAccountActionLabel(account?: GrikAccountController): string {
    if (!account) return 'Sign in';
    if (account.summary.hostedAccess) return 'Manage';
    if (account.summary.accessState === 'upgrade_required') return 'Upgrade';
    if (account.summary.accessState === 'signed_out') return 'Sign in';
    if (account.summary.accessState === 'sync_issue') return 'Retry';
    return 'Manage';
}
