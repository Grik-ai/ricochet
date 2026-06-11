import { useEffect, useState } from 'react';
import { Task, TaskCard } from './TaskCard';
import { QuickAddTask } from './QuickAddTask';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';

export function KanbanBoard() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const { postMessage, onMessage } = useVSCodeApi();

    useEffect(() => {
        // Request initial tasks
        postMessage({ type: 'get_tasks' });

        return onMessage((msg: any) => {
            if (msg.type === 'tasks_updated') {
                const tasksArray = Array.isArray(msg.payload)
                    ? msg.payload
                    : (msg.payload?.tasks || []);
                setTasks(tasksArray);
            }
        });
    }, [postMessage, onMessage]);

    const columns = [
        { id: 'backlog', title: 'Backlog' },
        { id: 'in_progress', title: 'In Progress' },
        { id: 'review', title: 'Review' },
        { id: 'done', title: 'Done' },
        { id: 'deferred', title: 'Deferred' }
    ];

    const handleDrop = (e: React.DragEvent, column: string) => {
        e.preventDefault();
        const taskId = e.dataTransfer.getData('taskId');
        if (taskId) {
            postMessage({
                type: 'move_task_column',
                payload: { taskId, column }
            });
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    return (
        <div className="h-full flex flex-col bg-vscode-sidebar-background overflow-hidden">
            <QuickAddTask />

            <div className="flex-1 overflow-x-auto overflow-y-hidden">
                <div className="flex h-full p-2 gap-3 min-w-[1000px]">
                    {columns.map(col => (
                        <div
                            key={col.id}
                            onDrop={(e) => handleDrop(e, col.id)}
                            onDragOver={handleDragOver}
                            className="flex-1 flex flex-col min-w-[200px] max-w-[300px]"
                        >
                            <div className="flex items-center justify-between px-2 mb-2">
                                <h3 className="text-[10px] font-bold uppercase tracking-widest text-foreground/40">
                                    {col.title}
                                </h3>
                                <span className="text-[10px] px-1.5 py-0.5 bg-foreground/5 rounded-full text-foreground/40 font-mono">
                                    {tasks.filter(t => (t.column || (t.status === 'done' ? 'done' : 'backlog')) === col.id).length}
                                </span>
                            </div>

                            <div className="flex-1 overflow-y-auto pr-1 overflow-x-hidden scrollbar-thin scrollbar-thumb-vscode-border">
                                {tasks
                                    .filter(t => (t.column || (t.status === 'done' ? 'done' : 'backlog')) === col.id)
                                    .map(task => (
                                        <TaskCard
                                            key={task.id}
                                            task={task}
                                        />
                                    ))}
                                {tasks.filter(t => (t.column || (t.status === 'done' ? 'done' : 'backlog')) === col.id).length === 0 && (
                                    <div className="h-20 border-2 border-dashed border-vscode-border/30 rounded flex items-center justify-center">
                                        <span className="text-[10px] text-foreground/20 italic">Drop here</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
