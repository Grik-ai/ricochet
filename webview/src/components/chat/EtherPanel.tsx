import { Wifi, WifiOff, ChevronUp, ChevronDown, Server } from 'lucide-react';
import { useState } from 'react';
import { EtherIcon } from './EtherIcon';

export type EtherStage = 'idle' | 'listening' | 'processing' | 'responding' | 'receiving';

export interface EtherChannelStatus {
    configured: boolean;
    active: boolean;
    label: string;
    owner?: string;
    error?: string;
}

export interface EtherStatus {
    enabled: boolean;
    connectedVia?: 'telegram' | 'discord' | string | null;
    lastActivity?: string;
    sessionId?: string;
    stage?: EtherStage;
    lastMessage?: string;
    isVoiceReady?: boolean;
    isDaemon?: boolean;
    channels?: Record<'telegram' | 'discord' | string, EtherChannelStatus>;
    lastSource?: 'telegram' | 'discord' | string | null;
    allowRemoteSessionStart?: boolean;
}

interface EtherPanelProps {
    status: EtherStatus;
    isMinimized?: boolean;
    onToggleMinimize?: () => void;
    onToggleLiveMode?: (enabled: boolean) => void;
}

const STAGE_CONFIG: Record<EtherStage, { icon: React.ReactNode; text: string; color: string }> = {
    idle: {
        icon: <EtherIcon className="w-4 h-4" />,
        text: 'Waiting for sent message...',
        color: 'text-blue-400/60',
    },
    receiving: {
        icon: <EtherIcon className="w-4 h-4 animate-bounce" />,
        text: 'Receiving message...',
        color: 'text-blue-400',
    },
    listening: {
        icon: <EtherIcon className="w-4 h-4 animate-pulse" />,
        text: 'Listening to voice...',
        color: 'text-blue-400',
    },
    processing: {
        icon: <EtherIcon className="w-4 h-4 animate-spin" />,
        text: 'Processing...',
        color: 'text-blue-300',
    },
    responding: {
        icon: <EtherIcon className="w-4 h-4" />,
        text: 'Sending response...',
        color: 'text-green-400',
    },
};

/**
 * EtherPanel — Live Mode status indicator.
 * Displays connection status, stage, and last activity from messenger.
 * Apple-style glassmorphism with pulsing blue glow.
 */
export function EtherPanel({ status, isMinimized: externalMinimized, onToggleMinimize, onToggleLiveMode }: EtherPanelProps) {
    const [internalMinimized, setInternalMinimized] = useState(false);
    const isMinimized = externalMinimized ?? internalMinimized;

    const handleToggle = () => {
        if (onToggleMinimize) {
            onToggleMinimize();
        } else {
            setInternalMinimized(!internalMinimized);
        }
    };

    const stage = status.stage || 'idle';
    const stageConfig = STAGE_CONFIG[stage];
    const isConnected = !!status.connectedVia;

    // Minimized view — single line indicator
    if (isMinimized) {
        return (
            <button
                onClick={handleToggle}
                className="ether-panel flex items-center gap-2 px-3 py-1.5 w-full transition-all hover:bg-blue-500/10"
            >
                <div className="flex items-center gap-1.5">
                    <EtherIcon className="w-3 h-3 text-blue-500 animate-pulse" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-blue-400">
                        Ether
                    </span>
                </div>
                <div className="flex-1" />
                <ChevronDown className="w-3 h-3 text-white/30" />
            </button>
        );
    }

    return (
        <div className="ether-panel p-2.5 mb-2 animate-ether-glow">
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <EtherIcon className="w-3 h-3 text-blue-500 animate-pulse" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-blue-400">
                        Ether
                    </span>
                    {status.stage !== 'idle' && (
                        <span className="flex h-1.5 w-1.5 relative ml-1">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {/* Daemon status */}
                    {status.isDaemon && (
                        <div className="flex items-center gap-1 text-[10px] text-blue-400 group relative">
                            <Server className="w-3 h-3" />
                            <span className="uppercase tracking-wider">Gateway</span>
                            <div className="absolute bottom-full right-0 mb-1 hidden group-hover:block bg-slate-800 text-[9px] p-1 rounded whitespace-nowrap border border-blue-500/30">
                                Persistence Enabled: Core is running in background
                            </div>
                        </div>
                    )}

                    {/* Connection status */}
                    <div className={`flex items-center gap-1 text-[10px] ${isConnected ? 'text-green-400' : 'text-white/30'}`}>
                        {isConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                        <span className="uppercase tracking-wider">
                            {status.connectedVia || 'Offline'}
                        </span>
                    </div>

                    {/* Disconnect button */}
                    <button
                        onClick={() => onToggleLiveMode?.(false)}
                        className="p-0.5 text-white/30 hover:text-red-400 transition-colors mr-1"
                        title="Disconnect Live Mode"
                    >
                        <WifiOff className="w-3 h-3" />
                    </button>

                    {/* Minimize button */}
                    <button
                        onClick={handleToggle}
                        className="p-0.5 text-white/30 hover:text-white/60 transition-colors"
                        title="Minimize"
                    >
                        <ChevronUp className="w-3 h-3" />
                    </button>
                </div>
            </div>

            {/* Status line */}
            <div className="flex items-center gap-2 text-xs">
                <span className={stageConfig.color}>
                    {stageConfig.icon}
                </span>
                <span className={`${stageConfig.color} flex-1 truncate`}>
                    {status.lastMessage || stageConfig.text}
                </span>

                <div className="flex items-center gap-1.5 text-[10px] text-blue-400/60">
                    <EtherIcon className="w-3 h-3" />
                    <span>Voice</span>
                </div>
            </div>

            {/* Last activity */}
            {status.lastActivity && (
                <div className="mt-1.5 text-[10px] text-white/30 truncate">
                    ▸ {status.lastActivity}
                </div>
            )}
        </div>
    );
}
