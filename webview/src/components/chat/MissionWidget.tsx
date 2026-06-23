import { useState, useEffect } from 'react';
import { useAgentStateMachine } from '../../hooks/useAgentStateMachine';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { SessionState } from '../../services/state-machine/sessionStateMachine';
import { deriveMissionRuntime } from '../../utils/missionRuntime';

interface MissionWidgetProps {
    agentState: ReturnType<typeof useAgentStateMachine>;
    onOpenDashboard: () => void;
    currentToolName?: string;
    inline?: boolean;
    pendingEditCount?: number;
    alwaysVisible?: boolean;
}

export const missionWidgetButtonClass = 'group inline-flex h-6 max-w-[180px] items-center gap-1.5 rounded px-1.5 text-[10px] font-medium text-vscode-fg/50 transition-colors hover:bg-vscode-toolbar-hover hover:text-vscode-fg/80';

export function MissionWidget({ agentState, onOpenDashboard, currentToolName, inline = false, pendingEditCount = 0, alwaysVisible = false }: MissionWidgetProps) {
    const { postMessage } = useVSCodeApi();
    const { state, context, uiState } = agentState;
    const [pendingAnswer, setPendingAnswer] = useState<string | null>(null);

    useEffect(() => {
        if (state !== SessionState.waiting_input) {
            setPendingAnswer(null);
        }
    }, [state]);

    const runtime = deriveMissionRuntime(context, state, uiState);
    const hasPendingEdits = pendingEditCount > 0;
    if (!alwaysVisible && !runtime.shouldShowPill && !hasPendingEdits) return null;

    const toneClass = hasPendingEdits ? 'text-amber-200/85'
        : runtime.tone === 'active' ? 'text-blue-300/75'
        : runtime.tone === 'waiting' ? 'text-amber-200/85'
        : runtime.tone === 'success' ? 'text-emerald-300/75'
        : runtime.tone === 'error' ? 'text-rose-300/80'
        : 'text-vscode-fg/45';
    const hasApproval = (context.pendingChoice && state === SessionState.waiting_input) ||
                       (context.pendingTool && state === SessionState.waiting_approval);
    const choices = context.pendingChoice?.choices || ['Allow', 'Decline'];
    const pendingId = context.pendingChoice?.id || context.pendingTool?.id;
    const statusLabel = hasPendingEdits ? 'Review' : runtime.pillLabel;
    const title = hasPendingEdits
        ? `Open Mission Dashboard · ${pendingEditCount} pending ${pendingEditCount === 1 ? 'edit' : 'edits'}`
        : currentToolName && runtime.hasActiveWork
        ? `Open Mission Dashboard · running ${currentToolName}`
        : runtime.title;

    return (
        <div className="pointer-events-auto">
            <div className="flex items-center gap-1.5">
                {/* Approval buttons (only when waiting) */}
                {hasApproval && !pendingAnswer && !inline && (
                    <div className="mr-1 flex items-center gap-1 animate-fade-in">
                        {choices.map((choice) => {
                            const label = choice.toLowerCase().includes('don\'t ask again') ? 'Always Allow' :
                                         choice.toLowerCase() === 'yes' ? 'Allow' :
                                         choice.toLowerCase() === 'allow' ? 'Allow' :
                                         choice.toLowerCase() === 'no' ? 'Decline' :
                                         choice.toLowerCase() === 'deny' ? 'Decline' :
                                         choice.toLowerCase() === 'decline' ? 'Decline' : choice;

                            const isPositive = label === 'Allow' || label === 'Always Allow';

                            return (
                                <button
                                    key={choice}
                                    onClick={() => {
                                        setPendingAnswer(choice);
                                        agentState.send({ type: 'submit_input' });
                                        postMessage({
                                            type: state === SessionState.waiting_approval ? 'permission_response' : 'permission_response',
                                            payload: { id: pendingId, answer: choice }
                                        });
                                    }}
                                    className={`rounded-md px-2.5 py-1 text-[10px] font-medium transition-colors ${
                                        isPositive
                                            ? 'bg-vscode-button-bg text-vscode-button-fg hover:bg-vscode-button-hover'
                                            : 'border border-vscode-border/40 bg-vscode-editor-background/70 text-white/60 hover:bg-vscode-list-hoverBackground hover:text-white/80'
                                    }`}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Processing spinner (after answering) */}
                {hasApproval && pendingAnswer && !inline && (
                    <span className="codicon codicon-loading codicon-modifier-spin text-[#e0e0e0]/30 text-[10px] mr-1.5" />
                )}

                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpenDashboard();
                    }}
                    className={missionWidgetButtonClass}
                    title={title}
                >
                    <span className={`codicon codicon-layout-sidebar-right text-[11px] transition-colors ${toneClass}`} />
                    <span className="inline min-w-0 truncate">{statusLabel}</span>
                </button>
            </div>
        </div>
    );
}
