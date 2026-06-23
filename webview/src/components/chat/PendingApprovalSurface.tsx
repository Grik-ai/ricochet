import { AlertTriangle } from 'lucide-react';
import { PermissionRequestPanel, type ChoiceOptionMetadata } from './PermissionRequestPanel';

export interface PendingApprovalRequest {
    id: string;
    question: string;
    choices?: string[];
    choiceMetadata?: ChoiceOptionMetadata[];
    kind?: 'permission' | 'choice';
}

interface PendingApprovalSurfaceProps {
    requests: PendingApprovalRequest[];
    onResponse: (id: string, answer: string) => void;
}

function approvalSurfaceTitle(count: number): string {
    if (count === 1) return 'Approval required';
    return `${count} approvals required`;
}

export function PendingApprovalSurface({ requests, onResponse }: PendingApprovalSurfaceProps) {
    if (requests.length === 0) return null;

    return (
        <div
            data-ricochet-pending-approval
            data-ricochet-permission-list
            tabIndex={-1}
            role="region"
            aria-live="assertive"
            aria-label="Pending Ricochet approval requests"
            className="mb-2 shrink-0 rounded-lg bg-amber-500/10 outline-none ring-1 ring-amber-400/20 focus:ring-amber-300/50"
        >
            <div className="px-3 py-2">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-amber-100/90">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>{approvalSurfaceTitle(requests.length)}</span>
                </div>
                <div className="overflow-hidden rounded-md bg-vscode-editor-background/80">
                    {requests.map(request => (
                        <PermissionRequestPanel
                            key={request.id}
                            request={request}
                            onResponse={onResponse}
                            inline
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
