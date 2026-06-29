import { describe, expect, it } from 'vitest';
import { deriveModelAccess, selectBestModel, type ModelAccessProvider } from './modelAccess';

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
