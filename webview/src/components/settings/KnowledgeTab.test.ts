import { describe, expect, it } from 'vitest';
import type { WorkspaceIndexStatus } from '../../types/protocol';
import {
    formatIndexBytes,
    formatIndexDuration,
    semanticIndexHealth,
    workspaceMapHealth,
    type IndexStatus,
} from './KnowledgeTab';

describe('KnowledgeTab helpers', () => {
    it('labels semantic index states without calling empty indexes healthy', () => {
        expect(semanticIndexHealth(undefined, false)).toMatchObject({ label: 'Disabled', tone: 'neutral' });
        expect(semanticIndexHealth({ is_indexing: true, total_docs: 0 }, true)).toMatchObject({ label: 'Indexing', tone: 'progress' });
        expect(semanticIndexHealth({ is_indexing: false, total_docs: 0, provider_configured: false }, true)).toMatchObject({ label: 'Needs embeddings', tone: 'warn' });
        expect(semanticIndexHealth({ is_indexing: false, total_docs: 0, provider_configured: true }, true)).toMatchObject({ label: 'Empty', tone: 'warn' });
        expect(semanticIndexHealth({ is_indexing: false, total_docs: 12, provider_configured: true }, true)).toMatchObject({ label: 'Ready', tone: 'good' });
        expect(semanticIndexHealth({ is_indexing: false, total_docs: 12, error: 'embed failed' } as IndexStatus, true)).toMatchObject({ label: 'Problem', tone: 'danger' });
    });

    it('labels workspace map status distinctly from semantic vectors', () => {
        expect(workspaceMapHealth(undefined, false)).toMatchObject({ label: 'Disabled', tone: 'neutral' });
        expect(workspaceMapHealth({ status: 'disabled', enabled: false } as WorkspaceIndexStatus, true)).toMatchObject({ label: 'Not built', tone: 'warn' });
        expect(workspaceMapHealth({ status: 'indexing', enabled: true } as WorkspaceIndexStatus, true)).toMatchObject({ label: 'Indexing', tone: 'progress' });
        expect(workspaceMapHealth({ status: 'error', enabled: true, error: 'walk failed' } as WorkspaceIndexStatus, true)).toMatchObject({ label: 'Problem', tone: 'danger' });
        expect(workspaceMapHealth({ status: 'clean', enabled: true, files_indexed: 150 } as WorkspaceIndexStatus, true)).toMatchObject({ label: 'Ready', tone: 'good' });
    });

    it('formats compact metrics', () => {
        expect(formatIndexBytes(0)).toBe('0 B');
        expect(formatIndexBytes(1536)).toBe('1.5 KB');
        expect(formatIndexBytes(1024 * 1024 * 12)).toBe('12 MB');
        expect(formatIndexDuration(167)).toBe('167ms');
        expect(formatIndexDuration(1500)).toBe('1.5s');
        expect(formatIndexDuration(12000)).toBe('12s');
    });
});
