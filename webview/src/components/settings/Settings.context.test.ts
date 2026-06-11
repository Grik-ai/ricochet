import { describe, expect, it } from 'vitest';
import {
    buildContextHealth,
    buildContextReportText,
    contextThresholdPreset,
    contextThresholdPresetValue,
} from './Settings';
import type { ContextStatus } from '../../types/protocol';

describe('Settings context helpers', () => {
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
});
