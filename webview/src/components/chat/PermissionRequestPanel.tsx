import React from 'react';

interface PermissionRequestPanelProps {
    request: {
        id: string;
        question: string;
        choices?: string[];
        choiceMetadata?: ChoiceOptionMetadata[];
        kind?: 'permission' | 'choice';
    };
    onResponse: (id: string, answer: string) => void;
    inline?: boolean; // When true, renders as chat message style
}

export interface ChoiceOptionMetadata {
    value: string;
    label?: string;
    description?: string;
    recommended?: boolean;
    danger?: boolean;
}

export interface ApprovalChoiceViewModel {
    value: string;
    label: string;
    description: string;
    primary: boolean;
    danger: boolean;
}

const GENERIC_CHOICE_DESCRIPTION = 'Send this decision to the agent.';

function normalizeChoiceText(choice: string): string {
    return choice.trim().toLowerCase();
}

function permissionChoiceLabel(choice: string): string {
    const normalized = normalizeChoiceText(choice);
    if (normalized === 'yes' || normalized === 'allow' || normalized === 'approve') return 'Approve';
    if (normalized === "yes, and don't ask again for this tool" || normalized === 'always allow') return 'Always allow';
    if (normalized === 'no' || normalized === 'deny' || normalized === 'reject') return 'Deny';
    if (normalized === 'proceed') return 'Proceed';
    return choice;
}

function permissionChoiceDescription(choice: string, metadata?: ChoiceOptionMetadata): string {
    const normalized = normalizeChoiceText(choice);
    if (metadata?.description && metadata.description !== GENERIC_CHOICE_DESCRIPTION && !/send this decision/i.test(metadata.description)) {
        return metadata.description;
    }
    if (normalized === "yes, and don't ask again for this tool" || normalized === 'always allow') {
        return 'Approve this action and stop asking for this tool category in this session.';
    }
    if (normalized === 'yes' || normalized === 'allow' || normalized === 'approve' || normalized === 'proceed') {
        return 'Approve this action once.';
    }
    if (normalized === 'no' || normalized === 'deny' || normalized === 'reject') {
        return 'Reject this action.';
    }
    return metadata?.description || GENERIC_CHOICE_DESCRIPTION;
}

function isPrimaryChoice(choice: string, metadata?: ChoiceOptionMetadata): boolean {
    if (metadata?.recommended !== undefined) return Boolean(metadata.recommended);
    const normalized = normalizeChoiceText(choice);
    return normalized === 'yes' || normalized === 'allow' || normalized === 'approve' || normalized === 'always allow' || normalized === 'proceed';
}

function isDangerChoice(choice: string, metadata?: ChoiceOptionMetadata): boolean {
    if (metadata?.danger !== undefined) return Boolean(metadata.danger);
    const normalized = normalizeChoiceText(choice);
    return normalized === 'no' || normalized === 'deny' || normalized === 'reject';
}

export function approvalChoiceViewModels(request: PermissionRequestPanelProps['request']): ApprovalChoiceViewModel[] {
    const choices = request.choices?.length ? request.choices : ['Yes', 'Always Allow', 'No'];
    return choices.map((choice, index) => {
        const metadata = request.choiceMetadata?.find(item => item.value === choice) || request.choiceMetadata?.[index];
        const value = metadata?.value || choice;
        const label = permissionChoiceLabel(metadata?.label || choice);
        return {
            value,
            label,
            description: permissionChoiceDescription(choice, metadata),
            primary: isPrimaryChoice(choice, metadata),
            danger: isDangerChoice(choice, metadata),
        };
    });
}

export const PermissionRequestPanel: React.FC<PermissionRequestPanelProps> = ({ request, onResponse, inline = false }) => {
    const q = request?.question || '';
    const lines = q.split('\n').map(line => line.trimEnd());
    const hasStructuredTitle = lines.length > 1 && lines[0].trim().length > 0;
    const title = hasStructuredTitle ? lines[0].trim() : 'Approval Required';
    const description = hasStructuredTitle
        ? lines.slice(1).join('\n').trim()
        : q.trim();
    const choices = approvalChoiceViewModels(request);

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
                                key={choice.value}
                                onClick={() => onResponse(request.id, choice.value)}
                                aria-label={`${choice.label}: ${choice.description}`}
                                className={[
                                    'px-3 py-1.5 text-xs rounded-md transition-colors',
                                    choice.primary
                                        ? 'bg-blue-600 hover:bg-blue-700 text-white'
                                        : choice.danger
                                            ? 'bg-red-600 hover:bg-red-700 text-white'
                                            : 'bg-vscode-button-secondaryBackground hover:bg-vscode-button-secondaryHoverBackground text-vscode-button-secondaryForeground'
                                ].join(' ')}
                                title={choice.description}
                            >
                                {choice.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
