import { isHostedSubscriptionAccess, type GrikAccountController } from '../../hooks/useGrikAccount';

export type ModelCredentialMode = 'none' | 'grik_account' | 'provider_key';

export type ModelAccessState =
    | 'coming_soon'
    | 'ready'
    | 'anonymous_free'
    | 'grik_sign_in_required'
    | 'grik_upgrade_required'
    | 'grik_limit_reached'
    | 'byok_key_required'
    | 'unavailable';

export interface ModelAccessProvider {
    id: string;
    name?: string;
    available?: boolean;
    hasKey?: boolean;
    hasUserKey?: boolean;
    keySource?: 'server' | 'user' | 'hosted' | 'none';
    accessMode?: 'free' | 'byok' | 'subscription';
    models?: ModelAccessModel[];
}

export interface ModelAccessModel {
    id: string;
    name: string;
    providerId?: string;
    provider?: string;
    isFree?: boolean;
    accessMode?: 'free' | 'byok' | 'subscription';
    keySource?: 'server' | 'user' | 'hosted' | 'none';
    credentialMode?: ModelCredentialMode;
    requiresSubscription?: boolean;
    mayTrainOnYourPrompts?: boolean;
    launchState?: 'live' | 'soon' | string;
    ownedBy?: string;
}

export interface SelectedModelAccess {
    state: ModelAccessState;
    sendable: boolean;
    label: string;
    detail: string;
    actionLabel?: string;
    action: 'account' | 'settings' | null;
}

export interface SelectedModelLike {
    id: string;
    name?: string;
    provider: string;
    mayTrainOnYourPrompts?: boolean;
    credentialMode?: ModelCredentialMode;
    launchState?: 'live' | 'soon' | string;
    ownedBy?: string;
}

export function modelCredentialMode(provider: ModelAccessProvider | undefined, model: ModelAccessModel | undefined): ModelCredentialMode {
    if (model?.credentialMode) return model.credentialMode;
    if (isHostedSubscriptionAccess(model?.accessMode, model?.keySource) || Boolean(model?.requiresSubscription)) {
        return 'grik_account';
    }
    if (isHostedSubscriptionAccess(provider?.accessMode, provider?.keySource) && model?.accessMode === 'subscription') {
        return 'grik_account';
    }
    return 'provider_key';
}

export function providerHasKey(provider: ModelAccessProvider | undefined): boolean {
    if (!provider) return false;
    return Boolean(provider.hasKey || provider.hasUserKey || provider.keySource === 'server' || provider.keySource === 'user');
}

export function providerCredentialLabel(provider: ModelAccessProvider | undefined): string {
    if (!provider) return 'No key';
    if (provider.keySource === 'hosted' || provider.accessMode === 'subscription') return 'Grik Account';
    if (provider.keySource === 'user' || provider.hasUserKey) return 'Key connected';
    if (provider.keySource === 'server' || provider.hasKey) return 'Included';
    return 'No key';
}

export function deriveModelAccess(
    provider: ModelAccessProvider | undefined,
    model: ModelAccessModel | undefined,
    grikAccount?: GrikAccountController,
): SelectedModelAccess {
    if (!provider || !model) {
        return {
            state: 'unavailable',
            sendable: false,
            label: 'Model unavailable',
            detail: 'Choose another model.',
            actionLabel: 'Models',
            action: 'settings',
        };
    }

    if (String(model.launchState || '').toLowerCase() === 'soon') {
        return {
            state: 'coming_soon',
            sendable: false,
            label: 'Soon',
            detail: model.ownedBy === 'grik' || provider.id === 'grik' ? 'Grik model coming soon.' : 'This model is coming soon.',
            action: null,
        };
    }

    const credentialMode = modelCredentialMode(provider, model);
    if (credentialMode === 'none') {
        return {
            state: 'anonymous_free',
            sendable: true,
            label: 'Free, no sign-in',
            detail: 'No Grik Account or provider key required.',
            action: null,
        };
    }

    if (credentialMode === 'grik_account') {
        const summary = grikAccount?.summary;
        if (summary?.hostedAccess) {
            return {
                state: 'ready',
                sendable: true,
                label: 'Grik Account',
                detail: summary.detail || 'Hosted Ricochet model available',
                action: null,
            };
        }
        if (!summary?.authenticated || summary?.accessState === 'signed_out') {
            return {
                state: 'grik_sign_in_required',
                sendable: false,
                label: 'Sign in required',
                detail: 'Sign in to Grik to use this hosted model.',
                actionLabel: 'Account',
                action: 'account',
            };
        }
        if (summary.accessState === 'limit_reached' || summary.accessState === 'approval_required') {
            return {
                state: 'grik_limit_reached',
                sendable: false,
                label: summary.accessLabel || 'Limit reached',
                detail: summary.detail || 'Manage your Grik account to continue.',
                actionLabel: 'Account',
                action: 'account',
            };
        }
        return {
            state: 'grik_upgrade_required',
            sendable: false,
            label: summary.accessLabel || 'Upgrade required',
            detail: summary.detail || 'Upgrade your Grik account to use this hosted model.',
            actionLabel: 'Account',
            action: 'account',
        };
    }

    if (providerHasKey(provider)) {
        const label = providerCredentialLabel(provider);
        return {
            state: 'ready',
            sendable: true,
            label,
            detail: label === 'Included' ? 'Included provider access is configured.' : 'Provider API key is connected.',
            action: null,
        };
    }

    return {
        state: 'byok_key_required',
        sendable: false,
        label: model.isFree || model.accessMode === 'free' ? 'Free, requires key' : 'No key',
        detail: `Add an API key for ${provider.name || provider.id}.`,
        actionLabel: 'Settings',
        action: 'settings',
    };
}

