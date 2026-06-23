import { ChangedFilesSummary, type ChangedFileItem } from './ChangedFilesSummary';

export type PendingReviewEdit = ChangedFileItem;

export function PendingReviewSurface({ edits }: { edits: PendingReviewEdit[] }) {
    const needsInspection = edits.some(edit => {
        const state = String(edit.state || edit.status || '').toLowerCase();
        return Boolean(edit.error || edit.conflictReason) || /conflict|failed|reject|review/.test(state);
    });
    return (
        <ChangedFilesSummary
            files={edits}
            mode="pending"
            anchor
            defaultExpanded={needsInspection}
            className="mb-2 bg-vscode-input-bg/80"
        />
    );
}
