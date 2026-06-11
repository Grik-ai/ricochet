import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BellRing, Loader2 } from 'lucide-react';

interface DynamicActionPillProps {
    pendingChoice?: { id: string; choices: string[]; question: string };
    isWaiting: boolean;
    postMessage: (msg: any) => void;
}

export function DynamicActionPill({ pendingChoice, isWaiting, postMessage }: DynamicActionPillProps) {
    const [isHovered, setIsHovered] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);

    // Reset processing state when a new choice appears
    useEffect(() => {
        if (isWaiting && pendingChoice) {
            setIsProcessing(false);
        }
    }, [isWaiting, pendingChoice]);

    if (!isWaiting && !isProcessing) {
        return null;
    }

    if (isWaiting && !pendingChoice) {
        return null; // Might be waiting for something else, though usually pendingChoice is set along with waiting_input
    }

    return (
        <div
            className="absolute top-12 right-4 z-50 flex justify-end"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <motion.div
                layout
                initial={{ width: 32, opacity: 0 }}
                animate={{
                    width: isHovered && !isProcessing ? 'auto' : 32,
                    opacity: 1
                }}
                className={`flex items-center overflow-hidden h-8 rounded-full border shadow-lg backdrop-blur-xl transition-colors duration-300 ${isHovered && !isProcessing ? 'bg-sidebar-background/95 border-vscode-border/50' : 'bg-button-background border-button-background overflow-visible cursor-pointer shadow-button-background/20'}`}
                style={{ originX: 1 }}
            >
                <AnimatePresence mode="wait">
                    {!isHovered || isProcessing ? (
                        <motion.div
                            key="collapsed"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="w-8 h-8 flex items-center justify-center shrink-0"
                        >
                            {isProcessing ? (
                                <Loader2 className="w-3.5 h-3.5 text-button-foreground animate-spin" />
                            ) : (
                                <>
                                    <div className="absolute inset-0 rounded-full bg-button-background animate-ping opacity-40 duration-1000" />
                                    <BellRing className="w-3.5 h-3.5 text-button-foreground relative z-10 animate-bounce" style={{ animationDuration: '2s' }} />
                                </>
                            )}
                        </motion.div>
                    ) : (
                        <motion.div
                            key="expanded"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-3 px-3 min-w-[240px] max-w-[400px] h-full"
                        >
                            <span className="text-[11px] font-bold text-foreground/90 truncate flex-1">
                                {pendingChoice?.question.split('\n')[0] || "Action Input Required"}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                                {pendingChoice?.choices.map((choice, i) => (
                                    <button
                                        key={choice}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setIsProcessing(true);
                                            postMessage({
                                                type: 'permission_response',
                                                payload: { id: pendingChoice?.id, answer: choice }
                                            });
                                        }}
                                        className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all shadow-sm ${
                                            i === 0
                                            ? 'bg-button-background text-button-foreground hover:bg-button-background-hover hover:scale-105'
                                            : 'bg-vscode-border/30 text-foreground/80 hover:bg-vscode-border/60 hover:text-foreground'
                                        }`}
                                    >
                                        {choice}
                                    </button>
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    );
}
