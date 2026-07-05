import { describe, expect, it } from 'vitest';
import {
    buildMarketplaceInstallPayload,
    filterMarketplaceItems,
    marketplaceItemInstalledScopes,
    marketplaceRequiredParameters,
    validateMarketplaceInstall,
} from './MarketplaceView';
import type { MarketplaceInstalledMetadata, MarketplaceItem } from '../../types/marketplace';

const items: MarketplaceItem[] = [
    {
        id: 'github',
        type: 'mcp',
        name: 'GitHub',
        description: 'Issues and pull requests',
        category: 'development',
        tags: ['git', 'issues'],
        trust: 'verified',
        mcp: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env_vars: ['GITHUB_TOKEN'],
            tools: ['create_issue', 'search_repositories'],
        },
    },
    {
        id: 'memory',
        type: 'mcp',
        name: 'Memory',
        description: 'Local memory',
        category: 'knowledge',
        tags: ['local'],
        trust: 'community',
        mcp: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-memory'],
            tools: ['search_nodes'],
        },
    },
    {
        id: 'review',
        type: 'skill',
        name: 'Project Review',
        description: 'Review code changes',
        category: 'quality',
        tags: ['review'],
        trust: 'verified',
        skill: {
            skill_name: 'project-review',
            allowed_tools: ['read_file', 'grep_search'],
            files: [{ path: 'SKILL.md' }],
        },
    },
];

const metadata: MarketplaceInstalledMetadata = {
    project: [{ id: 'github', type: 'mcp', name: 'GitHub', scope: 'project' }],
    global: [{ id: 'review', type: 'skill', name: 'Project Review', scope: 'global' }],
};

describe('MarketplaceView helpers', () => {
    it('returns installed scopes for project and global installs', () => {
        expect(marketplaceItemInstalledScopes(items[0], metadata)).toEqual(['project']);
        expect(marketplaceItemInstalledScopes(items[2], metadata)).toEqual(['global']);
        expect(marketplaceItemInstalledScopes(items[1], metadata)).toEqual([]);
    });

    it('filters by type, status, tag, and search', () => {
        expect(filterMarketplaceItems(items, {
            type: 'mcp',
            query: '',
            status: 'installed',
            tag: 'all',
        }, metadata).map((item) => item.id)).toEqual(['github']);

        expect(filterMarketplaceItems(items, {
            type: 'mcp',
            query: 'search_nodes',
            status: 'not_installed',
            tag: 'knowledge',
        }, metadata).map((item) => item.id)).toEqual(['memory']);

        expect(filterMarketplaceItems(items, {
            type: 'skill',
            query: 'grep',
            status: 'all',
            tag: 'review',
        }, metadata).map((item) => item.id)).toEqual(['review']);
    });

    it('builds install payloads with project scope by default caller choice', () => {
        expect(buildMarketplaceInstallPayload(items[0], 'project', { GITHUB_TOKEN: 'secret' })).toEqual({
            id: 'github',
            type: 'mcp',
            scope: 'project',
            method: undefined,
            parameters: { GITHUB_TOKEN: 'secret' },
        });
    });

    it('validates required parameters for MCP env vars', () => {
        expect(marketplaceRequiredParameters(items[0]).map((param) => param.name)).toEqual(['GITHUB_TOKEN']);
        expect(validateMarketplaceInstall(items[0], {})).toEqual(['GITHUB_TOKEN']);
        expect(validateMarketplaceInstall(items[0], { GITHUB_TOKEN: 'secret' })).toEqual([]);
    });
});
