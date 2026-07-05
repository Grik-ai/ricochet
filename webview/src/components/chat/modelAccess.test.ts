import { describe, expect, it } from 'vitest';
import {
    deriveModelAccess,
    providerCredentialLabel,
    selectBestModel,
    settingsTabForModelAccess,
    sortProvidersByDisplayOrder,
    type ModelAccessProvider,
} from './modelAccess';

const signedOutAccount = {
    summary: {
        authenticated: false,
        hostedAccess: false,
        accessState: 'signed_out',
        accessLabel: 'Sign in required',
        detail: 'Sign in to unlock hosted Ricochet models',
    },
} as any;

describe('model access helpers', () => {
    it('allows explicit anonymous Grik free models without credentials', () => {
        const provider: ModelAccessProvider = {
            id: 'grik',
            name: 'Grik',
            available: true,
            accessMode: 'subscription',
            keySource: 'none',
            models: [{ id: 'qwen/qwen3-coder:free', name: 'Qwen', isFree: true, accessMode: 'free', credentialMode: 'none' }],
        };
        const access = deriveModelAccess(provider, provider.models![0], signedOutAccount);
        expect(access.state).toBe('anonymous_free');
        expect(access.sendable).toBe(true);
        expect(access.label).toBe('Free, no sign-in');
    });

    it('keeps free-priced BYOK models key-required when credential mode is provider_key', () => {
        const provider: ModelAccessProvider = {
            id: 'openrouter',
            name: 'OpenRouter',
            available: false,
            hasKey: false,
            hasUserKey: false,
            keySource: 'none',
            models: [{ id: 'qwen/qwen3-coder:free', name: 'Qwen', isFree: true, accessMode: 'free', credentialMode: 'provider_key' }],
        };
        const access = deriveModelAccess(provider, provider.models![0], signedOutAccount);
        expect(access.state).toBe('byok_key_required');
        expect(access.sendable).toBe(false);
        expect(access.action).toBe('settings');
        expect(access.label).toBe('Free, requires key');
    });

    it('routes hosted Grik subscription models to account access', () => {
        const provider: ModelAccessProvider = {
            id: 'grik',
            name: 'Grik',
            available: true,
            accessMode: 'subscription',
            keySource: 'none',
            models: [{ id: 'openai/gpt-5.5', name: 'GPT', accessMode: 'subscription', credentialMode: 'grik_account', requiresSubscription: true }],
        };
        const access = deriveModelAccess(provider, provider.models![0], signedOutAccount);
        expect(access.state).toBe('grik_sign_in_required');
        expect(access.sendable).toBe(false);
        expect(access.action).toBe('account');
        expect(access.label).toBe('Sign in required');
    });

    it('labels hosted Grik account access when entitlement is available', () => {
        const provider: ModelAccessProvider = {
            id: 'grik',
            name: 'Grik',
            available: true,
            accessMode: 'subscription',
            keySource: 'hosted',
            models: [{ id: 'openai/gpt-5.5', name: 'GPT', accessMode: 'subscription', credentialMode: 'grik_account', requiresSubscription: true }],
        };
        const account = {
            summary: {
                authenticated: true,
                hostedAccess: true,
                accessState: 'available',
                detail: 'Subscription active',
            },
        } as any;
        const access = deriveModelAccess(provider, provider.models![0], account);
        expect(access.state).toBe('ready');
        expect(access.sendable).toBe(true);
        expect(access.label).toBe('Grik Account');
    });

    it('labels user and included provider keys distinctly', () => {
        const userProvider: ModelAccessProvider = {
            id: 'openrouter',
            name: 'OpenRouter',
            hasUserKey: true,
            keySource: 'user',
            models: [{ id: 'qwen/qwen3-coder:free', name: 'Qwen', accessMode: 'free', credentialMode: 'provider_key', isFree: true }],
        };
        const includedProvider: ModelAccessProvider = {
            id: 'mistral',
            name: 'Mistral',
            hasKey: true,
            keySource: 'server',
            models: [{ id: 'codestral-latest', name: 'Codestral', accessMode: 'free', credentialMode: 'provider_key', isFree: true }],
        };

        expect(providerCredentialLabel(userProvider)).toBe('Key connected');
        expect(providerCredentialLabel(includedProvider)).toBe('Included');
        expect(deriveModelAccess(userProvider, userProvider.models![0], signedOutAccount).label).toBe('Key connected');
        expect(deriveModelAccess(includedProvider, includedProvider.models![0], signedOutAccount).label).toBe('Included');
    });

    it('marks Grik Ricochet Code as coming soon and non-sendable', () => {
        const provider: ModelAccessProvider = {
            id: 'grik',
            name: 'Grik',
            accessMode: 'subscription',
            keySource: 'hosted',
            models: [{ id: 'ricochet-code', name: 'Ricochet Code', launchState: 'soon', ownedBy: 'grik', accessMode: 'subscription', credentialMode: 'grik_account' }],
        };
        const access = deriveModelAccess(provider, provider.models![0], signedOutAccount);

        expect(access.state).toBe('coming_soon');
        expect(access.sendable).toBe(false);
        expect(access.label).toBe('Soon');
        expect(access.action).toBeNull();
        expect(access.detail).toContain('Grik model');
    });

    it('keeps Grik first in deterministic provider ordering', () => {
        const ordered = sortProvidersByDisplayOrder([
            { id: 'zhipu', name: 'Zhipu' },
            { id: 'openrouter', name: 'OpenRouter' },
            { id: 'grik', name: 'Grik' },
            { id: 'anthropic', name: 'Anthropic' },
        ]);
        expect(ordered.map(provider => provider.id)).toEqual(['grik', 'openrouter', 'anthropic', 'zhipu']);
    });

    it('opens Providers for BYOK key-required access', () => {
        const provider: ModelAccessProvider = {
            id: 'openrouter',
            name: 'OpenRouter',
            keySource: 'none',
            models: [{ id: 'qwen/qwen3-coder:free', name: 'Qwen', isFree: true, accessMode: 'free', credentialMode: 'provider_key' }],
        };
        const access = deriveModelAccess(provider, provider.models![0], signedOutAccount);

        expect(settingsTabForModelAccess(access)).toBe('providers');
    });

    it('selects Grik anonymous free before inaccessible current models', () => {
        const providers: ModelAccessProvider[] = [
            {
                id: 'openrouter',
                name: 'OpenRouter',
                hasKey: false,
                hasUserKey: false,
                models: [{ id: 'qwen/qwen3-coder:free', name: 'OpenRouter Qwen', accessMode: 'free', credentialMode: 'provider_key' }],
            },
            {
                id: 'grik',
                name: 'Grik',
                available: true,
                models: [
                    { id: 'openai/gpt-5.5', name: 'GPT', accessMode: 'subscription', credentialMode: 'grik_account', requiresSubscription: true },
                    { id: 'qwen/qwen3-coder:free', name: 'Qwen Anonymous', isFree: true, accessMode: 'free', credentialMode: 'none' },
                ],
            },
        ];
        const selected = selectBestModel(providers, { provider: 'openrouter', id: 'qwen/qwen3-coder:free' }, signedOutAccount);
        expect(selected).toMatchObject({ provider: 'grik', id: 'qwen/qwen3-coder:free', name: 'Qwen Anonymous' });
    });
});
