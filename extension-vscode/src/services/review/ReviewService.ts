import * as vscode from 'vscode';
import { DiffService } from '../diff/DiffService';
import * as path from 'path';

export class ReviewService implements vscode.CodeLensProvider {
    private static instance: ReviewService;
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    private decorationTypeAdd: vscode.TextEditorDecorationType;
    private decorationTypeRemove: vscode.TextEditorDecorationType;

    public static getInstance(context?: vscode.ExtensionContext): ReviewService {
        if (!ReviewService.instance) {
            ReviewService.instance = new ReviewService(context!);
        }
        return ReviewService.instance;
    }

    private constructor(context: vscode.ExtensionContext) {
        this.decorationTypeAdd = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: 'rgba(74, 222, 128, 0.12)',
            color: 'rgba(74, 222, 128, 0.98)',
            overviewRulerColor: 'rgba(74, 222, 128, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            gutterIconPath: context.asAbsolutePath(path.join('assets', 'add.svg')),
            gutterIconSize: 'contain'
        });

        this.decorationTypeRemove = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: 'rgba(248, 113, 113, 0.12)',
            color: 'rgba(248, 113, 113, 0.95)',
            textDecoration: 'line-through',
            overviewRulerColor: 'rgba(248, 113, 113, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            gutterIconPath: context.asAbsolutePath(path.join('assets', 'remove.svg')),
            gutterIconSize: 'contain'
        });

        // Register commands
        context.subscriptions.push(
            vscode.commands.registerCommand('ricochet.acceptEdit', async (target: string | any) => {
                const filePath = this.filePathFromCommandTarget(target);
                if (!filePath) return;
                await DiffService.getInstance().applyPendingEdit(filePath);
                this.refresh();
            }),
            vscode.commands.registerCommand('ricochet.rejectEdit', async (target: string | any) => {
                const filePath = this.filePathFromCommandTarget(target);
                if (!filePath) return;
                const pending = DiffService.getInstance().getPendingEdit(filePath);
                if (pending) {
                    // Find editor and revert content
                    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === filePath);
                    if (editor) {
                        const end = editor.document.lineCount > 0
                            ? editor.document.lineAt(editor.document.lineCount - 1).range.end
                            : new vscode.Position(0, 0);
                        await editor.edit(editBuilder => {
                            const fullRange = new vscode.Range(
                                new vscode.Position(0, 0),
                                end
                            );
                            editBuilder.replace(fullRange, pending.originalContent);
                        });
                    }
                }
                await DiffService.getInstance().rejectPendingEdit(filePath);
                this.refresh();
                vscode.window.showInformationMessage(`Changes to ${path.basename(filePath)} discarded`);
            }),
            vscode.commands.registerCommand('ricochet.acceptHunk', async (target: string | any, hunkId?: string) => {
                const filePath = this.filePathFromCommandTarget(target);
                const resolvedHunkId = hunkId || target?.hunk?.id;
                if (!filePath || !resolvedHunkId) return;
                await DiffService.getInstance().acceptHunk(filePath, resolvedHunkId);
                this.refresh();
            }),
            vscode.commands.registerCommand('ricochet.rejectHunk', async (target: string | any, hunkId?: string) => {
                const filePath = this.filePathFromCommandTarget(target);
                const resolvedHunkId = hunkId || target?.hunk?.id;
                if (!filePath || !resolvedHunkId) return;
                await DiffService.getInstance().rejectHunk(filePath, resolvedHunkId);
                this.refresh();
            })
        );

        // Listen for editor changes to apply decorations
        vscode.window.onDidChangeActiveTextEditor(() => this.applyDecorations(), null, context.subscriptions);
        vscode.workspace.onDidOpenTextDocument(() => this.applyDecorations(), null, context.subscriptions);
        vscode.workspace.onDidChangeTextDocument(() => this.refresh(), null, context.subscriptions);

        // Register CodeLens Provider
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], this)
        );

        // Initial apply
        this.applyDecorations();
    }

    public refresh() {
        this._onDidChangeCodeLenses.fire();
        this.applyDecorations();
    }

    private filePathFromCommandTarget(target: string | any): string | undefined {
        if (typeof target === 'string') return target;
        if (typeof target?.edit?.filePath === 'string') return target.edit.filePath;
        if (typeof target?.filePath === 'string') return target.filePath;
        return undefined;
    }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];
        const filePath = document.uri.fsPath;
        const pending = DiffService.getInstance().refreshPendingEdit(filePath);

        if (pending) {
            const hunks = DiffService.getInstance().getHunks(filePath);
            const firstHunk = hunks[0];
            const line = Math.min(firstHunk?.newStart ?? 0, Math.max(document.lineCount - 1, 0));
            const range = new vscode.Range(line, 0, line, 0);
            const isConflicted = pending.status === 'conflicted';

            lenses.push(
                new vscode.CodeLens(range, {
                    title: isConflicted ? "$(warning) Resolve conflict before Proceed" : "$(check) Proceed",
                    command: "ricochet.acceptEdit",
                    arguments: [filePath]
                }),
                new vscode.CodeLens(range, {
                    title: "$(x) Cancel",
                    command: "ricochet.rejectEdit",
                    arguments: [filePath]
                })
            );

            if (!isConflicted && hunks.length > 1) {
                for (const hunk of hunks) {
                    const hunkLine = Math.min(hunk.newStart, Math.max(document.lineCount - 1, 0));
                    const hunkRange = new vscode.Range(hunkLine, 0, hunkLine, 0);
                    lenses.push(
                        new vscode.CodeLens(hunkRange, {
                            title: "$(check) Proceed hunk",
                            command: "ricochet.acceptHunk",
                            arguments: [filePath, hunk.id]
                        }),
                        new vscode.CodeLens(hunkRange, {
                            title: "$(x) Cancel hunk",
                            command: "ricochet.rejectHunk",
                            arguments: [filePath, hunk.id]
                        })
                    );
                }
            }
        }

        return lenses;
    }

    private computeLineDiff(oldContent: string, newContent: string): { added: number[], removed: { anchor: number; content: string }[], firstChangedLine?: number } {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const added: number[] = [];
        const removed: { anchor: number; content: string }[] = [];

        if (oldContent === newContent) {
            return { added, removed };
        }

        if (oldLines.length * newLines.length > 250000) {
            const maxLines = Math.max(oldLines.length, newLines.length);
            for (let idx = 0; idx < maxLines; idx++) {
                if (oldLines[idx] !== newLines[idx]) {
                    if (idx < newLines.length) added.push(idx);
                    if (idx < oldLines.length) removed.push({ anchor: Math.min(idx, newLines.length - 1), content: oldLines[idx] });
                }
            }
        } else {
            const dp = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
            for (let i = 1; i <= oldLines.length; i++) {
                for (let j = 1; j <= newLines.length; j++) {
                    dp[i][j] = oldLines[i - 1] === newLines[j - 1]
                        ? dp[i - 1][j - 1] + 1
                        : Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }

            let i = oldLines.length;
            let j = newLines.length;
            while (i > 0 || j > 0) {
                if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
                    i--;
                    j--;
                } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                    added.push(j - 1);
                    j--;
                } else if (i > 0) {
                    removed.push({ anchor: Math.min(j, newLines.length - 1), content: oldLines[i - 1] });
                    i--;
                }
            }
        }

        added.reverse();
        removed.reverse();

        const changedLines = [
            ...added,
            ...removed.map(item => Math.max(item.anchor, 0))
        ];

        return {
            added,
            removed,
            firstChangedLine: changedLines.length ? Math.min(...changedLines) : undefined
        };
    }

    private applyDecorations() {
        const editors = vscode.window.visibleTextEditors;
        for (const editor of editors) {
            const filePath = editor.document.uri.fsPath;
            const pending = DiffService.getInstance().refreshPendingEdit(filePath);

            if (!pending) {
                editor.setDecorations(this.decorationTypeAdd, []);
                editor.setDecorations(this.decorationTypeRemove, []);
                continue;
            }

            if (pending.status === 'conflicted') {
                editor.setDecorations(this.decorationTypeAdd, []);
                editor.setDecorations(this.decorationTypeRemove, []);
                continue;
            }

            const currentText = editor.document.getText();
            const hunks = DiffService.getInstance().getHunks(filePath);

            const addDecorations: vscode.DecorationOptions[] = [];
            const remDecorations: vscode.DecorationOptions[] = [];

            // If the editor shows the NEW content (likely after our edit), show additions
            if (currentText.trim() === pending.newContent.trim()) {
                for (const hunk of hunks) {
                    for (let offset = 0; offset < hunk.newLength; offset++) {
                        const line = editor.document.lineAt(Math.min(hunk.newStart + offset, editor.document.lineCount - 1));
                        addDecorations.push({ range: line.range });
                    }
                    hunk.oldLines.forEach((content, offset) => {
                        const anchor = Math.max(0, Math.min(hunk.newStart + offset, editor.document.lineCount - 1));
                        const line = editor.document.lineAt(anchor);
                        remDecorations.push({
                            range: line.range,
                            renderOptions: {
                                after: {
                                    contentText: `   - ${content}`,
                                    color: 'rgba(248, 113, 113, 0.7)',
                                    fontStyle: 'italic',
                                    textDecoration: 'line-through'
                                }
                            }
                        });
                    });
                }
            } else if (currentText.trim() === pending.originalContent.trim()) {
                // If it shows the OLD content, we can only show what WOULD BE removed
                for (const hunk of hunks) {
                    for (let offset = 0; offset < hunk.oldLength; offset++) {
                        const line = editor.document.lineAt(Math.max(0, Math.min(hunk.oldStart + offset, editor.document.lineCount - 1)));
                        remDecorations.push({ range: line.range });
                    }
                }
            }

            editor.setDecorations(this.decorationTypeAdd, addDecorations);
            editor.setDecorations(this.decorationTypeRemove, remDecorations);
        }
    }
}
