import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DiffService, EditHunk, PendingEdit } from '../diff/DiffService';
import { ReviewService } from './ReviewService';

type PendingChangeKind = 'file' | 'hunk';

class PendingChangeItem extends vscode.TreeItem {
    constructor(
        public readonly kind: PendingChangeKind,
        public readonly edit: PendingEdit,
        public readonly hunk?: EditHunk
    ) {
        super(
            kind === 'file'
                ? path.basename(edit.filePath)
                : `Hunk ${hunk ? `+${hunk.additions} -${hunk.deletions}` : ''}`,
            kind === 'file' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        this.id = kind === 'file' ? edit.filePath : `${edit.filePath}:${hunk?.id}`;
        this.contextValue = kind === 'file' ? 'pendingFile' : 'pendingHunk';
        this.description = kind === 'file'
            ? `${edit.status}${edit.additions || edit.deletions ? `  +${edit.additions} -${edit.deletions}` : ''}`
            : this.formatHunkLocation(hunk);
        this.tooltip = edit.conflictReason || edit.filePath;
        this.iconPath = kind === 'file'
            ? new vscode.ThemeIcon(edit.status === 'conflicted' ? 'warning' : 'diff')
            : new vscode.ThemeIcon('diff-single');

        this.command = {
            command: 'ricochet.openPendingChange',
            title: 'Open Pending Change',
            arguments: [edit.filePath, hunk?.id]
        };
    }

    private formatHunkLocation(hunk?: EditHunk): string {
        if (!hunk) return '';
        const line = Math.max(hunk.newStart + 1, 1);
        return `line ${line}`;
    }
}

export class PendingChangesTreeProvider implements vscode.TreeDataProvider<PendingChangeItem> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<PendingChangeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        DiffService.getInstance().on('change', () => this.refresh());

        context.subscriptions.push(
            vscode.commands.registerCommand('ricochet.refreshPendingChanges', () => this.refresh()),
            vscode.commands.registerCommand('ricochet.openPendingChange', async (target: string | PendingChangeItem | any, hunkId?: string) => {
                const filePath = typeof target === 'string' ? target : target?.edit?.filePath;
                const resolvedHunkId = hunkId || target?.hunk?.id;
                if (!filePath) return;
                await this.openPendingChange(filePath, resolvedHunkId);
            })
        );
    }

    refresh() {
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(element: PendingChangeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: PendingChangeItem): vscode.ProviderResult<PendingChangeItem[]> {
        const diffService = DiffService.getInstance();
        if (!element) {
            return diffService.getPendingEdits().map(edit => new PendingChangeItem('file', edit));
        }

        if (element.kind !== 'file' || element.edit.status === 'conflicted') {
            return [];
        }

        return diffService.getHunks(element.edit.filePath).map(hunk => new PendingChangeItem('hunk', element.edit, hunk));
    }

    private async openPendingChange(filePath: string, hunkId?: string) {
        const diffService = DiffService.getInstance();
        const pending = diffService.refreshPendingEdit(filePath);
        if (!pending) return;

        if (pending.status === 'conflicted') {
            vscode.window.showWarningMessage(pending.conflictReason || `Cannot open ${path.basename(filePath)} because it changed during review.`);
            return;
        }

        const editor = await this.openReviewDocument(pending);
        if (hunkId) {
            const hunk = diffService.getHunks(filePath).find(item => item.id === hunkId);
            if (hunk) {
                const targetLine = Math.min(Math.max(hunk.newStart, 0), Math.max(editor.document.lineCount - 1, 0));
                const position = new vscode.Position(targetLine, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
        }

        diffService.markReviewing(filePath);
        ReviewService.getInstance(this.context).refresh();
        this.refresh();
    }

    private async openReviewDocument(pending: PendingEdit): Promise<vscode.TextEditor> {
        if (!fs.existsSync(pending.filePath)) {
            const uri = vscode.Uri.from({ scheme: 'untitled', path: pending.filePath });
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            if (doc.getText() !== pending.newContent) {
                await this.replaceEditorContent(editor, pending.newContent);
            }
            return editor;
        }

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pending.filePath));
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        if (doc.getText() !== pending.newContent) {
            await this.replaceEditorContent(editor, pending.newContent);
        }
        return editor;
    }

    private async replaceEditorContent(editor: vscode.TextEditor, content: string) {
        const doc = editor.document;
        const end = doc.lineCount > 0 ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(0, 0);
        await editor.edit(editBuilder => {
            editBuilder.replace(new vscode.Range(new vscode.Position(0, 0), end), content);
        });
    }
}
