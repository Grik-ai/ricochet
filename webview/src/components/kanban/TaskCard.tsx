import { useState } from 'react';
import {
    ChevronDown,
    ChevronUp,
    CheckCircle2,
    User,
    Link as LinkIcon,
    Trash2
} from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { motion, AnimatePresence } from 'framer-motion';

export interface Subtask {
    id: string;
    title: string;
    status: string;
}

export interface Task {
    id: string;
    title: string;
    description?: string;
    status: string;
    priority: number;
    column?: string;
    assigned_to?: string;
    subtasks?: Subtask[];
    external_url?: string;
}

interface TaskCardProps {
    task: Task;
}

export function TaskCard({ task }: TaskCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const { postMessage } = useVSCodeApi();

    const priorityColors = [
        'bg-blue-500/20 text-blue-400',   // Low
        'bg-green-500/20 text-green-400', // Medium
        'bg-orange-500/20 text-orange-400', // High
        'bg-red-500/20 text-red-400'      // Critical
    ];

    const priorityNames = ['Low', 'Med', 'High', 'Crit'];

    const priorityBorderColors = [
        'border-l-blue-500/50',
        'border-l-green-500/50',
        'border-l-orange-500/50',
        'border-l-red-500/50'
    ];

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        postMessage({ type: 'delete_task_ui', payload: { taskId: task.id } });
    };

    const handleDragStart = (e: React.DragEvent) => {
        e.dataTransfer.setData('taskId', task.id);
    };

    return (
        <motion.div
            layout
            draggable
            onDragStart={handleDragStart as any}
            className={`group bg-vscode-list-background border border-vscode-border border-l-4 ${priorityBorderColors[task.priority] || priorityBorderColors[0]} rounded-sm p-2 mb-2 cursor-grab active:cursor-grabbing hover:border-vscode-focusBorder transition-all`}
        >
            <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-1.5">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-tighter ${priorityColors[task.priority] || priorityColors[0]}`}>
                        {priorityNames[task.priority] || 'Low'}
                    </span>
                    <span className="text-[10px] font-mono text-foreground/30">#{task.id}</span>
                </div>
                <button
                    onClick={handleDelete}
                    className="p-1 opacity-0 group-hover:opacity-100 hover:bg-error/10 hover:text-error rounded transition-all text-foreground/20"
                    title="Delete task"
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>

            <h3 className="text-xs font-semibold text-foreground/90 leading-tight mb-1 group-hover:text-blue-400 transition-colors">
                {task.title}
            </h3>

            {task.assigned_to && (
                <div className="flex items-center gap-1.5 mb-2 px-1.5 py-0.5 bg-foreground/5 rounded-full w-fit">
                    <User className="w-2.5 h-2.5 text-foreground/40" />
                    <span className="text-[9px] font-medium text-foreground/60 truncate max-w-[100px]">{task.assigned_to === 'user' ? 'You' : task.assigned_to}</span>
                </div>
            )}

            <div className="flex items-center justify-between mt-2 pt-2 border-t border-vscode-border/50">
                <div className="flex items-center gap-2">
                    {task.subtasks && task.subtasks.length > 0 && (
                        <div className="flex items-center gap-1 text-[10px] text-foreground/40">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>{task.subtasks.filter(s => s.status === 'done').length}/{task.subtasks.length}</span>
                        </div>
                    )}
                    {task.external_url && (
                        <a href={task.external_url} target="_blank" rel="noopener noreferrer" className="p-1 hover:bg-foreground/10 rounded transition-colors">
                            <LinkIcon className="w-3 h-3 text-foreground/40" />
                        </a>
                    )}
                </div>

                {task.description && (
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="p-0.5 hover:bg-foreground/10 rounded text-foreground/40 hover:text-foreground transition-all"
                    >
                        {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                )}
            </div>

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <p className="text-[11px] text-foreground/60 mt-2 leading-relaxed whitespace-pre-wrap">
                            {task.description}
                        </p>

                        {task.subtasks && task.subtasks.length > 0 && (
                            <div className="mt-3 space-y-1.5">
                                {task.subtasks.map(sub => (
                                    <div key={sub.id} className="flex items-center gap-2 group/sub text-left">
                                        <div className={`w-1 h-1 rounded-full ${sub.status === 'done' ? 'bg-green-500' : 'bg-foreground/20'}`} />
                                        <span className={`text-[10px] ${sub.status === 'done' ? 'text-foreground/40 line-through' : 'text-foreground/70'}`}>
                                            {sub.title}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}
