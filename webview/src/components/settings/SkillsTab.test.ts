import { describe, expect, it } from 'vitest';
import {
    buildSkillGroups,
    buildSkillSummary,
    filterSkillList,
    skillStatusCopy,
    type SkillManifest,
} from './SkillsTab';

const fixtures: SkillManifest[] = [
    {
        name: 'debug',
        display_name: 'Debug Ricochet',
        description: 'Diagnose runtime logs',
        enabled: true,
        source: 'bundled',
        scope: 'bundled',
        allowed_tools: ['read_file', 'grep_search'],
        trigger_hint: ['debug', 'logs'],
        implicit_invocation: true,
        load_status: 'ok',
    },
    {
        name: 'browser-automation',
        description: 'Automate browser flows',
        enabled: false,
        source: 'project',
        scope: 'project',
        content_path: '/repo/.ricochet/skills/browser-automation/SKILL.md',
        implicit_invocation: false,
        visibility: 'off',
        load_status: 'ok',
    },
    {
        name: '_diagnostic_browser',
        display_name: 'Misplaced skill file: browser_automation.md',
        description: 'Project skills must live under a folder',
        enabled: false,
        source: 'project',
        scope: 'project',
        content_path: '/repo/.ricochet/skills/browser_automation.md',
        load_status: 'warning',
        validation_errors: ['Project skills must live at .ricochet/skills/<name>/SKILL.md.'],
    },
    {
        name: 'repo-rules',
        display_name: 'Repository Rules',
        description: 'Always-on workspace instructions',
        enabled: true,
        type: 'root_rule',
        scope: 'root_rule',
        implicit_invocation: false,
        load_status: 'ok',
    },
    {
        name: 'legacy-review',
        description: 'Legacy review guidance',
        enabled: true,
        source: 'legacy',
        scope: 'legacy',
        implicit_invocation: false,
        load_status: 'ok',
    },
];

describe('SkillsTab helpers', () => {
    it('builds summary counts including diagnostics', () => {
        expect(buildSkillSummary(fixtures)).toEqual({
            total: 5,
            enabled: 3,
            disabled: 2,
        problems: 1,
        project: 2,
        global: 0,
    });
    });

    it('groups skills by source in the settings display order', () => {
        const groups = buildSkillGroups(fixtures);

        expect(groups.map((group) => group.source)).toEqual(['project', 'bundled', 'legacy', 'root_rule']);
        expect(groups.map((group) => group.label)).toEqual(['Project', 'Bundled', 'Legacy', 'Root rules']);
        expect(groups[0].skills.map((skill) => skill.name)).toEqual(['browser-automation', '_diagnostic_browser']);
    });

    it('filters by search, source, status, and auto invocation', () => {
        expect(filterSkillList(fixtures, {
            query: 'grep',
            status: 'all',
            source: 'all',
            sort: 'source',
            autoInvocableOnly: false,
        }).map((skill) => skill.name)).toEqual(['debug']);

        expect(filterSkillList(fixtures, {
            query: '',
            status: 'problems',
            source: 'project',
            sort: 'status',
            autoInvocableOnly: false,
        }).map((skill) => skill.name)).toEqual(['_diagnostic_browser']);

        expect(filterSkillList(fixtures, {
            query: '',
            status: 'all',
            source: 'all',
            sort: 'source',
            autoInvocableOnly: true,
        }).map((skill) => skill.name)).toEqual(['debug']);

        expect(filterSkillList(fixtures, {
            query: '',
            status: 'all',
            source: 'legacy',
            sort: 'source',
            autoInvocableOnly: false,
        }).map((skill) => skill.name)).toEqual(['legacy-review']);
    });

    it('renders disabled and diagnostic copy distinctly', () => {
        expect(skillStatusCopy(fixtures[1])).toBe('Disabled by local settings');
        expect(skillStatusCopy(fixtures[2])).toBe('Needs attention');
    });
});
