import { useState, useEffect } from 'react';
import { ChatView } from '@components/chat/ChatView';
import { Settings } from '@components/settings/Settings';
import { useVSCodeApi } from '@hooks/useVSCodeApi';

import { McpView } from '@components/mcp/McpView';
import { HistoryView } from './components/history/HistoryView';
import { AgentView } from './components/agent/AgentView';
import { AccountView } from './components/account/AccountView';
import { useAgentStateMachine } from './hooks/useAgentStateMachine';
import { useAgentSync } from './hooks/useAgentSync';
import { DEFAULT_MODEL } from './components/chat/ChatInput';

type View = 'chat' | 'settings' | 'mcp' | 'history' | 'agent' | 'account';

export default function App() {
    const [currentView, setCurrentView] = useState<View>('chat');
    const [mode, setMode] = useState<'plan' | 'act' | 'mission'>('act');
    const [model, setModel] = useState(DEFAULT_MODEL);
    const { onMessage } = useVSCodeApi();
    const agentState = useAgentStateMachine();

    // Global synchronization of agent state machine
    useAgentSync(agentState);

    // Listen for view change requests from extension
    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            if (message.type === 'open_settings') {
                setCurrentView('settings');
            } else if (message.type === 'open_agent') {
                setCurrentView('agent');
            } else if (message.type === 'open_history') {
                setCurrentView('history');
            } else if (message.type === 'open_mcp') {
                setCurrentView('mcp');
            } else if (message.type === 'open_account') {
                setCurrentView('account');
            }
        });
        return () => { unsubscribe(); };
    }, [onMessage]);

    return (
        <div className="flex flex-col h-full w-full overflow-hidden bg-vscode-editor-background text-vscode-fg font-sans selection:bg-vscode-editor-selectionBackground">

            {/* Main Content Area */}
            <main className="flex-1 flex flex-col overflow-hidden relative z-10">
                {/* ChatView is ALWAYS mounted to preserve session state */}
                <div className={currentView === 'chat' ? 'flex-1 flex flex-col overflow-hidden' : 'hidden'}>
                    <ChatView
                        onOpenHistory={() => setCurrentView('history')}
                        onOpenAgent={() => setCurrentView('agent')}
                        onOpenAccount={() => setCurrentView('account')}
                        agentState={agentState}
                        mode={mode}
                        onModeChange={setMode}
                        model={model}
                        onModelChange={setModel}
                    />
                </div>

                {/* Modal overlays / Specialized Views */}
                {currentView === 'settings' && (
                    <div className="absolute inset-0 z-50 bg-vscode-editor-background animate-fade-in">
                        <Settings onClose={() => setCurrentView('chat')} />
                    </div>
                )}
                {currentView === 'history' && (
                    <div className="absolute inset-0 z-50 bg-vscode-editor-background animate-fade-in">
                        <HistoryView onDone={() => setCurrentView('chat')} />
                    </div>
                )}
                {currentView === 'mcp' && (
                    <div className="absolute inset-0 z-50 bg-vscode-editor-background h-full flex flex-col animate-fade-in">
                        <div className="p-3 border-b border-vscode-border bg-vscode-editor-background">
                            <button onClick={() => setCurrentView('chat')} className="text-[10px] uppercase tracking-widest text-vscode-link-foreground hover:underline transition-colors">← Back to Terminal</button>
                        </div>
                        <div className="flex-1 overflow-hidden">
                            <McpView />
                        </div>
                    </div>
                )}
                {currentView === 'agent' && (
                    <div className="absolute inset-0 z-50 bg-vscode-editor-background h-full flex flex-col animate-fade-in">
                        <div className="flex-1 overflow-hidden">
                            <AgentView
                                agentState={agentState}
                                mode={mode}
                                onModeChange={setMode}
                                model={model}
                                onModelChange={setModel}
                                onBack={() => setCurrentView('chat')}
                            />
                        </div>
                    </div>
                )}
                {currentView === 'account' && (
                    <div className="absolute inset-0 z-50 bg-vscode-editor-background h-full flex flex-col animate-fade-in">
                        <AccountView onBack={() => setCurrentView('chat')} />
                    </div>
                )}
            </main>

            {/* CSS Variables for custom scrollbars */}
            <style>{`
                .custom-scrollbar::-webkit-scrollbar { width: 4px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 4px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

                @keyframes scan {
                    from { transform: translateX(-100%); }
                    to { transform: translateX(200%); }
                }

                @keyframes fade-in {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-fade-in { animation: fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
            `}</style>
        </div>
    );
}
