import { McpServerManager } from './McpServerManager';
import * as path from 'path';
import * as fs from 'fs/promises';

export class McpService {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly postMessage: (msg: any) => void
    ) { }

    public async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'get_mcp_servers':
                await this.getServers();
                break;
            case 'connect_mcp_server':
                await this.connectServer(message.payload);
                break;
            case 'call_mcp_tool':
                await this.callTool(message.payload);
                break;
            case 'install_mcp':
                await this.installMcp(message.payload);
                break;
            case 'uninstall_mcp':
                await this.uninstallMcp(message.payload);
                break;
        }
    }

    private async getServers(): Promise<void> {
        try {
            const mcpHub = await McpServerManager.getInstance(this.context);
            const servers = mcpHub.getServers();
            this.postMessage({ type: 'mcp_servers', payload: { servers } });
        } catch (e) {
            console.error('Failed to get MCP servers:', e);
        }
    }

    private async connectServer(payload: { name: string, config: string }): Promise<void> {
        try {
            const mcpHub = await McpServerManager.getInstance(this.context);
            await mcpHub.connectToServer(payload.name, payload.config);
            // Refresh list
            const servers = mcpHub.getServers();
            this.postMessage({ type: 'mcp_servers', payload: { servers } });
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to connect MCP server: ${e}`);
        }
    }

    private async callTool(payload: { id: string, serverName: string, toolName: string, args: any }): Promise<void> {
        try {
            const mcpHub = await McpServerManager.getInstance(this.context);
            const result = await mcpHub.callTool(payload.serverName, payload.toolName, payload.args);
            this.postMessage({
                type: 'mcp_tool_result',
                payload: {
                    id: payload.id,
                    result
                }
            });
        } catch (e: any) {
            this.postMessage({
                type: 'mcp_tool_error',
                payload: {
                    id: payload.id,
                    error: e.message
                }
            });
        }
    }

    private async installMcp(payload: { id: string, name: string, command: string, args: string[], env?: Record<string, string> }): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const configPath = path.join(workspaceRoot, 'mcp_settings.json');

            let config: any = { mcpServers: {} };
            try {
                const existing = await fs.readFile(configPath, 'utf-8');
                config = JSON.parse(existing);
            } catch (e) {
                // File might not exist
            }

            if (!config.mcpServers) config.mcpServers = {};
            config.mcpServers[payload.id] = {
                command: payload.command,
                args: payload.args,
                env: payload.env || {}
            };

            await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
            vscode.window.showInformationMessage(`MCP Server ${payload.name} installed.`);

            // Re-fetch to update UI status
            await this.getServers();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to install MCP: ${e.message}`);
        }
    }

    private async uninstallMcp(payload: { id: string, name: string }): Promise<void> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            const configPath = path.join(workspaceRoot, 'mcp_settings.json');

            try {
                const existing = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(existing);
                if (config.mcpServers && config.mcpServers[payload.id]) {
                    delete config.mcpServers[payload.id];
                    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
                    vscode.window.showInformationMessage(`MCP Server ${payload.name} uninstalled.`);
                }
            } catch (e) {
                // File might not exist
            }

            // Re-fetch to update UI status
            await this.getServers();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to uninstall MCP: ${e.message}`);
        }
    }
}
