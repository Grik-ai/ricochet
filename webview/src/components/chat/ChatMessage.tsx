import React, { useState, useMemo, useEffect, useRef, memo } from 'react';
import { ChatMessage as ChatMessageType, ToolCall, ActivityItem, ActivityEntry, WorkEvent, WorkSummary, QueuedTurnState, normalizeWorkCommentaryText } from '@hooks/useChat';
import { useVSCodeApi } from '@hooks/useVSCodeApi';
import { DiffView, parseDiff, FileDiff, DiffLine } from '../diff/DiffView';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SyntaxHighlighter } from '../../utils/syntaxHighlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
    cleanAssistantVisibleText,
    isRenderableChatMessage
} from '../../utils/chatVisibility';
import { FileGlyph } from '../common/FileGlyph';
import { MessengerIcon, messengerLabel } from './MessengerIcon';
import type { ContextFilePayload } from '../../types/protocol';
import { ChangedFilesSummary, type ChangedFileItem } from './ChangedFilesSummary';
import { Folder, Search } from 'lucide-react';

// --- Types ---


// --- Utils ---

const parseContent = (content: string) => {
    return {
        body: content.trim(),
        artifacts: [] as any[]
    };
};

function basename(path = '') {
    return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path;
}

export function formatTimelineLineRange(raw?: string): string {
    const value = (raw || '').trim().replace(/^#/, '');
    if (!value) return '';
    const range = value.match(/^L?(\d+)\s*[-–—:]\s*L?(\d+)$/i);
    if (range) return `L${range[1]}-L${range[2]}`;
    const single = value.match(/^L?(\d+)$/i);
    if (single) return `L${single[1]}`;
    return value.startsWith('L') ? value : `L${value}`;
}

const TimelineGlyph = ({
    path,
    type,
    size = 'sm',
}: {
    path?: string;
    type: 'folder' | 'file' | 'search';
    size?: 'xs' | 'sm';
}) => {
    if (type === 'folder') {
        return (
            <span
                aria-hidden="true"
                title={path || 'folder'}
                className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center text-sky-300/90 drop-shadow-[0_0_8px_rgba(125,211,252,0.16)]"
            >
                <Folder className="h-[15px] w-[15px] stroke-[1.9]" />
            </span>
        );
    }

    if (type === 'search') {
        return (
            <span
                aria-hidden="true"
                title={path || 'search'}
                className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center text-blue-300/80"
            >
                <Search className="h-[14px] w-[14px] stroke-[1.9]" />
            </span>
        );
    }

    return <FileGlyph path={path} type={type} size={size} />;
};

export function extractLegacyContextFiles(content: string): { content: string; contextFiles: ContextFilePayload[] } {
    const lines = (content || '').split(/\r?\n/);
    const contextFiles: ContextFilePayload[] = [];
    const kept: string[] = [];
    let inContextBlock = false;

    lines.forEach(line => {
        const trimmed = line.trim();
        if (!inContextBlock && /^Context Files:?$/i.test(trimmed)) {
            inContextBlock = true;
            return;
        }
        if (inContextBlock) {
            if (!trimmed) return;
            if (trimmed.startsWith('@')) {
                const path = trimmed.slice(1).trim();
                if (path) {
                    contextFiles.push({
                        path,
                        name: basename(path),
                        kind: 'file',
                        source: path.includes('.ricochet/attachments/') ? 'attachment' : 'workspace',
                    });
                }
                return;
            }
            inContextBlock = false;
        }
        kept.push(line);
    });

    return {
        content: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        contextFiles,
    };
}

function contextFileDisplayName(file: ContextFilePayload): string {
    return file.name || basename(file.stagedPath || file.path) || 'attachment';
}

function contextFileMeta(file: ContextFilePayload): string {
    const details = [
        file.source === 'attachment' ? 'Attachment' : 'Workspace file',
        file.size && file.size > 0 ? `${Math.round(file.size / 1024)} KB` : '',
    ].filter(Boolean);
    return details.join(' · ');
}

const splitMessageIntoBlocks = (text: string) => {
    const blocks: { type: 'text' | 'thinking', content: string }[] = [];
    let lastIndex = 0;

    // Use a non-greedy regex that handles both <thinking> and <think>
    const regex = /<(?:thinking|think)>([\s\S]*?)(?:<\/(?:thinking|think)>|$)/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            blocks.push({ type: 'text', content: text.substring(lastIndex, match.index) });
        }
        blocks.push({ type: 'thinking', content: match[1].trim() });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        blocks.push({ type: 'text', content: text.substring(lastIndex) });
    }

    // Fallback: If no blocks were found but message is strictly reasoning (rare cases)
    if (blocks.length === 0 && text.trim().length > 0) {
        blocks.push({ type: 'text', content: text });
    }

    return blocks;
};

// --- Sub-components ---

const CopyButton = ({
    code,
    title = 'Copy code',
    className = '',
}: {
    code: string;
    title?: string;
    className?: string;
}) => {
    const [copied, setCopied] = useState(false);
    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            onClick={handleCopy}
            className={`flex h-6 w-6 items-center justify-center rounded text-vscode-fg/45 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/80 ${className}`}
            title={copied ? 'Copied' : title}
            aria-label={copied ? 'Copied' : title}
        >
            {copied ? <span className="codicon codicon-check w-3 h-3 text-green-400" /> : <span className="codicon codicon-copy w-3 h-3" />}
        </button>
    );
};

export const ThinkingRow = memo(({ content, active = false }: { content: string; active?: boolean }) => {
    const [expanded, setExpanded] = useState(active);
    const trimmed = content.trim();
    useEffect(() => {
        setExpanded(active);
    }, [active]);
    if (!trimmed) return null;

    return (
        <div className="mb-1.5">
            <button
                type="button"
                onClick={() => setExpanded(open => !open)}
                className="flex max-w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] font-medium text-vscode-fg/45 hover:bg-vscode-list-hoverBackground/30 hover:text-vscode-fg/70"
            >
                <span className={`codicon ${active ? 'codicon-loading codicon-modifier-spin text-blue-300/65' : 'codicon-lightbulb text-vscode-fg/42'} text-[12px]`} />
                <span>{active ? 'Thinking...' : 'Thinking'}</span>
                <span className={`codicon codicon-chevron-right ml-auto text-[11px] text-vscode-fg/35 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
            </button>
            <AnimatedDisclosure open={expanded}>
                <div className="ml-4 mt-1 rounded-md bg-vscode-input-bg/18 px-2 py-1.5">
                    <pre className="custom-scrollbar max-h-[180px] overflow-auto whitespace-pre-wrap break-words font-sans text-[11.5px] leading-[1.5] text-vscode-fg/50">
                        {trimmed}
                    </pre>
                </div>
            </AnimatedDisclosure>
        </div>
    );
});

const ChatErrorCard = ({ errorInfo, onRetry }: { errorInfo: NonNullable<ChatMessageType['errorInfo']>; onRetry?: () => void }) => {
    const [detailsOpen, setDetailsOpen] = useState(false);
    const canRetry = errorInfo.retryable && Boolean(onRetry);
    const rawDetails = errorInfo.rawMessage?.trim();
    const tone = errorInfo.kind === 'network' || errorInfo.kind === 'rate_limit' || errorInfo.kind === 'provider_server'
        ? 'text-amber-200/90 border-amber-500/20 bg-amber-500/10'
        : errorInfo.kind === 'provider_config'
            ? 'text-rose-200/90 border-rose-500/20 bg-rose-500/10'
            : 'text-vscode-fg/78 border-vscode-border bg-vscode-input-bg/55';

    return (
        <div className={`my-1.5 overflow-hidden rounded-lg border px-3 py-2.5 ${tone}`}>
            <div className="flex min-w-0 items-start gap-2">
                <span className={`codicon ${errorInfo.kind === 'network' ? 'codicon-globe' : 'codicon-warning'} mt-0.5 shrink-0 text-[14px] opacity-80`} />
                <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium leading-5 text-vscode-fg/82">{errorInfo.title}</div>
                    <div className="mt-0.5 text-[12px] leading-5 text-vscode-fg/58">{errorInfo.message}</div>
                </div>
                <div className="ml-1 flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        disabled={!canRetry}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (canRetry) onRetry?.();
                        }}
                        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${canRetry ? 'text-vscode-fg/58 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/86' : 'cursor-not-allowed text-vscode-fg/22'}`}
                        title={canRetry ? 'Retry message' : 'Original message not found'}
                    >
                        <span className="codicon codicon-refresh text-[13px]" />
                    </button>
                    {rawDetails && (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                setDetailsOpen(open => !open);
                            }}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-vscode-fg/45 transition-colors hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/80"
                            title={detailsOpen ? 'Hide details' : 'Show technical details'}
                        >
                            <span className={`codicon codicon-info text-[13px] transition-transform duration-200 ${detailsOpen ? 'rotate-180' : ''}`} />
                        </button>
                    )}
                </div>
            </div>
            {rawDetails && (
                <AnimatedDisclosure open={detailsOpen} className="mt-2">
                    <div className="rounded-md bg-vscode-editor-background/70 px-2.5 py-2">
                        <div className="mb-1.5 flex items-center gap-2">
                            <span className="text-[10px] font-medium text-vscode-fg/45">Diagnostics</span>
                            {errorInfo.diagnosticCode && <span className="rounded bg-vscode-input-bg px-1.5 py-0.5 font-mono text-[9px] text-vscode-fg/38">{errorInfo.diagnosticCode}</span>}
                            <span className="ml-auto" />
                            <CopyButton code={rawDetails} />
                        </div>
                        <pre className="custom-scrollbar max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.45] text-vscode-fg/45">
                            {rawDetails}
                        </pre>
                    </div>
                </AnimatedDisclosure>
            )}
        </div>
    );
};

const plainTextLanguages = new Set(['', 'text', 'txt', 'plain', 'plaintext']);

const getVSCodeThemeKind = () => {
    if (typeof document === 'undefined') return 'dark';
    return document.body.classList.contains('vscode-light') ? 'light' : 'dark';
};

