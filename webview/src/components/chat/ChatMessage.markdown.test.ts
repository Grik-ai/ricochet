import { describe, expect, it } from 'vitest';
import {
    looksLikeIdentifierReference,
    normalizeAssistantMarkdown,
    normalizeBrokenReferenceLines,
    normalizeCompactInlineCodeFences,
    pathIconClass,
    shouldInlineCodeFence,
} from './ChatMessage';
import { fileGlyphInfo } from '../common/FileGlyph';

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

    it('maps common file paths to colored glyph badges', () => {
        expect(fileGlyphInfo('ChatMessage.markdown.test.ts')).toMatchObject({ kind: 'badge', label: 'TS' });
        expect(fileGlyphInfo('src/components/ChatMessage.tsx')).toMatchObject({ kind: 'badge', label: 'TSX' });
        expect(fileGlyphInfo('src/main.rs')).toMatchObject({ kind: 'badge', label: 'RS' });
        expect(fileGlyphInfo('README.md')).toMatchObject({ kind: 'badge', label: 'MD' });
        expect(fileGlyphInfo('src', 'folder')).toMatchObject({ kind: 'codicon', icon: 'codicon-folder' });
        expect(fileGlyphInfo('unknown.weird')).toMatchObject({ kind: 'codicon', icon: 'codicon-file' });
    });
});
