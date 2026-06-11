import { useEffect, useRef } from 'react';
import { Activity, AlertCircle, BellRing, CheckCircle2, Circle, Info, Radio, Terminal } from 'lucide-react';
import { SessionState, AgentLogEntry } from '../../services/state-machine/sessionStateMachine';

interface AgentLogProps {
    logs: AgentLogEntry[];
    state: SessionState;
    pendingToolId?: string;
    pendingChoiceId?: string;
    onResponse?: (id: string, answer: string) => void;
}

export function AgentLog({ logs, state, pendingToolId, pendingChoiceId, onResponse }: AgentLogProps) {
    const endRef = useRef<HTMLDivElement>(null);
    const visibleLogs = compactRepeatedStatusChecks(compactRepeatedReads(logs
        .map((log) => ({ ...log, content: stripReasoningBlocks(log.content) }))
        .filter((log) => log.content.trim().length > 0)
        .filter((log) => !isLowSignalToolResult(log))));

    useEffect(() => {
        const timeout = setTimeout(() => {
            endRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 80);
        return () => clearTimeout(timeout);
    }, [visibleLogs.length]);

    return (
        <div className="flex h-full min-h-0 flex-col overflow-y-auto px-3 py-2 text-[12px]">
            {visibleLogs.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[11px] text-foreground/35">
                    Waiting for mission events...
                </div>
            ) : (
                <div className="space-y-0.5">
                    {visibleLogs.map((log) => (
                        <LogRow
                            key={log.id}
                            log={log}
                            state={state}
                            pendingToolId={pendingToolId}
                            pendingChoiceId={pendingChoiceId}
                            onResponse={onResponse}
                        />
                    ))}
                </div>
            )}
            <div ref={endRef} />
        </div>
    );
}

