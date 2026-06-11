import { describe, expect, it } from 'vitest';
import { checkpointPreviewDefaultSelection } from './CheckpointPanel';
import type { CheckpointRestorePreviewPayload } from '../../types/protocol';

describe('CheckpointPanel helpers', () => {
    it('selects all changed paths by default for explicit review before restore', () => {
        const preview: CheckpointRestorePreviewPayload = {
            checkpoint_hash: 'abc123',
            current_hash: 'def456',
            safety_required: true,
            summary: '3 files changed',
            files: [
                { path: 'src/app.ts', status: 'modified' },
                { path: 'src/new.ts', status: 'added' },
                { path: 'src/old.ts', status: 'deleted' },
            ],
            warnings: [],
            restore_modes: ['full', 'selected_files', 'patch_only'],
            generated_at: 1_786_387_200,
        };

        expect(checkpointPreviewDefaultSelection(preview)).toEqual([
            'src/app.ts',
            'src/new.ts',
            'src/old.ts',
        ]);
    });
});
