export interface CoreSettingsClient {
    send(type: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface WebviewPoster {
    (message: { type: string; payload?: unknown }): void;
}

export async function syncAutoApprovalSettings(
    core: CoreSettingsClient,
    postMessage: WebviewPoster,
    autoApproval: Record<string, unknown>,
): Promise<unknown> {
    await core.send('save_settings', { auto_approval: autoApproval });
    const settings = await core.send('get_settings', {});
    postMessage({ type: 'settings_loaded', payload: settings });
    return settings;
}
