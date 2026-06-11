import { useState } from 'react';
import { Plus, Send } from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';

export function QuickAddTask() {
    const [title, setTitle] = useState('');
    const [priority, setPriority] = useState(1);
    const { postMessage } = useVSCodeApi();

    const handleAdd = () => {
        if (!title.trim()) return;
        postMessage({
            type: 'create_task_ui',
            payload: {
                title: title.trim(),
                description: '',
                priority: priority
            }
        });
        setTitle('');
    };

    return (
        <div className="flex items-center gap-2 p-2 bg-vscode-editor-background border-b border-vscode-border shrink-0">
            <div className="relative flex-1">
                <Plus className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-foreground/40" />
                <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                    placeholder="Quick add task..."
                    className="w-full bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded py-1 pl-8 pr-2 text-xs focus:outline-none focus:border-vscode-focusBorder placeholder:text-foreground/30"
                />
            </div>
            <select
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value))}
                className="bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded px-1 py-1 text-[10px] focus:outline-none focus:border-vscode-focusBorder cursor-pointer"
            >
                <option value={0}>Low</option>
                <option value={1}>Med</option>
                <option value={2}>High</option>
                <option value={3}>Crit</option>
            </select>
            <button
                onClick={handleAdd}
                disabled={!title.trim()}
                className="p-1.5 bg-vscode-button-background text-vscode-button-foreground rounded hover:bg-vscode-button-hover transition-colors disabled:opacity-50"
            >
                <Send className="w-3.5 h-3.5" />
            </button>
        </div>
    );
}
