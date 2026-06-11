import { Todo } from '@hooks/useChat';

interface TodoTrackerProps {
    todos: Todo[];
}

/**
 * Visualizes the agent's task list and progress.
 */
export function TodoTracker({ todos }: TodoTrackerProps) {
    if (todos.length === 0) return null;

    const completed = todos.filter(t => t.status === 'completed' || t.status === 'cancelled').length;
    const percent = Math.round((completed / todos.length) * 100);

    return (
        <div className="mx-3 my-2 p-3 bg-vscode-editor-background border border-vscode-border rounded-lg shadow-sm">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-vscode-fg/40">Plan & Progress</span>
                </div>
                <span className="text-[10px] font-bold text-ricochet-primary bg-ricochet-primary/10 px-1.5 py-0.5 rounded">
                    {percent}%
                </span>
            </div>

            <div className="w-full h-1 bg-vscode-border rounded-full overflow-hidden mb-3">
                <div
                    className="h-full bg-ricochet-primary transition-all duration-500 ease-out"
                    style={{ width: `${percent}%` }}
                />
            </div>

            <div className="space-y-2">
                {todos.map((todo, i) => (
                    <div key={i} className="flex items-start gap-2.5">
                        <div className="mt-0.5 shrink-0 text-[10px] font-black">
                            {todo.status === 'completed' ? (
                                <span className="text-green-500">DONE</span>
                            ) : todo.status === 'cancelled' ? (
                                <span className="text-vscode-fg/25">SKIP</span>
                            ) : todo.status === 'current' ? (
                                <span className="text-ricochet-primary animate-pulse">BUSY</span>
                            ) : (
                                <span className="text-vscode-fg/20">WAIT</span>
                            )}
                        </div>
                        <span className={`text-[11px] leading-relaxed transition-colors ${todo.status === 'completed' || todo.status === 'cancelled' ? 'text-vscode-fg/40 line-through' :
                            todo.status === 'current' ? 'text-vscode-fg font-medium' :
                                'text-vscode-fg/60'
                            }`}>
                            {todo.text}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
