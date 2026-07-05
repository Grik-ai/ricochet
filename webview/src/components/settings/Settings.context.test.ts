import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    buildDiscordInstallUrl,
    buildDiscordSetupSteps,
    buildContextHealth,
    buildContextReportText,
    catalogStatusText,
    contextThresholdPreset,
    contextThresholdPresetValue,
    filterPromptTrainingModelsForStealth,
    isAccessProviderOpen,
    isCatalogProviderOpen,
    isPromptTrainingModel,
    keyStatusLabel,
    settingsModelAccessLabel,
    type ProviderInfo,
} from './Settings';
import type { ContextStatus } from '../../types/protocol';

describe('Settings context helpers', () => {
    it('builds Discord install helper links and setup copy', () => {
        expect(buildDiscordInstallUrl('')).toBe('');
        expect(buildDiscordInstallUrl(' 1456955772943466542 ')).toBe('https://discord.com/oauth2/authorize?client_id=1456955772943466542&permissions=311385246720&scope=bot%20applications.commands');

        const setup = buildDiscordSetupSteps('1456955772943466542');
        expect(setup).toContain('/ricochet new');
        expect(setup).toContain('write directly there');
        expect(setup).toContain('scope=bot%20applications.commands');
    });

    it('maps threshold presets to compact values', () => {
        expect(contextThresholdPreset(60)).toBe('early');
        expect(contextThresholdPreset(70)).toBe('balanced');
        expect(contextThresholdPreset(85)).toBe('late');
        expect(contextThresholdPreset(75)).toBe('custom');
        expect(contextThresholdPresetValue('balanced', 75)).toBe(70);
        expect(contextThresholdPresetValue('custom', 75)).toBe(75);
    });

    it('summarizes context health states', () => {
        expect(buildContextHealth(null).label).toBe('No snapshot');
        expect(buildContextHealth({ percentage: 35 } as ContextStatus).label).toBe('Good');
        expect(buildContextHealth({ percentage: 64 } as ContextStatus).label).toBe('Watch');
        expect(buildContextHealth({ percentage: 74 } as ContextStatus, 70).label).toBe('Compact soon');
        expect(buildContextHealth({ percentage: 45, was_condensed: true } as ContextStatus).label).toBe('Compacted');
        expect(buildContextHealth({ percentage: 91, was_truncated: true } as ContextStatus).label).toBe('Emergency trimmed');
    });

    it('builds a copyable report with policy, compression, checkpoints, and diagnostics', () => {
        const report = buildContextReportText({
            tokens_used: 70000,
            tokens_max: 100000,
            percentage: 70,
            condense_threshold: 70,
            fallback_window: 20,
            compression_saved_tokens: 4500,
            checkpoint_status: {
                enabled: true,
                checkpoint_on_writes: true,
                initialized: true,
                checkpoint_count: 2,
            },
            warnings: ['Context is 70% full'],
            suggestions: ['Narrow broad file reads'],
        } as ContextStatus);

        expect(report).toContain('Context: 70000/100000 tokens (70%)');
        expect(report).toContain('Compression saved: 4500 tokens');
        expect(report).toContain('Restore points: on, 2 saved');
        expect(report).toContain('Warning: Context is 70% full');
        expect(report).toContain('Suggestion: Narrow broad file reads');
    });

    it('filters only models explicitly marked as prompt-training risks', () => {
        const models = [
            { id: 'training', mayTrainOnYourPrompts: true },
            { id: 'private', mayTrainOnYourPrompts: false },
            { id: 'unknown' },
        ];

        expect(isPromptTrainingModel(models[0])).toBe(true);
        expect(isPromptTrainingModel(models[1])).toBe(false);
        expect(isPromptTrainingModel(models[2])).toBe(false);
        expect(filterPromptTrainingModelsForStealth(models, false).map(model => model.id)).toEqual(['training', 'private', 'unknown']);
        expect(filterPromptTrainingModelsForStealth(models, true).map(model => model.id)).toEqual(['private', 'unknown']);
    });

    it('uses model access labels that distinguish free key-required models from anonymous free models', () => {
        const openRouter: ProviderInfo = {
            id: 'openrouter',
            name: 'OpenRouter',
            hasKey: false,
            hasUserKey: false,
            keySource: 'none',
            accessMode: 'free',
            available: false,
            models: [{ id: 'qwen/qwen3-coder:free', name: 'Qwen', contextWindow: 262000, inputPrice: 0, outputPrice: 0, isFree: true, supportsTools: true, accessMode: 'free', credentialMode: 'provider_key' }],
        };
        const grik: ProviderInfo = {
            id: 'grik',
            name: 'Grik',
            hasKey: false,
            hasUserKey: false,
            keySource: 'hosted',
            accessMode: 'subscription',
            available: true,
            models: [{ id: 'qwen/qwen3-coder:free', name: 'Qwen', contextWindow: 262000, inputPrice: 0, outputPrice: 0, isFree: true, supportsTools: true, accessMode: 'free', credentialMode: 'none' }],
        };

        expect(settingsModelAccessLabel(openRouter, openRouter.models[0])).toBe('Free, requires key');
        expect(settingsModelAccessLabel(grik, grik.models[0])).toBe('Free, no sign-in');
    });

    it('uses user-facing provider access labels without server-key wording', () => {
        expect(keyStatusLabel({ id: 'grik', name: 'Grik', hasKey: false, keySource: 'hosted', accessMode: 'subscription', available: true, models: [] })).toBe('Grik Account');
        expect(keyStatusLabel({ id: 'openrouter', name: 'OpenRouter', hasKey: false, hasUserKey: true, keySource: 'user', available: true, models: [] })).toBe('Key connected');
        expect(keyStatusLabel({ id: 'mistral', name: 'Mistral', hasKey: true, keySource: 'server', available: true, models: [] })).toBe('Included');
        expect(keyStatusLabel({ id: 'openai', name: 'OpenAI', hasKey: false, keySource: 'none', available: false, models: [] })).toBe('No key');
    });

    it('keeps provider key check UI and removes legacy donation buttons from About', () => {
        const source = readFileSync(new URL('./Settings.tsx', import.meta.url), 'utf8');

        expect(source).toContain('Check key');
        expect(source).toContain('validate_provider_key');
        expect(source).toContain('Voice input');
        expect(source).toContain('whisperBinary');
        expect(source).toContain('whisperModel');
        for (const legacy of ['ko' + '-fi.com', 'pay' + 'pal.com', 'Cof' + 'fee']) {
            expect(source).not.toContain(legacy);
        }
    });

    it('lets active catalog and provider access accordions collapse', () => {
        expect(isCatalogProviderOpen('openrouter', new Set(), false)).toBe(false);
        expect(isCatalogProviderOpen('openrouter', new Set(['openrouter']), false)).toBe(true);
        expect(isCatalogProviderOpen('openrouter', new Set(), true)).toBe(true);
        expect(isAccessProviderOpen('grik', new Set())).toBe(false);
        expect(isAccessProviderOpen('grik', new Set(['grik']))).toBe(true);
    });

    it('summarizes OpenRouter catalog source and fallback state', () => {
        const base: ProviderInfo = { id: 'openrouter', name: 'OpenRouter', hasKey: false, keySource: 'none', available: false, models: [] };

        expect(catalogStatusText({ ...base, catalogStatus: { source: 'mixed', refreshedAt: '2026-07-02T00:00:00Z' } })).toBe('Free models synced from OpenRouter.');
        expect(catalogStatusText({ ...base, catalogStatus: { source: 'curated', error: 'Live sync disabled' } })).toBe('Using bundled catalog; live sync disabled.');
        expect(catalogStatusText({ ...base, catalogStatus: { source: 'curated', error: 'openrouter models returned HTTP 500' } })).toBe('Using bundled catalog; refresh failed.');
    });
});
