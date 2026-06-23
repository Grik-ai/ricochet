import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PendingReviewSurface } from './PendingReviewSurface';
import { ChangedFilesSummary } from './ChangedFilesSummary';

describe('PendingReviewSurface', () => {
    it('renders pending file edits as a compact changed-files review surface', () => {
        const html = renderToStaticMarkup(
            <PendingReviewSurface
                edits={[{
                    filePath: '/workspace/src/main.rs',
                    relativePath: 'src/main.rs',
                    displayName: 'main.rs',
                    additions: 3,
                    deletions: 1,
                    status: 'pending',
                    state: 'pending',
                    hasDiff: true,
                    reviewable: true,
                    proposalId: 'proposal-1',
                    hunks: [{
                        id: 'hunk-1',
                        oldStart: 9,
                        oldLength: 1,
                        newStart: 9,
                        newLength: 3,
                        oldLines: ['let old = true;'],
                        newLines: ['let new_value = true;', 'run_phase_one();'],
                        additions: 3,
                        deletions: 1,
                    }],
                }]}
            />
        );

        expect(html).toContain('data-ricochet-pending-edit-review');
        expect(html).toContain('1 file changed');
        expect(html).toContain('+3');
        expect(html).toContain('-1');
        expect(html).toContain('Review');
        expect(html).toContain('Reject all');
        expect(html).toContain('Accept all');
    });

    it('expands changed files with icons, relative paths, and hunk preview', () => {
        const html = renderToStaticMarkup(
            <ChangedFilesSummary
                mode="pending"
                defaultExpanded
                files={[{
                    filePath: '/workspace/src/main.rs',
                    relativePath: 'src/main.rs',
                    displayName: 'main.rs',
                    additions: 3,
                    deletions: 1,
                    status: 'pending',
                    state: 'pending',
                    hasDiff: true,
                    reviewable: true,
                    proposalId: 'proposal-1',
                    hunks: [{
                        id: 'hunk-1',
                        oldStart: 9,
                        oldLength: 1,
                        newStart: 9,
                        newLength: 3,
                        oldLines: ['let old = true;'],
                        newLines: ['let new_value = true;', 'run_phase_one();'],
                        additions: 3,
                        deletions: 1,
                    }],
                }]}
            />
        );

        expect(html).toContain('main.rs');
        expect(html).toContain('src');
        expect(html).toContain('run_phase_one');
    });

    it('shows conflicted edits as failed review items without counting them as changed files', () => {
        const html = renderToStaticMarkup(
            <PendingReviewSurface
                edits={[{
                    filePath: '/workspace/Cargo.toml',
                    relativePath: 'Cargo.toml',
                    additions: 0,
                    deletions: 0,
                    status: 'conflicted',
                    state: 'conflicted',
                    hasDiff: false,
                    reviewable: false,
                    conflictReason: 'File changed on disk after Ricochet proposed this edit.',
                }]}
            />
        );

        expect(html).toContain('1 failed edit');
        expect(html).toContain('Conflict');
        expect(html).toContain('File changed on disk');
        expect(html).not.toContain('1 file changed');
        expect(html).not.toContain('No changes No changes');
    });

    it('uses muted surfaces without persistent border or divider classes', () => {
        const html = renderToStaticMarkup(
            <ChangedFilesSummary
                mode="completed"
                defaultExpanded
                files={[{
                    filePath: '/workspace/src/main.rs',
                    relativePath: 'src/main.rs',
                    displayName: 'main.rs',
                    additions: 0,
                    deletions: 0,
                    status: 'failed',
                    state: 'failed',
                    hasDiff: false,
                    error: 'TargetContent not found in file.',
                }]}
            />
        );

        expect(html).not.toContain('border ');
        expect(html).not.toContain('border-');
        expect(html).not.toContain('divide-');
        expect(html).toContain('1 failed edit');
        expect(html).toContain('TargetContent not found');
    });
});
