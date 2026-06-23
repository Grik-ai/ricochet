import * as vscode from 'vscode';
import { WebviewProvider } from './webview-provider';
import { CoreProcess } from './core-process';
import { LanguageService } from './services/language';
import { PendingChangesTreeProvider } from './services/review/PendingChangesTree';
import * as dns from 'node:dns';
import { getCliInstallStatus, installCli } from './commands/installCli';

let coreProcess: CoreProcess | undefined;

export async function activate(context: vscode.ExtensionContext) {
    // Set default auto-select family attempt timeout to 1000ms
    // This helps with "no such host" errors on some networks (Happy Eyeballs)
    if ((dns as any).setDefaultAutoSelectFamilyAttemptTimeout) {
        (dns as any).setDefaultAutoSelectFamilyAttemptTimeout(1000);
    }
    console.log('Ricochet extension activating...');

    // Get workspace root path
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || context.extensionPath;
    console.log(`Preparing lazy CoreProcess with workspace: ${workspacePath}`);

    // Create the Go core process wrapper, but do not spawn the binary until a
    // Ricochet view/command actually sends a request. This prevents passive IDE
    // windows from becoming Telegram/Discord gateway owners.
    coreProcess = new CoreProcess(workspacePath, context.extensionPath);

    // Initialize Language Service (LSP Bridge)
    new LanguageService(coreProcess);

    // Register webview provider
    const webviewProvider = new WebviewProvider(context, coreProcess);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'ricochet.chatView',
            webviewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    const pendingChangesProvider = new PendingChangesTreeProvider(context);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('ricochet.pendingChanges', pendingChangesProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('ricochet.newChat', async () => {
            await webviewProvider.createNewSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ricochet.toggleLiveMode', async () => {
            await webviewProvider.toggleLiveMode();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ricochet.openSettings', async () => {
            await webviewProvider.openSettings();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ricochet.openAgent', async () => {
            await webviewProvider.openAgent();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ricochet.openHistory', async () => {
            await webviewProvider.openHistory();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ricochet.openAccount', async () => {
            await webviewProvider.openAccount();
        })
    );

    // Register generic install command
    context.subscriptions.push(
        vscode.commands.registerCommand('ricochet.installCli', async () => {
            await installCli(context);
        })
    );

    // Check if CLI is installed on startup
    checkCliInstallation(context);

    console.log('Ricochet extension activated');
}

function checkCliInstallation(context: vscode.ExtensionContext) {
    const status = getCliInstallStatus(context);

    if (!status.healthy) {
        vscode.window.showInformationMessage(
            `Ricochet CLI needs install/update: ${status.reason}. Install it for terminal integration?`,
            "Install/Update",
            "Ignore"
        ).then(selection => {
            if (selection === "Install/Update") {
                vscode.commands.executeCommand('ricochet.installCli');
            }
        });
    }
}

export async function deactivate() {
    console.log('Ricochet extension deactivating...');

    if (coreProcess) {
        await coreProcess.stop();
    }

    console.log('Ricochet extension deactivated');
}