export function modelAccessBadgeLabel(access: SelectedModelAccess): string {
    return access.state === 'ready' ? access.label : access.label;
}

export function modelAccessBadgeClass(access: SelectedModelAccess): string {
    switch (access.state) {
        case 'coming_soon':
            return 'bg-zinc-400/10 text-zinc-300';
        case 'anonymous_free':
            return 'bg-green-400/10 text-green-400';
        case 'ready':
            return 'bg-vscode-button-bg/15 text-vscode-button-bg';
        case 'byok_key_required':
            return 'bg-sky-400/10 text-sky-300';
        case 'grik_sign_in_required':
        case 'grik_upgrade_required':
        case 'grik_limit_reached':
            return 'bg-amber-500/15 text-amber-300';
        default:
            return 'bg-red-500/15 text-red-300';
    }
}

export function findModelProvider(
    providers: ModelAccessProvider[],
    selected: Pick<SelectedModelLike, 'provider' | 'id'>,
): { provider?: ModelAccessProvider; model?: ModelAccessModel } {
    const provider = providers.find(item => item.id === selected.provider);
    const model = provider?.models?.find(item => item.id === selected.id);
    return { provider, model };
}

export function toSelectedModel(provider: ModelAccessProvider, model: ModelAccessModel): SelectedModelLike {
    return {
        id: model.id,
        name: model.name,
        provider: provider.id,
        mayTrainOnYourPrompts: model.mayTrainOnYourPrompts === true,
        credentialMode: model.credentialMode,
    };
}

export function selectBestModel(
    providers: ModelAccessProvider[],
    current: Pick<SelectedModelLike, 'provider' | 'id'> | null,
    grikAccount?: GrikAccountController,
): SelectedModelLike | null {
    if (current?.id && current.provider) {
        const { provider, model } = findModelProvider(providers, current);
        if (deriveModelAccess(provider, model, grikAccount).sendable && provider && model) {
            return toSelectedModel(provider, model);
        }
    }

    const defaultProvider = providers.find(provider => provider.id === 'grik');
    const defaultModel = defaultProvider?.models?.find(model => model.id === 'qwen/qwen3-coder:free' && model.credentialMode === 'none');
    if (defaultProvider && defaultModel) {
        return toSelectedModel(defaultProvider, defaultModel);
    }

    for (const provider of providers) {
        for (const model of provider.models || []) {
            if (deriveModelAccess(provider, model, grikAccount).sendable) {
                return toSelectedModel(provider, model);
            }
        }
    }

    return null;
}

export function providerDisplayRank(providerId?: string): number {
    switch (String(providerId || '').toLowerCase()) {
        case 'grik':
            return 0;
        case 'openrouter':
            return 10;
        case 'anthropic':
            return 20;
        case 'openai':
            return 30;
        case 'deepseek':
            return 40;
        case 'zhipu':
            return 50;
        case 'zhipu-coding':
            return 51;
        case 'gemini':
            return 60;
        case 'xai':
            return 70;
        case 'minimax':
            return 80;
        case 'mistral':
            return 90;
        default:
            return 1000;
    }
}

export function sortProvidersByDisplayOrder<T extends { id: string; name?: string }>(providers: T[]): T[] {
    return [...providers].sort((a, b) => {
        const rank = providerDisplayRank(a.id) - providerDisplayRank(b.id);
        if (rank !== 0) return rank;
        return (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id);
    });
}

export function settingsTabForModelAccess(access: SelectedModelAccess): 'models' | 'providers' {
    return access.state === 'byok_key_required' ? 'providers' : 'models';
}
