import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    buildExploredTree,
    ChatMessage,
    CompletionMarkdownCard,
    DraftMarkdownCard,
    formatTimelineLineRange,
    looksLikeIdentifierReference,
    normalizeAssistantMarkdown,
    normalizeBrokenReferenceLines,
    normalizeCompactInlineCodeFences,
    pathIconClass,
    shouldInlineCodeFence,
} from './ChatMessage';
import { extractLegacyContextFiles } from './ChatMessage';
import { FileGlyph, fileGlyphInfo } from '../common/FileGlyph';

describe('ChatMessage markdown code formatting', () => {
    it('converts accidental one-line plain fences into inline code', () => {
        const source = [
            '1. Replace all',
            '',
            '```',
            'unwrap()',
            '```',
            '',
            'calls',
        ].join('\n');

        expect(normalizeAssistantMarkdown(source)).toBe('1. Replace all `unwrap()` calls');
    });

    it('keeps parenthesized path references compact', () => {
        const source = [
            '2. Analysis Engine (',
            '```',
            'src/analysis/',
            '```',
            ')',
        ].join('\n');

        expect(normalizeAssistantMarkdown(source)).toBe('2. Analysis Engine (`src/analysis/`)');
    });

    it('keeps parenthesized file, folder, database, and URL references compact', () => {
        expect(normalizeAssistantMarkdown([
            'Data Ingestion (',
            'src/ingestion/',
            ')',
        ].join('\n'))).toBe('Data Ingestion (`src/ingestion/`)');

        expect(normalizeAssistantMarkdown([
            'Database: SQLite (',
            'polybot.db',
            ')',
        ].join('\n'))).toBe('Database: SQLite (`polybot.db`)');

        expect(normalizeAssistantMarkdown([
            'Polymarket API (',
            'https://gamma-api.polymarket.com',
            ')',
        ].join('\n'))).toBe('Polymarket API (<https://gamma-api.polymarket.com>)');

        expect(normalizeAssistantMarkdown([
            'Main Application (',
            'src/main.rs',
            '): Entry point and application lifecycle',
        ].join('\n'))).toBe('Main Application (`src/main.rs`): Entry point and application lifecycle');
    });

    it('keeps label, standalone reference, and dash description on one line', () => {
        expect(normalizeAssistantMarkdown([
            'Main Entry Point:',
            'src/main.rs',
            '- Application entry point',
        ].join('\n'))).toBe('Main Entry Point: `src/main.rs` - Application entry point');

        expect(normalizeAssistantMarkdown([
            'Modules:',
            'agents/',
            '- Trading agents and strategies',
        ].join('\n'))).toBe('Modules: `agents/` - Trading agents and strategies');
    });

    it('keeps real language fenced code blocks unchanged', () => {
        const source = [
            '```rust',
            'if let Err(e) = ingestor.run().await {',
            '    error!("failed: {}", e);',
            '}',
            '```',
        ].join('\n');

        expect(normalizeCompactInlineCodeFences(source)).toBe(source);
        expect(shouldInlineCodeFence('rust', 'unwrap()')).toBe(false);
    });

    it('keeps multiline plain output as a real block', () => {
        const source = [
            '```',
            'line one',
            'line two',
            '```',
        ].join('\n');

        expect(normalizeCompactInlineCodeFences(source)).toBe(source);
    });

    it('does not inline command-like plain fences with spaces', () => {
        expect(shouldInlineCodeFence('', 'npm run build')).toBe(false);
        expect(shouldInlineCodeFence('text', 'src/analysis/')).toBe(true);
        expect(shouldInlineCodeFence('text', 'polybot.db')).toBe(true);
    });

    it('keeps path references attached to their colon labels', () => {
        const source = [
            '- Самые крупные модули:',
            '  - `src/signal/mod.rs`',
            '    : 332 строки',
            '  - src/ingestion/polymarket.rs',
            '    : ~300+ строк',
        ].join('\n');

        expect(normalizeBrokenReferenceLines(source)).toContain('- `src/signal/mod.rs`: 332 строки');
        expect(normalizeBrokenReferenceLines(source)).toContain('- `src/ingestion/polymarket.rs`: ~300+ строк');
    });

    it('inlines accidental identifier fences used as comma lists', () => {
        const source = [
            'Структура БД: 4 таблица (',
            '```',
            'signals',
            '```',
            ',',
            '```',
            'trades',
            '```',
            ')',
        ].join('\n');

        expect(normalizeAssistantMarkdown(source)).toBe('Структура БД: 4 таблица (`signals`, `trades`)');
        expect(looksLikeIdentifierReference('signals')).toBe(true);
    });

    it('maps work log paths to compact codicon file classes', () => {
        expect(pathIconClass('README.md')).toBe('codicon-markdown');
        expect(pathIconClass('package.json')).toBe('codicon-json');
        expect(pathIconClass('src/main.rs')).toBe('codicon-file-code');
        expect(pathIconClass('src', 'dir')).toBe('codicon-folder');
        expect(pathIconClass('query', 'result')).toBe('codicon-search');
        expect(pathIconClass('runAnalysis', 'function')).toBe('codicon-symbol-function');
    });

    it('maps common file paths to branded svg glyphs', () => {
        expect(fileGlyphInfo('ChatMessage.markdown.test.ts')).toMatchObject({ kind: 'svg' });
        expect(fileGlyphInfo('src/components/ChatMessage.tsx')).toMatchObject({ kind: 'svg' });
        expect(fileGlyphInfo('src/main.rs')).toMatchObject({ kind: 'svg' });
        expect(fileGlyphInfo('README.md')).toMatchObject({ kind: 'svg' });
        expect(fileGlyphInfo('package.json')).toMatchObject({ kind: 'svg' });
        expect(fileGlyphInfo('Cargo.toml')).toMatchObject({ kind: 'svg' });
        expect(fileGlyphInfo('polybot.db')).toMatchObject({ kind: 'codicon', icon: 'codicon-database' });
        expect(fileGlyphInfo('src', 'folder')).toMatchObject({ kind: 'codicon', icon: 'codicon-folder' });
        expect(fileGlyphInfo('unknown.weird')).toMatchObject({ kind: 'codicon', icon: 'codicon-file' });
    });

    it('renders branded glyphs as inline svg instead of webview asset urls', () => {
        const html = renderToStaticMarkup(createElement(FileGlyph, { path: 'src/main.rs', type: 'file' }));

        expect(html).toContain('<svg');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('/main.svg');
    });

    it('renders interim answer cards with normalized markdown', () => {
        const html = renderToStaticMarkup(createElement(DraftMarkdownCard, {
            content: [
                'Main Application (',
                'src/main.rs',
                '): Entry point',
            ].join('\n'),
        }));

        expect(html).toContain('Interim answer');
        expect(html).toContain('src/main.rs');
        expect(html).not.toContain('Main Application (\\n');
    });

    it('keeps inline backtick code inside completion paragraphs', () => {
        const html = renderToStaticMarkup(createElement(CompletionMarkdownCard, {
            content: 'The transcript should show `Explored`, `Ran`, and `Edited` without block breaks.',
        }));

        expect(html).toContain('Task completed');
        expect(html).toContain('<code');
        expect(html).toContain('Explored');
        expect(html).not.toContain('<pre');
        expect(html).not.toContain('ricochet-code-block');
    });

    it('builds an expandable explored tree from list and read events', () => {
        const tree = buildExploredTree([
            {
                id: 'list-root',
                type: 'read',
                label: 'Explored',
                target: 'Polybot',
                path: '/Users/igoryan_dao/Polybot',
                status: 'completed',
                timestamp: 1,
            },
            {
                id: 'list-src',
                type: 'read',
                label: 'Explored',
                target: 'src',
                path: '/Users/igoryan_dao/Polybot/src',
                status: 'completed',
                timestamp: 2,
            },
            {
                id: 'read-main',
                type: 'read',
                label: 'Read',
                target: 'main.rs',
                path: '/Users/igoryan_dao/Polybot/src/main.rs',
                lineRange: 'L1-297',
                status: 'completed',
                timestamp: 3,
            },
        ]);

        expect(tree.folderCount).toBe(2);
        expect(tree.fileCount).toBe(1);
        expect(tree.nodes[0]).toMatchObject({ name: 'Polybot', type: 'folder' });
        expect(tree.nodes[0].children[0]).toMatchObject({ name: 'src', type: 'folder' });
        expect(tree.nodes[0].children[0].children[0]).toMatchObject({
            name: 'main.rs',
            type: 'file',
            lineRange: 'L1-297',
        });
    });

    it('formats explored line range chips without hash prefixes', () => {
        expect(formatTimelineLineRange('#L1-150')).toBe('L1-L150');
        expect(formatTimelineLineRange('L151-L297')).toBe('L151-L297');
        expect(formatTimelineLineRange('151-297')).toBe('L151-L297');
        expect(formatTimelineLineRange('1:125')).toBe('L1-L125');
        expect(formatTimelineLineRange('')).toBe('');
    });

    it('renders explored tree glyphs and line range chips', () => {
        const html = renderToStaticMarkup(createElement(ChatMessage, {
            message: {
                id: 'assistant-tree',
                role: 'assistant',
                content: '',
                timestamp: 1,
                metadata: { runPhase: 'final' },
            } as any,
            workSummary: {
                turnId: 'run-tree',
                status: 'completed',
                startedAt: 1,
                counts: {
                    filesRead: 1,
                    filesExplored: 1,
                    foldersExplored: 1,
                    searches: 1,
                    commands: 0,
                    edits: 0,
                    workers: 0,
                    approvals: 0,
                },
                items: [
                    { id: 'folder', type: 'read', label: 'Explored', target: 'Polybot', path: '/repo/Polybot', lineRange: '#L900-999', status: 'completed', timestamp: 1 },
                    { id: 'search', type: 'search', label: 'Searched', target: 'query: error handling', path: 'Polybot/src/error.rs', status: 'completed', timestamp: 2 },
                    { id: 'read', type: 'read', label: 'Read', target: 'main.rs', path: '/repo/Polybot/src/main.rs', lineRange: '#L1-150', status: 'completed', timestamp: 3 },
                ],
            } as any,
        }));

        const folderIconCount = html.match(/lucide-folder/g)?.length || 0;
        expect(folderIconCount).toBeGreaterThanOrEqual(2);
        expect(html).toContain('text-sky-300/90');
        expect(html).toContain('Analyzed');
        expect(html).toContain('Polybot');
        expect(html).toContain('src');
        expect(html).toContain('lucide-search');
        expect(html).toContain('L1-L150');
        expect(html).not.toContain('L900-L999');
        expect(html).not.toContain('#L1');
    });

    it('renders explicit final assistant text as a normal message with copy action', () => {
        const html = renderToStaticMarkup(createElement(ChatMessage, {
            message: {
                id: 'assistant-final',
                role: 'assistant',
                content: 'Swarm fixture complete. Architecture, tests, and UI agents finished successfully.',
                timestamp: 1,
                metadata: { runPhase: 'final' },
            } as any,
            workSummary: {
                turnId: 'run-swarm',
                status: 'completed',
                startedAt: 1,
                counts: {
                    filesRead: 0,
                    filesExplored: 0,
                    foldersExplored: 0,
                    searches: 0,
                    commands: 0,
                    edits: 0,
                    workers: 3,
                    approvals: 0,
                },
                items: [
                    { id: 'agent-architecture', type: 'worker', label: 'Completed agent', target: 'Architecture Mapper', agentId: 'agent-architecture', status: 'completed', timestamp: 1 },
                    { id: 'agent-tests', type: 'worker', label: 'Completed agent', target: 'Test Runner', agentId: 'agent-tests', status: 'completed', timestamp: 2 },
                    { id: 'agent-ui', type: 'worker', label: 'Completed agent', target: 'UI Reviewer', agentId: 'agent-ui', status: 'completed', timestamp: 3 },
                ],
            } as any,
        }));

        expect(html).toContain('Agents');
        expect(html).toContain('3 agents');
        expect(html).toContain('Swarm fixture complete');
        expect(html).toContain('Copy message');
        expect(html).toContain('opacity-80');
        expect(html).not.toContain('group-hover/assistant-message:opacity-100');
        expect(html).not.toContain('Task completed');
        expect(html).not.toContain('Copy code');
    });

    it('renders Ether remote user source in the transcript', () => {
        const html = renderToStaticMarkup(createElement(ChatMessage, {
            message: {
                id: 'ether-user',
                role: 'user',
                content: 'Проверь проект через Ether',
                timestamp: 1,
                via: 'telegram',
                remoteUsername: 'Igor',
            } as any,
        }));

        expect(html).toContain('Igor');
        expect(html).toContain('Telegram');
        expect(html).toContain('Проверь проект через Ether');
    });
});

