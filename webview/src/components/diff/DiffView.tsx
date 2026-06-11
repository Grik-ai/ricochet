import { useState, useMemo } from 'react';
import { Check, X, ChevronDown, Plus, Minus, Edit, FileEdit } from 'lucide-react';
import { SyntaxHighlighter } from '../../utils/syntaxHighlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

export interface DiffLine {
    type: 'add' | 'remove' | 'context';
    content: string;
    lineNumber?: number;
}

export interface FileDiff {
    path: string;
    operation: 'create' | 'modify' | 'delete';
    hunks: DiffLine[][];
}

interface DiffViewProps {
    diffs: FileDiff[];
    onApprove?: () => void;
    onReject?: () => void;
    onViewInVSCode?: (path: string) => void;
    isLoading?: boolean;
}

const getLanguage = (filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'ts':
        case 'tsx': return 'typescript';
        case 'js':
        case 'jsx': return 'javascript';
        case 'py': return 'python';
        case 'go': return 'go';
        case 'md': return 'markdown';
        case 'json': return 'json';
        case 'css': return 'css';
        case 'html': return 'html';
        case 'rs': return 'rust';
        default: return 'text';
    }
};

/**
 * DiffView - Shows file changes in unified diff format
 * Matches Antigravity industrial/graphite theme
 */
