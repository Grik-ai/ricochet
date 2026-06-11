import { memo } from 'react';

export type FileGlyphType = 'file' | 'folder' | 'dir' | 'symbol' | 'search' | 'result' | 'definition' | 'function';
export type FileGlyphSize = 'xs' | 'sm';

export type FileGlyphInfo =
    | {
        kind: 'badge';
        label: string;
        className: string;
    }
    | {
        kind: 'codicon';
        icon: string;
        className: string;
    };

const exactFileGlyphs: Record<string, FileGlyphInfo> = {
    'readme.md': { kind: 'badge', label: 'MD', className: 'bg-sky-500/18 text-sky-200 ring-sky-300/20' },
    'changelog.md': { kind: 'badge', label: 'MD', className: 'bg-sky-500/18 text-sky-200 ring-sky-300/20' },
    'package.json': { kind: 'badge', label: 'JS', className: 'bg-emerald-500/18 text-emerald-200 ring-emerald-300/20' },
    'package-lock.json': { kind: 'badge', label: 'JS', className: 'bg-emerald-500/18 text-emerald-200 ring-emerald-300/20' },
    'tsconfig.json': { kind: 'badge', label: 'TS', className: 'bg-blue-500/22 text-blue-100 ring-blue-300/25' },
    'jsconfig.json': { kind: 'badge', label: 'JS', className: 'bg-yellow-500/20 text-yellow-100 ring-yellow-300/25' },
    'cargo.toml': { kind: 'badge', label: 'RS', className: 'bg-orange-500/18 text-orange-100 ring-orange-300/25' },
    'cargo.lock': { kind: 'badge', label: 'RS', className: 'bg-orange-500/18 text-orange-100 ring-orange-300/25' },
    'go.mod': { kind: 'badge', label: 'GO', className: 'bg-cyan-500/18 text-cyan-100 ring-cyan-300/25' },
    'go.sum': { kind: 'badge', label: 'GO', className: 'bg-cyan-500/18 text-cyan-100 ring-cyan-300/25' },
    '.env': { kind: 'codicon', icon: 'codicon-key', className: 'text-amber-300/65' },
    '.env.local': { kind: 'codicon', icon: 'codicon-key', className: 'text-amber-300/65' },
    '.gitignore': { kind: 'codicon', icon: 'codicon-git-branch', className: 'text-orange-300/62' },
};

const extensionGlyphs: Record<string, FileGlyphInfo> = {
    tsx: { kind: 'badge', label: 'TSX', className: 'bg-cyan-500/18 text-cyan-100 ring-cyan-300/25' },
    jsx: { kind: 'badge', label: 'JSX', className: 'bg-cyan-500/18 text-cyan-100 ring-cyan-300/25' },
    ts: { kind: 'badge', label: 'TS', className: 'bg-blue-500/22 text-blue-100 ring-blue-300/25' },
    js: { kind: 'badge', label: 'JS', className: 'bg-yellow-500/20 text-yellow-100 ring-yellow-300/25' },
    mjs: { kind: 'badge', label: 'JS', className: 'bg-yellow-500/20 text-yellow-100 ring-yellow-300/25' },
    cjs: { kind: 'badge', label: 'JS', className: 'bg-yellow-500/20 text-yellow-100 ring-yellow-300/25' },
    rs: { kind: 'badge', label: 'RS', className: 'bg-orange-500/18 text-orange-100 ring-orange-300/25' },
    go: { kind: 'badge', label: 'GO', className: 'bg-cyan-500/18 text-cyan-100 ring-cyan-300/25' },
    py: { kind: 'badge', label: 'PY', className: 'bg-indigo-500/18 text-indigo-100 ring-indigo-300/25' },
    md: { kind: 'badge', label: 'MD', className: 'bg-sky-500/18 text-sky-200 ring-sky-300/20' },
    mdx: { kind: 'badge', label: 'MDX', className: 'bg-sky-500/18 text-sky-200 ring-sky-300/20' },
    json: { kind: 'badge', label: '{}', className: 'bg-lime-500/16 text-lime-100 ring-lime-300/20' },
    toml: { kind: 'badge', label: 'TOM', className: 'bg-stone-500/26 text-stone-100 ring-stone-300/20' },
    yaml: { kind: 'badge', label: 'YML', className: 'bg-purple-500/18 text-purple-100 ring-purple-300/24' },
    yml: { kind: 'badge', label: 'YML', className: 'bg-purple-500/18 text-purple-100 ring-purple-300/24' },
    sql: { kind: 'badge', label: 'DB', className: 'bg-violet-500/18 text-violet-100 ring-violet-300/24' },
    css: { kind: 'badge', label: 'CSS', className: 'bg-blue-500/18 text-blue-100 ring-blue-300/20' },
    html: { kind: 'badge', label: 'HTML', className: 'bg-orange-500/18 text-orange-100 ring-orange-300/22' },
};