describe('ChatMessage visual regressions', () => {
    it('extracts legacy Context Files blocks into attachment metadata', () => {
        const parsed = extractLegacyContextFiles([
            'прочитай док',
            '',
            'Context Files:',
            '@.ricochet/attachments/session/doc.md',
        ].join('\n'));

        expect(parsed.content).toBe('прочитай док');
        expect(parsed.contextFiles).toEqual([{
            path: '.ricochet/attachments/session/doc.md',
            name: 'doc.md',
            kind: 'file',
            source: 'attachment',
        }]);
    });

    it('renders Ether source icons without the old square highlight wrapper', () => {
        const source = readFileSync(new URL('./ChatMessage.tsx', import.meta.url), 'utf8');
        const userContentSource = source.match(/const UserContent = \([\s\S]*?\n\};/)?.[0] || '';

        expect(userContentSource).toContain('MessengerIcon');
        expect(userContentSource).not.toContain('bg-cyan');
        expect(userContentSource).not.toContain('border-cyan');
        expect(userContentSource).not.toContain('h-5 w-5');
    });

    it('keeps implementation plan actions out of the transcript card', () => {
        const source = readFileSync(new URL('./ChatMessage.tsx', import.meta.url), 'utf8');
        const planCardSource = source.match(/const PlanArtifactCard = \([\s\S]*?\n\};/)?.[0] || '';

        expect(planCardSource).toContain('data-ricochet-plan-transcript-card');
        expect(planCardSource).not.toContain('codicon-preview');
        expect(planCardSource).not.toContain("type: 'plan_decision'");
        expect(planCardSource).not.toContain('Proceed');
        expect(planCardSource).not.toContain('Revise');
    });
});
