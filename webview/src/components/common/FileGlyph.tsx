import { memo } from 'react';
import bashIcon from '../../assets/file-icons/bash.svg?raw';
import cIcon from '../../assets/file-icons/c.svg?raw';
import cppIcon from '../../assets/file-icons/cplusplus.svg?raw';
import csharpIcon from '../../assets/file-icons/csharp.svg?raw';
import cssIcon from '../../assets/file-icons/css.svg?raw';
import dartIcon from '../../assets/file-icons/dart.svg?raw';
import elixirIcon from '../../assets/file-icons/elixir.svg?raw';
import goIcon from '../../assets/file-icons/go.svg?raw';
import htmlIcon from '../../assets/file-icons/html5.svg?raw';
import javaIcon from '../../assets/file-icons/java.svg?raw';
import javascriptIcon from '../../assets/file-icons/javascript.svg?raw';
import jsonIcon from '../../assets/file-icons/json.svg?raw';
import kotlinIcon from '../../assets/file-icons/kotlin.svg?raw';
import luaIcon from '../../assets/file-icons/lua.svg?raw';
import markdownIcon from '../../assets/file-icons/markdown.svg?raw';
import phpIcon from '../../assets/file-icons/php.svg?raw';
import pythonIcon from '../../assets/file-icons/python.svg?raw';
import rubyIcon from '../../assets/file-icons/ruby.svg?raw';
import rustIcon from '../../assets/file-icons/rust.svg?raw';
import swiftIcon from '../../assets/file-icons/swift.svg?raw';
import typescriptIcon from '../../assets/file-icons/typescript.svg?raw';
import wasmIcon from '../../assets/file-icons/webassembly.svg?raw';
import zigIcon from '../../assets/file-icons/zig.svg?raw';

export type FileGlyphType = 'file' | 'folder' | 'dir' | 'symbol' | 'search' | 'result' | 'definition' | 'function';
export type FileGlyphSize = 'xs' | 'sm';

export type FileGlyphInfo =
    | {
        kind: 'badge';
        label: string;
        className: string;
    }
    | {
        kind: 'svg';
        svg: string;
        className?: string;
    }
    | {
        kind: 'codicon';
        icon: string;
        className: string;
    };

const exactFileGlyphs: Record<string, FileGlyphInfo> = {
    'readme.md': { kind: 'svg', svg: markdownIcon },
    'changelog.md': { kind: 'svg', svg: markdownIcon },
    'package.json': { kind: 'svg', svg: jsonIcon },
    'package-lock.json': { kind: 'svg', svg: jsonIcon },
    'tsconfig.json': { kind: 'svg', svg: typescriptIcon },
    'jsconfig.json': { kind: 'svg', svg: javascriptIcon },
    'cargo.toml': { kind: 'svg', svg: rustIcon },
    'cargo.lock': { kind: 'svg', svg: rustIcon },
    'go.mod': { kind: 'svg', svg: goIcon },
    'go.sum': { kind: 'svg', svg: goIcon },
    '.env': { kind: 'codicon', icon: 'codicon-key', className: 'text-amber-300/65' },
    '.env.local': { kind: 'codicon', icon: 'codicon-key', className: 'text-amber-300/65' },
    '.gitignore': { kind: 'codicon', icon: 'codicon-git-branch', className: 'text-orange-300/62' },
};

const extensionGlyphs: Record<string, FileGlyphInfo> = {
    tsx: { kind: 'svg', svg: typescriptIcon },
    jsx: { kind: 'svg', svg: javascriptIcon },
    ts: { kind: 'svg', svg: typescriptIcon },
    js: { kind: 'svg', svg: javascriptIcon },
    mjs: { kind: 'svg', svg: javascriptIcon },
    cjs: { kind: 'svg', svg: javascriptIcon },
    rs: { kind: 'svg', svg: rustIcon },
    go: { kind: 'svg', svg: goIcon },
    py: { kind: 'svg', svg: pythonIcon },
    md: { kind: 'svg', svg: markdownIcon },
    mdx: { kind: 'svg', svg: markdownIcon },
    json: { kind: 'svg', svg: jsonIcon },
    toml: { kind: 'badge', label: 'TOM', className: 'bg-stone-500/26 text-stone-100 ring-stone-300/20' },
    yaml: { kind: 'badge', label: 'YML', className: 'bg-purple-500/18 text-purple-100 ring-purple-300/24' },
    yml: { kind: 'badge', label: 'YML', className: 'bg-purple-500/18 text-purple-100 ring-purple-300/24' },
    sql: { kind: 'codicon', icon: 'codicon-database', className: 'text-violet-300/70' },
    db: { kind: 'codicon', icon: 'codicon-database', className: 'text-violet-300/70' },
    sqlite: { kind: 'codicon', icon: 'codicon-database', className: 'text-violet-300/70' },
    sqlite3: { kind: 'codicon', icon: 'codicon-database', className: 'text-violet-300/70' },
    css: { kind: 'svg', svg: cssIcon },
    scss: { kind: 'svg', svg: cssIcon },
    sass: { kind: 'svg', svg: cssIcon },
    html: { kind: 'svg', svg: htmlIcon },
    htm: { kind: 'svg', svg: htmlIcon },
    sh: { kind: 'svg', svg: bashIcon },
    bash: { kind: 'svg', svg: bashIcon },
    zsh: { kind: 'svg', svg: bashIcon },
    c: { kind: 'svg', svg: cIcon },
    h: { kind: 'svg', svg: cIcon },
    cpp: { kind: 'svg', svg: cppIcon },
    cc: { kind: 'svg', svg: cppIcon },
    cxx: { kind: 'svg', svg: cppIcon },
    hpp: { kind: 'svg', svg: cppIcon },
    cs: { kind: 'svg', svg: csharpIcon },
    java: { kind: 'svg', svg: javaIcon },
    kt: { kind: 'svg', svg: kotlinIcon },
    kts: { kind: 'svg', svg: kotlinIcon },
    swift: { kind: 'svg', svg: swiftIcon },
    rb: { kind: 'svg', svg: rubyIcon },
    php: { kind: 'svg', svg: phpIcon },
    lua: { kind: 'svg', svg: luaIcon },
    ex: { kind: 'svg', svg: elixirIcon },
    exs: { kind: 'svg', svg: elixirIcon },
    dart: { kind: 'svg', svg: dartIcon },
    wasm: { kind: 'svg', svg: wasmIcon },
    zig: { kind: 'svg', svg: zigIcon },
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

function svgMarkup(rawSvg: string): string {
    return rawSvg.replace(/<svg\b([^>]*)>/i, (_match, rawAttrs) => {
        const attrs = String(rawAttrs || '')
            .replace(/\s(?:width|height)="[^"]*"/gi, '')
            .replace(/\s(?:aria-hidden|focusable)="[^"]*"/gi, '')
            .trim();
        const hasClass = /\sclass="/i.test(` ${attrs}`);
        const withClass = hasClass
            ? attrs.replace(/\sclass="([^"]*)"/i, ' class="$1 h-full w-full"')
            : `${attrs} class="h-full w-full"`;
        return `<svg ${withClass} aria-hidden="true" focusable="false">`;
    });
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

    if (info.kind === 'svg') {
        return (
            <span
                aria-hidden="true"
                title={title}
                className={`inline-flex shrink-0 items-center justify-center ${box} ${mono ? 'opacity-55 grayscale text-vscode-fg/55' : info.className || 'text-vscode-fg/70'} ${className}`}
                dangerouslySetInnerHTML={{ __html: svgMarkup(info.svg) }}
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