export function DiffView({ diffs, onApprove, onReject, onViewInVSCode, isLoading }: DiffViewProps) {
    const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set(diffs.map(d => d.path)));

    const toggleFile = (path: string) => {
        setExpandedFiles(prev => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    };

    const stats = useMemo(() => {
        let additions = 0;
        let deletions = 0;
        diffs.forEach(diff => {
            diff.hunks.forEach(hunk => {
                hunk.forEach(line => {
                    if (line.type === 'add') additions++;
                    if (line.type === 'remove') deletions++;
                });
            });
        });
        return { additions, deletions };
    }, [diffs]);

    return (
        <div className="border border-white/5 rounded-xl overflow-hidden bg-white/[0.03] backdrop-blur-xl shadow-2xl group/diff transition-all">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 bg-white/[0.02] border-b border-white/5">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                        <div className="relative w-1.5 h-1.5">
                            <div className="absolute inset-0 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.45)]" />
                        </div>
                        <span className="text-[10px] font-black text-white/30 uppercase tracking-widest font-mono">
                            {diffs.length} {diffs.length !== 1 ? 'Files' : 'File'} Pending
                        </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold font-mono">
                        <span className="text-emerald-500/80">+{stats.additions}</span>
                        <span className="text-rose-500/80">-{stats.deletions}</span>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {onReject && (
                        <button
                            onClick={onReject}
                            disabled={isLoading}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-black bg-white/[0.03] text-white/40 hover:text-rose-400 hover:bg-rose-500/10 rounded-md transition-all border border-white/5 uppercase tracking-widest active:scale-95"
                        >
                            <X className="w-3 h-3" />
                            Discard
                        </button>
                    )}
                    {onApprove && (
                        <button
                            onClick={onApprove}
                            disabled={isLoading}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-[9px] font-black bg-blue-500/10 text-blue-300/80 hover:text-blue-300 hover:bg-blue-500/20 rounded-md transition-all border border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.05)] uppercase tracking-widest active:scale-95"
                        >
                            <Check className="w-3 h-3" />
                            Accept
                        </button>
                    )}
                </div>
            </div>

            {/* File list */}
            <div className="max-h-[600px] overflow-y-auto custom-scrollbar">
                {diffs.map((diff) => {
                    const lang = getLanguage(diff.path);
                    return (
                        <div key={diff.path} className="border-b border-white/5 last:border-b-0 animate-in fade-in duration-300">
                            {/* File header */}
                            <div
                                className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer group/file"
                                onClick={() => toggleFile(diff.path)}
                            >
                                <div className="flex-shrink-0 transition-transform duration-200" style={{ transform: expandedFiles.has(diff.path) ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                                    <ChevronDown className="w-3.5 h-3.5 text-white/20 group-hover/file:text-white/40" />
                                </div>
                                <FileIcon operation={diff.operation} />
                                <span className="text-[11px] text-white/60 font-mono truncate flex-1 tracking-tight">
                                    {diff.path}
                                </span>
                                <span className={`text-[8px] px-1.5 py-0.5 rounded font-black uppercase tracking-tighter ${
                                    diff.operation === 'create' ? 'bg-emerald-500/10 text-emerald-500/70' :
                                    diff.operation === 'delete' ? 'bg-rose-500/10 text-rose-500/70' :
                                    'bg-blue-500/10 text-blue-300/70'
                                }`}>
                                    {diff.operation}
                                </span>
                                {onViewInVSCode && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onViewInVSCode(diff.path);
                                        }}
                                        className="ml-2 p-1.5 text-white/10 hover:text-white/60 hover:bg-white/5 rounded-lg transition-all active:scale-90"
                                        title="Open native diff"
                                    >
                                        <FileEdit className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>

                            {/* Diff content */}
                            {expandedFiles.has(diff.path) && (
                                <div className="bg-black/20 font-mono text-[11px] overflow-x-auto border-t border-white/5 py-1">
                                    {diff.hunks.map((hunk, hunkIdx) => (
                                        <div key={hunkIdx} className="mb-2 last:mb-0">
                                            <div className="px-4 py-1 text-white/15 select-none text-[9px] bg-white/[0.01] tracking-wider font-bold">
                                                @@ {diff.path} @@
                                            </div>
                                            {hunk.map((line, lineIdx) => (
                                                <div
                                                    key={lineIdx}
                                                    className={`flex border-l-2 transition-all group/line ${
                                                        line.type === 'add' ? 'bg-emerald-500/[0.08] border-emerald-500/30' :
                                                        line.type === 'remove' ? 'bg-rose-500/[0.08] border-rose-500/30' :
                                                        'border-transparent'
                                                    }`}
                                                >
                                                    <span className="w-12 flex-shrink-0 px-3 text-right text-white/10 select-none font-mono text-[10px] py-0.5 border-r border-white/[0.02] group-hover/line:text-white/30 transition-colors">
                                                        {line.lineNumber !== undefined ? line.lineNumber : ''}
                                                    </span>
                                                    <span className={`w-6 flex-shrink-0 text-center select-none py-0.5 font-bold ${
                                                        line.type === 'add' ? 'text-emerald-500/60' :
                                                        line.type === 'remove' ? 'text-rose-500/60' :
                                                        'text-white/5'
                                                    }`}>
                                                        {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                                                    </span>
                                                    <div className={`flex-1 px-3 whitespace-pre py-0.5 ${
                                                        line.type === 'add' ? 'opacity-100' :
                                                        line.type === 'remove' ? 'opacity-80 line-through decoration-rose-500/20' :
                                                        'opacity-50'
                                                    }`}>
                                                        {lang !== 'text' ? (
                                                            <SyntaxHighlighter
                                                                language={lang}
                                                                style={vscDarkPlus}
                                                                customStyle={{ background: 'transparent', padding: 0, margin: 0, fontSize: 'inherit' }}
                                                                PreTag="div"
                                                                CodeTag="span"
                                                            >
                                                                {line.content || ' '}
                                                            </SyntaxHighlighter>
                                                        ) : (
                                                            line.content || ' '
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function FileIcon({ operation }: { operation: 'create' | 'modify' | 'delete' }) {
    const cls = "w-3.5 h-3.5 opacity-60";
    switch (operation) {
        case 'create':
            return <Plus className={`${cls} text-green-400`} />;
        case 'delete':
            return <Minus className={`${cls} text-red-400`} />;
        default:
            return <Edit className={`${cls} text-blue-300`} />;
    }
}

/**
 * Parse unified diff string into structured format with correct line numbering
 */
export function parseDiff(diffText: string): FileDiff[] {
    const files: FileDiff[] = [];
    // Hunk headers: @@ -start,len +start,len @@
    const hunkRegex = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/;

    const fileParts = diffText.split(/^diff --git/m).filter(Boolean);

    for (const part of fileParts) {
        const lines = part.split('\n');
        const headerLine = lines[0];
        const pathMatch = headerLine.match(/a\/(.*) b\/(.*)/);

        if (!pathMatch) continue;

        const path = pathMatch[2];
        let operation: 'create' | 'modify' | 'delete' = 'modify';

        if (part.includes('new file mode')) operation = 'create';
        if (part.includes('deleted file mode')) operation = 'delete';

        const hunks: DiffLine[][] = [];
        let currentHunk: DiffLine[] = [];

        let removedLineNum = 0;
        let addedLineNum = 0;

        for (const line of lines) {
            const hunkMatch = line.match(hunkRegex);
            if (hunkMatch) {
                if (currentHunk.length) hunks.push(currentHunk);
                currentHunk = [];
                // hunkMatch[1] is '-' start, hunkMatch[3] is '+' start
                removedLineNum = parseInt(hunkMatch[1], 10);
                addedLineNum = parseInt(hunkMatch[3], 10);
                continue;
            }

            if (line.startsWith('+') && !line.startsWith('+++')) {
                currentHunk.push({ type: 'add', content: line.slice(1), lineNumber: addedLineNum++ });
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                currentHunk.push({ type: 'remove', content: line.slice(1), lineNumber: removedLineNum++ });
            } else if (line.startsWith(' ')) {
                // Context line: advances both but we show added line num usually
                currentHunk.push({ type: 'context', content: line.slice(1), lineNumber: addedLineNum++ });
                removedLineNum++;
            }
        }

        if (currentHunk.length) hunks.push(currentHunk);
        files.push({ path, operation, hunks });
    }

    return files;
}
