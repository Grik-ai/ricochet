import { useVSCodeApi } from '../../hooks/useVSCodeApi';

interface AffectedFile {
    path: string;
    name: string;
    additions: number;
    deletions: number;
}

interface AffectedFilesListProps {
    files: AffectedFile[];
}

export function AffectedFilesList({ files }: AffectedFilesListProps) {
    const { postMessage } = useVSCodeApi();

    if (!files || files.length === 0) return null;

    return (
        <div className="flex flex-col gap-2 my-2">
            {/* Header with Badge */}
            <div className="flex items-center gap-2 px-1 mb-1">
                <span className="text-[12px] font-bold text-white/40">Files Modified</span>
                <div className="px-1.5 py-0.5 rounded-full bg-white/[0.08] text-[10px] font-bold text-white/50 min-w-[20px] text-center">
                    {files.length}
                </div>
            </div>

            {/* List Container */}
            <div className="flex flex-col gap-0.5 p-2 rounded-xl bg-[#0d0d0d] border border-white/[0.05] shadow-2xl max-w-full overflow-hidden">
                {files.map((file, i) => (
                    <button
                        key={`${file.path}-${i}`}
                        onClick={() => postMessage({ type: 'open_file', payload: { path: file.path } })}
                        className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-white/[0.03] transition-all group text-left w-full min-w-0"
                    >
                        {/* Orange Icon */}
                        <div className="flex-shrink-0 w-3.5 h-3.5 rounded-[3px] border border-orange-500/50 bg-orange-500/10 flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                        </div>

                        {/* Stats */}
                        <div className="flex items-center gap-1.5 shrink-0 min-w-[45px]">
                            <span className="text-[10px] font-bold text-emerald-500/80">+{file.additions}</span>
                            <span className="text-[10px] font-bold text-rose-500/80">-{file.deletions}</span>
                        </div>

                        {/* Filename */}
                        <span className="text-[12px] font-bold text-white/90 truncate shrink-0">
                            {file.name}
                        </span>

                        {/* Path */}
                        <span className="text-[11px] text-white/20 font-mono truncate ml-1 opacity-40 group-hover:opacity-100 transition-opacity">
                            {file.path}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}
