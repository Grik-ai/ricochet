import { motion, AnimatePresence } from 'framer-motion';

export interface BuddyProps {
    status: 'idle' | 'thinking' | 'executing' | 'success' | 'error' | 'stopped';
    message?: string;
}

const statusColors = {
    idle: '#94a3b8',
    thinking: '#00D1FF',
    executing: '#7000FF',
    success: '#4ade80',
    error: '#f87171',
    stopped: '#f87171',
};

export function Buddy({ status, message }: BuddyProps) {
    const isThinking = status === 'thinking' || status === 'executing';
    const logoUri = (window as any).RICOCHET_LOGO_URI;

    return (
        <div className="flex flex-col items-center justify-center p-4 relative">
            <motion.div
                animate={{
                    y: [0, -6, 0],
                }}
                transition={{
                    duration: 6,
                    repeat: Infinity,
                    ease: "easeInOut"
                }}
                className="relative z-10"
            >
                <div className="w-24 h-24 relative flex items-center justify-center">
                    {/* Minimalist Status Ring */}
                    <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 100 100">
                        <circle
                            cx="50"
                            cy="50"
                            r="46"
                            fill="none"
                            stroke="white"
                            strokeOpacity="0.05"
                            strokeWidth="1"
                        />
                        <motion.circle
                            cx="50"
                            cy="50"
                            r="46"
                            fill="none"
                            stroke={statusColors[status]}
                            strokeWidth="1.5"
                            strokeDasharray="10 280"
                            strokeLinecap="round"
                            animate={{
                                rotate: 360,
                                opacity: isThinking ? [0.4, 1, 0.4] : 0.6
                            }}
                            transition={{
                                rotate: { duration: 4, repeat: Infinity, ease: "linear" },
                                opacity: { duration: 2, repeat: Infinity, ease: "easeInOut" }
                            }}
                        />
                    </svg>

                    {/* Official Logo Container */}
                    <div className="w-16 h-16 rounded-xl bg-white/[0.03] border border-white/5 flex items-center justify-center overflow-hidden shadow-2xl">
                        {logoUri ? (
                            <img src={logoUri} alt="Ricochet" className="w-10 h-10 object-contain opacity-80" />
                        ) : (
                            <div className="w-8 h-8 rounded-full bg-cyan-500/10" />
                        )}
                    </div>
                </div>
            </motion.div>

            {/* Status Message */}
            <AnimatePresence>
                {message && (
                    <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 4 }}
                        className="mt-6 text-center"
                    >
                        <span className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">
                            {message}
                        </span>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
