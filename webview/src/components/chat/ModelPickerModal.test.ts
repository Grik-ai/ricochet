import { describe, expect, it } from 'vitest';
import { computeModelPickerPosition, modelMayTrainOnPrompts, modelPrivacyBadgeLabel } from './ModelPickerModal';

describe('ModelPickerModal privacy helpers', () => {
    it('labels only explicitly flagged prompt-training models', () => {
        expect(modelMayTrainOnPrompts({ mayTrainOnYourPrompts: true })).toBe(true);
        expect(modelPrivacyBadgeLabel({ mayTrainOnYourPrompts: true })).toBe('May train');
        expect(modelMayTrainOnPrompts({ mayTrainOnYourPrompts: false })).toBe(false);
        expect(modelPrivacyBadgeLabel({ mayTrainOnYourPrompts: false })).toBeNull();
        expect(modelMayTrainOnPrompts({})).toBe(false);
        expect(modelPrivacyBadgeLabel({})).toBeNull();
    });
});

describe('ModelPickerModal positioning', () => {
    it('flips below a centered composer when there is not enough room above', () => {
        const style = computeModelPickerPosition(
            { top: 300, bottom: 332, left: 260, right: 420, width: 160 },
            { left: 120, right: 680, width: 560 },
            { width: 800, height: 720 },
        );
        expect(style.top).toBeGreaterThanOrEqual(332);
        expect(Number(style.maxHeight)).toBeLessThanOrEqual(720 - Number(style.top) - 12);
    });

    it('stays above a docked composer and clamps to the viewport', () => {
        const style = computeModelPickerPosition(
            { top: 660, bottom: 692, left: 260, right: 420, width: 160 },
            { left: 80, right: 760, width: 680 },
            { width: 820, height: 720 },
        );
        expect(Number(style.top)).toBeLessThan(660);
        expect(Number(style.top)).toBeGreaterThanOrEqual(12);
        expect(Number(style.left)).toBeGreaterThanOrEqual(12);
        expect(Number(style.width)).toBeLessThanOrEqual(820 - 24);
    });
});
