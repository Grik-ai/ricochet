import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

export interface PendingEdit {
    filePath: string;
    newContent: string;
    originalContent: string;
    additions: number;
    deletions: number;
    baseContentHash: string;
    proposedContentHash: string;
    currentContentHash?: string;
    status: 'pending' | 'reviewing' | 'conflicted';
    conflictReason?: string;
    isNewFile: boolean;
    proposalId?: string;
    tool?: string;
}

export interface EditHunk {
    id: string;
    oldStart: number;
    oldLength: number;
    newStart: number;
    newLength: number;
    oldLines: string[];
    newLines: string[];
    additions: number;
    deletions: number;
}

export interface EditDecision {
    proposalId?: string;
    filePath: string;
    decision: 'accepted' | 'rejected' | 'conflicted';
    applied: boolean;
    reason?: string;
}

export class DiffService extends EventEmitter {
    private static instance: DiffService;
    private static tempDir = path.join(os.tmpdir(), 'ricochet-diff');
    private pendingEdits: Map<string, PendingEdit> = new Map();

    public static getInstance(): DiffService {
        if (!DiffService.instance) {
            DiffService.instance = new DiffService();
        }
        return DiffService.instance;
    }

    private constructor() {
        super();
        if (!fs.existsSync(DiffService.tempDir)) {
            fs.mkdirSync(DiffService.tempDir, { recursive: true });
        }
    }

    private toAbsolutePath(filePath: string): string {
        if (path.isAbsolute(filePath)) return filePath;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return filePath;
        return path.join(workspaceFolders[0].uri.fsPath, filePath);
    }

    public registerPendingEdit(filePath: string, newContent: string, options?: { originalContent?: string; proposalId?: string; tool?: string }): PendingEdit | undefined {
        const fullPath = this.toAbsolutePath(filePath);
        let originalContent = '';
        const existedAtProposal = fs.existsSync(fullPath);
        if (options?.originalContent !== undefined) {
            originalContent = options.originalContent;
        } else {
            try {
                if (existedAtProposal) {
                    originalContent = fs.readFileSync(fullPath, 'utf8');
                }
            } catch (e) {}
        }

        const hunks = this.computeHunks(originalContent, newContent);
        if (hunks.length === 0) {
            return undefined;
        }
        const stats = this.calculateStatsFromHunks(hunks);
        const conflict = this.getConflictState(fullPath, originalContent, newContent, !existedAtProposal);
        const edit: PendingEdit = {
            filePath: fullPath,
            newContent,
            originalContent,
            additions: stats.additions,
            deletions: stats.deletions,
            baseContentHash: this.hashContent(originalContent),
            proposedContentHash: this.hashContent(newContent),
            currentContentHash: conflict.currentContentHash,
            status: conflict.hasConflict ? 'conflicted' : 'pending',
            conflictReason: conflict.reason,
            isNewFile: !existedAtProposal,
            proposalId: options?.proposalId,
            tool: options?.tool
        };
        this.pendingEdits.set(fullPath, edit);
        this.emit('change');
        return edit;
    }

    private calculateStats(oldContent: string, newContent: string) {
        return this.calculateStatsFromHunks(this.computeHunks(oldContent, newContent));
    }

    private calculateStatsFromHunks(hunks: EditHunk[]) {
        return hunks.reduce(
            (stats, hunk) => ({
                additions: stats.additions + hunk.additions,
                deletions: stats.deletions + hunk.deletions
            }),
            { additions: 0, deletions: 0 }
        );
    }

    public getHunks(filePath: string): EditHunk[] {
        const edit = this.getPendingEdit(filePath);
        if (!edit) return [];
        return this.computeHunks(edit.originalContent, edit.newContent);
    }

    private computeHunks(oldContent: string, newContent: string): EditHunk[] {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');

        const maxCells = oldLines.length * newLines.length;
        if (maxCells > 250000) {
            return this.computeHunksByPosition(oldLines, newLines);
        }

        const dp = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
        for (let i = 1; i <= oldLines.length; i++) {
            for (let j = 1; j <= newLines.length; j++) {
                dp[i][j] = oldLines[i - 1] === newLines[j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }

        type Op = { type: 'equal' | 'add' | 'delete'; line: string };
        const ops: Op[] = [];
        let i = oldLines.length;
        let j = newLines.length;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
                ops.push({ type: 'equal', line: oldLines[i - 1] });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                ops.push({ type: 'add', line: newLines[j - 1] });
                j--;
            } else {
                ops.push({ type: 'delete', line: oldLines[i - 1] });
                i--;
            }
        }
        return this.opsToHunks(ops.reverse());
    }

