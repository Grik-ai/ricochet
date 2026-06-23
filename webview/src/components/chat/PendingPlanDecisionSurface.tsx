import { useEffect, useMemo, useState } from 'react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import type { Artifact, ChatMessage } from '../../hooks/useChat';

export type PlanDecision = 'implement' | 'revise';

export interface PendingPlanArtifact extends Artifact {
    type: 'implementation_plan';
    decision?: string;
    decision_error?: string;
}

interface PendingPlanDecisionSurfaceProps {
    artifacts: PendingPlanArtifact[];
}

const CLOSED_PLAN_STATUSES = new Set(['approved', 'revision_requested', 'saved']);

export function isPendingPlanDecisionArtifact(artifact: any): artifact is PendingPlanArtifact {
    if (artifact?.type !== 'implementation_plan') return false;
    const status = String(artifact.status || '').toLowerCase();
    return !CLOSED_PLAN_STATUSES.has(status);
}

export function planArtifactKey(artifact: Pick<PendingPlanArtifact, 'id' | 'path' | 'title'>): string {
    return String(artifact.id || artifact.path || artifact.title || 'implementation_plan');
}

export function planArtifactExcerpt(artifact: Pick<PendingPlanArtifact, 'summary' | 'content'>): string {
    const source = (artifact.summary || artifact.content || '').trim();
    if (!source) return 'Review the implementation plan and choose how Ricochet should proceed.';
    const collapsed = source
        .replace(/^#+\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    return collapsed.length > 180 ? `${collapsed.slice(0, 177)}...` : collapsed;
}

export function buildPlanDecisionMessage(artifact: PendingPlanArtifact, decision: PlanDecision) {
    return {
        type: 'plan_decision',
        payload: {
            session_id: artifact.session_id,
            artifact_id: artifact.id || artifact.path || artifact.title,
            path: artifact.path,
            decision,
        },
    };
}

export function collectPendingPlanDecisionArtifacts(messages: Pick<ChatMessage, 'artifacts'>[]): PendingPlanArtifact[] {
    const byKey = new Map<string, PendingPlanArtifact>();
    for (const message of messages) {
        const artifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
        for (const artifact of artifacts) {
            if (!isPendingPlanDecisionArtifact(artifact)) continue;
            byKey.set(planArtifactKey(artifact), artifact);
        }
    }
    return [...byKey.values()];
}

export function PendingPlanDecisionSurface({ artifacts }: PendingPlanDecisionSurfaceProps) {
    const { postMessage } = useVSCodeApi();
    const [applying, setApplying] = useState<Record<string, PlanDecision>>({});
    const artifactKeys = useMemo(() => new Set(artifacts.map(planArtifactKey)), [artifacts]);

    useEffect(() => {
        setApplying(prev => {
            const next = Object.fromEntries(Object.entries(prev).filter(([key]) => artifactKeys.has(key))) as Record<string, PlanDecision>;
            return Object.keys(next).length === Object.keys(prev).length ? prev : next;
        });
    }, [artifactKeys]);

    if (artifacts.length === 0) return null;

    const sendDecision = (artifact: PendingPlanArtifact, decision: PlanDecision) => {
        const key = planArtifactKey(artifact);
        setApplying(prev => ({ ...prev, [key]: decision }));
        postMessage(buildPlanDecisionMessage(artifact, decision));
    };

    return (
        <div
            data-ricochet-pending-plan
            role="region"
            aria-live="polite"
            aria-label="Pending Ricochet plan decision"
            className="mb-2 shrink-0 rounded-lg bg-blue-500/8 px-3 py-2.5 outline-none ring-1 ring-blue-400/18"
        >
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-blue-100/90">
                <span className="codicon codicon-checklist text-[13px]" />
                <span>{artifacts.length === 1 ? 'Plan decision required' : `${artifacts.length} plan decisions required`}</span>
            </div>
            <div className="flex flex-col gap-2">
                {artifacts.map(artifact => {
                    const key = planArtifactKey(artifact);
                    const pendingDecision = applying[key];
                    const hasError = String(artifact.status || '').toLowerCase() === 'error';
                    return (
                        <div key={key} className="rounded-md bg-vscode-editor-background/82 px-3 py-2">
                            <div className="mb-1 flex min-w-0 items-center gap-2">
                                <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-vscode-fg/90">
                                    {artifact.title || 'Implementation Plan'}
                                </div>
                                {pendingDecision && (
                                    <span className="shrink-0 rounded bg-blue-500/12 px-1.5 py-0.5 text-[9px] font-semibold text-blue-200/85">
                                        Applying...
                                    </span>
                                )}
                                {hasError && !pendingDecision && (
                                    <span className="shrink-0 rounded bg-red-500/12 px-1.5 py-0.5 text-[9px] font-semibold text-red-300/85">
                                        Decision failed
                                    </span>
                                )}
                            </div>
                            <div className="line-clamp-2 text-[12px] leading-[1.45] text-vscode-fg/60">
                                {planArtifactExcerpt(artifact)}
                            </div>
                            {artifact.decision_error && !pendingDecision && (
                                <div className="mt-2 rounded bg-red-500/8 px-2 py-1.5 text-[11px] leading-snug text-red-200/85">
                                    {artifact.decision_error}
                                </div>
                            )}
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    disabled={!artifact.path || Boolean(pendingDecision)}
                                    onClick={() => artifact.path && postMessage({ type: 'open_file', payload: { path: artifact.path } })}
                                    className="inline-flex items-center gap-1.5 rounded bg-vscode-input-bg px-2.5 py-1.5 text-[11px] font-medium text-vscode-fg/70 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                    <span className="codicon codicon-open-preview text-[12px]" />
                                    Review
                                </button>
                                <button
                                    type="button"
                                    disabled={Boolean(pendingDecision)}
                                    onClick={() => sendDecision(artifact, 'implement')}
                                    className="inline-flex items-center gap-1.5 rounded bg-vscode-button-bg px-3 py-1.5 text-[11px] font-semibold text-vscode-button-fg hover:bg-vscode-button-hover disabled:cursor-wait disabled:opacity-70"
                                >
                                    <span className="codicon codicon-check text-[12px]" />
                                    Proceed
                                </button>
                                <button
                                    type="button"
                                    disabled={Boolean(pendingDecision)}
                                    onClick={() => sendDecision(artifact, 'revise')}
                                    className="inline-flex items-center gap-1.5 rounded bg-vscode-input-bg px-2.5 py-1.5 text-[11px] font-medium text-vscode-fg/62 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg disabled:cursor-wait disabled:opacity-70"
                                >
                                    <span className="codicon codicon-edit text-[12px]" />
                                    Revise
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
