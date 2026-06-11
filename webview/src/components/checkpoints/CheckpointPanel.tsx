import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
    Archive,
    Check,
    ChevronDown,
    ChevronRight,
    Copy,
    History,
    Loader2,
    RotateCcw,
    Save,
    ShieldCheck,
} from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import type { CheckpointFileChangePayload, CheckpointRestorePreviewPayload, CheckpointRestoreResultPayload } from '../../types/protocol';
import { FileGlyph } from '../common/FileGlyph';

interface Checkpoint {
    hash: string;
    message: string;
    timestamp: number;
}

interface CheckpointPanelProps {
    taskId?: string;
    onRestore?: (hash: string) => void;
}

export function CheckpointPanel({ taskId = 'default', onRestore }: CheckpointPanelProps) {
    const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
    const [isExpanded, setIsExpanded] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isInitialized, setIsInitialized] = useState(false);
    const [baseHash, setBaseHash] = useState('');
    const [preview, setPreview] = useState<CheckpointRestorePreviewPayload | null>(null);
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const { postMessage, onMessage } = useVSCodeApi();

    useEffect(() => {
        postMessage({ type: 'checkpoint_init', payload: { taskId } });
    }, [taskId, postMessage]);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'checkpoint_initialized': {
                    const payload = (message.payload || {}) as { baseHash?: string };
                    setIsInitialized(true);
                    setBaseHash(payload.baseHash || '');
                    postMessage({ type: 'checkpoint_list' });
                    break;
                }
                case 'checkpoint_saved': {
                    const payload = (message.payload || {}) as { hash?: string; commit?: string; message?: string };
                    const hash = payload.hash || payload.commit;
                    setIsSaving(false);
                    if (hash) {
                        setCheckpoints(prev => [...prev, {
                            hash,
                            message: payload.message || 'Manual checkpoint',
                            timestamp: Date.now(),
                        }]);
                        setNotice(`Saved ${hash.slice(0, 8)}`);
                    }
                    break;
                }
                case 'checkpoint_list': {
                    const payload = (message.payload || {}) as { checkpoints?: string[]; baseHash?: string; base_hash?: string };
                    const hashes = payload.checkpoints || [];
                    setBaseHash(payload.baseHash || payload.base_hash || '');
                    setCheckpoints(hashes.map((hash, index) => ({
                        hash,
                        message: `Checkpoint ${index + 1}`,
                        timestamp: Date.now() - (hashes.length - index) * 60000,
                    })));
                    break;
                }
                case 'checkpoint_restore_preview': {
                    const payload = message.payload as CheckpointRestorePreviewPayload;
                    setPreview(payload);
                    setSelectedPaths(new Set(checkpointPreviewDefaultSelection(payload)));
                    setBusyAction(null);
                    setNotice(null);
                    break;
                }
                case 'checkpoint_restored': {
                    const payload = message.payload as CheckpointRestoreResultPayload;
                    setBusyAction(null);
                    setPreview(null);
                    setSelectedPaths(new Set());
                    setNotice(`Restore completed${payload.safety_checkpoint_hash ? ` with safety ${payload.safety_checkpoint_hash.slice(0, 8)}` : ''}`);
                    onRestore?.(payload.restored_hash || '');
                    postMessage({ type: 'checkpoint_list' });
                    break;
                }
                case 'checkpoint_patch': {
                    const payload = (message.payload || {}) as { patch_path?: string };
                    setBusyAction(null);
                    setNotice(payload.patch_path ? `Patch written: ${payload.patch_path}` : 'Patch written');
                    break;
                }
                case 'checkpoint_restore_error': {
                    const payload = (message.payload || {}) as { error?: string };
                    setBusyAction(null);
                    setNotice(payload.error || 'Checkpoint operation failed');
                    break;
                }
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage, onRestore, postMessage]);

    const selectedCount = selectedPaths.size;
    const latestHash = checkpoints[checkpoints.length - 1]?.hash;
    const visibleCheckpoints = useMemo(() => {
        const items = [...checkpoints].reverse();
        if (baseHash) {
            items.push({ hash: baseHash, message: 'Initial state', timestamp: 0 });
        }
        return items;
    }, [baseHash, checkpoints]);

    const handleSave = useCallback(() => {
        if (isSaving) return;
        setIsSaving(true);
        postMessage({ type: 'save_checkpoint', payload: { message: `Manual checkpoint at ${new Date().toLocaleTimeString()}` } });
    }, [isSaving, postMessage]);

    const handlePreview = useCallback((hash: string) => {
        setBusyAction(`preview:${hash}`);
        postMessage({ type: 'checkpoint_preview_restore', payload: { checkpoint_hash: hash } });
    }, [postMessage]);

    const handleRestore = useCallback((mode: 'full' | 'selected_files' | 'patch_only' | 'export_snapshot') => {
        if (!preview) return;
        setBusyAction(mode);
        postMessage({
            type: mode === 'patch_only' ? 'checkpoint_create_patch' : 'checkpoint_restore',
            payload: {
                checkpoint_hash: preview.checkpoint_hash,
                mode,
                paths: mode === 'selected_files' ? [...selectedPaths] : undefined,
                create_safety_checkpoint: true,
            },
        });
    }, [postMessage, preview, selectedPaths]);

    const togglePath = (path: string) => {
        setSelectedPaths(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    if (!isInitialized) {
        return (
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] text-vscode-fg/50 border-b border-vscode-border">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Initializing checkpoints</span>
            </div>
        );
    }

    return (
        <div className="shrink-0 border-b border-vscode-border bg-vscode-editor-background">
            <button
                onClick={() => setIsExpanded(value => !value)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-vscode-toolbar-hover transition-colors"
            >
                <div className="flex items-center gap-2 min-w-0">
                    <History className="w-3.5 h-3.5 text-vscode-fg/55 shrink-0" />
                    <span className="text-[11px] font-medium text-vscode-fg/75">Checkpoints</span>
                    <span className="text-[10px] text-vscode-fg/45">{checkpoints.length}</span>
                    {latestHash && <span className="text-[10px] font-mono text-vscode-fg/35 truncate">{latestHash.slice(0, 8)}</span>}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={(event) => {
                            event.stopPropagation();
                            handleSave();
                        }}
                        disabled={isSaving}
                        className="p-1 rounded text-vscode-fg/55 hover:text-vscode-fg hover:bg-vscode-toolbar-hover disabled:opacity-50"
                        title="Save checkpoint"
                    >
                        {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    </button>
                    {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-vscode-fg/45" /> : <ChevronRight className="w-3.5 h-3.5 text-vscode-fg/45" />}
                </div>
            </button>

            {isExpanded && (
                <div className="px-3 pb-3 space-y-3">
                    {notice && (
                        <div className="flex items-center gap-2 rounded border border-vscode-border bg-vscode-input-bg px-2 py-1.5 text-[11px] text-vscode-fg/65">
                            <ShieldCheck className="w-3.5 h-3.5 text-success shrink-0" />
                            <span className="truncate">{notice}</span>
                        </div>
                    )}

                    <div className="max-h-36 overflow-y-auto custom-scrollbar space-y-1">
                        {visibleCheckpoints.length === 0 ? (
                            <div className="text-[11px] text-vscode-fg/45 py-2">No checkpoints yet.</div>
                        ) : visibleCheckpoints.map((checkpoint) => (
                            <CheckpointRow
                                key={checkpoint.hash}
                                checkpoint={checkpoint}
                                busy={busyAction === `preview:${checkpoint.hash}`}
                                onPreview={() => handlePreview(checkpoint.hash)}
                            />
                        ))}
                    </div>

                    {preview && (
                        <div className="rounded-md border border-vscode-border bg-vscode-input-bg overflow-hidden">
                            <div className="flex items-start justify-between gap-3 border-b border-vscode-border px-3 py-2">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 text-[11px] font-medium text-vscode-fg/80">
                                        <RotateCcw className="w-3.5 h-3.5 text-vscode-fg/55" />
                                        Restore preview
                                    </div>
                                    <div className="mt-1 text-[10.5px] text-vscode-fg/55">{preview.summary}</div>
                                </div>
                                <button
                                    onClick={() => setPreview(null)}
                                    className="text-[10px] text-vscode-fg/45 hover:text-vscode-fg"
                                >
                                    Close
                                </button>
                            </div>

                            {preview.warnings && preview.warnings.length > 0 && (
                                <div className="border-b border-vscode-border px-3 py-2 text-[10.5px] text-warning/90 space-y-1">
                                    {preview.warnings.map(warning => <div key={warning}>{warning}</div>)}
                                </div>
                            )}

                            <div className="max-h-44 overflow-y-auto custom-scrollbar px-2 py-2 space-y-1">
                                {preview.files.map(file => (
                                    <RestoreFileRow
                                        key={`${file.path}:${file.status}`}
                                        file={file}
                                        selected={selectedPaths.has(file.path)}
                                        onToggle={() => togglePath(file.path)}
                                    />
                                ))}
                            </div>

                            {preview.diff_stat && (
                                <pre className="mx-2 mb-2 max-h-24 overflow-auto rounded bg-vscode-editor-background border border-vscode-border p-2 text-[10.5px] leading-4 text-vscode-fg/60">
                                    {preview.diff_stat}
                                </pre>
                            )}

                            <div className="flex flex-wrap gap-2 border-t border-vscode-border px-3 py-2">
                                <ActionButton
                                    label={`Restore selected (${selectedCount})`}
                                    icon={<Check className="w-3.5 h-3.5" />}
                                    disabled={selectedCount === 0 || busyAction !== null}
                                    busy={busyAction === 'selected_files'}
                                    onClick={() => handleRestore('selected_files')}
                                />
                                <ActionButton
                                    label="Restore all"
                                    icon={<RotateCcw className="w-3.5 h-3.5" />}
                                    disabled={busyAction !== null}
                                    busy={busyAction === 'full'}
                                    onClick={() => handleRestore('full')}
                                />
                                <ActionButton
                                    label="Patch"
                                    icon={<Copy className="w-3.5 h-3.5" />}
                                    disabled={busyAction !== null}
                                    busy={busyAction === 'patch_only'}
                                    onClick={() => handleRestore('patch_only')}
                                />
                                <ActionButton
                                    label="Export"
                                    icon={<Archive className="w-3.5 h-3.5" />}
                                    disabled={busyAction !== null}
                                    busy={busyAction === 'export_snapshot'}
                                    onClick={() => handleRestore('export_snapshot')}
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function CheckpointRow({ checkpoint, busy, onPreview }: { checkpoint: Checkpoint; busy: boolean; onPreview: () => void }) {
    return (
        <div className="flex items-center justify-between gap-2 rounded border border-transparent px-2 py-1.5 hover:border-vscode-border hover:bg-vscode-toolbar-hover">
            <div className="min-w-0 flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-vscode-fg/45 shrink-0" />
                <div className="min-w-0">
                    <div className="truncate text-[11px] text-vscode-fg/75">{checkpoint.message}</div>
                    <div className="font-mono text-[10px] text-vscode-fg/40">{checkpoint.hash.slice(0, 8)}</div>
                </div>
            </div>
            <button
                onClick={onPreview}
                disabled={busy}
                className="flex items-center gap-1 rounded border border-vscode-border bg-vscode-editor-background px-2 py-1 text-[10.5px] text-vscode-fg/65 hover:text-vscode-fg disabled:opacity-50"
            >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                Preview
            </button>
        </div>
    );
}

function RestoreFileRow({ file, selected, onToggle }: { file: CheckpointFileChangePayload; selected: boolean; onToggle: () => void }) {
    const tone = file.status === 'deleted' ? 'text-error' : file.status === 'added' ? 'text-success' : 'text-vscode-fg/65';
    return (
        <label className="flex items-center gap-2 rounded px-2 py-1 hover:bg-vscode-toolbar-hover cursor-pointer">
            <input type="checkbox" checked={selected} onChange={onToggle} className="m-0 h-3 w-3" />
            <FileGlyph path={file.path} type="file" size="sm" />
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-vscode-fg/70">{file.path}</span>
            <span className={`text-[10px] ${tone}`}>{file.status}</span>
            {file.binary && <span className="text-[10px] text-vscode-fg/40">binary</span>}
            {file.large && <span className="text-[10px] text-warning/80">large</span>}
        </label>
    );
}

function ActionButton({
    label,
    icon,
    busy,
    disabled,
    onClick,
}: {
    label: string;
    icon: ReactNode;
    busy?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded border border-vscode-border bg-vscode-editor-background px-2.5 py-1.5 text-[11px] text-vscode-fg/75 hover:bg-vscode-toolbar-hover hover:text-vscode-fg disabled:opacity-45"
        >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
            {label}
        </button>
    );
}

export function checkpointPreviewDefaultSelection(preview: CheckpointRestorePreviewPayload): string[] {
    return preview.files.map(file => file.path);
}