    private computeHunksByPosition(oldLines: string[], newLines: string[]): EditHunk[] {
        const hunks: EditHunk[] = [];
        let index = 0;

        while (index < Math.max(oldLines.length, newLines.length)) {
            if (oldLines[index] === newLines[index]) {
                index++;
                continue;
            }

            const oldStart = index;
            const newStart = index;
            const oldChunk: string[] = [];
            const newChunk: string[] = [];

            while (index < Math.max(oldLines.length, newLines.length) && oldLines[index] !== newLines[index]) {
                if (index < oldLines.length) oldChunk.push(oldLines[index]);
                if (index < newLines.length) newChunk.push(newLines[index]);
                index++;
            }

            hunks.push(this.createHunk(oldStart, oldChunk, newStart, newChunk));
        }

        return hunks;
    }

    private opsToHunks(ops: { type: 'equal' | 'add' | 'delete'; line: string }[]): EditHunk[] {
        const hunks: EditHunk[] = [];
        let oldCursor = 0;
        let newCursor = 0;
        let index = 0;

        while (index < ops.length) {
            const op = ops[index];
            if (!op || op.type === 'equal') {
                oldCursor++;
                newCursor++;
                index++;
                continue;
            }

            const oldStart = oldCursor;
            const newStart = newCursor;
            const oldChunk: string[] = [];
            const newChunk: string[] = [];

            while (index < ops.length && ops[index].type !== 'equal') {
                const change = ops[index];
                if (change.type === 'delete') {
                    oldChunk.push(change.line);
                    oldCursor++;
                } else {
                    newChunk.push(change.line);
                    newCursor++;
                }
                index++;
            }

            hunks.push(this.createHunk(oldStart, oldChunk, newStart, newChunk));
        }

        return hunks;
    }

