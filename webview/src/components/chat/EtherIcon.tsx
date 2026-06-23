export function EtherIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            aria-hidden="true"
            focusable="false"
        >
            <rect x="3" y="9" width="2.4" height="6" rx="1.2" fill="currentColor" opacity="0.56" />
            <rect x="7.4" y="6" width="2.4" height="12" rx="1.2" fill="currentColor" opacity="0.76" />
            <rect x="11.8" y="3.5" width="2.4" height="17" rx="1.2" fill="currentColor" />
            <rect x="16.2" y="6" width="2.4" height="12" rx="1.2" fill="currentColor" opacity="0.76" />
            <rect x="20.6" y="9" width="2.4" height="6" rx="1.2" fill="currentColor" opacity="0.56" />
        </svg>
    );
}