const folderNames = new Set([
    'src',
    'source',
    'test',
    'tests',
    'docs',
    'doc',
    'node_modules',
    'vendor',
    'config',
    'configs',
    'scripts',
    'tools',
    'components',
    'assets',
]);

function basename(path = '') {
    return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path;
}

function extension(path = '') {
    const name = basename(path).toLowerCase();
    if (name.endsWith('.test.tsx')) return 'tsx';
    if (name.endsWith('.spec.tsx')) return 'tsx';
    if (name.endsWith('.test.ts')) return 'ts';
    if (name.endsWith('.spec.ts')) return 'ts';
    if (name.endsWith('.d.ts')) return 'ts';
    const parts = name.split('.');
    return parts.length > 1 ? parts.pop() || '' : '';
}

export function fileGlyphInfo(path = '', type: FileGlyphType = 'file'): FileGlyphInfo {
    const normalizedType = type.toLowerCase();
    const normalizedPath = path.replace(/\\/g, '/');
    const name = basename(normalizedPath).toLowerCase();

    if (normalizedType === 'search' || normalizedType === 'result') {
        return { kind: 'codicon', icon: 'codicon-search', className: 'text-blue-300/65' };
    }
    if (normalizedType === 'definition' || normalizedType === 'function' || normalizedType === 'symbol') {
        return { kind: 'codicon', icon: 'codicon-symbol-function', className: 'text-purple-300/65' };
    }
    if (normalizedType === 'folder' || normalizedType === 'dir' || normalizedPath.endsWith('/') || folderNames.has(name)) {
        return { kind: 'codicon', icon: 'codicon-folder', className: 'text-blue-300/65' };
    }

    return exactFileGlyphs[name] ||
        extensionGlyphs[extension(normalizedPath)] ||
        { kind: 'codicon', icon: 'codicon-file', className: 'text-vscode-fg/42' };
}

export const FileGlyph = memo(({
    path,
    type = 'file',
    size = 'sm',
    mono = false,
    className = '',
}: {
    path?: string;
    type?: FileGlyphType;
    size?: FileGlyphSize;
    mono?: boolean;
    className?: string;
}) => {
    const info = fileGlyphInfo(path || '', type);
    const box = size === 'xs' ? 'h-3 w-3 text-[7px]' : 'h-3.5 w-3.5 text-[7.5px]';
    const title = path || type;

    if (info.kind === 'codicon') {
        return (
            <span
                aria-hidden="true"
                title={title}
                className={`codicon ${info.icon} inline-flex shrink-0 items-center justify-center ${box} ${mono ? 'text-vscode-fg/45' : info.className} ${className}`}
            />
        );
    }

    return (
        <span
            aria-hidden="true"
            title={title}
            className={`inline-flex shrink-0 items-center justify-center rounded-[3px] font-mono font-bold leading-none ring-1 ${box} ${mono ? 'bg-vscode-input-bg text-vscode-fg/55 ring-vscode-border/60' : info.className} ${className}`}
        >
            {info.label}
        </span>
    );
});

FileGlyph.displayName = 'FileGlyph';
