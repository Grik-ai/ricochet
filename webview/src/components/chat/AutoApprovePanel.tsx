import { useState, useEffect, useRef } from 'react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { ChevronUp, ChevronDown, Search, FileEdit, Terminal, Globe, Server, Bell, Trash2 } from 'lucide-react';

// Action definitions matching Cline's pattern
const AUTO_APPROVE_ACTIONS = [
    {
        id: 'readFiles',
        label: 'Read project files',
        shortName: 'Read',
        icon: Search,
        subAction: {
            id: 'readFilesExternally',
            label: 'Read all files',
            shortName: 'Read (all)',
        }
    },
    {
        id: 'editFiles',
        label: 'Edit project files',
        shortName: 'Edit',
        icon: FileEdit,
        subAction: {
            id: 'editFilesExternally',
            label: 'Edit all files',
            shortName: 'Edit (all)',
        }
    },
    {
        id: 'deleteFiles',
        label: 'Delete project files',
        shortName: 'Delete',
        icon: Trash2,
        subAction: {
            id: 'deleteFilesExternally',
            label: 'Delete all files',
            shortName: 'Delete (all)',
        }
    },
    {
        id: 'executeSafeCommands',
        label: 'Execute safe commands',
        shortName: 'Safe Commands',
        icon: Terminal,
        subAction: {
            id: 'executeAllCommands',
            label: 'Execute all commands',
            shortName: 'All Commands',
        }
    },
    {
        id: 'useBrowser',
        label: 'Use the browser',
        shortName: 'Browser',
        icon: Globe,
    },
    {
        id: 'useMcp',
        label: 'Use MCP servers',
        shortName: 'MCP',
        icon: Server,
    },
];

interface AutoApproveState {
    readFiles: boolean;
    readFilesExternally: boolean;
    editFiles: boolean;
    editFilesExternally: boolean;
    deleteFiles: boolean;
    deleteFilesExternally: boolean;
    executeSafeCommands: boolean;
    executeAllCommands: boolean;
    useBrowser: boolean;
    useMcp: boolean;
    enableNotifications: boolean;
}

interface AutoApprovePanelProps {
    style?: React.CSSProperties;
}

/**
 * Collapsible Auto-Approve panel — Cline-style.
 * Shows enabled actions summary when collapsed, full checkbox grid when expanded.
 */
