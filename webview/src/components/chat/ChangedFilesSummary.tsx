import { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { FileGlyph } from '../common/FileGlyph';

export type ChangedFileHunk = {
    id?: string;
    oldStart?: number;
    oldLength?: number;
    newStart?: number;
    newLength?: number;
    oldLines?: string[];
    newLines?: string[];
    additions?: number;
    deletions?: number;
};

export type ChangedFileItem = {
    id?: string;
    filePath?: string;
    relativePath?: string;
    displayName?: string;
    path?: string;
    target?: string;
    additions?: number;
    deletions?: number;
    status?: string;
    state?: string;
    hasDiff?: boolean;
    reviewable?: boolean;
    conflictReason?: string;
    isNewFile?: boolean;
    proposalId?: string;
    tool?: string;
    hunks?: ChangedFileHunk[];
    diffPreview?: string;
    error?: string;
};

function normalizePath(path = ''): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function basename(path = ''): string {
    const normalized = normalizePath(path);
    return normalized.split('/').filter(Boolean).pop() || normalized || 'pending edit';
}

function dirname(path = ''): string {
    const normalized = normalizePath(path);
    const parts = normalized.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
}

function displayPath(file: ChangedFileItem): string {
    return file.relativePath || file.displayName || file.target || file.path || file.filePath || 'pending edit';
}

function openPath(file: ChangedFileItem): string {
    return file.filePath || file.path || file.relativePath || file.target || '';
}

function normalizedEditState(file: ChangedFileItem): string {
    return String(file.state || file.status || '').toLowerCase();
}

function hasRealDiff(file: ChangedFileItem): boolean {
    if (file.hasDiff === true) return true;
    if (file.hasDiff === false && !file.hunks?.length) return false;
    if ((file.additions || 0) > 0 || (file.deletions || 0) > 0) return true;
    if (file.hunks?.some(hunk => (hunk.additions || 0) > 0 || (hunk.deletions || 0) > 0 || (hunk.oldLines?.length || 0) > 0 || (hunk.newLines?.length || 0) > 0)) return true;
    return Boolean(file.diffPreview?.trim());
}

function isFailedEdit(file: ChangedFileItem): boolean {
    const state = normalizedEditState(file);
    return Boolean(file.error || file.conflictReason)
        || /conflict|failed|failure|error|reject|rejected|blocked/.test(state);
}

function isReviewNeeded(file: ChangedFileItem): boolean {
    const state = normalizedEditState(file);
    if (isFailedEdit(file)) return true;
    if (file.reviewable === true) return true;
    return /pending|waiting|review/.test(state) && hasRealDiff(file);
}

function fileStatusLabel(file: ChangedFileItem): string {
    const state = normalizedEditState(file);
    if (/conflict/.test(state)) return 'Conflict';
    if (/reject|rejected/.test(state)) return 'Review failed';
    if (isFailedEdit(file)) return 'Failed';
    if (/reviewing/.test(state)) return 'Reviewing';
    if (isReviewNeeded(file)) return 'Review needed';
    if (!hasRealDiff(file)) return 'No changes';
    return file.isNewFile ? 'New file' : 'Modified';
}

function statusClassName(file: ChangedFileItem): string {
    if (isFailedEdit(file)) return 'text-rose-300/78';
    if (isReviewNeeded(file)) return 'text-amber-200/72';
    if (hasRealDiff(file)) return 'text-emerald-300/72';
    return 'text-vscode-fg/38';
}

function hunkLineRange(hunk: ChangedFileHunk): string {
    const start = Math.max(1, hunk.newStart || hunk.oldStart || 1);
    const length = Math.max(hunk.newLength || hunk.oldLength || 1, 1);
    return length > 1 ? `#L${start}-${start + length - 1}` : `#L${start}`;
}

function renderPreviewLine(prefix: '+' | '-', line: string, index: number) {
    return (
        <div key={`${prefix}-${index}-${line}`} className="flex min-w-0 gap-2">
            <span className={prefix === '+' ? 'text-emerald-400/70' : 'text-rose-400/70'}>{prefix}</span>
            <span className="min-w-0 truncate text-vscode-fg/52">{line || ' '}</span>
        </div>
    );
}

function ChangedFilePreview({ file }: { file: ChangedFileItem }) {
    const hunk = file.hunks?.[0];
    if (!hunk && !file.diffPreview) return null;

    const removed = (hunk?.oldLines || []).filter(line => line.trim()).slice(0, 2);
    const added = (hunk?.newLines || []).filter(line => line.trim()).slice(0, 3);
    const previewLines = [
        ...removed.map((line, index) => renderPreviewLine('-', line, index)),
        ...added.map((line, index) => renderPreviewLine('+', line, index)),
    ];

    return (
        <div className="mt-2 rounded-md bg-vscode-editor-background/60 px-2.5 py-2 font-mono text-[10.5px] leading-4">
            <div className="mb-1 flex items-center justify-between gap-2 text-vscode-fg/35">
                <span>{hunk ? hunkLineRange(hunk) : 'Diff preview'}</span>
                {hunk && (
                    <span>
                        +{hunk.additions || 0} -{hunk.deletions || 0}
                    </span>
                )}
            </div>
            {previewLines.length > 0 ? previewLines : (
                <div className="truncate text-vscode-fg/48">{file.diffPreview}</div>
            )}
        </div>
    );
}

export function ChangedFilesSummary({
    files,
    mode = 'completed',
    titlePrefix,
    className = '',
    anchor,
    defaultExpanded = false,
}: {
    files: ChangedFileItem[];
    mode?: 'pending' | 'completed';
    titlePrefix?: string;
    className?: string;
    anchor?: boolean;
    defaultExpanded?: boolean;
}) {
    const { postMessage } = useVSCodeApi();
    const visibleFiles = useMemo(
        () => files.filter(file => openPath(file) || displayPath(file)),
        [files],
    );
    const [expanded, setExpanded] = useState(defaultExpanded);
    if (visibleFiles.length === 0) return null;

    const changedFiles = visibleFiles.filter(file => hasRealDiff(file) && !isFailedEdit(file));
    const failedFiles = visibleFiles.filter(isFailedEdit);
    const reviewNeededFiles = visibleFiles.filter(file => isReviewNeeded(file) && !isFailedEdit(file));
    const additions = changedFiles.reduce((total, file) => total + (file.additions || 0), 0);
    const deletions = changedFiles.reduce((total, file) => total + (file.deletions || 0), 0);
    const hasConflict = failedFiles.some(file => /conflict/.test(normalizedEditState(file)));
    const canAcceptAll = mode === 'pending' && reviewNeededFiles.some(file => file.reviewable !== false) && !hasConflict;
    const changedLabel = changedFiles.length > 0
        ? `${changedFiles.length} ${changedFiles.length === 1 ? 'file' : 'files'} changed`
        : failedFiles.length > 0
            ? `${failedFiles.length} failed ${failedFiles.length === 1 ? 'edit' : 'edits'}`
            : reviewNeededFiles.length > 0
                ? `${reviewNeededFiles.length} edit ${reviewNeededFiles.length === 1 ? 'attempt' : 'attempts'} need review`
                : 'No file changes';
    const countLabel = changedFiles.length > 0
        ? (
            <>
                <span className="text-emerald-400/85">+{additions}</span>
                <span className="text-rose-400/85">-{deletions}</span>
            </>
        )
        : failedFiles.length > 0
            ? <span className="text-rose-300/70">Review needed</span>
            : null;

    const openReview = (file = visibleFiles[0]) => {
        const path = openPath(file);
        if (!path) return;
        postMessage({ type: 'open_file', payload: { path, proposalId: file.proposalId, review: true } });
    };

    return (
        <section
            data-ricochet-pending-edit-review={anchor ? true : undefined}
            tabIndex={anchor ? -1 : undefined}
            aria-live={anchor ? 'polite' : undefined}
            className={`rounded-lg bg-vscode-input-bg/45 p-2 outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder ${className}`}
        >
            <div className="flex min-w-0 items-center gap-2">
                <button
                    type="button"
                    onClick={() => setExpanded(open => !open)}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-vscode-list-hoverBackground/35"
                >
                    <span className={`codicon codicon-chevron-right shrink-0 text-[11px] text-vscode-fg/35 transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
                    <span className="shrink-0 text-[12.5px] font-semibold text-vscode-fg/72">
                        {titlePrefix ? `${titlePrefix} ` : ''}{changedLabel}
                    </span>
                    {countLabel && (
                        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] text-vscode-fg/48">
                            {countLabel}
                        </span>
                    )}
                    {changedFiles.length > 0 && failedFiles.length > 0 && (
                        <span className="shrink-0 text-[10.5px] text-rose-300/70">
                            {failedFiles.length} failed
                        </span>
                    )}
                </button>
                <button
                    type="button"
                    onClick={() => openReview()}
                    className="shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-vscode-fg/58 hover:bg-vscode-toolbar-hover hover:text-vscode-fg/84"
                >
                    Review
                </button>
            </div>

            {mode === 'pending' && (
                <div className="mt-1 flex justify-end gap-1.5 px-1">
                    <button
                        type="button"
                        onClick={() => postMessage({ type: 'execute_command', payload: { command: '/reject-all' } })}
                        className="inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-[11px] font-medium text-vscode-fg/58 hover:bg-vscode-toolbar-hover hover:text-vscode-fg/82"
                    >
                        <X className="h-3.5 w-3.5" />
                        Reject all
                    </button>
                    <button
                        type="button"
                        disabled={!canAcceptAll}
                        onClick={() => postMessage({ type: 'execute_command', payload: { command: '/accept-all' } })}
                        className="inline-flex h-7 items-center gap-1.5 rounded bg-vscode-button-bg px-2.5 text-[11px] font-semibold text-vscode-button-fg hover:bg-vscode-button-hover disabled:cursor-not-allowed disabled:opacity-45"
                        title={!canAcceptAll ? 'No reviewable diff is ready to accept' : 'Accept all pending Ricochet edits'}
                    >
                        <Check className="h-3.5 w-3.5" />
                        Accept all
                    </button>
                </div>
            )}

            {expanded && (
                <div className="mt-2 grid gap-1.5">
                    {visibleFiles.map((file, index) => {
                        const path = displayPath(file);
                        const fullPath = openPath(file);
                        const name = file.displayName || basename(path);
                        const folder = dirname(file.relativePath || path);
                        const fileAdditions = file.additions || 0;
                        const fileDeletions = file.deletions || 0;
                        const realDiff = hasRealDiff(file);
                        return (
                            <div key={`${file.proposalId || fullPath || path}-${index}`} className="rounded-md bg-vscode-editor-background/45 px-2.5 py-2">
                                <div className="flex min-w-0 items-center gap-2">
                                    <FileGlyph path={path} type="file" size="sm" />
                                    <button
                                        type="button"
                                        onClick={() => openReview(file)}
                                        className="min-w-0 flex-1 text-left hover:text-vscode-link-foreground"
                                        title={file.conflictReason || file.error || fullPath || path}
                                    >
                                        <span className="block truncate font-mono text-[11.5px] font-semibold text-vscode-fg/76">{name}</span>
                                        {folder && <span className="block truncate text-[10.5px] text-vscode-fg/38">{folder}</span>}
                                    </button>
                                    <span className={`shrink-0 text-[10px] ${statusClassName(file)}`}>
                                        {fileStatusLabel(file)}
                                    </span>
                                    {realDiff && (
                                        <span className="shrink-0 font-mono text-[10.5px] text-vscode-fg/45">
                                            <>
                                                <span className="text-emerald-400/85">+{fileAdditions}</span>{' '}
                                                <span className="text-rose-400/85">-{fileDeletions}</span>
                                            </>
                                        </span>
                                    )}
                                </div>
                                {(file.conflictReason || file.error) && (
                                    <div className="mt-1 truncate text-[10.5px] text-rose-300/70" title={file.conflictReason || file.error}>
                                        {file.conflictReason || file.error}
                                    </div>
                                )}
                                <ChangedFilePreview file={file} />
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
