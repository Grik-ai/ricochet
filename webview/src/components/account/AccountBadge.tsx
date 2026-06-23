import { UserCircle } from 'lucide-react';
import type { GrikAccountController, GrikAccountTone } from '../../hooks/useGrikAccount';

type AccountBadgeProps = {
    account: GrikAccountController;
    onOpenAccount: () => void;
    compact?: boolean;
    className?: string;
};

const TONE_CLASS: Record<GrikAccountTone, string> = {
    idle: 'text-vscode-fg/58 hover:bg-vscode-list-hoverBackground/50 hover:text-vscode-fg/86',
    info: 'text-vscode-fg/64 hover:bg-vscode-list-hoverBackground/50 hover:text-vscode-fg/88',
    success: 'text-vscode-fg/68 hover:bg-vscode-list-hoverBackground/50 hover:text-vscode-fg/90',
    warning: 'text-amber-200/82 hover:bg-vscode-list-hoverBackground/50 hover:text-amber-100',
    danger: 'text-rose-200/82 hover:bg-vscode-list-hoverBackground/50 hover:text-rose-100',
};

export function AccountBadge({ account, onOpenAccount, compact = false, className = '' }: AccountBadgeProps) {
    const { summary, isBusy, deviceAuth } = account;
    const detail = deviceAuth
        ? 'Finish Grik sign in in your browser'
        : summary.detail;
    const label = deviceAuth
        ? 'Signing in'
        : summary.label;
    const showAction = !compact && !deviceAuth && summary.actionLabel;

    return (
        <button
            type="button"
            onClick={onOpenAccount}
            title={detail}
            aria-label={`Open Grik account: ${label}`}
            className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-[10.5px] font-medium transition-colors ${TONE_CLASS[summary.tone]} ${className}`}
        >
            <UserCircle className={`h-3.5 w-3.5 shrink-0 ${isBusy ? 'animate-pulse' : ''}`} />
            <span className="truncate">{label}</span>
            {showAction && (
                <span className="hidden sm:inline text-vscode-fg/42">
                    {summary.actionLabel}
                </span>
            )}
        </button>
    );
}