export function AutoApprovePanel({ style }: AutoApprovePanelProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const { postMessage } = useVSCodeApi();
    const [settings, setSettings] = useState<AutoApproveState>(() => {
        const saved = localStorage.getItem('autoApproveSettings');
        return saved ? JSON.parse(saved) : {
            readFiles: true,
            readFilesExternally: false,
            editFiles: true,
            editFilesExternally: false,
            deleteFiles: false,
            deleteFilesExternally: false,
            executeSafeCommands: true,
            executeAllCommands: false,
            useBrowser: true,
            useMcp: true,
            enableNotifications: false,
        };
    });

    const isFirstMount = useRef(true);

    useEffect(() => {
        if (isFirstMount.current) {
            isFirstMount.current = false;
            // Load but don't re-sync on mount to avoid redundant save_settings RPC
            localStorage.setItem('autoApproveSettings', JSON.stringify(settings));
            return;
        }

        localStorage.setItem('autoApproveSettings', JSON.stringify(settings));

        // Transform to backend snake_case format
        const payload = {
            enabled: true, // Always valid if this panel is used
            read_files: settings.readFiles,
            read_files_external: settings.readFilesExternally,
            edit_files: settings.editFiles,
            edit_files_external: settings.editFilesExternally,
            delete_files: settings.deleteFiles,
            delete_files_external: settings.deleteFilesExternally,
            execute_safe_commands: settings.executeSafeCommands,
            execute_all_commands: settings.executeAllCommands,
            use_browser: settings.useBrowser,
            use_mcp: settings.useMcp,
            enable_notifications: settings.enableNotifications
        };

        // Sync with backend
        postMessage({
            type: 'auto_approve_settings',
            payload
        });
    }, [settings, postMessage]);

    // Generate summary text of enabled actions
    const getEnabledActionsText = () => {
        const enabled: string[] = [];

        if (settings.readFilesExternally) enabled.push('Read (all)');
        else if (settings.readFiles) enabled.push('Read');

        if (settings.editFilesExternally) enabled.push('Edit (all)');
        else if (settings.editFiles) enabled.push('Edit');

        if (settings.deleteFilesExternally) enabled.push('Delete (all)');
        else if (settings.deleteFiles) enabled.push('Delete');

        if (settings.executeAllCommands) enabled.push('All Commands');
        else if (settings.executeSafeCommands) enabled.push('Safe Commands');

        if (settings.useBrowser) enabled.push('Browser');
        if (settings.useMcp) enabled.push('MCP');

        return enabled.length > 0 ? enabled.join(', ') : 'None';
    };

    const toggleSetting = (key: keyof AutoApproveState) => {
        setSettings(prev => ({
            ...prev,
            [key]: !prev[key]
        }));
    };

    return (
        <div
            className="select-none relative overflow-hidden transition-all duration-500 group rounded-xl border border-white/10"
            style={{
                background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.02) 50%, rgba(255, 255, 255, 0.01) 100%)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
                ...style
            }}
        >

            {/* Header bar — always visible */}
            <div
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center justify-between gap-2 px-3.5 py-3 cursor-pointer group"
            >
                <div className="flex items-center gap-1 min-w-0 flex-1">
                    <span className="text-sm text-[#ccc] whitespace-nowrap">Auto-approve:</span>
                    <span className={`text-sm truncate ${isExpanded ? 'text-[#ccc]' : 'text-[#888] group-hover:text-[#ccc]'}`}>
                        {getEnabledActionsText()}
                    </span>
                </div>
                {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-[#888]" />
                ) : (
                    <ChevronUp className="w-4 h-4 text-[#888]" />
                )}
            </div>

            {/* Expanded content */}
            {isExpanded && (
                <div className="px-3.5 pb-3 overflow-y-auto max-h-[60vh]">
                    <p className="text-xs text-[#888] mb-2.5">
                        Let Ricochet take these actions without asking for approval.{' '}
                        <a
                            href="#"
                            className="text-[#569cd6] hover:underline"
                            onClick={(e) => e.preventDefault()}
                        >
                            Docs
                        </a>
                    </p>

                    {/* 2-column checkbox grid */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 mb-2">
                        {AUTO_APPROVE_ACTIONS.map(action => {
                            const Icon = action.icon;
                            const isChecked = settings[action.id as keyof AutoApproveState];

                            return (
                                <div key={action.id} className="space-y-0.5">
                                    {/* Main action */}
                                    <label
                                        className="flex items-center gap-2 py-1 cursor-pointer hover:bg-[#2a2d2e] rounded px-1 -mx-1"
                                        onClick={() => toggleSetting(action.id as keyof AutoApproveState)}
                                    >
                                        <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${isChecked
                                            ? 'bg-[#0e639c] border-[#0e639c]'
                                            : 'border-[#555] bg-transparent'
                                            }`}>
                                            {isChecked && <span className="text-white text-[10px]">✓</span>}
                                        </div>
                                        <Icon className="w-3.5 h-3.5 text-[#888]" />
                                        <span className="text-sm text-[#ccc]">{action.label}</span>
                                    </label>

                                    {/* Sub-action (indented) */}
                                    {action.subAction && isChecked && (
                                        <label
                                            className="flex items-center gap-2 py-1 pl-6 cursor-pointer hover:bg-[#2a2d2e] rounded px-1 -mx-1"
                                            onClick={() => toggleSetting(action.subAction!.id as keyof AutoApproveState)}
                                        >
                                            <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${settings[action.subAction.id as keyof AutoApproveState]
                                                ? 'bg-[#0e639c] border-[#0e639c]'
                                                : 'border-[#555] bg-transparent'
                                                }`}>
                                                {settings[action.subAction.id as keyof AutoApproveState] &&
                                                    <span className="text-white text-[10px]">✓</span>
                                                }
                                            </div>
                                            <span className="text-sm text-[#ccc]">{action.subAction.label}</span>
                                        </label>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Separator */}
                    <div className="h-px bg-[#333] my-2" />

                    {/* Notifications toggle */}
                    <label
                        className="flex items-center gap-2 py-1 cursor-pointer hover:bg-[#2a2d2e] rounded px-1 -mx-1"
                        onClick={() => toggleSetting('enableNotifications')}
                    >
                        <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${settings.enableNotifications
                            ? 'bg-[#0e639c] border-[#0e639c]'
                            : 'border-[#555] bg-transparent'
                            }`}>
                            {settings.enableNotifications && <span className="text-white text-[10px]">✓</span>}
                        </div>
                        <Bell className="w-3.5 h-3.5 text-[#888]" />
                        <span className="text-sm text-[#ccc]">Enable notifications</span>
                    </label>
                </div>
            )}
        </div>
    );
}
