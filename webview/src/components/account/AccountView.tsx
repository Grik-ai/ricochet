import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, LogOut, RefreshCw, UserCircle, Wallet } from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';

type AuthUser = {
    id?: string;
    email?: string;
    name?: string;
};

type AuthState = {
    authenticated: boolean;
    user?: AuthUser | null;
    expiresAt?: number | null;
    apiBaseUrl?: string;
    webBaseUrl?: string;
};

type DeviceAuthState = {
    userCode: string;
    verificationUrl: string;
    expiresAt?: number;
    interval?: number;
};

type CreditBalance = {
    product: string;
    balance: number;
    updatedAt?: string;
};

type Entitlement = {
    product: string;
    plan?: string;
    status?: string;
    currentPeriodEnd?: string;
};

type BillingState = {
    credits?: CreditBalance[];
    entitlements?: Entitlement[];
};

type AccountViewProps = {
    onBack: () => void;
};

export function AccountView({ onBack }: AccountViewProps) {
    const { postMessage, onMessage } = useVSCodeApi();
    const [authState, setAuthState] = useState<AuthState>({ authenticated: false });
    const [billingState, setBillingState] = useState<BillingState>({});
    const [deviceAuth, setDeviceAuth] = useState<DeviceAuthState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isBusy, setIsBusy] = useState(false);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            switch (message.type) {
                case 'auth_state':
                    setAuthState((message.payload || { authenticated: false }) as AuthState);
                    setIsBusy(false);
                    break;
                case 'billing_state':
                    setBillingState((message.payload || {}) as BillingState);
                    break;
                case 'device_auth_started':
                    setDeviceAuth((message.payload || null) as DeviceAuthState | null);
                    setError(null);
                    setIsBusy(false);
                    break;
                case 'device_auth_complete':
                    setDeviceAuth(null);
                    setError(null);
                    setIsBusy(false);
                    break;
                case 'device_auth_failed':
                    setDeviceAuth(null);
                    setError(((message.payload as { error?: string })?.error) || 'Sign in failed.');
                    setIsBusy(false);
                    break;
            }
        });

        postMessage({ type: 'auth_refresh' });
        return () => { unsubscribe(); };
    }, [onMessage, postMessage]);

    const ricochetCredits = useMemo(
        () => billingState.credits?.find(item => item.product === 'ricochet_code') || null,
        [billingState.credits]
    );
    const videoCredits = useMemo(
        () => billingState.credits?.find(item => item.product === 'video') || null,
        [billingState.credits]
    );

    const signIn = () => {
        setIsBusy(true);
        setError(null);
        postMessage({ type: 'auth_login' });
    };

    const cancelSignIn = () => {
        setIsBusy(false);
        setDeviceAuth(null);
        postMessage({ type: 'auth_cancel' });
    };

    const refresh = () => {
        setIsBusy(true);
        postMessage({ type: 'auth_refresh' });
    };

    const logout = () => {
        setIsBusy(true);
        setBillingState({});
        postMessage({ type: 'auth_logout' });
    };

    return (
        <div className="h-full flex flex-col bg-vscode-editor-background text-vscode-fg">
            <div className="h-11 px-3 border-b border-vscode-border flex items-center justify-between gap-3">
                <button
                    onClick={onBack}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-vscode-list-hoverBackground text-vscode-fg/75 transition-colors"
                    title="Back"
                    aria-label="Back"
                >
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="text-[12px] font-medium text-vscode-fg/80">Grik account</div>
                <button
                    onClick={refresh}
                    disabled={isBusy}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-vscode-list-hoverBackground text-vscode-fg/65 disabled:opacity-50 transition-colors"
                    title="Refresh account"
                    aria-label="Refresh account"
                >
                    <RefreshCw className={`w-4 h-4 ${isBusy ? 'animate-spin' : ''}`} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                <div className="max-w-2xl mx-auto space-y-4">
                    {error && (
                        <div className="rounded-md border border-vscode-errorForeground/35 bg-vscode-input-bg px-3 py-2 text-[12px] text-vscode-errorForeground">
                            {error}
                        </div>
                    )}

                    {!authState.authenticated && !deviceAuth && (
                        <section className="rounded-md border border-vscode-border bg-vscode-input-bg p-4">
                            <div className="flex items-start gap-3">
                                <UserCircle className="w-5 h-5 text-vscode-fg/60 mt-0.5 shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <h2 className="text-[14px] font-semibold text-vscode-fg/90">Sign in to Grik</h2>
                                    <p className="mt-1 text-[12px] leading-5 text-vscode-fg/58">
                                        Use your Grik account to manage Ricochet Code credits and subscriptions.
                                    </p>
                                    <button
                                        onClick={signIn}
                                        disabled={isBusy}
                                        className="mt-4 h-8 px-3 inline-flex items-center gap-2 rounded-md bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground text-[12px] font-medium disabled:opacity-50 transition-colors"
                                    >
                                        <ExternalLink className="w-3.5 h-3.5" />
                                        Sign in with Grik
                                    </button>
                                </div>
                            </div>
                        </section>
                    )}

                    {deviceAuth && (
                        <section className="rounded-md border border-vscode-border bg-vscode-input-bg p-4">
                            <div className="text-[11px] uppercase tracking-wide text-vscode-fg/45 font-medium">Device login</div>
                            <div className="mt-3 rounded-md border border-vscode-border bg-vscode-editor-background px-3 py-3 font-mono text-[22px] tracking-[0.18em] text-vscode-fg/90 text-center">
                                {deviceAuth.userCode}
                            </div>
                            <div className="mt-3 text-[12px] leading-5 text-vscode-fg/58 break-all">
                                {deviceAuth.verificationUrl}
                            </div>
                            <div className="mt-4 flex items-center gap-2">
                                <button
                                    onClick={() => postMessage({ type: 'open_external', payload: { url: deviceAuth.verificationUrl } })}
                                    className="h-8 px-3 inline-flex items-center gap-2 rounded-md bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground text-[12px] font-medium transition-colors"
                                >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                    Open browser
                                </button>
                                <button
                                    onClick={cancelSignIn}
                                    className="h-8 px-3 rounded-md border border-vscode-border hover:bg-vscode-list-hoverBackground text-[12px] text-vscode-fg/75 transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </section>
                    )}

                    {authState.authenticated && (
                        <>
                            <section className="rounded-md border border-vscode-border bg-vscode-input-bg p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-start gap-3 min-w-0">
                                        <UserCircle className="w-5 h-5 text-vscode-fg/65 mt-0.5 shrink-0" />
                                        <div className="min-w-0">
                                            <div className="text-[14px] font-semibold text-vscode-fg/90 truncate">
                                                {authState.user?.name || authState.user?.email || 'Grik account'}
                                            </div>
                                            {authState.user?.email && (
                                                <div className="mt-0.5 text-[12px] text-vscode-fg/50 truncate">{authState.user.email}</div>
                                            )}
                                        </div>
                                    </div>
                                    <button
                                        onClick={logout}
                                        className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-vscode-list-hoverBackground text-vscode-fg/65 transition-colors"
                                        title="Log out"
                                        aria-label="Log out"
                                    >
                                        <LogOut className="w-4 h-4" />
                                    </button>
                                </div>
                            </section>

                            <section className="rounded-md border border-vscode-border bg-vscode-input-bg p-4">
                                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-vscode-fg/45 font-medium">
                                    <Wallet className="w-3.5 h-3.5" />
                                    Credits
                                </div>
                                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <CreditRow label="Ricochet Code" balance={ricochetCredits?.balance} />
                                    <CreditRow label="Video" balance={videoCredits?.balance} />
                                </div>
                                {billingState.entitlements && billingState.entitlements.length > 0 && (
                                    <div className="mt-3 space-y-1">
                                        {billingState.entitlements.map((item) => (
                                            <div key={`${item.product}-${item.plan}-${item.status}`} className="text-[12px] text-vscode-fg/55">
                                                {item.product}: {item.plan || 'plan'} - {item.status || 'active'}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="mt-4 flex flex-wrap items-center gap-2">
                                    <button
                                        onClick={() => postMessage({ type: 'open_billing', payload: { target: 'dashboard' } })}
                                        className="h-8 px-3 inline-flex items-center gap-2 rounded-md border border-vscode-border hover:bg-vscode-list-hoverBackground text-[12px] text-vscode-fg/75 transition-colors"
                                    >
                                        <ExternalLink className="w-3.5 h-3.5" />
                                        Dashboard
                                    </button>
                                    <button
                                        onClick={() => postMessage({ type: 'open_billing', payload: { target: 'credits', product: 'ricochet_code' } })}
                                        className="h-8 px-3 rounded-md bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground text-[12px] font-medium transition-colors"
                                    >
                                        Add credits
                                    </button>
                                </div>
                            </section>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function CreditRow({ label, balance }: { label: string; balance?: number }) {
    return (
        <div className="rounded-md border border-vscode-border bg-vscode-editor-background px-3 py-3">
            <div className="text-[11px] text-vscode-fg/45">{label}</div>
            <div className="mt-1 text-[18px] font-semibold text-vscode-fg/90">
                {typeof balance === 'number' ? formatCredits(balance) : '0'}
            </div>
        </div>
    );
}

function formatCredits(value: number) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}
