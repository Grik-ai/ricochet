import { useState } from 'react';
import { FileText, Layout, CheckCircle2, ClipboardList, FileSearch } from 'lucide-react';

interface ArtifactCardProps {
    type: 'walkthrough' | 'implementation_plan' | 'task' | 'report' | 'other';
    title: string;
    summary: string;
    onOpen: () => void;
}

/**
 * ArtifactCard - Compact item for interacting with agent-generated files
 */
export function ArtifactCard({ type, title, summary, onOpen }: ArtifactCardProps) {

    const getIcon = () => {
        const cls = "w-3.5 h-3.5 opacity-60";
        switch (type) {
            case 'implementation_plan': return <Layout className={`${cls} text-blue-400`} />;
            case 'walkthrough': return <CheckCircle2 className={`${cls} text-green-400`} />;
            case 'task': return <ClipboardList className={`${cls} text-vscode-fg/45`} />;
            case 'report': return <FileSearch className={`${cls} text-cyan-400`} />;
            default: return <FileText className={`${cls} text-vscode-fg/40`} />;
        }
    };

    return (
        <div className="mb-2 overflow-hidden rounded-md border border-vscode-widget-border/60 bg-vscode-sideBar-background/35 transition-colors hover:bg-vscode-list-hoverBackground/40 group">
            <div className="flex items-center gap-2.5 px-2.5 py-2">
                <div className="w-7 h-7 rounded bg-vscode-editor-background flex items-center justify-center shrink-0 border border-vscode-widget-border/50">
                    {getIcon()}
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                        <h4 className="text-[11px] font-semibold text-vscode-fg/80 truncate">{title}</h4>
                        <span className="text-[9px] text-vscode-fg/35 shrink-0">Document</span>
                    </div>
                    <p className="text-[10px] text-vscode-fg/45 leading-relaxed truncate">
                        {summary}
                    </p>
                </div>
            </div>

            <div className="flex items-stretch border-t border-vscode-widget-border/45">
                <button
                    onClick={onOpen}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 hover:bg-vscode-list-hoverBackground text-vscode-fg/55 hover:text-vscode-fg text-[10px] font-semibold transition-colors"
                >
                    Open
                </button>
            </div>
        </div>
    );
}

interface TaskProgressCardProps {
    taskName: string;
    mode: 'planning' | 'execution' | 'verification';
    steps: string[];
    isActive: boolean;
}

/**
 * TaskProgressCard - Minimalist visualization of agent workflow state
 */
export function TaskProgressCard({ taskName, mode, steps, isActive }: TaskProgressCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    const modeColor = {
        planning: 'text-vscode-link-foreground',
        execution: 'text-vscode-fg/60',
        verification: 'text-vscode-fg/60',
    }[mode] || 'text-vscode-fg/50';

    const modeLabel = {
        planning: 'PLAN',
        execution: 'EXEC',
        verification: 'VERIFY',
    }[mode] || 'ACT';

    const lastStep = steps?.length ? steps[steps.length - 1] : '';

    return (
        <div className="my-1 p-0.5">
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-2 text-[11px] text-vscode-fg/50 hover:text-vscode-fg/75 transition-colors w-full group"
            >
                <div className="relative w-1.5 h-1.5 shrink-0">
                    <div className={`absolute inset-0 rounded-full ${isActive ? 'bg-vscode-button-bg' : 'bg-vscode-fg/25'}`} />
                    {isActive && <div className="absolute inset-0 rounded-full bg-vscode-button-bg animate-ping opacity-25" />}
                </div>

                <span className={`text-[9px] font-medium ${modeColor} shrink-0`}>{modeLabel}</span>
                <span className="text-[10.5px] font-medium text-vscode-fg/75 truncate">{taskName}</span>

                {!isExpanded && lastStep && isActive && (
                    <span className="text-[10px] text-vscode-fg/45 truncate ml-auto italic opacity-0 group-hover:opacity-100 transition-opacity">Current: {lastStep}</span>
                )}

                {steps?.length > 0 && (
                    <span className={`codicon codicon-chevron-right w-3 h-3 shrink-0 ml-auto text-vscode-fg/30 transition-transform ${isExpanded ? 'rotate-90 text-vscode-fg/55' : ''}`} />
                )}
            </button>

            {isExpanded && steps?.length > 0 && (
                <div className="mt-1.5 ml-[7px] border-l border-vscode-border pl-3 space-y-1 animate-in fade-in slide-in-from-left-1 duration-300">
                    {steps.map((step, i) => {
                        const isCurrent = i === steps.length - 1 && isActive;
                        return (
                            <div key={i} className="flex items-start gap-2 py-0.5 group/step">
                                {isCurrent ? (
                                    <div className="mt-1 w-3 h-3 flex items-center justify-center shrink-0">
                                        <div className="w-1.5 h-1.5 rounded-full bg-vscode-button-bg animate-pulse" />
                                    </div>
                                ) : (
                                    <span className="codicon codicon-check text-[10px] text-green-500/30 w-3 shrink-0 mt-0.5 group-hover/step:text-green-500/50 transition-colors" />
                                )}
                                <span className={`text-[10.5px] leading-relaxed ${isCurrent ? 'text-vscode-fg/80 font-medium' : 'text-vscode-fg/45'}`}>
                                    {step}
                                </span>
                            </div>
                        );
                    })}

                </div>
            )}
        </div>
    );
}

/**
 * InlineActivity - Compact status row
 */
export function InlineActivity({ activity, count }: { activity: string; count: number }) {
    return (
        <div className="flex items-center gap-2 py-0.5 text-[10px] text-vscode-fg/45">
            <div className="w-1 h-1 rounded-full bg-vscode-fg/25" />
            <span className="font-medium">{activity}</span>
            <span className="opacity-40 italic">{count} items</span>
        </div>
    );
}
