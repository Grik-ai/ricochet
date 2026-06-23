import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';

export interface CliInstallStatus {
    targetPath: string;
    expectedPath: string;
    installed: boolean;
    healthy: boolean;
    reason: string;
    actualPath?: string;
    version?: string;
}

function binaryName(): string {
    return process.platform === 'win32' ? 'ricochet-core.exe' : 'ricochet-core';
}

function pathExists(filePath: string): boolean {
    try {
        fs.lstatSync(filePath);
        return true;
    } catch {
        return false;
    }
}

function realPath(filePath: string): string {
    try {
        return fs.realpathSync.native(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

function samePath(a: string, b: string): boolean {
    return realPath(a) === realPath(b);
}

function stamp(): string {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
}

function resolveBundledBinary(context: vscode.ExtensionContext): string | undefined {
    const name = binaryName();
    const bundledPath = path.join(context.extensionPath, 'bin', `${process.platform}-${process.arch}`, name);
    if (fs.existsSync(bundledPath)) {
        return bundledPath;
    }

    const devPath = path.join(context.extensionPath, '..', 'extension-vscode', 'bin', `${process.platform}-${process.arch}`, name);
    if (fs.existsSync(devPath)) {
        return devPath;
    }

    return undefined;
}

function cliTargetPath(): string {
    return path.join(os.homedir(), '.local', 'bin', 'ricochet');
}

function readCliVersion(binaryPath: string): string | undefined {
    try {
        const output = childProcess.execFileSync(binaryPath, ['version', '--json'], {
            encoding: 'utf8',
            timeout: 3000,
            env: { ...process.env, RICOCHET_NO_COLOR: '1' }
        });
        const start = output.indexOf('{');
        const end = output.lastIndexOf('}');
        if (start < 0 || end < start) {
            return undefined;
        }
        const parsed = JSON.parse(output.slice(start, end + 1));
        return typeof parsed.version === 'string' ? parsed.version : undefined;
    } catch {
        return undefined;
    }
}

export function getCliInstallStatus(context: vscode.ExtensionContext): CliInstallStatus {
    const targetPath = cliTargetPath();
    const expectedPath = resolveBundledBinary(context) || '';
    if (!expectedPath) {
        return {
            targetPath,
            expectedPath,
            installed: false,
            healthy: false,
            reason: 'bundled ricochet-core binary is missing'
        };
    }

    if (!pathExists(targetPath)) {
        return {
            targetPath,
            expectedPath,
            installed: false,
            healthy: false,
            reason: 'not installed'
        };
    }

    const actualPath = realPath(targetPath);
    const version = readCliVersion(targetPath);
    if (!samePath(targetPath, expectedPath)) {
        return {
            targetPath,
            expectedPath,
            actualPath,
            version,
            installed: true,
            healthy: false,
            reason: `installed CLI points to ${actualPath}`
        };
    }
    if (!version) {
        return {
            targetPath,
            expectedPath,
            actualPath,
            installed: true,
            healthy: false,
            reason: 'installed CLI does not support version --json'
        };
    }

    return {
        targetPath,
        expectedPath,
        actualPath,
        version,
        installed: true,
        healthy: true,
        reason: `installed (${version})`
    };
}

function backupExisting(targetPath: string): string | undefined {
    if (!pathExists(targetPath)) {
        return undefined;
    }
    const backupPath = `${targetPath}.old-${stamp()}`;
    fs.renameSync(targetPath, backupPath);
    return backupPath;
}

export async function installCli(context: vscode.ExtensionContext) {
    const status = getCliInstallStatus(context);
    const extensionBinPath = status.expectedPath;
    if (!extensionBinPath) {
        vscode.window.showErrorMessage(`Ricochet binary not found: ${status.reason}`);
        return;
    }

    if (status.healthy) {
        vscode.window.showInformationMessage(`Ricochet CLI is already installed at ${status.targetPath} (${status.version}).`);
        return;
    }

    const targetPath = status.targetPath;
    const localBin = path.dirname(targetPath);

    // Ensure ~/.local/bin exists
    if (!fs.existsSync(localBin)) {
        try {
            fs.mkdirSync(localBin, { recursive: true });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create ${localBin}: ${error}`);
            return;
        }
    }

    // 3. Create Symlink
    try {
        const backupPath = backupExisting(targetPath);

        fs.symlinkSync(extensionBinPath, targetPath);
        fs.chmodSync(extensionBinPath, '755'); // Ensure executable

        const nextStatus = getCliInstallStatus(context);
        const suffix = backupPath ? ` Previous CLI backed up to ${backupPath}.` : '';
        vscode.window.showInformationMessage(`Successfully installed 'ricochet' to ${targetPath} (${nextStatus.version || 'version unknown'}).${suffix}`);

        // Optional: Check if ~/.local/bin is in PATH
        if (!process.env.PATH?.includes('.local/bin')) {
            vscode.window.showWarningMessage(`Note: ${localBin} is not in your PATH. You may need to add it.`);
        }

    } catch (error) {
        console.error(error);

        // Fallback: Copy to clipboard?
        const action = await vscode.window.showErrorMessage(
            `Failed to install CLI: ${error}. Try manual installation?`,
            'Copy Command'
        );

        if (action === 'Copy Command') {
            const cmd = `mkdir -p "$HOME/.local/bin" && ln -sfn "${extensionBinPath}" "$HOME/.local/bin/ricochet" && "$HOME/.local/bin/ricochet" version --json`;
            await vscode.env.clipboard.writeText(cmd);
            vscode.window.showInformationMessage('Command copied! Run it in your terminal (may require sudo).');
        }
    }
}
