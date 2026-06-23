import { describe, expect, it, vi } from 'vitest';
import { syncAutoApprovalSettings } from './autoApprovalSync';

describe('syncAutoApprovalSettings', () => {
    it('saves auto-approval settings and broadcasts the refreshed settings snapshot', async () => {
        const refreshedSettings = {
            auto_approval: {
                enabled: true,
                execute_safe_commands: true,
                execute_all_commands: false,
            },
        };
        const core = {
            send: vi.fn(async (type: string) => {
                if (type === 'get_settings') return refreshedSettings;
                return { success: true };
            }),
        };
        const postMessage = vi.fn();

        await syncAutoApprovalSettings(core, postMessage, {
            enabled: true,
            execute_safe_commands: true,
        });

        expect(core.send).toHaveBeenNthCalledWith(1, 'save_settings', {
            auto_approval: {
                enabled: true,
                execute_safe_commands: true,
            },
        });
        expect(core.send).toHaveBeenNthCalledWith(2, 'get_settings', {});
        expect(postMessage).toHaveBeenCalledWith({
            type: 'settings_loaded',
            payload: refreshedSettings,
        });
    });
});