function LogRow({
    log,
    state,
    pendingToolId,
    pendingChoiceId,
    onResponse,
}: {
    log: AgentLogEntry;
    state: SessionState;
    pendingToolId?: string;
    pendingChoiceId?: string;
    onResponse?: (id: string, answer: string) => void;
}) {
    const meta = getLogMeta(log);
    const choices = log.metadata?.choices as string[] | undefined;
    const isPendingChoice = state === SessionState.waiting_input && log.metadata?.id === pendingChoiceId;
    const isPendingTool = state === SessionState.waiting_approval && log.metadata?.toolId === pendingToolId;

    return (
        <div className="relative flex gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-list-background-hover/30">
            <div className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded text-foreground/45">
                {meta.icon}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2">
                    <span className={`shrink-0 text-[10px] font-medium ${meta.color}`}>{meta.label}</span>
                    <span className={`min-w-0 truncate leading-5 ${meta.textClass}`}>{summarizeContent(log)}</span>
                    <span className="ml-auto shrink-0 font-mono text-[9px] text-foreground/30">
                        {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                </div>
                {log.type === 'tool_started' && log.metadata?.args && (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-foreground/35">
                        {formatToolArgs(log.metadata.args)}
                    </div>
                )}
                {(isPendingChoice || isPendingTool) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {(choices?.length ? choices : ['Allow', 'Deny']).map((choice, i) => (
                            <button
                                key={choice}
                                onClick={() => onResponse?.(log.metadata?.id || log.metadata?.toolId, choice)}
                                className={`rounded px-2.5 py-1 text-[10px] font-medium transition-colors ${
                                    i === 0
                                        ? 'bg-button-background text-button-foreground hover:bg-button-background-hover'
                                        : 'bg-vscode-widget-border/20 text-foreground/60 hover:bg-vscode-widget-border/40 hover:text-foreground'
                                }`}
                            >
                                {choice}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function getLogMeta(log: AgentLogEntry) {
    switch (log.type) {
        case 'assistant_text':
            return { label: 'Agent', color: 'text-foreground/45', textClass: 'text-foreground/75', icon: <Info size={12} /> };
        case 'tool_started':
            return { label: 'Tool', color: 'text-blue-400/70', textClass: 'text-foreground/70', icon: <Terminal size={12} /> };
        case 'tool_finished':
            return { label: 'Done', color: 'text-emerald-400/70', textClass: 'text-foreground/55', icon: <CheckCircle2 size={12} /> };
        case 'status_check':
            return { label: 'Worker', color: 'text-foreground/35', textClass: 'text-foreground/45', icon: <Radio size={12} /> };
        case 'worker_spawned':
            return { label: 'Queued', color: 'text-blue-400/70', textClass: 'text-foreground/70', icon: <Circle size={11} /> };
        case 'worker_running':
            return { label: 'Running', color: 'text-button-background', textClass: 'text-foreground/80', icon: <Activity size={12} /> };
        case 'worker_completed':
            return { label: 'Worker done', color: 'text-emerald-400/75', textClass: 'text-foreground/70', icon: <CheckCircle2 size={12} /> };
        case 'mission_completed':
            return { label: 'Mission done', color: 'text-emerald-400/80', textClass: 'text-foreground/80 font-medium', icon: <CheckCircle2 size={12} /> };
        case 'mission_timed_out':
            return { label: 'Timed out', color: 'text-yellow-400/80', textClass: 'text-foreground/75', icon: <AlertCircle size={12} /> };
        case 'mission_failed':
        case 'error':
            return { label: 'Error', color: 'text-red-400', textClass: 'text-red-300/90', icon: <AlertCircle size={12} /> };
        case 'permission_requested':
        case 'choice':
            return { label: 'Waiting', color: 'text-blue-400/80', textClass: 'text-foreground/80', icon: <BellRing size={12} /> };
        default:
            return { label: 'Event', color: 'text-foreground/40', textClass: 'text-foreground/65', icon: <Info size={12} /> };
    }
}

function summarizeContent(log: AgentLogEntry): string {
    if (log.type === 'status_check') return log.content.replace(/^Checked worker /, 'Checked ');
    if (log.type === 'tool_finished') return firstLine(log.content).slice(0, 180);
    return firstLine(log.content);
}

function firstLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function formatToolArgs(args: any): string {
    if (!args || typeof args !== 'object') return '';
    const target = args.path || args.file || args.command || args.query || args.pattern || args.id || args.description || args.goal;
    if (!target) return '';
    return String(target);
}

function isLowSignalToolResult(log: AgentLogEntry): boolean {
    return log.type === 'tool_finished' && /^(Tool completed|ok|✅ Note .* saved to shared scratchpad\.)$/i.test(log.content.trim());
}

function compactRepeatedReads(logs: AgentLogEntry[]): AgentLogEntry[] {
    const compacted: AgentLogEntry[] = [];
    let readGroup: AgentLogEntry[] = [];

    const flushReads = () => {
        if (readGroup.length === 0) return;
        if (readGroup.length < 4) {
            compacted.push(...readGroup);
        } else {
            compacted.push({
                ...readGroup[readGroup.length - 1],
                id: `read-group-${readGroup[0].id}-${readGroup.length}`,
                type: 'tool_started',
                content: `Read ${readGroup.length} files`,
                metadata: { grouped: readGroup },
            });
        }
        readGroup = [];
    };

    logs.forEach((log) => {
        if (log.type === 'tool_started' && /^Reading /i.test(log.content)) {
            readGroup.push(log);
            return;
        }
        flushReads();
        compacted.push(log);
    });
    flushReads();

    return compacted;
}

function compactRepeatedStatusChecks(logs: AgentLogEntry[]): AgentLogEntry[] {
    const seen = new Set<string>();
    return logs.filter((log) => {
        if (log.type !== 'status_check') return true;
        const workerId = log.metadata?.workerId || log.content;
        if (seen.has(workerId)) return false;
        seen.add(workerId);
        return true;
    });
}

function stripReasoningBlocks(text: string): string {
    return text
        .replace(/<(?:thinking|think)>[\s\S]*?(?:<\/(?:thinking|think)>|$)/gi, '')
        .replace(/<(?:thinking|think)\b[\s\S]*$/gi, '')
        .replace(/^\s*(?:thinking|think)>?[\s\S]*$/gi, '')
        .trim();
}
