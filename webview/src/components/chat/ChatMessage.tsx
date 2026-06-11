import React, { useState, useMemo, useEffect, useRef, memo } from 'react';
import { ChatMessage as ChatMessageType, ToolCall, ActivityItem, WorkEvent, WorkSummary, normalizeWorkCommentaryText } from '@hooks/useChat';
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

// --- Types ---


// --- Utils ---

const parseContent = (content: string) => {
    return {
        body: content.trim(),
        artifacts: [] as any[]
    };
};

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

const CopyButton = ({ code }: { code: string }) => {
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
            className="flex h-6 w-6 items-center justify-center rounded text-vscode-fg/45 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/80"
            title={copied ? 'Copied' : 'Copy code'}
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
                <div className="ml-4 mt-1 border-l border-vscode-border/45 pl-2">
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
    const trimmed = line.trim().replace(/^`|`$/g, '').replace(/,$/, '');
    if (!trimmed) return false;
    if (/^[./~\w@-]+(?:[\\/][.\w@ -]+)+\/?$/.test(trimmed)) return true;
    return /^[\w@.-]+(?:\.(?:rs|go|ts|tsx|js|jsx|json|md|toml|yaml|yml|py|sh|css|html))(?::\d+)?$/.test(trimmed);
};

export const looksLikeIdentifierReference = (line: string) => {
    const trimmed = line.trim().replace(/^`|`$/g, '').replace(/,$/, '');
    if (!trimmed || looksLikePathReference(trimmed)) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed);
};

export const normalizeParenthesizedPathReferences = (text: string) => {
    return text.replace(/\(\s*\n[ \t]*(?:`([^`\n]+)`|([^()\n]+?))[ \t]*\n[ \t]*\)/g, (match, backtickedPath, rawPath) => {
        const path = String(backtickedPath || rawPath || '').trim().replace(/,$/, '');
        if (!looksLikePathReference(path)) return match;
        return `(\`${path}\`)`;
    });
};

export const normalizeBrokenReferenceLines = (text: string) => {
    return text
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
    const isIdentifier = looksLikeIdentifierReference(value);
    return (
        <code
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-vscode-input-bg/70 px-1.5 py-0.5 align-baseline font-mono text-[0.92em] text-vscode-fg/80"
            title={isPath || isIdentifier ? value : undefined}
            {...props}
        >
            {isPath && <FileGlyph path={value} type={value.endsWith('/') ? 'folder' : 'file'} size="xs" />}
            {!isPath && isIdentifier && <FileGlyph path={value} type="symbol" size="xs" mono />}
            <span className="min-w-0 truncate">{children}</span>
        </code>
    );
};

