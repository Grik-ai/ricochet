import React from 'react';

interface PermissionRequestPanelProps {
    request: {
        id: string;
        question: string;
        choices?: string[];
        kind?: 'permission' | 'choice';
    };
    onResponse: (id: string, answer: string) => void;
    inline?: boolean; // When true, renders as chat message style
}

export const PermissionRequestPanel: React.FC<PermissionRequestPanelProps> = ({ request, onResponse, inline = false }) => {
    const q = request?.question || '';
    const lines = q.split('\n').map(line => line.trimEnd());
    const hasStructuredTitle = lines.length > 1 && lines[0].trim().length > 0;
    const title = hasStructuredTitle ? lines[0].trim() : 'Approval Required';
    const description = hasStructuredTitle
        ? lines.slice(1).join('\n').trim()
        : q.trim();
    const choices = request.choices?.length ? request.choices : ['Yes', 'Always Allow', 'No'];

    const formatChoiceLabel = (choice: string) => {
        const normalized = choice.toLowerCase();
        if (normalized === 'yes' || normalized === 'allow') return 'Allow';
        if (normalized === 'always allow') return 'Always Allow';
        if (normalized === 'no' || normalized === 'deny') return 'Deny';
        if (normalized === 'proceed') return 'Proceed';
        return choice;
    };

    const isPrimaryChoice = (choice: string) => {
        const normalized = choice.toLowerCase();
        return normalized === 'yes' || normalized === 'allow' || normalized === 'always allow' || normalized === 'proceed';
    };

    const isDangerChoice = (choice: string) => {
        const normalized = choice.toLowerCase();
        return normalized === 'no' || normalized === 'deny';
    };

    const containerClass = inline
        ? "py-4 px-6 bg-vscode-sideBar-background/50 border-y border-blue-500/20 animate-fade-in"
        : "mx-4 mb-4 p-4 rounded-lg bg-vscode-input-background border border-vscode-focusBorder shadow-lg animate-in fade-in slide-in-from-bottom-2";

    return (
        <div className={containerClass}>
            <div className="flex items-start gap-3">
                <div className="text-blue-400 mt-1">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                </div>
                <div className="flex-1">
                    {hasStructuredTitle && (
                        <h3 className="text-sm font-semibold text-vscode-fg mb-1">{title}</h3>
                    )}
                    <div className="text-xs text-vscode-fg/85 mb-3 font-mono whitespace-pre-wrap leading-relaxed">
                        {description}
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {choices.map((choice) => (
                            <button
                                key={choice}
                                onClick={() => onResponse(request.id, choice)}
                                className={[
                                    'px-3 py-1.5 text-xs rounded-md transition-colors',
                                    isPrimaryChoice(choice)
                                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                                        : isDangerChoice(choice)
                                            ? 'bg-red-600 hover:bg-red-700 text-white'
                                            : 'bg-vscode-button-secondaryBackground hover:bg-vscode-button-secondaryHoverBackground text-vscode-button-secondaryForeground'
                                ].join(' ')}
                            >
                                {formatChoiceLabel(choice)}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