    private createHunk(oldStart: number, oldLines: string[], newStart: number, newLines: string[]): EditHunk {
        const signature = `${oldStart}:${oldLines.length}:${newStart}:${newLines.length}:${this.hashContent(oldLines.join('\n'))}:${this.hashContent(newLines.join('\n'))}`;
        return {
            id: crypto.createHash('sha1').update(signature).digest('hex').slice(0, 12),
            oldStart,
            oldLength: oldLines.length,
            newStart,
            newLength: newLines.length,
            oldLines,
            newLines,
            additions: newLines.length,
            deletions: oldLines.length
        };
    }

    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private getOpenDocumentContent(filePath: string): string | undefined {
        const normalized = this.toAbsolutePath(filePath);
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === normalized);
        return doc?.getText();
    }

    private readDiskContent(filePath: string): string | undefined {
        try {
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf8');
            }
        } catch (e) {}
        return undefined;
    }

    private getConflictState(filePath: string, originalContent: string, newContent: string, isNewFile: boolean): { hasConflict: boolean; reason?: string; currentContentHash?: string } {
        const openContent = this.getOpenDocumentContent(filePath);
        const diskContent = this.readDiskContent(filePath);
        const currentContent = openContent ?? diskContent ?? '';
        const currentContentHash = this.hashContent(currentContent);

        if (isNewFile) {
            if (diskContent !== undefined && diskContent !== newContent) {
                return { hasConflict: true, reason: 'File was created outside Ricochet while review was pending.', currentContentHash };
            }
            if (openContent !== undefined && openContent !== '' && openContent !== newContent) {
                return { hasConflict: true, reason: 'Open editor content no longer matches the proposed new file.', currentContentHash };
            }
            return { hasConflict: false, currentContentHash };
        }

        if (openContent !== undefined && openContent !== originalContent && openContent !== newContent) {
            return { hasConflict: true, reason: 'Open editor content changed after Ricochet proposed this edit.', currentContentHash };
        }

        if (diskContent !== undefined && diskContent !== originalContent && diskContent !== newContent) {
            return { hasConflict: true, reason: 'File changed on disk after Ricochet proposed this edit.', currentContentHash: this.hashContent(diskContent) };
        }

        return { hasConflict: false, currentContentHash };
    }

    public refreshPendingEdit(filePath: string): PendingEdit | undefined {
        const edit = this.getPendingEdit(filePath);
        if (!edit) return undefined;

        const conflict = this.getConflictState(edit.filePath, edit.originalContent, edit.newContent, edit.isNewFile);
        edit.currentContentHash = conflict.currentContentHash;
        edit.status = conflict.hasConflict ? 'conflicted' : edit.status === 'reviewing' ? 'reviewing' : 'pending';
        edit.conflictReason = conflict.reason;
        this.pendingEdits.set(edit.filePath, edit);
        return edit;
    }

    public getPendingEdit(filePath: string): PendingEdit | undefined {
        const fullPath = this.toAbsolutePath(filePath);
        return this.pendingEdits.get(fullPath);
    }

    public getPendingEdits(): PendingEdit[] {
        return Array.from(this.pendingEdits.values()).map(edit => this.refreshPendingEdit(edit.filePath) ?? edit);
    }

    public clearPendingEdit(filePath: string) {
        const fullPath = this.toAbsolutePath(filePath);
        this.pendingEdits.delete(fullPath);
        this.emit('change');
    }

    private updateEditContent(edit: PendingEdit, originalContent: string, newContent: string): PendingEdit {
        const hunks = this.computeHunks(originalContent, newContent);
        const stats = this.calculateStatsFromHunks(hunks);
        edit.originalContent = originalContent;
        edit.newContent = newContent;
        edit.additions = stats.additions;
        edit.deletions = stats.deletions;
        edit.baseContentHash = this.hashContent(originalContent);
        edit.proposedContentHash = this.hashContent(newContent);
        edit.status = hunks.length === 0 ? 'pending' : 'reviewing';
        edit.conflictReason = undefined;
        this.pendingEdits.set(edit.filePath, edit);
        this.emit('change');
        return edit;
    }

    private replaceLines(content: string, start: number, deleteCount: number, insertLines: string[]): string {
        const lines = content.split('\n');
        lines.splice(start, deleteCount, ...insertLines);
        return lines.join('\n');
    }

    private async setOpenDocumentContent(filePath: string, content: string): Promise<void> {
        const fullPath = this.toAbsolutePath(filePath);
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === fullPath);
        if (!editor) return;

        const doc = editor.document;
        const end = doc.lineCount > 0 ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(0, 0);
        await editor.edit(editBuilder => {
            editBuilder.replace(new vscode.Range(new vscode.Position(0, 0), end), content);
        });
    }

    public async acceptHunk(filePath: string, hunkId: string): Promise<void> {
        const edit = this.refreshPendingEdit(filePath);
        if (!edit) return;
        if (edit.status === 'conflicted') {
            vscode.window.showWarningMessage(edit.conflictReason || `Cannot accept hunk in ${path.basename(filePath)} because it changed during review.`);
            this.emit('change');
            return;
        }

        const hunk = this.getHunks(edit.filePath).find(item => item.id === hunkId);
        if (!hunk) {
            vscode.window.showWarningMessage(`That Ricochet change block is no longer available.`);
            this.emit('change');
            return;
        }

        const nextOriginal = this.replaceLines(edit.originalContent, hunk.oldStart, hunk.oldLength, hunk.newLines);
        if (!fs.existsSync(path.dirname(edit.filePath))) {
            fs.mkdirSync(path.dirname(edit.filePath), { recursive: true });
        }
        fs.writeFileSync(edit.filePath, nextOriginal);
        edit.isNewFile = false;

        this.updateEditContent(edit, nextOriginal, edit.newContent);
        if (this.getHunks(edit.filePath).length === 0) {
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === edit.filePath);
            if (openDoc?.uri.scheme === 'file' && openDoc.getText() === edit.newContent) {
                await openDoc.save();
            }
            this.clearPendingEdit(edit.filePath);
            this.emit('decision', {
                proposalId: edit.proposalId,
                filePath: edit.filePath,
                decision: 'accepted',
                applied: true
            } satisfies EditDecision);
            vscode.window.showInformationMessage(`Applied all changes to ${path.basename(filePath)}`);
            return;
        }

        vscode.window.showInformationMessage(`Accepted one change in ${path.basename(filePath)}`);
    }

    public async rejectHunk(filePath: string, hunkId: string): Promise<void> {
        const edit = this.refreshPendingEdit(filePath);
        if (!edit) return;
        if (edit.status === 'conflicted') {
            vscode.window.showWarningMessage(edit.conflictReason || `Cannot reject hunk in ${path.basename(filePath)} because it changed during review.`);
            this.emit('change');
            return;
        }

        const hunk = this.getHunks(edit.filePath).find(item => item.id === hunkId);
        if (!hunk) {
            vscode.window.showWarningMessage(`That Ricochet change block is no longer available.`);
            this.emit('change');
            return;
        }

        const nextProposed = this.replaceLines(edit.newContent, hunk.newStart, hunk.newLength, hunk.oldLines);
        await this.setOpenDocumentContent(edit.filePath, nextProposed);
        this.updateEditContent(edit, edit.originalContent, nextProposed);

        if (this.getHunks(edit.filePath).length === 0) {
            this.clearPendingEdit(edit.filePath);
            this.emit('decision', {
                proposalId: edit.proposalId,
                filePath: edit.filePath,
                decision: 'rejected',
                applied: false
            } satisfies EditDecision);
            vscode.window.showInformationMessage(`Discarded all changes to ${path.basename(filePath)}`);
            return;
        }

        vscode.window.showInformationMessage(`Rejected one change in ${path.basename(filePath)}`);
    }

    public async applyPendingEdit(filePath: string) {
        const edit = this.refreshPendingEdit(filePath);
        if (edit) {
            if (edit.status === 'conflicted') {
                const event: EditDecision = {
                    proposalId: edit.proposalId,
                    filePath: edit.filePath,
                    decision: 'conflicted',
                    applied: false,
                    reason: edit.conflictReason
                };
                this.emit('decision', event);
                vscode.window.showWarningMessage(edit.conflictReason || `Cannot apply ${path.basename(filePath)} because it changed during review.`);
                this.emit('change');
                return;
            }
            if (!fs.existsSync(path.dirname(edit.filePath))) {
                fs.mkdirSync(path.dirname(edit.filePath), { recursive: true });
            }
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === edit.filePath);
            if (openDoc?.uri.scheme === 'file' && openDoc.getText() === edit.newContent) {
                const saved = await openDoc.save();
                if (!saved) {
                    fs.writeFileSync(edit.filePath, edit.newContent);
                }
            } else {
                fs.writeFileSync(edit.filePath, edit.newContent);
                await vscode.workspace.openTextDocument(vscode.Uri.file(edit.filePath)).then(doc => {
                    return vscode.window.showTextDocument(doc, { preview: false });
                }).catch(() => undefined);
            }
            this.clearPendingEdit(filePath);
            const event: EditDecision = {
                proposalId: edit.proposalId,
                filePath: edit.filePath,
                decision: 'accepted',
                applied: true
            };
            this.emit('decision', event);
            vscode.window.showInformationMessage(`Applied changes to ${path.basename(filePath)}`);
        }
    }

    public async rejectPendingEdit(filePath: string) {
        const edit = this.getPendingEdit(filePath);
        if (!edit) return;

        this.clearPendingEdit(filePath);
        const event: EditDecision = {
            proposalId: edit.proposalId,
            filePath: edit.filePath,
            decision: 'rejected',
            applied: false
        };
        this.emit('decision', event);
    }

    public markReviewing(filePath: string) {
        const edit = this.getPendingEdit(filePath);
        if (!edit) return;
        const refreshed = this.refreshPendingEdit(filePath);
        if (!refreshed || refreshed.status === 'conflicted') {
            this.emit('change');
            return;
        }
        refreshed.status = 'reviewing';
        refreshed.conflictReason = undefined;
        this.pendingEdits.set(refreshed.filePath, refreshed);
        this.emit('change');
    }

    public async showDiff(filePath: string, newContent: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folder open');
        }

        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceFolders[0].uri.fsPath, filePath);

        if (!fs.existsSync(fullPath)) {
            // New file case or file not found
            const newFileUri = vscode.Uri.file(fullPath);
            await vscode.window.showTextDocument(newFileUri);
            return;
        }

        const originalContent = fs.readFileSync(fullPath, 'utf8');

        // Create temporary file for new content
        const fileName = path.basename(filePath);
        const folderName = crypto.createHash('md5').update(filePath).digest('hex').substring(0, 8);
        const tempFolderPath = path.join(DiffService.tempDir, folderName);

        if (!fs.existsSync(tempFolderPath)) {
            fs.mkdirSync(tempFolderPath, { recursive: true });
        }

        const tempFilePath = path.join(tempFolderPath, fileName);
        fs.writeFileSync(tempFilePath, newContent);

        const originalUri = vscode.Uri.file(fullPath);
        const proposedUri = vscode.Uri.file(tempFilePath);

        await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            proposedUri,
            `${fileName} (Proposed Changes)`,
            { isWholeLine: true }
        );
    }

    public async showPartialDiff(filePath: string, targetContent: string, replacementContent: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folder open');
        }

        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceFolders[0].uri.fsPath, filePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error('File not found for partial diff');
        }

        const originalContent = fs.readFileSync(fullPath, 'utf8');

        // Find and replace (simple string replacement for now)
        if (!originalContent.includes(targetContent)) {
            throw new Error('Target content not found in file');
        }

        const newContent = originalContent.replace(targetContent, replacementContent);

        // Use existing showDiff logic
        await this.showDiff(filePath, newContent);
    }

    public static cleanup(): void {
        if (fs.existsSync(DiffService.tempDir)) {
            try {
                fs.rmSync(DiffService.tempDir, { recursive: true, force: true });
            } catch (e) {
                console.error('Failed to cleanup diff temp dir:', e);
            }
        }
    }
}
