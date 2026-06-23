import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
    Boxes,
    CheckCircle2,
    FileDiff,
    FileText,
    GitBranch,
    Loader2,
    Play,
    RotateCcw,
    ShieldCheck,
    StopCircle,
    Trash2,
} from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import type { BatchEventPayload, BatchRunPayload, BatchWorkerPayload } from '../../types/protocol';

interface BatchDashboardProps {
    sessionId?: string | null;
    defaultGoal?: string;
}

interface WorkerDiffPayload {
    worker_id: string;
    diff_stat?: string;
    patch?: string;
}

export function BatchDashboard({ sessionId, defaultGoal = '' }: BatchDashboardProps) {
    const { postMessage, onMessage } = useVSCodeApi();
    const [runs, setRuns] = useState<BatchRunPayload[]>([]);
    const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
    const [goal, setGoal] = useState(defaultGoal);
    const [workerText, setWorkerText] = useState('Core changes\nVerification and tests\nUI wiring');
    const [verificationText, setVerificationText] = useState('npm test -- --run\nnpm run build');
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [workerDiff, setWorkerDiff] = useState<WorkerDiffPayload | null>(null);
    const [summaryWorker, setSummaryWorker] = useState<BatchWorkerPayload | null>(null);

    useEffect(() => {
        setGoal(current => current || defaultGoal);
    }, [defaultGoal]);

    useEffect(() => {
        postMessage({ type: 'batch_run_list', payload: {} });
    }, [postMessage]);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'batch_runs':
                case 'batch_run_list_result': {
                    const payload = (message.payload || {}) as { runs?: BatchRunPayload[] };
                    setRuns(payload.runs || []);
                    setBusy(null);
                    break;
                }
                case 'batch_run':
                case 'batch_run_create_result':
                case 'batch_run_start_result':
                case 'batch_run_abort_result':
                case 'batch_worker_retry_result':
                case 'batch_run_cleanup_result': {
                    const run = message.payload as BatchRunPayload;
                    if (run?.id) {
                        setRuns(prev => upsertRun(prev, run));
                        setSelectedRunId(run.id);
                    }
                    setBusy(null);
                    break;
                }
                case 'batch_worker_diff':
                case 'batch_worker_diff_result': {
                    setWorkerDiff(message.payload as WorkerDiffPayload);
                    setBusy(null);
                    break;
                }
                case 'batch_worker':
                case 'batch_worker_apply_result': {
                    postMessage({ type: 'batch_run_list', payload: {} });
                    setBusy(null);
                    break;
                }
                case 'batch_worker_artifacts':
                case 'batch_worker_artifacts_result': {
                    const payload = (message.payload || {}) as { worker_id?: string; artifacts?: BatchWorkerPayload['artifacts'] };
                    if (payload.worker_id) {
                        setRuns(prev => updateWorkerInRuns(prev, payload.worker_id!, worker => ({
                            ...worker,
                            artifacts: payload.artifacts || worker.artifacts || [],
                        })));
                    }
                    setBusy(null);
                    break;
                }
                case 'batch_event': {
                    const payload = message.payload as BatchEventPayload;
                    if (payload?.run) {
                        setRuns(prev => upsertRun(prev, payload.run!));
                        setSelectedRunId(current => current || payload.run!.id);
                    } else if (payload?.worker) {
                        setRuns(prev => upsertWorker(prev, payload.worker!));
                    }
                    setBusy(null);
                    break;
                }
                case 'batch_error': {
                    const payload = (message.payload || {}) as { error?: string };
                    setError(payload.error || 'Batch action failed');
                    setBusy(null);
                    break;
                }
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage, postMessage]);

    const selectedRun = useMemo(() => {
        return runs.find(run => run.id === selectedRunId) || runs[0] || null;
    }, [runs, selectedRunId]);

    const createRun = useCallback(() => {
        if (!goal.trim()) return;
        const workers = workerText
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 5);
        const verificationCommands = verificationText
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);
        setBusy('create');
        setError(null);
        postMessage({
            type: 'batch_run_create',
            payload: {
                session_id: sessionId || undefined,
                goal,
                max_workers: Math.min(Math.max(workers.length || 3, 1), 5),
                workers,
                verification_commands: verificationCommands,
            },
        });
    }, [goal, postMessage, sessionId, verificationText, workerText]);

    const runAction = useCallback((type: string, payload: Record<string, string>) => {
        setBusy(`${type}:${Object.values(payload)[0] || ''}`);
        setError(null);
        postMessage({ type, payload });
    }, [postMessage]);

    return (
        <div className="flex-1 overflow-y-auto bg-sidebar-background p-3">
            <div className="grid gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
                <section className="rounded-md bg-input-background/20 p-3">
                    <div className="mb-3 flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-foreground/55" />
                        <div>
                            <h2 className="text-[12px] font-medium text-foreground/80">Batch Worktrees</h2>
                            <p className="text-[10.5px] text-foreground/45">Advanced parallel worktree workers with review gates.</p>
                        </div>
                    </div>
                    <div className="mb-3 rounded bg-vscode-editor-background/45 px-2.5 py-2 text-[10.5px] leading-4 text-foreground/42">
                        Use Batch when one broad goal should be split into isolated worker branches, reviewed, and applied deliberately. Normal chat activity and Task Steps are tracked outside this tab.
                    </div>

                    <label className="mb-1 block text-[10px] text-foreground/45">Goal</label>
                    <textarea
                        value={goal}
                        onChange={event => setGoal(event.target.value)}
                        className="mb-3 min-h-[74px] w-full resize-none rounded bg-input-background px-2 py-2 text-[11.5px] text-input-foreground outline-none"
                        placeholder="Describe a broad change to split into worktree agents"
                    />

                    <label className="mb-1 block text-[10px] text-foreground/45">Worker units, one per line</label>
                    <textarea
                        value={workerText}
                        onChange={event => setWorkerText(event.target.value)}
                        className="mb-3 min-h-[86px] w-full resize-none rounded bg-input-background px-2 py-2 text-[11px] text-input-foreground outline-none"
                        placeholder={"API changes\nUI changes\nTests"}
                    />

                    <label className="mb-1 block text-[10px] text-foreground/45">Verification commands</label>
                    <textarea
                        value={verificationText}
                        onChange={event => setVerificationText(event.target.value)}
                        className="mb-3 min-h-[58px] w-full resize-none rounded bg-input-background px-2 py-2 font-mono text-[10.5px] text-input-foreground outline-none"
                        placeholder={"npm test -- --run\nnpm run build"}
                    />

                    <button
                        onClick={createRun}
                        disabled={!goal.trim() || busy !== null}
                        className="inline-flex w-full items-center justify-center gap-2 rounded bg-button-background px-3 py-2 text-[11px] font-medium text-button-foreground hover:bg-button-background-hover disabled:opacity-45"
                    >
                        {busy === 'create' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                        Create reviewed batch
                    </button>

                    {error && <div className="mt-3 rounded bg-error/10 px-2 py-1.5 text-[10.5px] text-error">{error}</div>}
                </section>

                <section className="min-w-0 rounded-md bg-input-background/20">
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                            <h2 className="truncate text-[12px] font-medium text-foreground/80">
                                {selectedRun ? selectedRun.goal : 'No batch run selected'}
                            </h2>
                            {selectedRun && (
                                <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] text-foreground/40">
                                    <span>{selectedRun.id}</span>
                                    <span>{selectedRun.status}</span>
                                    {selectedRun.base_branch && <span>{selectedRun.base_branch}</span>}
                                </div>
                            )}
                        </div>
                        <button
                            onClick={() => postMessage({ type: 'batch_run_list', payload: {} })}
                            className="rounded bg-vscode-editor-background/45 px-2 py-1 text-[10.5px] text-foreground/60 hover:bg-list-background-hover"
                        >
                            Refresh
                        </button>
                    </div>

                    {runs.length > 0 && (
                        <div className="flex gap-1 overflow-x-auto px-2 py-2">
                            {runs.map(run => (
                                <button
                                    key={run.id}
                                    onClick={() => setSelectedRunId(run.id)}
                                    className={`shrink-0 rounded px-2 py-1 text-[10.5px] ${selectedRun?.id === run.id ? 'bg-button-background text-button-foreground' : 'bg-vscode-border/20 text-foreground/55 hover:bg-list-background-hover'}`}
                                >
                                    {run.id}
                                </button>
                            ))}
                        </div>
                    )}

                    {selectedRun ? (
                        <div className="p-3">
                            <div className="mb-3 flex flex-wrap gap-2">
                                <ToolbarButton
                                    label="Start"
                                    icon={<Play className="h-3.5 w-3.5" />}
                                    busy={busy === `batch_run_start:${selectedRun.id}`}
                                    onClick={() => runAction('batch_run_start', { run_id: selectedRun.id })}
                                />
                                <ToolbarButton
                                    label="Abort"
                                    icon={<StopCircle className="h-3.5 w-3.5" />}
                                    busy={busy === `batch_run_abort:${selectedRun.id}`}
                                    onClick={() => runAction('batch_run_abort', { run_id: selectedRun.id })}
                                />
                                <ToolbarButton
                                    label="Cleanup"
                                    icon={<Trash2 className="h-3.5 w-3.5" />}
                                    busy={busy === `batch_run_cleanup:${selectedRun.id}`}
                                    onClick={() => runAction('batch_run_cleanup', { run_id: selectedRun.id })}
                                />
                            </div>

                            <div className="space-y-2">
                                {(selectedRun.workers || []).map(worker => (
                                    <WorkerCard
                                        key={worker.id}
                                        worker={worker}
                                        busy={busy}
                                        onDiff={() => runAction('batch_worker_diff', { worker_id: worker.id })}
                                        onApply={() => runAction('batch_worker_apply', { worker_id: worker.id })}
                                        onRetry={() => runAction('batch_worker_retry', { worker_id: worker.id })}
                                        onSummary={() => setSummaryWorker(worker)}
                                    />
                                ))}
                            </div>

                            {selectedRun.merge_plan?.warnings && selectedRun.merge_plan.warnings.length > 0 && (
                                <div className="mt-3 rounded bg-vscode-editor-background px-3 py-2 text-[10.5px] text-foreground/50">
                                    {selectedRun.merge_plan.warnings.map(warning => <div key={warning}>{warning}</div>)}
                                </div>
                            )}

                            {workerDiff && (
                                <div className="mt-3 overflow-hidden rounded bg-vscode-editor-background">
                                    <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-foreground/75">
                                        <FileDiff className="h-3.5 w-3.5 text-foreground/45" />
                                        Diff: {workerDiff.worker_id}
                                    </div>
                                    <pre className="max-h-64 overflow-auto p-3 text-[10.5px] leading-4 text-foreground/65">
                                        {workerDiff.diff_stat || workerDiff.patch || 'No diff'}
                                    </pre>
                                </div>
                            )}

                            {summaryWorker && (
                                <div className="mt-3 overflow-hidden rounded bg-vscode-editor-background">
                                    <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-foreground/75">
                                        <span className="inline-flex items-center gap-2">
                                            <FileText className="h-3.5 w-3.5 text-foreground/45" />
                                            Summary: {summaryWorker.id}
                                        </span>
                                        <button onClick={() => setSummaryWorker(null)} className="text-[10px] text-foreground/45 hover:text-foreground">Close</button>
                                    </div>
                                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap p-3 text-[10.5px] leading-4 text-foreground/65">
                                        {summaryWorker.summary || summaryWorker.output_preview || summaryWorker.error || 'No summary yet'}
                                    </pre>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex min-h-[260px] items-center justify-center px-6 text-center text-[11px] leading-5 text-foreground/40">
                            Create a reviewed batch only when you want parallel durable worktrees. Ordinary chat runs do not need anything here.
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}

function WorkerCard({
    worker,
    busy,
    onDiff,
    onApply,
    onRetry,
    onSummary,
}: {
    worker: BatchWorkerPayload;
    busy: string | null;
    onDiff: () => void;
    onApply: () => void;
    onRetry: () => void;
    onSummary: () => void;
}) {
    return (
        <div className="rounded-md bg-vscode-editor-background px-3 py-2">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-[12px] font-medium text-foreground/80">{worker.title}</span>
                        <WorkerStatusPill status={worker.status} />
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[10px] text-foreground/40">
                        <span className="font-mono">{worker.id}</span>
                        {worker.branch && <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" />{worker.branch}</span>}
                        {worker.attempt && <span>attempt {worker.attempt}</span>}
                        {worker.verification_status && <span>verify: {worker.verification_status}</span>}
                        {worker.path && <span className="truncate font-mono">{worker.path}</span>}
                    </div>
                    {worker.scope_paths && worker.scope_paths.length > 0 && (
                        <div className="mt-1 truncate font-mono text-[10px] text-foreground/35">scope: {worker.scope_paths.join(', ')}</div>
                    )}
                    {worker.error && <div className="mt-1 text-[10.5px] text-error">{worker.error}</div>}
                    {(worker.summary || worker.output_preview) && <div className="mt-1 line-clamp-2 text-[10.5px] text-foreground/50">{worker.summary || worker.output_preview}</div>}
                    {worker.artifacts && worker.artifacts.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                            {worker.artifacts.slice(0, 3).map(artifact => (
                                <span key={`${artifact.type}-${artifact.path}`} className="rounded bg-input-background px-1.5 py-0.5 font-mono text-[9.5px] text-foreground/45">
                                    {artifact.type}: {artifact.path}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
                <div className="flex shrink-0 gap-1">
                    <ToolbarButton
                        label="Summary"
                        icon={<FileText className="h-3.5 w-3.5" />}
                        onClick={onSummary}
                    />
                    <ToolbarButton
                        label="Diff"
                        icon={<FileDiff className="h-3.5 w-3.5" />}
                        busy={busy === `batch_worker_diff:${worker.id}`}
                        onClick={onDiff}
                    />
                    {(worker.status === 'failed' || worker.status === 'timeout' || worker.status === 'interrupted' || worker.status === 'aborted') && (
                        <ToolbarButton
                            label="Retry"
                            icon={<RotateCcw className="h-3.5 w-3.5" />}
                            busy={busy === `batch_worker_retry:${worker.id}`}
                            onClick={onRetry}
                        />
                    )}
                    <ToolbarButton
                        label="Apply"
                        icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                        busy={busy === `batch_worker_apply:${worker.id}`}
                        onClick={onApply}
                    />
                </div>
            </div>
            {worker.diff_stat && (
                <pre className="mt-2 max-h-24 overflow-auto rounded bg-input-background p-2 text-[10px] leading-4 text-foreground/55">
                    {worker.diff_stat}
                </pre>
            )}
        </div>
    );
}

export function upsertRun(runs: BatchRunPayload[], run: BatchRunPayload): BatchRunPayload[] {
    const index = runs.findIndex(item => item.id === run.id);
    if (index === -1) return [run, ...runs];
    const next = [...runs];
    next[index] = run;
    return next;
}

export function upsertWorker(runs: BatchRunPayload[], worker: BatchWorkerPayload): BatchRunPayload[] {
    return runs.map(run => {
        if (run.id !== worker.run_id) return run;
        const workers = run.workers || [];
        const index = workers.findIndex(item => item.id === worker.id);
        const nextWorkers = [...workers];
        if (index === -1) nextWorkers.push(worker);
        else nextWorkers[index] = { ...nextWorkers[index], ...worker };
        return { ...run, workers: nextWorkers, updated_at: Date.now() };
    });
}

export function updateWorkerInRuns(
    runs: BatchRunPayload[],
    workerId: string,
    update: (worker: BatchWorkerPayload) => BatchWorkerPayload,
    runId?: string,
): BatchRunPayload[] {
    return runs.map(run => {
        if (runId && run.id !== runId) return run;
        const workers = run.workers || [];
        const index = workers.findIndex(item => item.id === workerId);
        if (index === -1) return run;
        const nextWorkers = [...workers];
        nextWorkers[index] = update(nextWorkers[index]);
        return { ...run, workers: nextWorkers, updated_at: Date.now() };
    });
}

function ToolbarButton({ label, icon, busy, onClick }: { label: string; icon: ReactNode; busy?: boolean; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded bg-input-background px-2 py-1 text-[10.5px] text-foreground/65 hover:bg-list-background-hover hover:text-foreground disabled:opacity-50"
        >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
            {label}
        </button>
    );
}

function WorkerStatusPill({ status }: { status: string }) {
    const color = status === 'applied' || status === 'completed'
        ? 'text-success'
        : status === 'failed' || status === 'aborted' || status === 'timeout'
            ? 'text-error'
            : status === 'ready' || status === 'running' || status === 'queued'
                ? 'text-button-background'
                : 'text-foreground/45';
    return <span className={`shrink-0 rounded bg-vscode-border/15 px-1.5 py-0.5 text-[9.5px] ${color}`}>{status}</span>;
}