const useVSCodeThemeKind = () => {
    const [themeKind, setThemeKind] = useState(getVSCodeThemeKind);

    useEffect(() => {
        if (typeof document === 'undefined') return;
        const observer = new MutationObserver(() => setThemeKind(getVSCodeThemeKind()));
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    return themeKind;
};

export const looksLikePathReference = (line: string) => {
    const trimmed = line.trim().replace(/^`|`$/g, '').replace(/^<|>$/g, '').replace(/,$/, '');
    if (!trimmed) return false;
    if (/^https?:\/\/\S+$/i.test(trimmed)) return true;
    if (/^[\w@.-]+\/$/.test(trimmed)) return true;
    if (/^[./~\w@-]+(?:[\\/][.\w@ -]+)+\/?$/.test(trimmed)) return true;
    return /^[\w@.-]+(?:\.(?:rs|go|ts|tsx|js|jsx|mjs|cjs|json|md|mdx|toml|yaml|yml|py|sh|bash|zsh|css|scss|sass|html|htm|sql|db|sqlite|sqlite3|lock))(?::\d+)?$/i.test(trimmed);
};

function looksLikeUrlReference(line: string) {
    return /^https?:\/\/\S+$/i.test(line.trim().replace(/^<|>$/g, '').replace(/,$/, ''));
}

function inlineReference(ref: string) {
    const cleaned = ref.trim().replace(/^`|`$/g, '').replace(/^<|>$/g, '').replace(/,$/, '');
    if (!cleaned) return ref;
    if (looksLikeUrlReference(cleaned)) return `<${cleaned}>`;
    return `\`${cleaned}\``;
}

export const looksLikeIdentifierReference = (line: string) => {
    const trimmed = line.trim().replace(/^`|`$/g, '').replace(/,$/, '');
    if (!trimmed || looksLikePathReference(trimmed)) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed);
};

export const normalizeParenthesizedPathReferences = (text: string) => {
    return text.replace(/\(\s*\n[ \t]*(?:`([^`\n]+)`|([^()\n]+?))[ \t]*\n[ \t]*\)/g, (match, backtickedPath, rawPath) => {
        const path = String(backtickedPath || rawPath || '').trim().replace(/,$/, '');
        if (!looksLikePathReference(path)) return match;
        return `(${inlineReference(path)})`;
    });
};

export const normalizeBrokenReferenceLines = (text: string) => {
    return text
        .replace(/(^|\n)([ \t]*(?:[-*+]\s+|\d+\.\s+)?[^:\n]{1,96}:\s*)\n[ \t]*(?:`([^`\n]+)`|([^`\n]+))[ \t]*\n[ \t]*[-–—]\s+/g, (match, lineStart, label, backtickedRef, rawRef) => {
            const ref = String(backtickedRef || rawRef || '').trim();
            const labelWithSpace = /\s$/.test(label) ? label : `${label} `;
            return looksLikePathReference(ref) ? `${lineStart}${labelWithSpace}${inlineReference(ref)} - ` : match;
        })
        .replace(/(^|\n)([ \t]*(?:[-*+]\s+|\d+\.\s+)?)(`[^`\n]{1,140}`)\s*\n[ \t]*(:\s*)/g, '$1$2$3$4')
        .replace(/(^|\n)([ \t]*(?:[-*+]\s+|\d+\.\s+)?)([./~\w@-]+(?:[\\/][.\w@ -]+)+(?:\.[A-Za-z0-9]+)?\/?)\s*\n[ \t]*(:\s*)/g, (_match, lineStart, prefix, ref, colon) => {
            return looksLikePathReference(ref) ? `${lineStart}${prefix}\`${ref}\`${colon}` : _match;
        });
};

const INLINE_FENCE_MAX_LENGTH = 90;

export const shouldInlineCodeFence = (language: string, code: string) => {
    const normalizedLanguage = language.trim().toLowerCase();
    if (!plainTextLanguages.has(normalizedLanguage)) return false;

    const compactLines = code
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && line !== ',');
    if (compactLines.length !== 1) return false;

    const token = compactLines[0].replace(/,$/, '');
    if (!token || token.length > INLINE_FENCE_MAX_LENGTH || token.includes('`')) return false;
    if (looksLikePathReference(token) || looksLikeIdentifierReference(token)) return true;
    if (/\s/.test(token)) return false;

    return /^[\w@~./\\:$#-][\w@~./\\:$#()[\]{}.,;:+?=&%|!*'"<>-]*$/.test(token);
};

export const normalizeCompactInlineCodeFences = (text: string) => {
    const withInlineFences = text.replace(/(^|\n)([ \t]*)```([^\n`]*)\r?\n([\s\S]*?)\r?\n[ \t]*```(?=\n|$)/g, (match, lineStart, indent, rawLanguage, code) => {
        if (!shouldInlineCodeFence(String(rawLanguage || ''), String(code || ''))) return match;
        const token = String(code).trim().replace(/,$/, '');
        return `${lineStart}${indent}\`${token}\``;
    });

    return withInlineFences
        .replace(/([^\n])\n{1,2}[ \t]*(`[^`\n]{1,120}`)\n{1,2}(?![ \t]*(?:[-*+] |\d+\. |#{1,6}\s))([^\n])/g, '$1 $2 $3')
        .replace(/([(:])\n[ \t]*(`[^`\n]{1,120}`)\n[ \t]*\n([)])/g, '$1$2$3')
        .replace(/\(\s+(`[^`\n]{1,120}`)\s+\)/g, '($1)')
        .replace(/\(\s+(`[^`\n]{1,120}`)/g, '($1')
        .replace(/(`[^`\n]{1,120}`)\s+,/g, '$1,')
        .replace(/,\s*\n\s*(`[^`\n]{1,120}`)/g, ', $1')
        .replace(/(`[^`\n]{1,120}`)\s*\n\s*\)/g, '$1)');
};

export const normalizeAssistantMarkdown = (content: string) => {
    return normalizeBrokenReferenceLines(normalizeParenthesizedPathReferences(normalizeCompactInlineCodeFences(content)));
};

const CodeBlock = memo(({ language, code, onExecuteCommand }: { language: string; code: string; onExecuteCommand?: (cmd: string) => void }) => {
    const normalizedLanguage = language.toLowerCase();
    const isTerminal = ['sh', 'bash', 'zsh', 'terminal', 'cmd'].includes(normalizedLanguage);
    const isPlainText = plainTextLanguages.has(normalizedLanguage);
    const lineCount = code.split('\n').length;
    const isLong = lineCount > 18;
    const [showAll, setShowAll] = useState(!isLong);
    const { postMessage } = useVSCodeApi();
    const themeKind = useVSCodeThemeKind();
    const syntaxTheme = themeKind === 'light' ? oneLight : vscDarkPlus;

    if (code.trim() === '') return null;

    if (language.toLowerCase() === 'diff') {
        const diffs = parseDiff(code);
        if (diffs.length > 0) {
            return (
                <div className="my-1.5">
                    <DiffView
                        diffs={diffs}
                        onApprove={() => postMessage({ type: 'send_message', payload: { content: 'I approve these changes.' } })}
                        onViewInVSCode={(path) => postMessage({ type: 'open_file', payload: { path } })}
                    />
                </div>
            );
        }
    }

    const compactLines = code
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && line !== ',');
    const isPathReferenceBlock = isPlainText && compactLines.length > 0 && compactLines.length <= 6 && compactLines.every(looksLikePathReference);

    if (isPathReferenceBlock) {
        return (
            <div className="my-1 flex max-w-full flex-wrap gap-1.5">
                {compactLines.map((line, index) => (
                    <code
                        key={`${line}-${index}`}
                        className="max-w-full truncate rounded-md bg-vscode-input-bg/70 px-1.5 py-0.5 font-mono text-[11.5px] text-vscode-fg/75"
                        title={line}
                    >
                        {line.replace(/,$/, '')}
                    </code>
                ))}
            </div>
        );
    }

    if (isPlainText && lineCount <= 6 && code.length <= 260) {
        return (
            <div className="my-1.5 flex max-w-full items-start gap-2 rounded-md bg-vscode-input-bg/45 px-2.5 py-1.5">
                <pre className="custom-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.45] text-vscode-fg/70">
                    {code}
                </pre>
                {lineCount > 1 && <CopyButton code={code} />}
            </div>
        );
    }

    if (isPlainText) {
        return (
            <div className="group my-2 max-w-full rounded-md bg-vscode-editor-background/50 px-3 py-2.5">
                <div className="flex items-start gap-2">
                    <div className={`relative min-w-0 flex-1 ${showAll ? '' : 'max-h-[360px] overflow-hidden'}`}>
                        <pre
                            data-testid="plain-text-output-block"
                            className="custom-scrollbar overflow-x-auto whitespace-pre font-mono text-[12px] leading-[1.55] text-vscode-fg/72 selection:bg-vscode-editor-selectionBackground"
                        >
                            {code}
                        </pre>
                        {!showAll && (
                            <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-vscode-editor-background via-vscode-editor-background/90 to-transparent pt-10 pb-2">
                                <button
                                    onClick={() => setShowAll(true)}
                                    className="rounded bg-vscode-editor-background px-2.5 py-1 text-[10px] font-medium text-vscode-fg/55 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/78"
                                >
                                    Show full block
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="-mr-1 -mt-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <CopyButton code={code} />
                    </div>
                </div>
                {isLong && showAll && (
                    <button
                        onClick={() => setShowAll(false)}
                        className="mt-1 rounded px-1.5 py-0.5 text-[10px] text-vscode-fg/42 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/68"
                    >
                        Collapse
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="my-2.5 max-w-full overflow-hidden rounded-lg border border-vscode-border/35 bg-vscode-input-bg/55 shadow-sm">
            <div className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="shrink-0 text-[11px] font-medium text-vscode-fg/55">{language || 'text'}</span>
                <div className="flex items-center gap-1 ml-auto">
                    <CopyButton code={code} />
                    {isTerminal && onExecuteCommand && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onExecuteCommand(code); }}
                            className="h-6 rounded bg-vscode-button-background px-2 text-[9px] font-semibold text-vscode-button-foreground hover:bg-vscode-button-hoverBackground"
                            title="Run command"
                        >
                            RUN
                        </button>
                    )}
                </div>
            </div>

            <div className={`relative ${showAll ? '' : 'max-h-[360px] overflow-hidden'}`}>
                <SyntaxHighlighter
                    language={language.toLowerCase()}
                    style={syntaxTheme}
                    customStyle={{
                        margin: 0,
                        padding: '8px 12px 12px',
                        fontSize: '12px',
                        lineHeight: '1.5',
                        background: 'transparent',
                        backgroundColor: 'transparent',
                        color: 'var(--vscode-editor-foreground)',
                        width: '100%',
                    }}
                    codeTagProps={{
                        style: {
                            background: 'transparent',
                            backgroundColor: 'transparent',
                            color: 'var(--vscode-editor-foreground)'
                        }
                    }}
                    className="ricochet-code-block custom-scrollbar overflow-x-auto selection:bg-vscode-editor-selectionBackground"
                >
                    {code}
                </SyntaxHighlighter>
                {!showAll && (
                    <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-vscode-editor-background via-vscode-editor-background/90 to-transparent pt-10 pb-2">
                        <button
                            onClick={() => setShowAll(true)}
                            className="rounded border border-vscode-widget-border bg-vscode-editor-background px-2.5 py-1 text-[10px] font-semibold text-vscode-fg/65 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg"
                        >
                            Show full block
                        </button>
                    </div>
                )}
            </div>
            {isLong && showAll && (
                <button
                    onClick={() => setShowAll(false)}
                    className="w-full border-t border-vscode-widget-border/60 py-1 text-[10px] text-vscode-fg/45 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/70"
                >
                    Collapse
                </button>
            )}
        </div>
    );
});

const InlineCode = ({ children, ...props }: { children: React.ReactNode }) => {
    const value = String(children).trim();
    const isPath = looksLikePathReference(value);
    return (
        <code
            className="inline rounded-md bg-vscode-input-bg/70 px-1.5 py-0.5 align-baseline box-decoration-clone font-mono text-[0.92em] text-vscode-fg/80"
            title={isPath ? value : undefined}
            {...props}
        >
            {isPath && <FileGlyph path={value} type={value.endsWith('/') ? 'folder' : 'file'} size="xs" className="mr-1 align-[-0.15em]" />}
            {children}
        </code>
    );
};

const isInlineMarkdownCode = (inline: unknown, className: string | undefined, node: any, code: string) => {
    if (typeof inline === 'boolean') return inline;
    if (className) return false;
    const position = node?.position;
    if (position?.start?.line && position?.end?.line) {
        return position.start.line === position.end.line;
    }
    return !code.includes('\n');
};

const MarkdownContent = memo(({ content, onExecuteCommand }: { content: string; onExecuteCommand?: (cmd: string) => void }) => {
    const { postMessage } = useVSCodeApi();
    const normalizedContent = useMemo(() => normalizeAssistantMarkdown(content), [content]);

    const components = useMemo(() => ({
        code: ({ node, inline, className, children, ...props }: any) => {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');

            if (!isInlineMarkdownCode(inline, className, node, codeString)) {
                return (
                    <CodeBlock
                        language={match ? match[1] : 'text'}
                        code={codeString}
                        onExecuteCommand={onExecuteCommand}
                    />
                );
            }

            return (
                <InlineCode {...props}>{children}</InlineCode>
            );
        },
        p: ({ children }: any) => <p className="mb-2 last:mb-0 leading-[1.55] text-[12.75px]">{children}</p>,
        ul: ({ children }: any) => <ul className="list-disc ml-4 mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }: any) => <ol className="list-decimal ml-4 mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }: any) => (
            <li className="leading-[1.55] text-[12.75px] opacity-90 pl-1 mb-0.5 text-vscode-fg/75">
                {children}
            </li>
        ),
        h1: ({ children }: any) => <h1 className="text-[16px] font-semibold mb-3 mt-5 text-vscode-fg/90 border-b border-vscode-border pb-1">{children}</h1>,
        h2: ({ children }: any) => <h2 className="text-[14px] font-semibold mb-2 mt-4 text-vscode-fg/90">{children}</h2>,
        h3: ({ children }: any) => <h3 className="text-[13px] font-semibold mb-2 mt-3 text-vscode-fg/80">{children}</h3>,
        strong: ({ children }: any) => <strong className="font-semibold text-vscode-fg/95">{children}</strong>,
        a: ({ node, ...props }: any) => {
            const href = props.href || '';
            const isCommand = href.startsWith('command:');
            const isFile = href.startsWith('file:') || href.startsWith('/') || href.endsWith('.go') || href.endsWith('.ts') || href.endsWith('.tsx') || href.endsWith('.js') || href.endsWith('.py') || href.endsWith('.md');

            return (
                <a
                    className="text-vscode-link-foreground hover:underline transition-colors font-medium cursor-pointer"
                    {...props}
                    onClick={(e) => {
                        if (isCommand || isFile) {
                            e.preventDefault();
                            if (isCommand) {
                                try {
                                    const url = new URL(href);
                                    const params = JSON.parse(decodeURIComponent(url.search.slice(1)));
                                    postMessage({ type: 'open_file', payload: { path: params.path } });
                                } catch (err) {
                                    console.error('Failed to parse command link:', err);
                                }
                            } else {
                                // Handle file protocol or direct paths
                                const cleanPath = href.replace(/^file:\/\//, '');
                                postMessage({ type: 'open_file', payload: { path: cleanPath } });
                            }
                        }
                    }}
                />
            );
        },
        blockquote: ({ children }: any) => (
            <blockquote className="border-l-2 border-vscode-border pl-4 py-1 my-3 italic text-vscode-fg/60 bg-vscode-input-bg rounded-r">
                {children}
            </blockquote>
        ),
    }), [onExecuteCommand, postMessage]);

    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={components}
        >
            {normalizedContent}
        </ReactMarkdown>
    );
});

const TimelineMarkdownContent = memo(({ content }: { content: string }) => {
    const { postMessage } = useVSCodeApi();
    const normalizedContent = useMemo(() => normalizeAssistantMarkdown(content), [content]);

    const components = useMemo(() => ({
        code: ({ node, inline, className, children, ...props }: any) => {
            const codeString = String(children).replace(/\n$/, '');
            if (!isInlineMarkdownCode(inline, className, node, codeString)) {
                return (
                    <pre className="my-1.5 max-h-[180px] overflow-auto rounded-md bg-vscode-editor-background px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-vscode-fg/68">
                        <code {...props}>{codeString}</code>
                    </pre>
                );
            }

            return (
                <InlineCode {...props}>{children}</InlineCode>
            );
        },
        p: ({ children }: any) => <p className="mb-1.5 last:mb-0 leading-[1.5] text-vscode-fg/58">{children}</p>,
        ul: ({ children }: any) => <ul className="mb-1.5 ml-4 list-disc space-y-0.5 text-vscode-fg/58 last:mb-0">{children}</ul>,
        ol: ({ children }: any) => <ol className="mb-1.5 ml-4 list-decimal space-y-0.5 text-vscode-fg/58 last:mb-0">{children}</ol>,
        li: ({ children }: any) => <li className="pl-0.5 leading-[1.45] text-vscode-fg/56">{children}</li>,
        h1: ({ children }: any) => <h1 className="mb-1.5 mt-2 text-[12.5px] font-semibold text-vscode-fg/64 first:mt-0">{children}</h1>,
        h2: ({ children }: any) => <h2 className="mb-1.5 mt-2 text-[12px] font-semibold text-vscode-fg/62 first:mt-0">{children}</h2>,
        h3: ({ children }: any) => <h3 className="mb-1 mt-1.5 text-[11.5px] font-semibold text-vscode-fg/60 first:mt-0">{children}</h3>,
        strong: ({ children }: any) => <strong className="font-semibold text-vscode-fg/68">{children}</strong>,
        em: ({ children }: any) => <em className="text-vscode-fg/54">{children}</em>,
        a: ({ node, ...props }: any) => {
            const href = props.href || '';
            const isFile = href.startsWith('file:') || href.startsWith('/') || looksLikePathReference(href);

            return (
                <a
                    className="font-medium text-vscode-link-foreground hover:underline"
                    {...props}
                    onClick={(event) => {
                        if (!isFile) return;
                        event.preventDefault();
                        postMessage({ type: 'open_file', payload: { path: href.replace(/^file:\/\//, '') } });
                    }}
                />
            );
        },
        blockquote: ({ children }: any) => (
            <blockquote className="my-1.5 rounded-md bg-vscode-input-bg/20 px-2 py-1 text-vscode-fg/52">
                {children}
            </blockquote>
        ),
    }), [postMessage]);

    return (
        <div className="timeline-thought-markdown text-[12px] leading-[1.5]">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={components}
            >
                {normalizedContent}
            </ReactMarkdown>
        </div>
    );
});

export const CompletionMarkdownCard = memo(({ content, onExecuteCommand }: { content: string; onExecuteCommand?: (cmd: string) => void }) => {
    const trimmed = content.trim();
    if (!trimmed) return null;

    return (
        <div className="ricochet-result-card ricochet-result-card--completed my-1.5 overflow-hidden rounded-lg" data-testid="completion-markdown-card">
            <div className="ricochet-result-card__header flex items-center gap-2 px-3 py-2">
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-emerald-300/80">
                    <span className="codicon codicon-check text-[12px]" />
                </span>
                <div className="min-w-0 flex-1 text-[12px] font-semibold leading-5 text-vscode-fg/78">Task completed</div>
                <CopyButton code={trimmed} />
            </div>
            <div className="ricochet-result-card__body px-3 pb-3 pt-1.5">
                <div className="prose prose-sm max-w-none text-vscode-fg/88 [&_p]:text-[12.75px] [&_li]:text-[12.75px] [&_h1]:mt-1 [&_h2]:mt-2">
                    <MarkdownContent content={trimmed} onExecuteCommand={onExecuteCommand} />
                </div>
            </div>
        </div>
    );
});

export const DraftMarkdownCard = memo(({ content, onExecuteCommand }: { content: string; onExecuteCommand?: (cmd: string) => void }) => {
    const trimmed = content.trim();
    if (!trimmed) return null;

    return (
        <div className="ricochet-result-card ricochet-result-card--draft my-1.5 overflow-hidden rounded-lg" data-testid="draft-result-card">
            <div className="ricochet-result-card__header flex items-center gap-2 px-3 py-2">
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-vscode-fg/52">
                    <span className="codicon codicon-edit text-[12px]" />
                </span>
                <div className="min-w-0 flex-1 text-[12px] font-semibold leading-5 text-vscode-fg/66">Interim answer</div>
                <CopyButton code={trimmed} title="Copy interim answer" className="opacity-55 hover:opacity-100" />
            </div>
            <div className="ricochet-result-card__body px-3 pb-3 pt-1.5">
                <div className="prose prose-sm max-w-none text-vscode-fg/78 [&_p]:text-[12.75px] [&_li]:text-[12.75px] [&_h1]:mt-1 [&_h2]:mt-2">
                    <MarkdownContent content={trimmed} onExecuteCommand={onExecuteCommand} />
                </div>
            </div>
        </div>
    );
});

function getToolDiff(tool: ToolCall, args: any): FileDiff | null {
    if (tool.name === 'replace_file_content' || tool.name === 'edit_file') {
        if (!args.TargetContent || !args.ReplacementContent) return null;
        const targetLines = args.TargetContent.split('\n');
        const replacementLines = args.ReplacementContent.split('\n');
        const startLine = parseInt(args.StartLine || args.start_line || "1", 10);

        const hunks: DiffLine[] = [
            ...targetLines.map((l: string, i: number) => ({ type: 'remove' as const, content: l, lineNumber: startLine + i })),
            ...replacementLines.map((l: string, i: number) => ({ type: 'add' as const, content: l, lineNumber: startLine + i }))
        ];
        return { path: args.TargetFile || args.path, operation: 'modify', hunks: [hunks] };
    }
    if (tool.name === 'write_to_file' || tool.name === 'write_file') {
        const content = args.CodeContent || args.content;
        const filePath = args.TargetFile || args.path;
        if (!content) return null;
        return {
            path: filePath,
            operation: args.Overwrite ? 'modify' : 'create',
            hunks: [[
                ...content.split('\n').map((l: string, i: number) => ({ type: 'add' as const, content: l, lineNumber: 1 + i }))
            ]]
        };
    }
    return null;
}

export const WorkedStatus = ({
    timeSpent,
    isStreaming,
    children
}: {
    timeSpent?: number,
    isStreaming?: boolean,
    children?: React.ReactNode
}) => {
    const [expanded, setExpanded] = useState(isStreaming);

    useEffect(() => {
        setExpanded(Boolean(isStreaming));
    }, [isStreaming]);

    const displayTime = timeSpent !== undefined ? `${timeSpent.toFixed(1)}s` : isStreaming ? '...' : null;

    return (
        <div className="my-1.5 w-full">
            <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 text-[10px] font-medium text-vscode-fg/45 hover:text-vscode-fg/70 group transition-colors"
            >
                <div className={`w-1.5 h-1.5 rounded-full ${isStreaming ? 'bg-vscode-button-bg animate-pulse' : 'bg-vscode-fg/25'}`} />
                <span>{displayTime ? `Agent activity ${displayTime}` : 'Agent activity'}</span>
                <span className={`codicon codicon-chevron-right w-3 h-3 text-vscode-fg/25 transition-transform duration-200 ${expanded ? 'rotate-90 text-vscode-fg/55' : ''}`} />
            </button>

            {expanded && (
                <div className="mt-1.5 ml-1 rounded-md bg-vscode-input-bg/25 px-2 py-1.5 flex flex-col gap-1.5 ricochet-message-enter">
                    <div className="flex flex-col gap-1">
                        {children}
                    </div>
                </div>
            )}
        </div>
    );
};



export const ProcessEventBlock = ({
    command,
    output,
    status,
    isBackground,
    cwd,
    shell,
    script,
    scriptLabel = 'Script',
    outputLabel = 'Output',
    exitCode,
    durationMs,
    actionLabel,
    defaultExpanded,
}: {
    command: string;
    output?: string;
    status?: string;
    isBackground?: boolean;
    cwd?: string;
    shell?: string;
    script?: string;
    scriptLabel?: string;
    outputLabel?: string;
    exitCode?: number;
    durationMs?: number;
    actionLabel?: string;
    defaultExpanded?: boolean;
}) => {
    const isRunning = status === 'running';
    const isWaiting = status === 'waiting';
    const isFailed = status === 'failed' || status === 'error' || (typeof exitCode === 'number' && exitCode !== 0);
    const userToggledRef = useRef(false);
    const [copied, setCopied] = useState(false);
    const trimmedCommand = command.trim();
    const trimmedOutput = (output || '').trimEnd();
    const trimmedScript = (script || '').trimEnd();
    const hasDetails = Boolean(trimmedOutput || trimmedScript || isRunning || cwd || shell);
    const inferredShell = shell || (/^python(?:3)?\b|<script>/i.test(trimmedCommand) ? 'python' : 'bash');
    const shellLabel = inferredShell === 'python' ? 'python' : inferredShell === 'bash' || inferredShell === 'sh' ? 'bash' : inferredShell;
    const initialExpanded = defaultExpanded ?? (isRunning || isWaiting || isFailed);
    const [expanded, setExpanded] = useState(initialExpanded);
    const friendlyCommand = (() => {
        if (/retrieve_context_original/i.test(trimmedCommand)) return 'Context retrieval';
        if (/^graph_status\b/i.test(trimmedCommand)) return 'Command graph_status';
        if (isBackground) return `Background ${trimmedCommand}`;
        if (actionLabel && actionLabel !== 'Command' && actionLabel !== 'Python script') return actionLabel;
        return trimmedCommand;
    })();
    const statusLabel = isWaiting
        ? 'Waiting for approval'
        : isRunning
            ? 'Running'
            : isFailed
                ? typeof exitCode === 'number' ? `Failed exit ${exitCode}` : 'Failed'
                : typeof durationMs === 'number' && durationMs > 0
                    ? `Completed ${formatWorkDuration(durationMs)}`
                    : 'Completed';
    const statusTone = isWaiting ? 'text-blue-300/70' : isRunning ? 'text-vscode-fg/56' : isFailed ? 'text-rose-300/78' : 'text-vscode-fg/44';
    const cardTone = isWaiting
        ? 'ricochet-command-card--waiting'
        : isRunning
            ? 'ricochet-command-card--running'
            : isFailed
                ? 'ricochet-command-card--failed'
                : 'ricochet-command-card--completed';
    const copyText = [trimmedCommand, trimmedScript, trimmedOutput].filter(Boolean).join('\n\n');

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(copyText || trimmedCommand);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    useEffect(() => {
        if (isRunning && !userToggledRef.current) setExpanded(true);
    }, [isRunning]);

    if (!trimmedCommand) return null;

    return (
        <div data-testid="ricochet-process-event" className={`ricochet-command-card ${cardTone} my-1.5 w-full max-w-full rounded-lg px-2.5 py-2 text-[12px]`}>
            <button
                type="button"
                disabled={!hasDetails}
                aria-expanded={hasDetails ? expanded : undefined}
                onClick={() => {
                    if (!hasDetails) return;
                    userToggledRef.current = true;
                    setExpanded(open => !open);
                }}
                className={`flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors ${hasDetails ? 'hover:bg-vscode-list-hoverBackground/30' : 'cursor-default'}`}
            >
                <span className={`codicon ${isRunning ? 'codicon-loading codicon-modifier-spin' : isWaiting ? 'codicon-shield' : isFailed ? 'codicon-error' : 'codicon-terminal'} shrink-0 text-[13px] ${isWaiting ? 'text-blue-300/65' : isFailed ? 'text-rose-300/70' : 'text-vscode-fg/42'}`} />
                <span className="shrink-0 font-mono text-[11.5px] font-semibold text-vscode-fg/50">
                    {shellLabel}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-5 text-vscode-fg/74">
                    {friendlyCommand}
                </span>
                <span className={`shrink-0 text-[10.5px] font-medium ${statusTone}`}>
                    {statusLabel}
                </span>
                {hasDetails && (
                    <span className={`codicon codicon-chevron-right shrink-0 text-[11px] text-vscode-fg/32 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
                )}
            </button>

            {hasDetails && (
                <AnimatedDisclosure open={expanded} className="mt-1">
                    <div className="space-y-2 px-1 pb-1 pt-1">
                        {(cwd || shell) && (
                            <div className="flex min-w-0 flex-wrap items-center gap-2 px-1 text-[10px] text-vscode-fg/34">
                                <span className="font-medium">{shellLabel}</span>
                                {cwd && <span className="min-w-0 truncate font-mono">{cwd}</span>}
                            </div>
                        )}
                        {trimmedScript && (
                            <div className="ricochet-command-card__panel rounded-md px-2.5 py-2">
                                <div className="mb-1 flex items-center gap-2">
                                    <span className="text-[10px] font-medium text-vscode-fg/36">{scriptLabel}</span>
                                    <span className="ml-auto" />
                                    <button
                                        type="button"
                                        onClick={handleCopy}
                                        className="flex h-5 w-5 items-center justify-center rounded text-vscode-fg/38 hover:bg-vscode-list-hoverBackground/45 hover:text-vscode-fg/70"
                                        title={copied ? 'Copied' : 'Copy'}
                                    >
                                        {copied ? <span className="codicon codicon-check text-[12px]" /> : <span className="codicon codicon-copy text-[12px]" />}
                                    </button>
                                </div>
                                <pre className="custom-scrollbar max-h-[260px] overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.45] text-vscode-fg/58 selection:bg-vscode-editor-selectionBackground">
                                    {trimmedScript}
                                </pre>
                            </div>
                        )}
                        {(trimmedOutput || isRunning) && (
                            <div className="ricochet-command-card__panel rounded-md px-2.5 py-2">
                                <div className="mb-1 flex items-center gap-2">
                                    <span className="text-[10px] font-medium text-vscode-fg/36">{outputLabel}</span>
                                    <span className="ml-auto" />
                                    {!trimmedScript && (
                                        <button
                                            type="button"
                                            onClick={handleCopy}
                                            className="flex h-5 w-5 items-center justify-center rounded text-vscode-fg/38 hover:bg-vscode-list-hoverBackground/45 hover:text-vscode-fg/70"
                                            title={copied ? 'Copied' : 'Copy'}
                                        >
                                            {copied ? <span className="codicon codicon-check text-[12px]" /> : <span className="codicon codicon-copy text-[12px]" />}
                                        </button>
                                    )}
                                </div>
                                <pre className="custom-scrollbar max-h-[360px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5] text-vscode-fg/64 selection:bg-vscode-editor-selectionBackground">
                                    {trimmedOutput || 'Waiting for output...'}
                                </pre>
                            </div>
                        )}
                        {!trimmedScript && !trimmedOutput && !isRunning && (
                            <div className="flex justify-end px-1">
                                <button
                                    type="button"
                                    onClick={handleCopy}
                                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-vscode-fg/38 hover:bg-vscode-list-hoverBackground/45 hover:text-vscode-fg/68"
                                >
                                    {copied ? <span className="codicon codicon-check text-[12px]" /> : <span className="codicon codicon-copy text-[12px]" />}
                                    {copied ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                        )}
                    </div>
                </AnimatedDisclosure>
            )}
        </div>
    );
};

export const TerminalBlock = ({ command, result, status, isBackground, cwd }: { command: string, result?: string, status: string, isBackground?: boolean, cwd?: string }) => {
    return (
        <ProcessEventBlock
            command={command}
            output={result}
            status={status}
            isBackground={isBackground}
            cwd={cwd}
            actionLabel={isBackground ? 'Background command' : 'Command'}
            defaultExpanded={status === 'running'}
        />
    );
};

export const ToolRow = ({ tool, hideSummary = false, pendingPermission, onRespond }: {
    tool: ToolCall,
    hideSummary?: boolean,
    pendingPermission?: any,
    onRespond?: (id: string, answer: string) => void
}) => {
    const { postMessage } = useVSCodeApi();
    const isScratchpad = tool.name === 'write_scratchpad' || tool.name === 'read_scratchpad';
    const isEdit = !isScratchpad && (tool.name.includes('edit') || tool.name.includes('write') || tool.name.includes('replace') || tool.name.includes('apply_diff'));
    const isShellTool = /^(?:execute_command|run_command|terminal|shell|bash|cmd|command)$/i.test(tool.name);

    // If pending permission, we show diff by default
    const [showDiff, setShowDiff] = useState((isEdit && tool.status === 'completed') || !!pendingPermission);

    const args = useMemo(() => {
        try { return typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments; } catch { return {}; }
    }, [tool.arguments]);

    const path = args.TargetFile || args.path || args.AbsolutePath || args.file || args.query || "";
    const fileName = path?.split('/').pop() || path;
    const diff = isEdit ? getToolDiff(tool, args) : null;
    const toolArgsText = typeof tool.arguments === 'string'
        ? tool.arguments
        : JSON.stringify(tool.arguments || {}, null, 2);

    if (tool.name === 'command_status' && typeof args.id === 'string' && args.id.startsWith('agent-')) {
        return (
            <div className="my-0.5 ml-1 flex items-center gap-2 text-[10px] text-vscode-fg/42">
                <span className="codicon codicon-radio-tower w-3 h-3" />
                <span>Checked agent {args.id}</span>
            </div>
        );
    }

    if (isShellTool || args.command || args.CommandLine || args.cmd || args.Cmd) {
        return (
            <TerminalBlock
                command={args.command || args.CommandLine || args.cmd || args.Cmd || tool.name}
                result={tool.result}
                status={tool.status}
                isBackground={tool.name.includes('background') || tool.name.includes('async')}
                cwd={args.cwd || args.Cwd || args.workingDirectory || args.working_directory}
            />
        );
    }

    if (isEdit && diff) {
        return (
            <div className="flex flex-col gap-1 my-1 w-full max-w-full">
                {!hideSummary && (
                    <button
                        onClick={() => setShowDiff(!showDiff)}
                        className="flex items-center gap-2 px-2 py-1.5 bg-vscode-editor-background hover:bg-vscode-list-hoverBackground rounded border border-vscode-border transition-colors w-full text-left group"
                    >
                        <span className="codicon codicon-edit w-3 h-3 text-vscode-fg/40" />
                        <span className="text-[11px] font-medium text-vscode-fg/70 truncate text-left">Edited {fileName}</span>
                        <span className="ml-auto text-[9px] font-bold shrink-0">
                            <span className="text-green-500/70">+{diff.hunks.flat().filter(l => l.type === 'add').length}</span>
                            <span className="text-red-500/70"> -{diff.hunks.flat().filter(l => l.type === 'remove').length}</span>
                        </span>
                        {showDiff ? <span className="codicon codicon-chevron-up w-3 h-3 text-vscode-fg/30" /> : <span className="codicon codicon-chevron-down w-3 h-3 text-vscode-fg/30" />}
                    </button>
                )}
                {showDiff && (
                    <div className="relative group">
                        <DiffView
                            diffs={[diff]}
                            onViewInVSCode={(p) => postMessage({ type: 'open_file', payload: { path: p } })}
                            onApprove={pendingPermission ? () => onRespond?.(pendingPermission.id, 'yes') : undefined}
                            onReject={pendingPermission ? () => onRespond?.(pendingPermission.id, 'no') : undefined}
                        />
                    </div>
                )}
            </div>
        );
    }

    // Default detailed layout for tools
    return (
        <ProcessEventBlock
            command={tool.name}
            output={tool.result}
            status={tool.status}
            script={toolArgsText && toolArgsText !== '{}' ? toolArgsText : undefined}
            scriptLabel="Input"
            outputLabel="Result"
            actionLabel={tool.name === 'write_scratchpad'
                ? 'Saved notes'
                : tool.name === 'read_scratchpad'
                    ? 'Read notes'
                    : tool.name.includes('search')
                        ? 'Searched'
                        : 'Tool'}
            defaultExpanded={tool.status === 'running'}
        />
    );
};

export const ProgressBlock = ({
    activities,
    toolCalls,
    isStreaming,
    pendingPermissions = {},
    onRespondToPermission
}: {
    activities: ActivityItem[];
    toolCalls: ToolCall[];
    isStreaming?: boolean;
    pendingPermissions?: Record<string, any>;
    onRespondToPermission?: (id: string, answer: string) => void;
}) => {
    const { postMessage } = useVSCodeApi();

    const isReadOnlyTool = (name: string) =>
        name.includes('read') || name.includes('view') || name.includes('list') ||
        name.includes('search') || name.includes('grep') || name.includes('analyze') ||
        name.startsWith('get_') || name === 'command_status';

    const isEditTool = (name: string) =>
        name.includes('write') || name.includes('edit') || name.includes('replace') || name.includes('apply_diff');

    const isCommandTool = (name: string) =>
        name.includes('command') || name.includes('run') || name === 'terminal';

    const isControlTool = (name: string) =>
        name === 'task_boundary';

    const compactPath = (path: string) => {
        if (!path) return '';
        const clean = path.replace(/\\/g, '/');
        const parts = clean.split('/').filter(Boolean);
        const srcIdx = parts.lastIndexOf('src');
        if (srcIdx >= 0) return parts.slice(srcIdx).join('/');
        if (parts.length >= 2) return parts.slice(-2).join('/');
        return parts[0] || clean;
    };

    const toolTargetKey = (tool: ToolCall) => {
        let args: any = {};
        try { args = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : (tool.arguments || {}); } catch {}
        const filePath = args.path || args.AbsolutePath || args.TargetFile || args.file || args.SearchPath || args.DirectoryPath || '';
        const query = args.query || args.Query || args.pattern || args.Pattern || '';
        if (filePath) return `${tool.name.includes('list') ? 'list_dir' : 'analyze'}:${filePath}`;
        if (query) return `search:${query}`;
        return '';
    };

    // Timeline merge and sort
    const timeline = useMemo(() => {
        const items: Array<{
            type: 'activity' | 'tool',
            data?: ActivityItem | ToolCall,
            timestamp: number
        }> = [];
        const activityKeys = new Set<string>();

        // Reasoning is intentionally not rendered in the activity timeline.
        // The useful user-facing signal here is what the agent did: tools,
        // files, commands, and worker progress.

        (activities || []).forEach(act => {
            const key = act.file ? `${act.type}:${act.file}` : act.query ? `search:${act.query}` : '';
            if (key) activityKeys.add(key);
            items.push({ type: 'activity', data: act, timestamp: act.timestamp || 0 });
        });

        (toolCalls || []).forEach(tc => {
            if (isControlTool(tc.name)) return;
            if (isReadOnlyTool(tc.name)) {
                const key = toolTargetKey(tc);
                if (key && activityKeys.has(key)) return;
            }
            items.push({ type: 'tool', data: tc, timestamp: tc.timestamp || 0 });
        });

        // Sort by timestamp (ascending)
        return items.sort((a, b) => a.timestamp - b.timestamp);
    }, [activities, toolCalls]);

    const renderActivity = (act: ActivityItem, idx: number) => {
        const fp = act.file || '';
        const bn = fp ? compactPath(fp) : act.query || '';
        let lbl = 'Read';
        if (act.type === 'edit') lbl = 'Edited';
        else if (act.type === 'search') lbl = 'Search';
        else if (act.type === 'list_dir') lbl = 'Explore';
        const ic = act.type === 'search'
            ? <TimelineGlyph path={bn} type="search" size="xs" />
            : act.type === 'list_dir'
                ? <TimelineGlyph path={bn} type="folder" size="xs" />
                : <TimelineGlyph path={bn} type="file" size="xs" />;

        return (
            <div key={`a-${idx}`} className="group flex items-start gap-3 py-1 relative">
                <div className="w-[42px] shrink-0 mt-0.5">
                    <span className="text-vscode-fg/40 font-medium text-[9px] block text-right">{lbl}</span>
                </div>
                <div className="relative z-10 w-4 flex justify-center pt-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                    {ic}
                </div>
                <div className="flex-1 min-w-0" onClick={() => fp && postMessage({ type: 'open_file', payload: { path: fp } })}>
                    <div className="flex items-center gap-2 cursor-pointer">
                        <span className="font-mono text-[10.5px] text-vscode-fg/70 truncate hover:text-vscode-fg/90 hover:underline">{bn}</span>
                        {act.lineRange && (
                            <span className="rounded bg-vscode-input-bg/45 px-1.5 py-0.5 font-mono text-[9px] leading-none text-vscode-fg/46 select-none">
                                {formatTimelineLineRange(act.lineRange)}
                            </span>
                        )}
                        {act.type === 'edit' && (
                            <div className="flex items-center gap-1.5 text-[9px] font-bold opacity-30">
                                <span className="text-green-400">+{act.additions}</span>
                                <span className="text-red-400">-{act.deletions}</span>
                            </div>
                        )}
                        <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="codicon codicon-chevron-right text-[10px] text-vscode-fg/35" />
                        </span>
                    </div>
                </div>
            </div>
        );
    };

    const renderTool = (tool: ToolCall, idx: number) => {
        if (isReadOnlyTool(tool.name)) {
            let args: any = {};
            try { args = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : (tool.arguments || {}); } catch {}
            if (tool.name === 'command_status') {
                const rawId = String(args.id || '');
                const workerId = rawId.startsWith('agent-') ? rawId : rawId ? `agent-${rawId}` : '';
                if (workerId) {
                    return (
                        <div key={`rt-${idx}`} className="group flex items-start gap-3 py-1 relative">
                            <div className="w-[42px] shrink-0 mt-0.5">
                                <span className="text-vscode-fg/35 font-medium text-[9px] block text-right">Agent</span>
                            </div>
                            <div className="relative z-10 w-4 flex justify-center pt-0.5 opacity-50">
                                <span className="codicon codicon-radio-tower text-vscode-fg/35 text-[11px]" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-[10.5px] text-vscode-fg/45 truncate">Checked {workerId}</span>
                                    <span className="text-vscode-fg/30 text-[9px] font-mono ml-auto italic lowercase">
                                        {tool.status === 'running' ? 'checking...' : 'ok'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    );
                }
            }
            const filePath = args.path || args.AbsolutePath || args.TargetFile || args.file || args.SearchPath || args.DirectoryPath || '';
            const fileName = filePath ? compactPath(filePath) : '';
            const query = args.query || args.Query || args.pattern || args.Pattern || '';
            const name = tool.name;
            let label = 'Run';
            if (name.includes('search') || name.includes('web')) label = 'Search';
            else if (name.includes('list')) label = 'Explore';
            else if (name.includes('read') || name.includes('view') || name.includes('analyze')) label = 'Read';
            const displayName = fileName || query || name;
            let icon;
            if (label === 'Search') icon = name.includes('web') ? <span className="codicon codicon-globe text-blue-400/55 text-[11px]" /> : <TimelineGlyph path={displayName} type="search" size="xs" />;
            else if (label === 'Explore') icon = <TimelineGlyph path={fileName || displayName} type="folder" size="xs" />;
            else icon = fileName ? <TimelineGlyph path={fileName} type="file" size="xs" /> : <span className="text-vscode-fg/35">●</span>;

            const sl = (args as any).StartLine || (args as any).StartLineNumber || (args as any).start_line;
            const el = (args as any).EndLine || (args as any).EndLineNumber || (args as any).end_line;
            const range = sl && el ? `#L${sl}-${el}` : sl ? `#L${sl}` : '';

            return (
                <div key={`rt-${idx}`} className="group flex items-start gap-3 py-1 relative">
                    <div className="w-[42px] shrink-0 mt-0.5">
                        <span className="text-vscode-fg/40 font-medium text-[9px] block text-right">{label}</span>
                    </div>
                    <div className="relative z-10 w-4 flex justify-center pt-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                        {icon}
                    </div>
                    <div className="flex-1 min-w-0" onClick={() => filePath && postMessage({ type: 'open_file', payload: { path: filePath } })}>
                        <div className="flex items-center gap-2 cursor-pointer">
                            <span className="font-mono text-[10.5px] text-vscode-fg/70 truncate hover:text-vscode-fg/90 hover:underline">{displayName}</span>
                            {range && (
                                <span className="rounded bg-vscode-input-bg/45 px-1.5 py-0.5 font-mono text-[9px] leading-none text-vscode-fg/46 select-none">
                                    {formatTimelineLineRange(range)}
                                </span>
                            )}
                            <span className="text-vscode-fg/35 text-[9px] font-mono ml-auto italic lowercase">
                                {tool.status === 'running' ? 'doing...' : 'ok'}
                            </span>
                        </div>
                    </div>
                </div>
            );
        }

        if (isEditTool(tool.name)) {
            let args: any = {};
            try { args = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments; } catch {}
            const path = args.TargetFile || args.path || "";
            const fileName = path.split('/').pop() || path;
            const pendingPerm = Object.values(pendingPermissions).find(p => p.question.includes(path));

            return (
                <div key={`edit-${idx}`} className="group flex items-start gap-3 py-1.5 relative">
                    <div className="w-[42px] shrink-0 mt-1">
                        <span className="text-vscode-fg/40 font-medium text-[9px] block text-right">Edit</span>
                    </div>
                    <div className="relative z-10 w-4 flex justify-center pt-1">
                        <span className="codicon codicon-edit text-blue-400/55 text-[10px]" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 cursor-pointer mb-1" onClick={() => postMessage({ type: 'open_file', payload: { path } })}>
                            <FileGlyph path={fileName || path} type="file" size="xs" />
                            <span className="font-mono text-[10.5px] text-blue-300/75 truncate hover:underline">{fileName}</span>
                            {pendingPerm && <span className="text-[9px] text-blue-300/45 font-bold ml-auto opacity-60">REVIEW</span>}
                        </div>
                        <ToolRow tool={tool} hideSummary pendingPermission={pendingPerm} onRespond={onRespondToPermission} />
                    </div>
                </div>
            );
        }

	        const isNotesTool = tool.name === 'write_scratchpad' || tool.name === 'read_scratchpad';
	        return (
	            <div key={`t-${idx}`} className="group flex items-start gap-3 py-1.5 relative">
	                <div className="w-[42px] shrink-0 mt-1">
	                    <span className="text-vscode-fg/40 font-medium text-[9px] block text-right">{isNotesTool ? 'Notes' : isCommandTool(tool.name) ? 'Run' : 'Tool'}</span>
	                </div>
	                <div className="relative z-10 w-4 flex justify-center pt-1">
	                    <span className={`codicon codicon-${isNotesTool ? 'notebook' : isCommandTool(tool.name) ? 'terminal' : 'rocket'} text-blue-500/50 text-[10px]`} />
	                </div>
                <div className="flex-1 min-w-0">
                    <ToolRow tool={tool} pendingPermission={Object.values(pendingPermissions).find(p => p.question.includes(tool.name))} onRespond={onRespondToPermission} />
                </div>
            </div>
        );
    };

    if (timeline.length === 0) return null;

    return (
        <div className="mb-2 mt-1 px-1 relative ricochet-message-enter overflow-hidden">
            <div className="relative">
                <div className="flex flex-col">
                    {timeline.map((item, i) => {
                        return item.type === 'activity'
                            ? renderActivity(item.data as ActivityItem, i)
                            : renderTool(item.data as ToolCall, i);
                    })}

	                    {isStreaming && (
	                        <div className="group flex items-start gap-3 py-1.5 relative animate-pulse">
	                            <div className="w-[42px] shrink-0 mt-1">
	                                <span className="text-vscode-fg/40 font-medium text-[9px] block text-right">
	                                    {Object.keys(pendingPermissions).length > 0 ? 'Approval' : 'Working'}
	                                </span>
	                            </div>
                            <div className="relative z-10 w-4 flex justify-center pt-1">
                                <span className="codicon codicon-loading codicon-modifier-spin text-blue-400/40 text-[10px]" />
                            </div>
	                            <div className="flex-1 mt-0.5">
	                                <span className="text-[10px] text-blue-300/30 font-bold tracking-tight">
	                                    {Object.keys(pendingPermissions).length > 0 ? 'Waiting for approval...' : 'Working...'}
	                                </span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

function formatWorkDuration(ms?: number): string {
    const secondsTotal = Math.max(0, Math.round((ms || 0) / 1000));
    const minutes = Math.floor(secondsTotal / 60);
    const seconds = secondsTotal % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}

function workEventIcon(type: WorkEvent['type']) {
    switch (type) {
        case 'commentary': return 'codicon-comment-discussion';
        case 'read': return 'codicon-file-code';
        case 'search': return 'codicon-search';
        case 'task': return 'codicon-checklist';
        case 'edit': return 'codicon-edit';
        case 'review': return 'codicon-warning';
        case 'worker': return 'codicon-radio-tower';
        case 'approval': return 'codicon-shield';
        case 'artifact': return 'codicon-file-media';
        case 'error': return 'codicon-error';
        default: return 'codicon-terminal';
    }
}

export function pathIconClass(path?: string, entryType?: string) {
    const normalizedType = (entryType || '').toLowerCase();
    if (normalizedType === 'dir' || normalizedType === 'folder' || /\/$/.test(path || '')) return 'codicon-folder';
    if (normalizedType === 'search' || normalizedType === 'result') return 'codicon-search';
    if (normalizedType === 'definition' || normalizedType === 'function' || normalizedType === 'symbol') return 'codicon-symbol-function';

    const ext = (path || '').split('.').pop()?.toLowerCase() || '';
    switch (ext) {
        case 'md': return 'codicon-markdown';
        case 'json': return 'codicon-json';
        case 'go':
        case 'rs':
        case 'ts':
        case 'tsx':
        case 'js':
        case 'jsx':
        case 'py':
        case 'java':
        case 'kt':
        case 'swift':
        case 'cpp':
        case 'c':
        case 'h':
        case 'hpp':
        case 'css':
        case 'html':
        case 'sh':
            return 'codicon-file-code';
        default:
            return 'codicon-file';
    }
}

function activityActionLabel(item: Pick<WorkEvent, 'type' | 'label'>) {
    if (item.type === 'search') return 'Searched';
    if (item.type === 'read') return 'Analyzed';
    if (item.type === 'task') return 'Created';
    if (item.type === 'review') return item.label || 'Review';
    if (item.type === 'artifact') return 'Document';
    if (item.type === 'worker') return 'Agent';
    return item.label;
}

export function summarizeWork(summary: WorkSummary): string {
    const parts: string[] = [];
    const readFiles = summary.counts.filesExplored || summary.counts.filesRead;
    const editItems = summary.items.filter(item => item.type === 'edit');
    const reviewItems = summary.items.filter(item => item.type === 'review');
    const editHasDiff = (item: WorkEvent) => Boolean(
        item.hasDiff
        || (item.additions || 0) > 0
        || (item.deletions || 0) > 0
        || item.hunks?.some(hunk => (hunk.additions || 0) > 0 || (hunk.deletions || 0) > 0 || (hunk.oldLines?.length || 0) > 0 || (hunk.newLines?.length || 0) > 0)
        || item.diffPreview?.trim()
    );
    const editFailed = (item: WorkEvent) => Boolean(item.error)
        || item.status === 'failed'
        || /conflict|failed|failure|error|reject|rejected|blocked/i.test(item.state || item.label || '');
    const changedEditFiles = new Set(editItems
        .filter(item => editHasDiff(item) && !editFailed(item))
        .map(item => item.path || item.target || item.id));
    const failedEditCount = editItems.filter(editFailed).length;
    const reviewIssueCount = reviewItems.filter(item => item.status === 'failed' || Boolean(item.error)).length;
    const failedCommandCount = summary.items.filter(item => item.type === 'command' && item.status === 'failed').length;
    const auditRejectCount = summary.items.filter(item => /shadow audit|verification rejected/i.test(`${item.label} ${item.target || ''} ${item.error || ''}`)).length;
    if (readFiles || summary.counts.foldersExplored) {
        const readParts = [
            readFiles ? plural(readFiles, 'file') : '',
            summary.counts.foldersExplored ? plural(summary.counts.foldersExplored, 'folder') : '',
        ].filter(Boolean).join(', ');
        parts.push(`explored ${readParts}`);
    }
    if (summary.counts.searches) parts.push(`performed ${plural(summary.counts.searches, 'search', 'searches')}`);
    if (summary.counts.commands) parts.push(`ran ${plural(summary.counts.commands, 'command')}`);
    if (failedCommandCount) parts.push(`${failedCommandCount} failed`);
    if (summary.counts.tasks) parts.push(`created ${plural(summary.counts.tasks, 'Hub Task')}`);
    if (changedEditFiles.size) parts.push(`edited ${plural(changedEditFiles.size, 'file')}`);
    if (failedEditCount) parts.push(`${failedEditCount} failed ${failedEditCount === 1 ? 'edit' : 'edits'}`);
    if (reviewIssueCount) parts.push(`${reviewIssueCount} review ${reviewIssueCount === 1 ? 'issue' : 'issues'}`);
    if (auditRejectCount && auditRejectCount !== reviewIssueCount) parts.push(`${auditRejectCount} audit ${auditRejectCount === 1 ? 'reject' : 'rejects'}`);
    if (summary.counts.workers) parts.push(`checked ${plural(summary.counts.workers, 'agent')}`);
    if (summary.counts.approvals) parts.push(`requested ${plural(summary.counts.approvals, 'approval')}`);
    return parts.length ? `Ricochet ${parts.join(', ')}` : '';
}

function emptyWorkSummaryText(summary: WorkSummary): string {
    if (summary.status === 'running' && summary.activityHint === 'hidden_reasoning') return 'Thinking...';
    if (summary.status === 'running') return 'Preparing the next step...';
    if (summary.activityHint === 'hidden_reasoning') return 'Only hidden reasoning was captured.';
    if (summary.activityHint === 'unassociated_tool') return 'Tool activity was not associated with this run.';
    if (summary.status === 'failed') return 'Agent failed before detailed activity was captured.';
    return 'No visible agent activity captured.';
}

function workEventDisplayTarget(item: WorkEvent) {
    const target = (item.target || '').trim();
    const label = item.label.trim();
    if (!target) return '';
    const normalizedTarget = target.replace(/[.!…]+$/g, '').toLowerCase();
    const normalizedLabel = label.replace(/[.!…]+$/g, '').toLowerCase();
    if (normalizedTarget === normalizedLabel || normalizedTarget.startsWith(`${normalizedLabel} `)) return '';
    return target;
}

function sectionTitle(type: WorkEvent['type']) {
    switch (type) {
        case 'commentary': return 'Progress';
        case 'read':
        case 'search': return 'Explored';
        case 'command': return 'Ran';
        case 'task': return 'Created Hub Tasks';
        case 'edit': return 'Edited';
        case 'review': return 'Review';
        case 'artifact': return 'Artifacts';
        case 'approval': return 'Approvals';
        case 'worker': return 'Agents';
        case 'error': return 'Errors';
        default: return 'Activity';
    }
}

const timelineSectionOrder = ['Progress', 'Created Hub Tasks', 'Explored', 'Ran', 'Edited', 'Review', 'Artifacts', 'Approvals', 'Agents', 'Errors'];

export interface ExploredTreeNode {
    key: string;
    name: string;
    path?: string;
    type: 'folder' | 'file' | 'search';
    lineRange?: string;
    status?: WorkEvent['status'];
    timestamp: number;
    children: ExploredTreeNode[];
}

function normalizeFsPath(path = '') {
    return path
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
}

function pathSegments(path = '') {
    return normalizeFsPath(path).split('/').filter(Boolean);
}

function basenameFromPath(path = '') {
    const parts = pathSegments(path);
    return parts[parts.length - 1] || path;
}

function hasFileExtension(path = '') {
    const name = basenameFromPath(path);
    return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,12}$/.test(name);
}

function isAbsolutePath(path = '') {
    return normalizeFsPath(path).startsWith('/');
}

function commonAbsoluteRoot(paths: string[]) {
    const absolutePaths = paths.map(normalizeFsPath).filter(isAbsolutePath);
    if (absolutePaths.length === 0) return '';

    const folderCandidates = [...absolutePaths]
        .filter(path => !hasFileExtension(path))
        .sort((a, b) => pathSegments(a).length - pathSegments(b).length);
    const explicitRoot = folderCandidates.find(candidate =>
        absolutePaths.every(path => path === candidate || path.startsWith(`${candidate}/`))
    );
    if (explicitRoot) return explicitRoot;

    const splitPaths = absolutePaths.map(pathSegments);
    const first = splitPaths[0] || [];
    const common: string[] = [];
    for (let index = 0; index < first.length; index += 1) {
        if (splitPaths.every(parts => parts[index] === first[index])) {
            common.push(first[index]);
        } else {
            break;
        }
    }
    return common.length ? `/${common.join('/')}` : '';
}

function displayPartsForPath(path: string, root: string) {
    const normalized = normalizeFsPath(path);
    if (!root || (normalized !== root && !normalized.startsWith(`${root}/`))) {
        return pathSegments(normalized);
    }
    const rootName = basenameFromPath(root);
    if (normalized === root) return [rootName];
    const rest = normalized.slice(root.length + 1);
    return [rootName, ...pathSegments(rest)];
}

function eventPath(item: WorkEvent) {
    return normalizeFsPath(item.path || workEventDisplayTarget(item));
}

function eventIsFolder(item: WorkEvent) {
    const path = eventPath(item);
    if (item.entries?.length || item.counts?.folders || item.label === 'Explored') return true;
    if (!path) return false;
    return path.endsWith('/') || (item.type === 'read' && !hasFileExtension(path) && item.label !== 'Read');
}

type ExploredRecord = {
    path: string;
    type: ExploredTreeNode['type'];
    lineRange?: string;
    status?: WorkEvent['status'];
    timestamp: number;
};

function entryPath(parent: string, entry: ActivityEntry) {
    if (entry.path) return normalizeFsPath(entry.path);
    if (!parent) return normalizeFsPath(entry.name);
    return normalizeFsPath(`${parent}/${entry.name}`);
}

function collectExploredRecords(items: WorkEvent[]): ExploredRecord[] {
    const records: ExploredRecord[] = [];

    items.forEach(item => {
        const path = eventPath(item);
        if (item.type === 'search') {
            records.push({
                path: item.target || item.label,
                type: 'search',
                status: item.status,
                timestamp: item.timestamp,
            });
            return;
        }

        if (path) {
            const type = eventIsFolder(item) ? 'folder' : 'file';
            records.push({
                path,
                type,
                lineRange: type === 'file' ? (item as any).lineRange : undefined,
                status: item.status,
                timestamp: item.timestamp,
            });
        }

        (item.entries || []).forEach(entry => {
            const fullPath = entryPath(path, entry);
            if (!fullPath) return;
            records.push({
                path: fullPath,
                type: entry.type === 'dir' || entry.type === 'folder' ? 'folder' : 'file',
                lineRange: entry.type === 'dir' || entry.type === 'folder' ? undefined : (entry as any).lineRange,
                status: item.status,
                timestamp: item.timestamp,
            });
        });
    });

    return records;
}

type MutableExploredNode = ExploredTreeNode & {
    order: number;
    childMap: Map<string, MutableExploredNode>;
};

function createMutableNode(
    key: string,
    name: string,
    type: ExploredTreeNode['type'],
    timestamp: number,
    path?: string,
): MutableExploredNode {
    return {
        key,
        name,
        path,
        type,
        timestamp,
        order: timestamp,
        children: [],
        childMap: new Map(),
    };
}

function toReadonlyNode(node: MutableExploredNode): ExploredTreeNode {
    const children = [...node.childMap.values()]
        .sort((a, b) => a.order - b.order || (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || a.name.localeCompare(b.name))
        .map(toReadonlyNode);
    return {
        key: node.key,
        name: node.name,
        path: node.path,
        type: node.type,
        lineRange: node.lineRange,
        status: node.status,
        timestamp: node.timestamp,
        children,
    };
}

function mergeExploredLineRange(existing?: string, incoming?: string): string | undefined {
    if (!incoming) return existing;
    if (!existing) return incoming;
    const ranges = existing.split(',').map(part => part.trim()).filter(Boolean);
    if (!ranges.includes(incoming)) ranges.push(incoming);
    return ranges.join(', ');
}

export function buildExploredTree(items: WorkEvent[]) {
    const records = collectExploredRecords(items);
    const root = commonAbsoluteRoot(records.map(record => record.path));
    const topLevel = new Map<string, MutableExploredNode>();

    const addRecord = (record: ExploredRecord) => {
        const displayParts = displayPartsForPath(record.path, root).filter(Boolean);
        if (!displayParts.length) return;
        let children = topLevel;
        let keyPrefix = '';

        displayParts.forEach((part, index) => {
            const isLeaf = index === displayParts.length - 1;
            const key = `${keyPrefix}/${part}`;
            const nodeType = isLeaf ? record.type : 'folder';
            let node = children.get(key);
            if (!node) {
                node = createMutableNode(
                    key,
                    part,
                    nodeType,
                    record.timestamp,
                    isLeaf ? record.path : undefined,
                );
                children.set(key, node);
            }

            if (record.timestamp < node.order) {
                node.order = record.timestamp;
                node.timestamp = record.timestamp;
            }
            if (isLeaf) {
                if (node.type !== 'folder') node.type = nodeType;
                if (record.type === 'folder') node.type = 'folder';
                node.path = record.path || node.path;
                node.lineRange = mergeExploredLineRange(node.lineRange, record.lineRange);
                node.status = record.status || node.status;
            } else if (node.type !== 'folder') {
                node.type = 'folder';
            }

            children = node.childMap;
            keyPrefix = key;
        });
    };

    records.forEach(addRecord);

    const nodes = [...topLevel.values()]
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
        .map(toReadonlyNode);

    const files = new Set<string>();
    const folders = new Set<string>();
    const searches = new Set<string>();
    const visit = (node: ExploredTreeNode) => {
        if (node.type === 'folder') folders.add(node.path || node.key);
        if (node.type === 'file') files.add(node.path || node.key);
        if (node.type === 'search') searches.add(node.path || node.key);
        node.children.forEach(visit);
    };
    nodes.forEach(visit);

    return {
        nodes,
        fileCount: files.size,
        folderCount: folders.size,
        searchCount: searches.size,
    };
}

function findActiveSectionTitle(items: WorkEvent[], groupedItems: Map<string, WorkEvent[]>) {
    const candidates = items.filter(item => groupedItems.has(sectionTitle(item.type)));
    if (!candidates.length) return null;

    const newestItem = candidates.reduce((latest, item) => item.timestamp >= latest.timestamp ? item : latest, candidates[0]);
    const activeItems = candidates.filter(item => item.status === 'running' || item.status === 'waiting');
    if (!activeItems.length) return sectionTitle(newestItem.type);

    const newestActiveItem = activeItems.reduce((latest, item) => item.timestamp >= latest.timestamp ? item : latest, activeItems[0]);
    return sectionTitle(newestActiveItem.timestamp >= newestItem.timestamp ? newestActiveItem.type : newestItem.type);
}

function sectionSummary(title: string, items: WorkEvent[]) {
    if (title === 'Explored') {
        const tree = buildExploredTree(items);
        const countFiles = items.reduce((sum, item) => sum + (item.counts?.files || 0), 0);
        const countFolders = items.reduce((sum, item) => sum + (item.counts?.folders || 0), 0);
        const files = Math.max(tree.fileCount, countFiles);
        const folders = Math.max(tree.folderCount, countFolders);
        const searches = tree.searchCount;
        return [
            files ? plural(files, 'file') : '',
            folders ? plural(folders, 'folder') : '',
            searches ? plural(searches, 'search', 'searches') : '',
        ].filter(Boolean).join(', ');
    }
    if (title === 'Ran') return plural(items.length, 'command');
    if (title === 'Created Hub Tasks') return plural(items.length, 'task');
    if (title === 'Progress') return plural(items.length, 'update');
    if (title === 'Review') return plural(items.length, 'issue');
    if (title === 'Agents') return plural(items.length, 'agent');
    return plural(items.length, 'item');
}

const AnimatedDisclosure = ({
    open,
    children,
    className = '',
}: {
    open: boolean;
    children: React.ReactNode;
    className?: string;
}) => (
    <div
        className={`timeline-disclosure ${className}`}
        data-open={open ? 'true' : 'false'}
        aria-hidden={!open}
    >
        <div className="timeline-disclosure-inner">
            {children}
        </div>
    </div>
);

const ShellOutputPanel = ({
    command,
    output,
    status,
    exitCode,
    durationMs,
    cwd,
    shell,
    script,
}: {
    command: string;
    output?: string;
    status?: WorkEvent['status'];
    exitCode?: number;
    durationMs?: number;
    cwd?: string;
    shell?: string;
    script?: string;
}) => {
    const isRunning = status === 'running';
    const shouldExpand = isRunning || status === 'failed' || status === 'waiting';
    const isPython = shell === 'python';

    return (
        <ProcessEventBlock
            command={command}
            output={output}
            status={status}
            exitCode={exitCode}
            durationMs={durationMs}
            cwd={cwd}
            shell={shell}
            script={script}
            actionLabel={isPython ? 'Python script' : 'Command'}
            defaultExpanded={shouldExpand}
        />
    );
};

const TimelineCommandRow = ({ item }: { item: WorkEvent }) => {
    const command = (item.command || item.target || '').trim();

    if (!command) return null;

    return (
        <ShellOutputPanel
            command={command}
            output={item.resultPreview}
            status={item.status}
            exitCode={item.exitCode}
            durationMs={item.durationMs}
            cwd={item.cwd}
            shell={item.shell}
            script={item.script}
        />
    );
};

const TimelineActivityRow = ({ item }: { item: WorkEvent }) => {
    const { postMessage } = useVSCodeApi();
    const displayTarget = workEventDisplayTarget(item);
    const hasEntries = Boolean(item.entries?.length);
    const [expanded, setExpanded] = useState(item.status === 'running' && hasEntries);
    const countText = item.counts
        ? [item.counts.files ? plural(item.counts.files, 'file') : '', item.counts.folders ? plural(item.counts.folders, 'folder') : '', item.counts.results ? plural(item.counts.results, 'result') : ''].filter(Boolean).join(', ')
        : '';

    if (item.type === 'command') {
        return <TimelineCommandRow item={item} />;
    }

    const actionLabel = activityActionLabel(item);
    const readGlyphType = hasEntries || item.label === 'Explored' ? 'folder' : 'file';
    return (
        <div className="rounded px-1 py-0.5 text-[11.5px] leading-5 hover:bg-vscode-list-hoverBackground/35">
            <div className="flex min-w-0 items-center gap-1.5">
                {item.type === 'read' ? (
                    <TimelineGlyph path={item.path || displayTarget} type={readGlyphType} size="sm" />
                ) : item.type === 'search' ? (
                    <TimelineGlyph path={item.target || displayTarget} type="search" size="sm" />
                ) : item.type === 'artifact' ? (
                    <FileGlyph path={item.path || item.target || displayTarget || 'artifact.md'} type="file" size="sm" />
                ) : item.type === 'edit' ? (
                    <FileGlyph path={item.path || displayTarget} type="file" size="sm" />
                ) : (
                    <span className={`codicon ${workEventIcon(item.type)} w-4 shrink-0 text-[12px] text-vscode-fg/38`} />
                )}
                <button
                    type="button"
                    disabled={!item.path}
                    onClick={() => item.path && postMessage({ type: 'open_file', payload: { path: item.path } })}
                    className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${item.path ? 'cursor-pointer hover:text-vscode-link-foreground' : 'cursor-default'}`}
                    title={item.path || item.target || item.label}
                >
                    <span className="shrink-0 whitespace-nowrap text-[10.5px] font-medium tracking-normal text-vscode-fg/44">
                        {actionLabel}
                    </span>
                    {displayTarget && <span className="min-w-0 truncate whitespace-nowrap font-mono text-[11.5px] font-semibold text-vscode-fg/76">{displayTarget}</span>}
                    {countText && <span className="shrink-0 text-[10.5px] text-vscode-fg/42">{countText}</span>}
                </button>
                {item.type === 'edit' && (
                    <span className="shrink-0 font-mono text-[10.5px] text-vscode-fg/45">
                        {(item.additions || 0) === 0 && (item.deletions || 0) === 0 ? (
                            <span className="text-vscode-fg/38">No changes</span>
                        ) : (
                            <>
                                <span className="text-emerald-500/80">+{item.additions || 0}</span> <span className="text-rose-500/80">-{item.deletions || 0}</span>
                            </>
                        )}
                    </span>
                )}
                {hasEntries && (
                    <button
                        type="button"
                        onClick={() => setExpanded(open => !open)}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-vscode-toolbar-hover"
                        title={expanded ? 'Collapse entries' : 'Show entries'}
                    >
                        <span className={`codicon codicon-chevron-right text-[11px] text-vscode-fg/38 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
                    </button>
                )}
                {item.status === 'waiting' && <span className="shrink-0 text-[10.5px] text-blue-400/70">waiting</span>}
            </div>
            {item.error && (
                <div className="ml-5 mt-0.5 truncate text-[10.5px] leading-4 text-rose-300/70" title={item.error}>
                    {item.error}
                </div>
            )}
            {item.type === 'edit' && item.hunks?.[0] && (
                <div className="ml-5 mt-1 rounded bg-vscode-editor-background/55 px-2 py-1.5 font-mono text-[10.5px] leading-4">
                    <div className="mb-0.5 text-vscode-fg/35">
                        #L{Math.max(1, (item.hunks[0].newStart ?? item.hunks[0].oldStart ?? 0) + 1)}
                    </div>
                    {(item.hunks[0].oldLines || []).filter(line => line.trim()).slice(0, 1).map((line, index) => (
                        <div key={`old-${index}`} className="truncate text-rose-300/60">- {line}</div>
                    ))}
                    {(item.hunks[0].newLines || []).filter(line => line.trim()).slice(0, 2).map((line, index) => (
                        <div key={`new-${index}`} className="truncate text-emerald-300/65">+ {line}</div>
                    ))}
                </div>
            )}
            <AnimatedDisclosure open={expanded && Boolean(item.entries?.length)}>
                <div className="ml-5 mt-1 grid grid-cols-1 gap-0.5">
                    {(item.entries || []).map((entry, index) => (
                        <button
                            key={`${entry.path || entry.name}-${index}`}
                            type="button"
                            disabled={!entry.path}
                            onClick={() => entry.path && postMessage({ type: 'open_file', payload: { path: entry.path } })}
                            className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11.5px] leading-5 text-vscode-fg/58 hover:bg-vscode-list-hoverBackground/60 hover:text-vscode-link-foreground"
                            title={entry.path || entry.name}
                        >
                            <TimelineGlyph path={entry.path || entry.name} type={entry.type === 'dir' ? 'folder' : 'file'} size="xs" />
                            <span className="shrink-0 whitespace-nowrap text-[10px] font-medium tracking-normal text-vscode-fg/36">
                                {entry.type === 'dir' ? 'Analyzed' : actionLabel}
                            </span>
                            <span className="min-w-0 truncate font-mono font-semibold">{entry.name}</span>
                        </button>
                    ))}
                </div>
            </AnimatedDisclosure>
        </div>
    );
};

const ExploredTreeRow = ({
    node,
    depth,
}: {
    node: ExploredTreeNode;
    depth: number;
}) => {
    const { postMessage } = useVSCodeApi();
    const canExpand = node.type === 'folder' && node.children.length > 0;
    const [expanded, setExpanded] = useState(canExpand && depth === 0);
    const actionLabel = node.type === 'search' ? 'Searched' : 'Analyzed';
    const lineRange = node.type === 'file' ? formatTimelineLineRange(node.lineRange) : '';
    const indent = Math.min(depth * 16, 56);

    const handleClick = () => {
        if (canExpand) {
            setExpanded(open => !open);
            return;
        }
        if (node.type === 'file' && node.path) {
            postMessage({ type: 'open_file', payload: { path: node.path } });
        }
    };

    return (
        <div>
            <button
                type="button"
                onClick={handleClick}
                className={`group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11.75px] leading-5 hover:bg-vscode-list-hoverBackground/35 ${node.type === 'file' && node.path ? 'cursor-pointer hover:text-vscode-link-foreground' : 'cursor-default text-vscode-fg/70'}`}
                style={{ paddingLeft: `${indent + 4}px` }}
                title={node.path || node.name}
            >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {canExpand ? (
                        <span className={`codicon codicon-chevron-right text-[11px] text-vscode-fg/36 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
                    ) : (
                        <span className="w-[11px]" />
                    )}
                </span>
                <TimelineGlyph
                    path={node.path || node.name}
                    type={node.type === 'folder' ? 'folder' : node.type === 'search' ? 'search' : 'file'}
                    size="sm"
                />
                <span className="shrink-0 whitespace-nowrap text-[10.75px] font-medium tracking-normal text-vscode-fg/44">
                    {actionLabel}
                </span>
                <span className="min-w-0 truncate whitespace-nowrap font-mono text-[11.75px] font-semibold text-vscode-fg/76">
                    {node.name}
                </span>
                {lineRange && (
                    <span className="shrink-0 rounded bg-vscode-input-bg/45 px-1.5 py-0.5 font-mono text-[10px] leading-none text-vscode-fg/46">
                        {lineRange}
                    </span>
                )}
                {node.status === 'waiting' && <span className="ml-auto shrink-0 text-[10.5px] text-blue-400/70">waiting</span>}
            </button>
            <AnimatedDisclosure open={expanded && canExpand}>
                <div className="space-y-0.5">
                    {node.children.map(child => (
                        <ExploredTreeRow key={child.key} node={child} depth={depth + 1} />
                    ))}
                </div>
            </AnimatedDisclosure>
        </div>
    );
};

const ExploredTree = ({ items }: { items: WorkEvent[] }) => {
    const tree = useMemo(() => buildExploredTree(items), [items]);
    if (!tree.nodes.length) return null;

    return (
        <div className="space-y-0.5">
            {tree.nodes.map(node => (
                <ExploredTreeRow key={node.key} node={node} depth={0} />
            ))}
        </div>
    );
};

const TimelineSection = ({
    title,
    items,
    open,
    active,
    onToggle,
}: {
    title: string;
    items: WorkEvent[];
    open: boolean;
    active: boolean;
    onToggle: () => void;
}) => {
    const summary = sectionSummary(title, items);
    const visibleItems = title === 'Explored' ? [] : items;

    return (
        <section className="ricochet-timeline-section space-y-1 px-1 py-0.5" data-open={open ? 'true' : 'false'}>
            <button
                type="button"
                onClick={onToggle}
                className={`group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-vscode-list-hoverBackground/30 ${active ? 'text-vscode-fg/70' : 'text-vscode-fg/50'}`}
                title={open ? `Collapse ${title}` : `Expand ${title}`}
            >
                <span className={`codicon codicon-chevron-right shrink-0 text-[11px] text-vscode-fg/35 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
                {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400/70" />}
                <span className="shrink-0 text-[12px] font-semibold leading-5">{title}</span>
                {summary && <span className="min-w-0 truncate text-[11px] font-medium text-vscode-fg/48">{summary}</span>}
            </button>
            <AnimatedDisclosure open={open}>
                <div className="space-y-0.5 pl-2">
                    {title === 'Explored' ? (
                        <ExploredTree items={items} />
                    ) : visibleItems.map(item => item.type === 'commentary' ? (
                        <div key={item.id} className="ricochet-timeline-note custom-scrollbar max-h-[220px] overflow-auto break-words rounded-md px-2 py-1.5 text-vscode-fg/56">
                            <TimelineMarkdownContent content={item.target || ''} />
                        </div>
                    ) : (
                        <TimelineActivityRow key={item.id} item={item} />
                    ))}
                </div>
            </AnimatedDisclosure>
        </section>
    );
};

type PendingEditItem = ChangedFileItem;

type PlanArtifact = {
    id?: string;
    type?: string;
    title?: string;
    summary?: string;
    path?: string;
    content?: string;
    session_id?: string;
    status?: string;
    decision?: string;
    decision_error?: string;
};

const isImplementationPlanArtifact = (artifact: any): artifact is PlanArtifact =>
    artifact?.type === 'implementation_plan';

const FIRST_CLASS_ARTIFACT_TYPES = new Set(['implementation_plan', 'walkthrough', 'report', 'task']);

const isRicochetArtifactPath = (path?: string) => {
    const normalized = (path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return /(^|\/)\.ricochet\/artifacts\//.test(normalized);
};

const isFirstClassArtifact = (artifact: any) => {
    if (!artifact || typeof artifact !== 'object') return false;
    const type = String(artifact.type || '').toLowerCase();
    return FIRST_CLASS_ARTIFACT_TYPES.has(type) || isRicochetArtifactPath(artifact.path);
};

const isTimelineArtifact = (artifact: any) =>
    isFirstClassArtifact(artifact) && !isImplementationPlanArtifact(artifact);

const compactArtifactTarget = (path?: string) => {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    const artifactIndex = parts.lastIndexOf('artifacts');
    if (artifactIndex >= 0 && parts.length > artifactIndex + 2) {
        return parts.slice(artifactIndex + 2).join('/');
    }
    const srcIndex = parts.lastIndexOf('src');
    if (srcIndex >= 0) return parts.slice(srcIndex).join('/');
    if (parts.length > 2) return parts.slice(-2).join('/');
    return parts.join('/') || path;
};

const artifactDisplayTarget = (artifact: any) =>
    compactArtifactTarget(artifact?.path) || artifact?.title || artifact?.type || 'Artifact';

const isRenderableWorkArtifact = (item: WorkEvent) => {
    if (item.type !== 'artifact') return false;
    if (isRicochetArtifactPath(item.path)) return true;
    const type = String(item.artifactType || '').toLowerCase();
    if (FIRST_CLASS_ARTIFACT_TYPES.has(type)) return true;
    return false;
};

const planExcerpt = (artifact: PlanArtifact) => {
    const source = (artifact.summary || artifact.content || '').trim();
    if (!source) return 'Review the implementation plan and choose how Ricochet should proceed.';
    const collapsed = source
        .replace(/^#+\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    return collapsed.length > 210 ? `${collapsed.slice(0, 207)}...` : collapsed;
};

const PlanArtifactCard = ({
    artifact,
}: {
    artifact: PlanArtifact;
}) => {
    const { postMessage } = useVSCodeApi();
    const title = artifact.title || 'Implementation Plan';
    const status = artifact.status;
    const isApproved = status === 'approved';
    const isRevisionRequested = status === 'revision_requested';
    const hasDecisionError = status === 'error';

    return (
        <div
            data-ricochet-plan-transcript-card
            className={`mb-3 rounded-md bg-vscode-input-bg/35 px-3 py-2.5 ${artifact.path ? 'cursor-pointer hover:bg-vscode-list-hoverBackground/60' : ''}`}
            role={artifact.path ? 'button' : undefined}
            tabIndex={artifact.path ? 0 : undefined}
            title={artifact.path ? `Open ${artifact.path}` : title}
            onClick={() => artifact.path && postMessage({ type: 'open_file', payload: { path: artifact.path } })}
            onKeyDown={(event) => {
                if (!artifact.path) return;
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    postMessage({ type: 'open_file', payload: { path: artifact.path } });
                }
            }}
        >
            <div className="mb-1 flex min-w-0 items-center gap-2">
                <div className="truncate text-[13px] font-semibold text-vscode-fg/88">{title}</div>
                {!status && (
                    <span className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-blue-200/80">
                        Plan created
                    </span>
                )}
                {isApproved && (
                    <span className="shrink-0 rounded bg-emerald-500/12 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300/85">
                        Approved
                    </span>
                )}
                {isRevisionRequested && (
                    <span className="shrink-0 rounded bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300/85">
                        Revision requested
                    </span>
                )}
                {hasDecisionError && (
                    <span className="shrink-0 rounded bg-red-500/12 px-1.5 py-0.5 text-[9px] font-semibold text-red-300/85">
                        Decision failed
                    </span>
                )}
            </div>
            <div className="line-clamp-2 text-[12px] leading-[1.5] text-vscode-fg/58">
                {planExcerpt(artifact)}
            </div>
            {artifact.decision_error && (
                <div className="mt-2 rounded bg-red-500/8 px-2 py-1.5 text-[11px] leading-snug text-red-200/85">
                    {artifact.decision_error}
                </div>
            )}
        </div>
    );
};

const WorkSummaryBlock = ({
    summary,
    pendingEdits = [],
}: {
    summary: WorkSummary;
    pendingEdits?: PendingEditItem[];
}) => {
    const { postMessage } = useVSCodeApi();
    const isActive = summary.status === 'running';
    const needsAttention = summary.status === 'waiting' || summary.status === 'failed';
    const shouldAutoExpand = isActive || needsAttention;
    const [expanded, setExpanded] = useState(shouldAutoExpand);
    const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
    const previousStatusRef = useRef(summary.status);
    const previousTurnIdRef = useRef(summary.turnId);
    const previousActiveSectionRef = useRef<string | null>(null);
    const userToggledRef = useRef(false);
    const manuallyToggledSectionsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (previousStatusRef.current !== summary.status) {
            previousStatusRef.current = summary.status;
            userToggledRef.current = false;
            if (['completed', 'stopped', 'rejected'].includes(summary.status)) {
                manuallyToggledSectionsRef.current.clear();
                previousActiveSectionRef.current = null;
                setOpenSections({});
            }
            setExpanded(summary.status === 'running' || summary.status === 'waiting' || summary.status === 'failed');
            return;
        }

        if (!userToggledRef.current && shouldAutoExpand) {
            setExpanded(true);
        }
    }, [summary.status, shouldAutoExpand]);

    const duration = summary.durationMs || Date.now() - summary.startedAt;
    const changedFiles = summary.items.filter(item => item.type === 'edit' && item.path);
    const artifacts = summary.items.filter(isRenderableWorkArtifact);
    const title = isActive
        ? `Working ${formatWorkDuration(duration)}`
        : summary.status === 'waiting'
            ? 'Waiting for action'
            : summary.status === 'failed'
                ? 'Stopped with error'
                : summary.status === 'stopped'
                    ? 'Stopped'
                    : `Worked ${formatWorkDuration(duration)}`;
    const subtitle = summarizeWork(summary);
    const groupedItems = summary.items.reduce((groups, item) => {
        const title = sectionTitle(item.type);
        if (!groups.has(title)) groups.set(title, []);
        groups.get(title)!.push(item);
        return groups;
    }, new Map<string, WorkEvent[]>());
    const sectionTitles = timelineSectionOrder.filter(title => groupedItems.has(title));
    const sectionTitlesKey = sectionTitles.join('|');
    const activeSectionTitle = findActiveSectionTitle(summary.items, groupedItems);

    useEffect(() => {
        if (previousTurnIdRef.current !== summary.turnId) {
            previousTurnIdRef.current = summary.turnId;
            previousActiveSectionRef.current = null;
            manuallyToggledSectionsRef.current.clear();
            setOpenSections({});
        }
    }, [summary.turnId]);

    useEffect(() => {
        if (!isActive && ['completed', 'stopped', 'rejected'].includes(summary.status)) {
            previousActiveSectionRef.current = activeSectionTitle;
            setOpenSections({});
            return;
        }

        setOpenSections(prev => {
            const manual = manuallyToggledSectionsRef.current;
            const activeChanged = previousActiveSectionRef.current !== activeSectionTitle;
            const next: Record<string, boolean> = {};

            sectionTitles.forEach((title, index) => {
                const hasExistingState = Object.prototype.hasOwnProperty.call(prev, title);
                next[title] = hasExistingState
                    ? prev[title]
                    : title === activeSectionTitle || (!activeSectionTitle && index === 0);

                if (activeSectionTitle && activeChanged && !manual.has(title)) {
                    next[title] = title === activeSectionTitle;
                } else if (title === activeSectionTitle && !manual.has(title)) {
                    next[title] = true;
                }
            });

            return next;
        });
        previousActiveSectionRef.current = activeSectionTitle;
    }, [activeSectionTitle, sectionTitlesKey]);

    return (
        <div className="mb-3 mt-1 pb-2 text-[12.5px]">
            <button
                type="button"
                onClick={() => {
                    userToggledRef.current = true;
                    setExpanded(open => !open);
                }}
                className="group flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-vscode-fg/60 hover:bg-vscode-list-hoverBackground/35 hover:text-vscode-fg/80"
            >
                <span className={`codicon ${isActive ? 'codicon-loading codicon-modifier-spin' : 'codicon-terminal'} text-[12px] text-vscode-fg/42`} />
                <span className="shrink-0 text-[13px] font-semibold">{title}</span>
                {subtitle && <span className="min-w-0 truncate text-[11.5px] text-vscode-fg/46">{subtitle}</span>}
                <span className={`codicon codicon-chevron-right ml-auto text-[11px] text-vscode-fg/30 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
            </button>

            <AnimatedDisclosure open={expanded} className="mt-2">
                <div>
                    <div className="space-y-2.5">
                        {summary.items.length === 0 ? (
                            <div className="flex items-start gap-2 text-[11px] text-vscode-fg/40">
                                <span className={`codicon ${isActive ? 'codicon-loading codicon-modifier-spin' : 'codicon-info'} mt-0.5 w-4 shrink-0 text-[12px]`} />
                                <span>{emptyWorkSummaryText(summary)}</span>
                            </div>
                        ) : sectionTitles
                            .map(title => (
                                <TimelineSection
                                    key={title}
                                    title={title}
                                    items={groupedItems.get(title)!}
                                    open={Boolean(openSections[title])}
                                    active={activeSectionTitle === title && isActive}
                                    onToggle={() => {
                                        manuallyToggledSectionsRef.current.add(title);
                                        setOpenSections(prev => ({ ...prev, [title]: !prev[title] }));
                                    }}
                                />
                            ))}
                    </div>

                    {(changedFiles.length > 0 || artifacts.length > 0 || pendingEdits.length > 0) && (
                        <div className="mt-3 space-y-1.5 pt-0.5">
                            {pendingEdits.length > 0 && (
                                <ChangedFilesSummary files={pendingEdits} mode="pending" />
                            )}

                            {changedFiles.length > 0 && (
                                <ChangedFilesSummary files={changedFiles} mode="completed" />
                            )}

                            {artifacts.length > 0 && (
                                <div>
                                    <div className="mb-1 text-[11px] font-medium text-vscode-fg/42">Artifacts</div>
                                    <div className="flex flex-col gap-1">
                                        {artifacts.map(artifact => (
                                            <button
                                                key={artifact.id}
                                                type="button"
                                                onClick={() => artifact.path && postMessage({ type: 'open_file', payload: { path: artifact.path } })}
                                                className="flex items-center gap-2 rounded border border-vscode-border bg-vscode-input-bg px-2 py-1 text-left text-[11px] text-vscode-fg/65 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg"
                                            >
                                                <FileGlyph path={artifact.path || artifact.target || 'artifact.md'} type="file" size="xs" />
                                                <span className="min-w-0 flex-1 truncate">{artifact.target || compactArtifactTarget(artifact.path) || artifact.artifactType || 'Artifact'}</span>
                                                <span className="shrink-0 text-[10px] text-vscode-fg/38">Document</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </AnimatedDisclosure>
        </div>
    );
};


const AssistantContent = ({
    message,
    workSummary,
    pendingEdits = [],
    onExecuteCommand,
    onRetryMessage
}: {
    message: ChatMessageType;
    workSummary?: WorkSummary;
    pendingEdits?: PendingEditItem[];
    onExecuteCommand?: (cmd: string) => void;
    onRetryMessage?: () => void;
}) => {
    const { body, artifacts: inlineArtifacts } = useMemo(() => parseContent(message.content), [message.content]);
    const artifacts = useMemo(() => {
        const fromMessage = Array.isArray((message as any).artifacts) ? (message as any).artifacts : [];
        const seen = new Set<string>();
        return [...fromMessage, ...inlineArtifacts].filter((artifact: any) => {
            if (!isFirstClassArtifact(artifact)) return false;
            const key = artifact.path || `${artifact.type}:${artifact.title}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }, [message, inlineArtifacts]);
    const planArtifacts = useMemo(() => artifacts.filter(isImplementationPlanArtifact), [artifacts]);
    const nonPlanArtifacts = useMemo(() => artifacts.filter(isTimelineArtifact), [artifacts]);
    const isStreaming = message.isStreaming || false;
    const messageHasWorkPayload = Boolean(message.toolCalls?.length || message.activities?.length || artifacts.length);
    const effectiveWorkSummary = useMemo<WorkSummary | undefined>(() => {
        if (workSummary) {
            if (message.errorInfo && workSummary.items.length === 0) return undefined;
            return workSummary;
        }
        if (nonPlanArtifacts.length === 0) return undefined;
        const timestamp = message.timestamp || Date.now();
        return {
            turnId: message.turn_id || message.run_id || message.id,
            sessionId: undefined,
                status: 'completed',
                startedAt: timestamp,
            completedAt: timestamp,
            durationMs: 0,
            counts: {
                filesRead: 0,
                filesExplored: 0,
                foldersExplored: 0,
                searches: 0,
                commands: 0,
                edits: 0,
                workers: 0,
                approvals: 0,
            },
            items: nonPlanArtifacts.map((artifact: any, index: number) => ({
                id: `artifact-${artifact.path || artifact.title || index}`,
                type: 'artifact',
                label: 'Document',
                target: artifactDisplayTarget(artifact),
                path: artifact.path,
                artifactType: artifact.type,
                status: 'completed',
                timestamp,
            })),
        };
    }, [message.errorInfo, message.id, message.run_id, message.timestamp, message.turn_id, nonPlanArtifacts, workSummary]);

    const cleanedBody = useMemo(() => {
        let text = body;
        artifacts.forEach((art: any) => {
            if (!art.path) return;
            const escapedPath = art.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const linkRegex = new RegExp(`\\[.*?\\]\\(${escapedPath}\\)`, 'g');
            text = text.replace(linkRegex, '');
        });
        const visible = cleanAssistantVisibleText(text);
        return messageHasWorkPayload ? normalizeWorkCommentaryText(visible) : visible;
    }, [body, artifacts, messageHasWorkPayload]);

    const blocks = useMemo(() => splitMessageIntoBlocks(cleanedBody), [cleanedBody]);
    const textBlocks = useMemo(() => blocks.filter(block => block.type !== 'thinking' && block.content.trim()), [blocks]);
    const runPhase = message.metadata?.runPhase;
    const shouldUseDraftCard = Boolean(runPhase === 'intermediate' && cleanedBody.trim() && !message.errorInfo);
    const suppressCompletionCard = effectiveWorkSummary?.status === 'stopped'
        || effectiveWorkSummary?.status === 'failed'
        || effectiveWorkSummary?.status === 'rejected';
    const shouldUseCompletionCard = Boolean(!isStreaming && cleanedBody.trim() && !suppressCompletionCard && !runPhase && messageHasWorkPayload && effectiveWorkSummary?.status === 'completed' && !message.errorInfo);
    const shouldRenderPlainAssistantText = Boolean(cleanedBody.trim() && !shouldUseCompletionCard && !shouldUseDraftCard);

    if (!cleanedBody && planArtifacts.length === 0 && !effectiveWorkSummary && !message.errorInfo) {
        return null;
    }

    return (
        <div className="flex flex-col text-[12.5px] pb-1">
            {effectiveWorkSummary && (
                <WorkSummaryBlock
                    summary={effectiveWorkSummary}
                    pendingEdits={pendingEdits}
                />
            )}

            {message.errorInfo && (
                <ChatErrorCard
                    errorInfo={message.errorInfo}
                    onRetry={onRetryMessage}
                />
            )}

            {planArtifacts.map((artifact, index) => (
                <PlanArtifactCard
                    key={artifact.id || artifact.path || `${artifact.title || 'plan'}-${index}`}
                    artifact={artifact}
                />
            ))}

            <div className={`prose prose-sm max-w-none text-vscode-fg ${isStreaming ? 'opacity-90' : ''}`}>
                {shouldUseCompletionCard ? (
                    <CompletionMarkdownCard content={cleanedBody} onExecuteCommand={onExecuteCommand} />
                ) : shouldUseDraftCard ? (
                    <DraftMarkdownCard content={cleanedBody} onExecuteCommand={onExecuteCommand} />
                ) : shouldRenderPlainAssistantText ? (
                    <div className="group/assistant-message relative pr-7" data-testid="assistant-message-body">
                        {!isStreaming && (
                            <CopyButton
                                code={cleanedBody}
                                title="Copy message"
                                className={`absolute right-0 top-0 transition-opacity ${runPhase === 'final'
                                    ? 'opacity-80 hover:opacity-100 focus:opacity-100'
                                    : 'opacity-0 group-hover/assistant-message:opacity-100 focus:opacity-100'
                                }`}
                            />
                        )}
                        {textBlocks.map((block, idx) => (
                            <MarkdownContent key={idx} content={block.content} onExecuteCommand={onExecuteCommand} />
                        ))}
                    </div>
                ) : null}
                {(isStreaming && !cleanedBody) ? (
                    <div className="flex items-center gap-2 text-vscode-fg/40 py-2">
                        <span className="codicon codicon-loading codicon-modifier-spin w-3 h-3 animate-spin" />
                        <span className="text-[11px] animate-pulse">Thinking...</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
};

function queuedTurnLabel(queuedTurn: QueuedTurnState): string {
    if (queuedTurn.status === 'failed') return queuedTurn.error || 'Queued message failed';
    if (queuedTurn.status === 'running') return 'Running queued turn';
    return queuedTurn.queueLength && queuedTurn.queueLength > 1
        ? `Queued for current run (${queuedTurn.queueLength} waiting)`
        : 'Queued for current run';
}

const UserContent = ({
    content,
    via,
    remoteUsername,
    queuedTurn,
    contextFiles = [],
}: {
    content: string;
    via?: 'telegram' | 'discord' | 'ide';
    remoteUsername?: string;
    queuedTurn?: QueuedTurnState;
    contextFiles?: ContextFilePayload[];
}) => {
    const legacy = useMemo(() => extractLegacyContextFiles(content), [content]);
    const visibleContent = legacy.content || content.trim();
    const attachments = useMemo(() => {
        const merged = [...contextFiles, ...legacy.contextFiles];
        const seen = new Set<string>();
        return merged.filter(file => {
            const key = file.stagedPath || file.path;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }, [contextFiles, legacy.contextFiles]);
    const isRedundantName = remoteUsername && via && remoteUsername.toLowerCase() === via.toLowerCase();
    const remoteLabel = messengerLabel(via);
    const queuedIcon = queuedTurn?.status === 'running'
        ? 'codicon-loading codicon-modifier-spin'
        : queuedTurn?.status === 'failed'
            ? 'codicon-error'
            : 'codicon-clock';
    return (
        <div className="flex flex-col items-end w-full px-2 mb-2">
            <div className="flex items-center gap-2 mb-1.5 px-2">
                {(!isRedundantName && remoteUsername) ? <span className="text-[10px] text-vscode-fg/45 font-medium">{remoteUsername}</span> : null}
                {via && via !== 'ide' ? (
                    <span
                        className="inline-flex items-center justify-center text-cyan-400"
                        title={remoteLabel}
                        aria-label={remoteLabel}
                    >
                        <MessengerIcon via={via} className="h-4 w-4" />
                    </span>
                ) : null}
            </div>
            {attachments.length > 0 ? (
                <div className="mb-1.5 flex max-w-[88%] flex-wrap justify-end gap-1.5">
                    {attachments.map((file, index) => {
                        const displayName = contextFileDisplayName(file);
                        const path = file.stagedPath || file.path;
                        return (
                            <div
                                key={`${path}-${index}`}
                                title={path}
                                className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md bg-vscode-input-bg/70 px-2 py-1 text-[11px] text-vscode-fg/68"
                            >
                                <FileGlyph path={displayName || path} type={file.kind === 'folder' ? 'folder' : 'file'} size="xs" />
                                <span className="min-w-0 truncate font-medium">{displayName}</span>
                                <span className="shrink-0 text-[10px] text-vscode-fg/38">{contextFileMeta(file)}</span>
                            </div>
                        );
                    })}
                </div>
            ) : null}
            {visibleContent ? (
                <div className="max-w-[88%] py-3 px-4 rounded-md rounded-tr-sm whitespace-pre-wrap text-[13px] leading-relaxed border border-vscode-border bg-vscode-input-bg text-vscode-fg/90 transition-colors hover:bg-vscode-list-hoverBackground">
                    {visibleContent}
                </div>
            ) : null}
            {queuedTurn ? (
                <div className={`mt-1.5 flex max-w-[88%] items-center gap-1.5 rounded px-2 py-0.5 text-[10.5px] ${
                    queuedTurn.status === 'failed'
                        ? 'border border-red-500/25 bg-red-500/10 text-red-300'
                        : 'border border-vscode-border/60 bg-vscode-input-bg/60 text-vscode-fg/55'
                }`}>
                    <span className={`codicon ${queuedIcon} text-[11px]`} />
                    <span className="min-w-0 truncate">{queuedTurnLabel(queuedTurn)}</span>
                </div>
            ) : null}
        </div>
    );
};

export function ChatMessage({
    message,
    workSummary,
    queuedTurn,
    pendingEdits = [],
    onExecuteCommand,
    onRetryMessage,
    onRestore
}: {
    message: ChatMessageType;
    workSummary?: WorkSummary;
    queuedTurn?: QueuedTurnState;
    pendingEdits?: PendingEditItem[];
    onExecuteCommand?: (command: string) => void;
    onRetryMessage?: () => void;
    onRestore?: (hash: string) => void;
}) {
    const isAssistant = message.role === 'assistant';
    if (isAssistant && !isRenderableChatMessage(message) && !workSummary) {
        return null;
    }

    return (
        <div className="py-3 px-1 transition-colors">
            {isAssistant ? (
                <div className="px-3 animate-fade-in">
                    <div className="flex items-center gap-2 mb-2 pl-1 opacity-40 hover:opacity-100 transition-opacity">
                        <span className="text-[10px] text-vscode-fg/40 truncate select-none">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {(message.checkpointHash && onRestore) ? (
                            <button onClick={() => onRestore(message.checkpointHash!)} className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded bg-vscode-input-bg hover:bg-vscode-list-hoverBackground border border-vscode-border text-[9px] font-medium text-vscode-fg/55 hover:text-vscode-fg/80 transition-colors" title={`Restore workspace to checkpoint ${message.checkpointHash.slice(0, 8)}`}><span className="codicon codicon-history w-3 h-3" />Restore</button>
                        ) : null}
                    </div>
                    <AssistantContent
                        message={message}
                        workSummary={workSummary}
                        pendingEdits={pendingEdits}
                        onExecuteCommand={onExecuteCommand}
                        onRetryMessage={onRetryMessage}
                    />
                </div>
            ) : (
                <>
                    <UserContent
                        content={message.content}
                        via={message.via}
                        remoteUsername={message.remoteUsername}
                        queuedTurn={queuedTurn}
                        contextFiles={message.contextFiles || message.context_files || []}
                    />
                    {workSummary && (
                        <div className="px-3 pt-1">
                            <WorkSummaryBlock
                                summary={workSummary}
                                pendingEdits={pendingEdits}
                            />
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
