import { describe, expect, it } from 'vitest';
import { buildPermissionRulePayload } from './PermissionsTab';

describe('PermissionsTab payload builder', () => {
    it('builds target rules without command prefixes', () => {
        const result = buildPermissionRulePayload({
            tool: 'write_file',
            action: 'allow',
            scope: 'project',
            matchKind: 'target',
            target: 'README.md',
            commandPrefix: 'git status',
            sessionId: '',
        });

        expect(result.error).toBeUndefined();
        expect(result.payload).toEqual({
            tool: 'write_file',
            action: 'allow',
            scope: 'project',
            path: 'README.md',
        });
    });

    it('builds command prefix rules without path targets', () => {
        const result = buildPermissionRulePayload({
            tool: 'execute_command',
            action: 'deny',
            scope: 'global',
            matchKind: 'command_prefix',
            target: 'README.md',
            commandPrefix: 'rm -rf',
            sessionId: '',
        });

        expect(result.error).toBeUndefined();
        expect(result.payload).toEqual({
            tool: 'execute_command',
            action: 'deny',
            scope: 'global',
            command_prefix: 'rm -rf',
        });
    });

    it('requires a session id for session-scoped rules', () => {
        const result = buildPermissionRulePayload({
            tool: 'browser_open',
            action: 'allow',
            scope: 'session',
            matchKind: 'target',
            target: 'https://example.com',
            commandPrefix: '',
            sessionId: '',
        });

        expect(result.error).toBe('Session scope requires a session id.');
        expect(result.payload).toBeUndefined();
    });

    it('limits command prefix rules to command execution', () => {
        const result = buildPermissionRulePayload({
            tool: 'mcp',
            action: 'allow',
            scope: 'project',
            matchKind: 'command_prefix',
            target: '',
            commandPrefix: 'custom_tool',
            sessionId: '',
        });

        expect(result.error).toBe('Command prefix rules only apply to Run commands.');
        expect(result.payload).toBeUndefined();
    });

    it('requires a non-empty command prefix in command prefix mode', () => {
        const result = buildPermissionRulePayload({
            tool: 'execute_command',
            action: 'allow',
            scope: 'project',
            matchKind: 'command_prefix',
            target: '',
            commandPrefix: '',
            sessionId: '',
        });

        expect(result.error).toBe('Command prefix is required.');
        expect(result.payload).toBeUndefined();
    });
});
