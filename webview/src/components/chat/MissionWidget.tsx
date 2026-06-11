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
}

export const missionWidgetButtonClass = 'group inline-flex h-6 items-center gap-1.5 rounded px-1.5 text-[10px] font-medium text-vscode-fg/50 transition-colors hover:bg-vscode-toolbar-hover hover:text-vscode-fg/80';

export function MissionWidget({ agentState, onOpenDashboard, currentToolName, inline = false }: MissionWidgetProps) {
    const { postMessage } = useVSCodeApi();
    const { state, context, uiState } = agentState;
    const [pendingAnswer, setPendingAnswer] = useState<string | null>(null);

    useEffect(() => {
        if (state !== SessionState.waiting_input) {
            setPendingAnswer(null);
        }
    }, [state]);

    const runtime = deriveMissionRuntime(context, state, uiState);
    if (!runtime.shouldShowPill) return null;

    // Determine dot color
    const dotColor = runtime.tone === 'active' ? 'bg-blue-400'
        : runtime.tone === 'waiting' ? 'bg-amber-300'
        : runtime.tone === 'success' ? 'bg-green-400'
        : runtime.tone === 'error' ? 'bg-red-400'
        : 'bg-[#e0e0e0]/30';

    const isPinging = runtime.tone === 'active' && runtime.hasActiveWork;
    const hasApproval = (context.pendingChoice && state === SessionState.waiting_input) ||
                       (context.pendingTool && state === SessionState.waiting_approval);
    const choices = context.pendingChoice?.choices || ['Allow', 'Decline'];
    const pendingId = context.pendingChoice?.id || context.pendingTool?.id;
    const statusLabel = runtime.pillLabel;
    const title = currentToolName && runtime.hasActiveWork
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
                    <span className="relative h-2.5 w-2.5 shrink-0">
                        <span className={`absolute inset-0 rounded-full ${dotColor} transition-colors`} />
                        {isPinging && <span className={`absolute inset-0 rounded-full ${dotColor} animate-ping opacity-40`} />}
                    </span>
                    <span className="hidden sm:inline">{statusLabel}</span>
                    <span className="codicon codicon-layout-sidebar-right text-[11px] text-vscode-fg/30 group-hover:text-vscode-fg/60 transition-colors" />
                </button>
            </div>
        </div>
    );
}