const MarkdownContent = memo(({ content, onExecuteCommand }: { content: string; onExecuteCommand?: (cmd: string) => void }) => {
    const { postMessage } = useVSCodeApi();
    const normalizedContent = useMemo(() => normalizeAssistantMarkdown(content), [content]);

    const components = useMemo(() => ({
        code: ({ node, inline, className, children, ...props }: any) => {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');

            if (!inline) {
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
        code: ({ inline, children, ...props }: any) => {
            if (!inline) {
                return (
                    <pre className="my-1.5 max-h-[180px] overflow-auto rounded-md bg-vscode-editor-background px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-vscode-fg/68">
                        <code {...props}>{String(children).replace(/\n$/, '')}</code>
                    </pre>
                );
            }

            return (
                <InlineCode {...props}>{children}</InlineCode>
            );
        },
        p: ({ children }: any) => <p className="mb-1.5 last:mb-0 leading-[1.5] text-vscode-fg/76">{children}</p>,
        ul: ({ children }: any) => <ul className="mb-1.5 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>,
        ol: ({ children }: any) => <ol className="mb-1.5 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>,
        li: ({ children }: any) => <li className="pl-0.5 leading-[1.45] text-vscode-fg/74">{children}</li>,
        h1: ({ children }: any) => <h1 className="mb-1.5 mt-2 text-[12.5px] font-semibold text-vscode-fg/82 first:mt-0">{children}</h1>,
        h2: ({ children }: any) => <h2 className="mb-1.5 mt-2 text-[12px] font-semibold text-vscode-fg/80 first:mt-0">{children}</h2>,
        h3: ({ children }: any) => <h3 className="mb-1 mt-1.5 text-[11.5px] font-semibold text-vscode-fg/76 first:mt-0">{children}</h3>,
        strong: ({ children }: any) => <strong className="font-semibold text-vscode-fg/88">{children}</strong>,
        em: ({ children }: any) => <em className="text-vscode-fg/70">{children}</em>,
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
            <blockquote className="my-1.5 border-l border-vscode-border pl-2 text-vscode-fg/58">
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
        <div className="my-1.5 overflow-hidden rounded-md border border-vscode-border bg-vscode-input-bg/28 shadow-[0_1px_0_rgba(255,255,255,0.025)]" data-testid="completion-markdown-card">
            <div className="flex items-center gap-2 px-3 py-2">
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-emerald-300/80">
                    <span className="codicon codicon-check text-[12px]" />
                </span>
                <div className="min-w-0 flex-1 text-[12px] font-semibold leading-5 text-vscode-fg/78">Task completed</div>
                <CopyButton code={trimmed} />
            </div>
            <div className="border-t border-vscode-border/45 px-3 pb-3 pt-2">
                <div className="prose prose-sm max-w-none text-vscode-fg/88 [&_p]:text-[12.75px] [&_li]:text-[12.75px] [&_h1]:mt-1 [&_h2]:mt-2">
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
                <div className="mt-1.5 ml-1 border-l border-vscode-border pl-3 flex flex-col gap-1.5 animate-in fade-in slide-in-from-left-2 duration-300">
                    <div className="flex flex-col gap-1">
                        {children}
                    </div>
                </div>
            )}
        </div>
    );
};



export const TerminalBlock = ({ command, result, status, isBackground }: { command: string, result?: string, status: string, isBackground?: boolean }) => {
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    const workspacePath = '~/GRIKAI/Ricochet'; // Placeholder, could be dynamic
    const hasOutput = Boolean((result || '').trim());

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="flex flex-col gap-1 my-1 w-full max-w-[98%]">
            <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-2 px-2 py-1.5 transition-colors text-left group hover:bg-vscode-list-hoverBackground rounded-md"
            >
                <span className="text-[10px] text-vscode-fg/45 font-medium">
                    {isBackground ? 'Ran background command' : 'Ran command'}
                </span>
                <span className={`codicon codicon-chevron-down w-3 h-3 text-vscode-fg/30 transition-transform ${expanded ? '' : '-rotate-90'}`} />
            </button>

            {expanded && (
                <div className="flex flex-col bg-vscode-input-bg rounded-md border border-vscode-border overflow-hidden shadow-sm animate-in zoom-in-95 duration-200">
                    {/* Header/Prompt Line */}
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-vscode-editor-background border-b border-vscode-border">
                        <div className="flex items-center gap-2 font-mono text-[11.5px] flex-1 truncate">
                            <span className="text-vscode-fg/45">{workspacePath} $</span>
                            <span className="text-vscode-fg/75 truncate">{command}</span>
                        </div>
                        <button onClick={handleCopy} className="ml-2 p-1.5 hover:bg-vscode-list-hoverBackground rounded transition-colors">
                            {copied ? <span className="codicon codicon-check text-emerald-400 w-3.5 h-3.5" /> : <span className="codicon codicon-copy text-vscode-fg/45 w-3.5 h-3.5" />}
                        </button>
                    </div>

                    {(hasOutput || status === 'running') && (
                        <div className="p-3 font-mono text-[11px] leading-relaxed text-vscode-fg/65 whitespace-pre-wrap break-all custom-scrollbar max-h-[400px] overflow-y-auto selection:bg-vscode-editor-selectionBackground">
                            {hasOutput ? result : "Running..."}
                        </div>
                    )}

                    {/* Footer */}
                    <div className="flex items-center justify-between px-3 py-2 bg-vscode-editor-background border-t border-vscode-border text-[9.5px] font-medium text-vscode-fg/35">
                        <div className="flex items-center gap-1.5 hover:text-vscode-fg/60 cursor-pointer transition-colors">
                            <span>Always run</span>
                            <span className="codicon codicon-chevron-up w-3 h-3" />
                        </div>
                        <div className="flex items-center gap-2">
                            {status === 'error' && <span className="text-rose-500/50">Command Failed</span>}
                            {status !== 'running' && <span>{status === 'error' ? '✕ Failed' : '✓ Success'}</span>}
                            {status === 'running' && <span>Running...</span>}
                        </div>
                    </div>
                </div>
            )}
        </div>
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
    const [showDropdown, setShowDropdown] = useState(false);

    const args = useMemo(() => {
        try { return typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments; } catch { return {}; }
    }, [tool.arguments]);

    const path = args.TargetFile || args.path || args.AbsolutePath || args.file || args.query || "";
    const fileName = path?.split('/').pop() || path;
    const diff = isEdit ? getToolDiff(tool, args) : null;

    if (tool.name === 'command_status' && typeof args.id === 'string' && args.id.startsWith('agent-')) {
        return (
            <div className="my-0.5 ml-1 flex items-center gap-2 text-[10px] text-vscode-fg/42">
                <span className="codicon codicon-radio-tower w-3 h-3" />
                <span>Checked worker {args.id}</span>
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
        <div className="flex flex-col gap-1 my-1 ml-1 w-full max-w-[95%]">
            <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-2 px-2 py-1.5 bg-vscode-editor-background hover:bg-vscode-list-hoverBackground rounded border border-vscode-border transition-colors w-full text-left group"
            >
                <div className="flex items-center gap-2">
                    <span className={`text-[12px] font-medium ${tool.status === 'running' ? 'text-blue-400' : 'text-vscode-fg/70'}`}>
                        {tool.name === 'write_scratchpad' ? 'Saved notes' : tool.name === 'read_scratchpad' ? 'Read notes' : tool.name.includes('search') ? 'Searched' : 'Ran'}
                    </span>
                    <span className="font-mono text-[11px] truncate max-w-[200px] text-vscode-fg/90">{tool.name}</span>
                </div>

                <div className="ml-auto flex items-center gap-2 shrink-0">
                    {tool.status === 'running' && <span className="codicon codicon-loading codicon-modifier-spin text-blue-400 w-3 h-3" />}
                    {tool.status === 'completed' && <span className="codicon codicon-pass text-vscode-fg/30 w-3 h-3 group-hover:text-vscode-fg/60 transition-colors" />}
                    {tool.status === 'error' && <span className="codicon codicon-error text-red-500/70 w-3 h-3" />}
                    {showDropdown ? <span className="codicon codicon-chevron-up w-3 h-3 text-vscode-fg/30" /> : <span className="codicon codicon-chevron-down w-3 h-3 text-vscode-fg/30" />}
                </div>
            </button>

            {showDropdown && (
                <div className="p-2.5 border-l-2 border-vscode-widget-border/30 ml-2 mt-0.5 text-[11px] font-mono rounded-r bg-vscode-input-bg">
                    <div className="text-vscode-fg/40 mb-1 select-none font-bold tracking-wider uppercase text-[9px]">Input Payload</div>
                    <div className="text-vscode-fg/80 whitespace-pre-wrap break-all mb-3 text-[11px]">{typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments, null, 2)}</div>

                    {tool.result && (
                        <div className="mt-3">
                            <div className="text-vscode-fg/40 mb-1 select-none font-bold tracking-wider uppercase text-[9px]">Execution Output</div>
                            <div className="text-vscode-fg/80 whitespace-pre-wrap break-all max-h-48 overflow-y-auto custom-scrollbar p-2 bg-vscode-editor-background rounded border border-vscode-border leading-relaxed">{tool.result}</div>
                        </div>
                    )}
                </div>
            )}
        </div>
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
            ? <FileGlyph path={bn} type="search" size="xs" />
            : act.type === 'list_dir'
                ? <FileGlyph path={bn} type="folder" size="xs" />
                : <FileGlyph path={bn} type="file" size="xs" />;

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
                        {act.lineRange && <span className="text-vscode-fg/35 text-[9px] font-mono select-none">{act.lineRange.startsWith('#L') ? act.lineRange : `#L${act.lineRange}`}</span>}
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
                                <span className="text-vscode-fg/35 font-medium text-[9px] block text-right">Worker</span>
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
            if (label === 'Search') icon = name.includes('web') ? <span className="codicon codicon-globe text-blue-400/55 text-[11px]" /> : <span className="codicon codicon-search text-blue-400/55 text-[11px]" />;
            else if (label === 'Explore') icon = <FileGlyph path={fileName || displayName} type="folder" size="xs" />;
            else icon = fileName ? <FileGlyph path={fileName} type="file" size="xs" /> : <span className="text-vscode-fg/35">●</span>;

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
                            {range && <span className="text-vscode-fg/35 text-[9px] font-mono select-none">{range}</span>}
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
        <div className="mb-2 mt-1 px-1 relative animate-in fade-in duration-300 overflow-hidden">
            <div className="relative">
                <div className="absolute left-[57px] top-2 bottom-4 w-[1px] bg-vscode-border" />
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
        case 'edit': return 'codicon-edit';
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
    if (item.label === 'Explored') return 'Explored';
    if (item.type === 'read') return 'Read';
    if (item.type === 'artifact') return 'Document';
    if (item.type === 'worker') return 'Worker';
    return item.label;
}

export function summarizeWork(summary: WorkSummary): string {
    const parts: string[] = [];
    const readFiles = summary.counts.filesExplored || summary.counts.filesRead;
    if (readFiles || summary.counts.foldersExplored) {
        const readParts = [
            readFiles ? plural(readFiles, 'file') : '',
            summary.counts.foldersExplored ? plural(summary.counts.foldersExplored, 'folder') : '',
        ].filter(Boolean).join(', ');
        parts.push(`read ${readParts}`);
    }
    if (summary.counts.searches) parts.push(`performed ${plural(summary.counts.searches, 'search', 'searches')}`);
    if (summary.counts.commands) parts.push(`ran ${plural(summary.counts.commands, 'command')}`);
    if (summary.counts.edits) parts.push(`edited ${plural(summary.counts.edits, 'file')}`);
    if (summary.counts.workers) parts.push(`checked ${plural(summary.counts.workers, 'worker')}`);
    if (summary.counts.approvals) parts.push(`requested ${plural(summary.counts.approvals, 'approval')}`);
    return parts.length ? `Ricochet ${parts.join(', ')}` : '';
}

function emptyWorkSummaryText(summary: WorkSummary): string {
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
        case 'commentary': return 'Thought / plan';
        case 'read':
        case 'search': return 'Explored / read / searched';
        case 'command': return 'Ran';
        case 'edit': return 'Edited';
        case 'artifact': return 'Artifacts';
        case 'approval': return 'Approvals';
        case 'worker': return 'Workers';
        case 'error': return 'Errors';
        default: return 'Activity';
    }
}

const timelineSectionOrder = ['Thought / plan', 'Explored / read / searched', 'Ran', 'Edited', 'Artifacts', 'Approvals', 'Workers', 'Errors'];

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
    if (title === 'Explored / read / searched') {
        const files = items.reduce((sum, item) => sum + (item.counts?.files || 0), 0);
        const folders = items.reduce((sum, item) => sum + (item.counts?.folders || 0), 0);
        const reads = items.filter(item => item.type === 'read' && !item.counts?.files && !item.counts?.folders).length;
        const searches = items.filter(item => item.type === 'search').length;
        return [
            files ? plural(files, 'file') : '',
            folders ? plural(folders, 'folder') : '',
            reads ? plural(reads, 'read') : '',
            searches ? plural(searches, 'search', 'searches') : '',
        ].filter(Boolean).join(', ');
    }
    if (title === 'Ran') return plural(items.length, 'command');
    if (title === 'Thought / plan') return plural(items.length, 'note');
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
    const isFailed = status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0);
    const isPython = shell === 'python';
    const footerLabel = isRunning ? 'Running...' : isFailed ? '✕ Failed' : '✓ Success';
    const footerTone = isRunning ? 'text-blue-300/70' : isFailed ? 'text-red-300/80' : 'text-vscode-fg/48';
    const trimmedOutput = (output || '').trimEnd();
    const trimmedScript = (script || '').trimEnd();
    const copyText = [command, trimmedScript, trimmedOutput].filter(Boolean).join('\n\n');

    return (
        <div className="overflow-hidden rounded-xl bg-[#2b2b2b] shadow-none">
            <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-[12px] font-medium text-vscode-fg/62">{isPython ? 'Python' : 'Shell'}</span>
                {cwd && <span className="min-w-0 truncate font-mono text-[10.5px] text-vscode-fg/35">{cwd}</span>}
                <span className="ml-auto" />
                <CopyButton code={copyText} />
            </div>
            <div className="px-3 pb-2">
                <div className="font-mono text-[11.5px] leading-[1.45] text-vscode-fg/86">
                    <span className="text-vscode-fg/38">$ </span>
                    <span className="whitespace-pre-wrap break-words">{command}</span>
                </div>
            </div>
            {trimmedScript && (
                <div className="px-3 pb-2">
                    <div className="mb-1 text-[10px] font-medium text-vscode-fg/38">Script</div>
                    <pre className="custom-scrollbar max-h-[260px] overflow-auto whitespace-pre rounded-md bg-vscode-editor-background/45 px-2.5 py-2 font-mono text-[10.5px] leading-[1.45] text-vscode-fg/58 selection:bg-vscode-editor-selectionBackground">
                        {trimmedScript}
                    </pre>
                </div>
            )}
            {(trimmedOutput || isRunning) && (
                <div className="px-3 py-2">
                    {trimmedScript && <div className="mb-1 text-[10px] font-medium text-vscode-fg/38">Output</div>}
                    <pre className="custom-scrollbar max-h-[360px] overflow-auto whitespace-pre font-mono text-[11.5px] leading-[1.5] text-vscode-fg/66 selection:bg-vscode-editor-selectionBackground">
                        {trimmedOutput || 'Waiting for output...'}
                    </pre>
                </div>
            )}
            <div className={`flex items-center justify-end gap-2 px-3 py-2 text-[11px] ${footerTone}`}>
                {typeof exitCode === 'number' && <span className="font-mono text-[10.5px] text-vscode-fg/38">exit {exitCode}</span>}
                {typeof durationMs === 'number' && <span className="font-mono text-[10.5px] text-vscode-fg/38">{formatWorkDuration(durationMs)}</span>}
                <span>{footerLabel}</span>
            </div>
        </div>
    );
};

const TimelineCommandRow = ({ item }: { item: WorkEvent }) => {
    const [expanded, setExpanded] = useState(item.status === 'running');
    const userToggledRef = useRef(false);
    const command = (item.command || item.target || '').trim();
    const output = (item.resultPreview || '').trimEnd();
    const hasOutput = output.trim().length > 0;
    const isRunning = item.status === 'running';
    const hasScript = Boolean(item.script?.trim());
    const isPython = item.shell === 'python' || item.label === 'Ran Python script';
    const canExpand = hasOutput || hasScript || isRunning;
    const durationLabel = typeof item.durationMs === 'number' && item.durationMs > 0 ? ` ${formatWorkDuration(item.durationMs)}` : '';
    const label = isRunning
        ? (isPython ? 'Running Python script' : 'Running')
        : item.status === 'failed'
            ? (isPython ? 'Python script failed' : 'Command failed')
            : isPython
                ? `Ran Python script${durationLabel}`
                : `Ran command${durationLabel}`;

    useEffect(() => {
        if (isRunning && !userToggledRef.current) {
            setExpanded(true);
        }
    }, [isRunning]);

    if (!command) return null;

    return (
        <div className="rounded px-1 py-0.5 text-[12px] leading-5">
            <button
                type="button"
                disabled={!canExpand}
                aria-expanded={canExpand ? expanded : undefined}
                onClick={() => {
                    if (!canExpand) return;
                    userToggledRef.current = true;
                    setExpanded(open => !open);
                }}
                className={`flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-vscode-fg/68 ${canExpand ? 'hover:bg-vscode-list-hoverBackground/35 hover:text-vscode-fg/82' : 'cursor-default'}`}
            >
                <span className={`codicon ${item.status === 'running' ? 'codicon-loading codicon-modifier-spin' : 'codicon-terminal'} shrink-0 text-[12px] text-vscode-fg/42`} />
                <span className="shrink-0 text-[11.5px] font-medium text-vscode-fg/58">{label}</span>
                <span className="min-w-0 truncate font-mono text-[11.5px] leading-5 text-vscode-fg/78">{command}</span>
                {canExpand && (
                    <span className={`codicon codicon-chevron-right ml-auto shrink-0 text-[11px] text-vscode-fg/35 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
                )}
            </button>
            {canExpand && (
                <AnimatedDisclosure open={expanded}>
                    <div className="mt-1.5">
                        <ShellOutputPanel
                            command={command}
                            output={output}
                            status={item.status}
                            exitCode={item.exitCode}
                            durationMs={item.durationMs}
                            cwd={item.cwd}
                            shell={item.shell}
                            script={item.script}
                        />
                    </div>
                </AnimatedDisclosure>
            )}
        </div>
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
    return (
        <div className="rounded px-1 py-0.5 text-[11.5px] leading-5 hover:bg-vscode-list-hoverBackground/35">
            <div className="flex min-w-0 items-center gap-1.5">
                {item.type === 'read' ? (
                    <FileGlyph path={item.path || displayTarget} type={hasEntries ? 'folder' : 'file'} size="sm" />
                ) : item.type === 'search' ? (
                    <FileGlyph path={item.target || displayTarget} type="search" size="sm" />
                ) : item.type === 'artifact' ? (
                    <FileGlyph path={item.path || item.target || displayTarget || 'artifact.md'} type="file" size="sm" />
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
                    <span className="shrink-0 whitespace-nowrap text-[10.5px] font-medium tracking-normal text-vscode-fg/42">
                        {actionLabel}
                    </span>
                    {displayTarget && <span className="min-w-0 truncate whitespace-nowrap font-mono text-[11px] text-vscode-fg/76">{displayTarget}</span>}
                    {countText && <span className="shrink-0 text-[10.5px] text-vscode-fg/42">{countText}</span>}
                </button>
                {item.type === 'edit' && (
                    <span className="shrink-0 font-mono text-[10.5px] text-vscode-fg/45">
                        <span className="text-emerald-500/80">+{item.additions || 0}</span> <span className="text-rose-500/80">-{item.deletions || 0}</span>
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
            <AnimatedDisclosure open={expanded && Boolean(item.entries?.length)}>
                <div className="ml-5 mt-1 grid grid-cols-1 gap-0.5">
                    {(item.entries || []).map((entry, index) => (
                        <button
                            key={`${entry.path || entry.name}-${index}`}
                            type="button"
                            disabled={!entry.path}
                            onClick={() => entry.path && postMessage({ type: 'open_file', payload: { path: entry.path } })}
                            className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] leading-5 text-vscode-fg/58 hover:bg-vscode-list-hoverBackground/60 hover:text-vscode-link-foreground"
                            title={entry.path || entry.name}
                        >
                            <FileGlyph path={entry.path || entry.name} type={entry.type === 'dir' ? 'folder' : 'file'} size="xs" />
                            <span className="shrink-0 whitespace-nowrap text-[10px] font-medium tracking-normal text-vscode-fg/36">
                                {entry.type === 'dir' ? 'Explored' : actionLabel}
                            </span>
                            <span className="min-w-0 truncate font-mono">{entry.name}</span>
                        </button>
                    ))}
                </div>
            </AnimatedDisclosure>
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

    return (
        <section className="space-y-1">
            <button
                type="button"
                onClick={onToggle}
                className={`group flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-vscode-list-hoverBackground/30 ${active ? 'text-vscode-fg/70' : 'text-vscode-fg/50'}`}
                title={open ? `Collapse ${title}` : `Expand ${title}`}
            >
                <span className={`codicon codicon-chevron-right shrink-0 text-[11px] text-vscode-fg/35 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
                {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400/70" />}
                <span className="shrink-0 text-[11px] font-medium leading-5">{title}</span>
                {summary && <span className="min-w-0 truncate text-[10.5px] text-vscode-fg/35">{summary}</span>}
            </button>
            <AnimatedDisclosure open={open}>
                <div className="space-y-0.5 pl-2">
                    {items.map(item => item.type === 'commentary' ? (
                        <div key={item.id} className="custom-scrollbar max-h-[220px] overflow-auto break-words rounded-md bg-vscode-input-bg/30 px-2 py-1.5 text-vscode-fg/78">
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

type PendingEditItem = {
    filePath?: string;
    additions?: number;
    deletions?: number;
    status?: 'pending' | 'reviewing' | 'conflicted' | string;
    conflictReason?: string;
    isNewFile?: boolean;
};

const InlineEditApprovalCard = ({
    edits,
    onOpenFile,
    onSave,
    onReject,
}: {
    edits: PendingEditItem[];
    onOpenFile: (path: string) => void;
    onSave: () => void;
    onReject: () => void;
}) => {
    if (!edits.length) return null;
    const hasConflict = edits.some(edit => edit.status === 'conflicted');

    return (
        <div className="rounded-md border border-vscode-border bg-vscode-input-bg/45" data-ricochet-inline-edit-approval>
            <div className="flex items-center gap-2 border-b border-vscode-border/70 px-3 py-2">
                <span className="codicon codicon-edit text-[13px] text-blue-300/65" />
                <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-semibold text-vscode-fg/82">Ricochet wants to edit this file{edits.length === 1 ? '' : 's'}:</div>
                    <div className="truncate text-[10.5px] text-vscode-fg/42">Review pending workspace changes</div>
                </div>
            </div>

            <div className="grid gap-1.5 p-2">
                {edits.map((edit, index) => {
                    const path = edit.filePath || '';
                    const target = path ? workEventDisplayTarget({ id: path, type: 'edit', label: 'Edited', target: path, path, timestamp: 0 }) : 'pending edit';
                    return (
                        <button
                            key={`${path}-${index}`}
                            type="button"
                            disabled={!path}
                            onClick={() => path && onOpenFile(path)}
                            title={edit.conflictReason || path}
                            className={`flex min-w-0 items-center gap-2 rounded border px-2.5 py-2 text-left text-[11.5px] transition-colors ${
                                edit.status === 'conflicted'
                                    ? 'border-rose-500/25 bg-rose-500/10 text-rose-200/85'
                                    : 'border-vscode-border bg-vscode-editor-background/55 text-vscode-fg/72 hover:bg-vscode-list-hoverBackground/55 hover:text-vscode-fg/88'
                            }`}
                        >
                            <FileGlyph path={target} type="file" size="sm" />
                            <span className="min-w-0 flex-1 truncate font-mono">{target}</span>
                            {edit.status === 'conflicted' && <span className="shrink-0 text-[10px] text-rose-200/75">conflict</span>}
                            <span className="shrink-0 font-mono text-[10.5px] text-vscode-fg/48">
                                <span className="text-emerald-400/85">+{edit.additions || 0}</span>{' '}
                                <span className="text-rose-400/85">-{edit.deletions || 0}</span>
                            </span>
                            <span className="codicon codicon-chevron-right shrink-0 text-[11px] text-vscode-fg/35" />
                        </button>
                    );
                })}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-vscode-border/70 px-3 py-2">
                <div className="min-w-0 truncate text-[10.5px] text-vscode-fg/42">
                    Auto-approve: current Ricochet workspace rules
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        onClick={onReject}
                        className="rounded border border-vscode-border bg-vscode-editor-background px-3 py-1.5 text-[11px] font-medium text-vscode-fg/64 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg/86"
                    >
                        Reject
                    </button>
                    <button
                        type="button"
                        disabled={hasConflict}
                        onClick={onSave}
                        className="rounded bg-vscode-button-bg px-3 py-1.5 text-[11px] font-semibold text-vscode-button-fg hover:bg-vscode-button-hover disabled:cursor-not-allowed disabled:opacity-45"
                        title={hasConflict ? 'Resolve conflicted files before saving changes' : 'Save all pending Ricochet edits'}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
};

type PlanArtifact = {
    id?: string;
    type?: string;
    title?: string;
    summary?: string;
    path?: string;
    content?: string;
    session_id?: string;
    status?: string;
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
    onSendMessage,
}: {
    artifact: PlanArtifact;
    onSendMessage?: (content: string) => void;
}) => {
    const { postMessage } = useVSCodeApi();
    const [decision, setDecision] = useState<string | null>(artifact.status === 'approved' ? 'implement' : null);
    const title = artifact.title || 'Implementation Plan';
    const sessionId = artifact.session_id;
    const artifactId = artifact.id || artifact.path || title;

    const sendDecision = (nextDecision: 'implement' | 'revise') => {
        setDecision(nextDecision);
        postMessage({
            type: 'plan_decision',
            payload: {
                session_id: sessionId,
                artifact_id: artifactId,
                path: artifact.path,
                decision: nextDecision,
            }
        });
    };

    const requestRevision = () => {
        sendDecision('revise');
        onSendMessage?.(`Revise the implementation plan "${title}" and submit the updated plan artifact.`);
    };

    return (
        <div className="mb-3 rounded-md border border-vscode-border bg-vscode-input-bg/35">
            <div className="flex items-start gap-3 px-3 py-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-vscode-border bg-vscode-editor-background">
                    <span className="codicon codicon-preview text-[14px] text-blue-300/75" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="mb-1 flex min-w-0 items-center gap-2">
                        <div className="truncate text-[13px] font-semibold text-vscode-fg/88">{title}</div>
                        {decision === 'implement' && (
                            <span className="shrink-0 rounded bg-emerald-500/12 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300/85">
                                Approved
                            </span>
                        )}
                    </div>
                    <div className="line-clamp-3 text-[12px] leading-[1.5] text-vscode-fg/60">
                        {planExcerpt(artifact)}
                    </div>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-vscode-border/70 px-3 py-2">
                <button
                    type="button"
                    disabled={!artifact.path}
                    onClick={() => artifact.path && postMessage({ type: 'open_file', payload: { path: artifact.path } })}
                    className="inline-flex items-center gap-1.5 rounded border border-vscode-border bg-vscode-editor-background px-2.5 py-1.5 text-[11px] font-medium text-vscode-fg/70 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg disabled:cursor-not-allowed disabled:opacity-45"
                >
                    <span className="codicon codicon-open-preview text-[12px]" />
                    Review
                </button>
                <button
                    type="button"
                    onClick={() => sendDecision('implement')}
                    className="inline-flex items-center gap-1.5 rounded bg-vscode-button-bg px-3 py-1.5 text-[11px] font-semibold text-vscode-button-fg hover:bg-vscode-button-hover"
                >
                    <span className="codicon codicon-check text-[12px]" />
                    Proceed
                </button>
                <button
                    type="button"
                    onClick={requestRevision}
                    className="inline-flex items-center gap-1.5 rounded border border-vscode-border bg-vscode-editor-background px-2.5 py-1.5 text-[11px] font-medium text-vscode-fg/62 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg"
                >
                    <span className="codicon codicon-edit text-[12px]" />
                    Revise
                </button>
            </div>
        </div>
    );
};

const WorkSummaryBlock = ({
    summary,
    pendingPermissions = {},
    pendingEdits = [],
    onRespondToPermission,
}: {
    summary: WorkSummary;
    pendingPermissions?: Record<string, any>;
    pendingEdits?: PendingEditItem[];
    onRespondToPermission?: (id: string, answer: string) => void;
}) => {
    const { postMessage, onMessage } = useVSCodeApi();
    const isActive = summary.status === 'running';
    const needsAttention = summary.status === 'waiting' || summary.status === 'failed';
    const shouldAutoExpand = isActive || needsAttention;
    const [expanded, setExpanded] = useState(shouldAutoExpand);
    const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
    const [openFileWarning, setOpenFileWarning] = useState<string | null>(null);
    const previousStatusRef = useRef(summary.status);
    const previousTurnIdRef = useRef(summary.turnId);
    const previousActiveSectionRef = useRef<string | null>(null);
    const userToggledRef = useRef(false);
    const manuallyToggledSectionsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (previousStatusRef.current !== summary.status) {
            previousStatusRef.current = summary.status;
            userToggledRef.current = false;
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
    const visiblePendingPermissions = Object.values(pendingPermissions).filter((request: any) => {
        if (!pendingEdits.length) return true;
        return !/edit|file|write|save|apply|diff/i.test(request.question || '');
    });
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
        const unsubscribe = onMessage((message: any) => {
            if (message.type !== 'open_file_result' || message.payload?.ok !== false) return;
            const failedPath = message.payload.path;
            if (!failedPath || !changedFiles.some(file => file.path === failedPath || file.target === failedPath)) return;
            setOpenFileWarning(`File not found: ${failedPath}`);
        });
        return () => { unsubscribe(); };
    }, [onMessage, changedFiles]);

    useEffect(() => {
        if (previousTurnIdRef.current !== summary.turnId) {
            previousTurnIdRef.current = summary.turnId;
            previousActiveSectionRef.current = null;
            manuallyToggledSectionsRef.current.clear();
            setOpenSections({});
        }
    }, [summary.turnId]);

    useEffect(() => {
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
        <div className="mb-3 mt-1 pb-2 text-[12px]">
            <button
                type="button"
                onClick={() => {
                    userToggledRef.current = true;
                    setExpanded(open => !open);
                }}
                className="group flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-vscode-fg/60 hover:bg-vscode-list-hoverBackground/35 hover:text-vscode-fg/80"
            >
                <span className={`codicon ${isActive ? 'codicon-loading codicon-modifier-spin' : 'codicon-terminal'} text-[12px] text-vscode-fg/42`} />
                <span className="shrink-0 text-[12.5px] font-semibold">{title}</span>
                {subtitle && <span className="min-w-0 truncate text-[11px] text-vscode-fg/44">{subtitle}</span>}
                <span className={`codicon codicon-chevron-right ml-auto text-[11px] text-vscode-fg/30 transition-transform duration-200 ease-out motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
            </button>

            <AnimatedDisclosure open={expanded} className="mt-2">
                <div>
                    <div className="space-y-2.5">
                        {summary.items.length === 0 ? (
                            <div className="flex items-start gap-2 text-[11px] text-vscode-fg/40">
                                <span className="codicon codicon-info mt-0.5 w-4 shrink-0 text-[12px]" />
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

                    {(changedFiles.length > 0 || artifacts.length > 0 || pendingEdits.length > 0 || visiblePendingPermissions.length > 0) && (
                        <div className="mt-3 space-y-1.5 pt-0.5">
                            {pendingEdits.length > 0 && (
                                <InlineEditApprovalCard
                                    edits={pendingEdits}
                                    onOpenFile={(path) => postMessage({ type: 'open_file', payload: { path } })}
                                    onSave={() => postMessage({ type: 'execute_command', payload: { command: '/accept-all' } })}
                                    onReject={() => postMessage({ type: 'execute_command', payload: { command: '/reject-all' } })}
                                />
                            )}

                            {changedFiles.length > 0 && (
                                <div>
                                    <div className="mb-1 text-[11px] font-medium text-vscode-fg/42">Changed files</div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {changedFiles.map(file => (
                                            <button
                                                key={file.id}
                                                type="button"
                                                title={file.path || file.target}
                                                onClick={() => {
                                                    setOpenFileWarning(null);
                                                    file.path && postMessage({ type: 'open_file', payload: { path: file.path } });
                                                }}
                                                className="inline-flex max-w-full items-center gap-1.5 rounded border border-vscode-border bg-vscode-input-bg px-2 py-1 text-left font-mono text-[10px] text-vscode-fg/65 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg"
                                            >
                                                <span className="codicon codicon-file-code shrink-0 text-[12px] text-vscode-fg/45" />
                                                <span className="min-w-0 truncate">{file.target || file.path}</span>
                                                <span className="shrink-0 text-vscode-fg/35">
                                                    {typeof file.additions === 'number' || typeof file.deletions === 'number'
                                                        ? `+${file.additions || 0} -${file.deletions || 0}`
                                                        : 'modified'}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                    {openFileWarning && (
                                        <div className="mt-1 text-[10px] leading-snug text-amber-400/80">{openFileWarning}</div>
                                    )}
                                </div>
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

                            {visiblePendingPermissions.map((request: any) => (
                                <div key={request.id} className="rounded border border-blue-400/20 bg-blue-400/5 px-2 py-2">
                                    <div className="mb-2 text-[11px] text-vscode-fg/75">{request.question}</div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(request.choices?.length ? request.choices : ['Allow', 'Deny']).map((choice: string, index: number) => (
                                            <button
                                                key={choice}
                                                type="button"
                                                onClick={() => onRespondToPermission?.(request.id, choice)}
                                                className={`rounded px-2.5 py-1 text-[10px] font-medium transition-colors ${
                                                    index === 0
                                                        ? 'bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground'
                                                        : 'bg-vscode-input-bg text-vscode-fg/65 hover:bg-vscode-list-hoverBackground hover:text-vscode-fg'
                                                }`}
                                            >
                                                {choice}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
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
    pendingPermissions = {},
    pendingEdits = [],
    onRespondToPermission,
    onExecuteCommand,
    onSendMessage,
    onRetryMessage
}: {
    message: ChatMessageType;
    workSummary?: WorkSummary;
    pendingPermissions?: Record<string, any>;
    pendingEdits?: PendingEditItem[];
    onRespondToPermission?: (id: string, answer: string) => void;
    onExecuteCommand?: (cmd: string) => void;
    onSendMessage?: (content: string) => void;
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
        const hasToolPayload = Boolean(message.toolCalls?.length || message.activities?.length || artifacts.length);
        return hasToolPayload ? normalizeWorkCommentaryText(visible) : visible;
    }, [body, artifacts, message.activities?.length, message.toolCalls?.length]);

    const blocks = useMemo(() => splitMessageIntoBlocks(cleanedBody), [cleanedBody]);
    const textBlocks = useMemo(() => blocks.filter(block => block.type !== 'thinking' && block.content.trim()), [blocks]);
    const shouldUseCompletionCard = Boolean(!isStreaming && cleanedBody.trim() && effectiveWorkSummary?.status === 'completed' && !message.errorInfo);

    if (!cleanedBody && planArtifacts.length === 0 && !effectiveWorkSummary && !message.errorInfo) {
        return null;
    }

    return (
        <div className="flex flex-col text-[12.5px] pb-1">
            {effectiveWorkSummary && (
                <WorkSummaryBlock
                    summary={effectiveWorkSummary}
                    pendingPermissions={pendingPermissions}
                    pendingEdits={pendingEdits}
                    onRespondToPermission={onRespondToPermission}
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
                    onSendMessage={onSendMessage}
                />
            ))}

            <div className={`prose prose-sm max-w-none text-vscode-fg ${isStreaming ? 'opacity-90' : ''}`}>
                {shouldUseCompletionCard ? (
                    <CompletionMarkdownCard content={cleanedBody} onExecuteCommand={onExecuteCommand} />
                ) : textBlocks.map((block, idx) => (
                    <MarkdownContent key={idx} content={block.content} onExecuteCommand={onExecuteCommand} />
                ))}
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

const UserContent = ({ content, via, remoteUsername }: { content: string; via?: 'telegram' | 'discord' | 'ide'; remoteUsername?: string }) => {
    const isRedundantName = remoteUsername && via && remoteUsername.toLowerCase() === via.toLowerCase();
    return (
        <div className="flex flex-col items-end w-full px-2 mb-2">
            <div className="flex items-center gap-2 mb-1.5 px-2">
                {(!isRedundantName && remoteUsername) ? <span className="text-[10px] text-vscode-fg/45 font-medium">{remoteUsername}</span> : null}
                {via && via !== 'ide' ? <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-cyan-500/10 text-[9px] text-cyan-400 font-medium border border-cyan-500/20">{via}</span> : null}
            </div>
            <div className="max-w-[88%] py-3 px-4 rounded-md rounded-tr-sm whitespace-pre-wrap text-[13px] leading-relaxed border border-vscode-border bg-vscode-input-bg text-vscode-fg/90 transition-colors hover:bg-vscode-list-hoverBackground">
                {content}
            </div>
        </div>
    );
};

export function ChatMessage({
    message,
    workSummary,
    pendingPermissions = {},
    pendingEdits = [],
    onRespondToPermission,
    onExecuteCommand,
    onSendMessage,
    onRetryMessage,
    onRestore
}: {
    message: ChatMessageType;
    workSummary?: WorkSummary;
    pendingPermissions?: Record<string, any>;
    pendingEdits?: PendingEditItem[];
    onRespondToPermission?: (id: string, answer: string) => void;
    onExecuteCommand?: (command: string) => void;
    onSendMessage?: (content: string) => void;
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
                        pendingPermissions={pendingPermissions}
                        pendingEdits={pendingEdits}
                        onRespondToPermission={onRespondToPermission}
                        onExecuteCommand={onExecuteCommand}
                        onSendMessage={onSendMessage}
                        onRetryMessage={onRetryMessage}
                    />
                </div>
            ) : (
                <UserContent content={message.content} via={message.via} remoteUsername={message.remoteUsername} />
            )}
        </div>
    );
}
