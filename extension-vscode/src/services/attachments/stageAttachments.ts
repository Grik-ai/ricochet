import * as fs from 'fs';
import * as path from 'path';
import * as nodeCrypto from 'crypto';

export interface StageAttachmentsResult {
    request_id: string;
    attachments: any[];
    errors: any[];
}

const maxFiles = 8;
const maxBytes = 5 * 1024 * 1024;

export async function stageAttachmentsForWorkspace(payload: any, workspaceRoot?: string): Promise<StageAttachmentsResult> {
    const requestId = String(payload?.request_id || `attach-${Date.now()}`);
    const files = Array.isArray(payload?.files) ? payload.files : [];
    const attachments: any[] = [];
    const errors: any[] = [];

    if (!workspaceRoot) {
        return {
            request_id: requestId,
            attachments,
            errors: files.map((file: any) => ({ id: file?.id, error: 'No workspace is open.' })),
        };
    }

    const safeSession = safeAttachmentSegment(payload?.session_id || 'default');
    const attachmentDir = path.join(workspaceRoot, '.ricochet', 'attachments', safeSession);
    await fs.promises.mkdir(attachmentDir, { recursive: true });

    for (const [index, file] of files.slice(0, maxFiles).entries()) {
        const id = String(file?.id || `${requestId}-${index}`);
        try {
            const name = safeAttachmentName(file?.name || `attachment-${index + 1}`);
            const data = typeof file?.data === 'string' ? file.data : '';
            const buffer = Buffer.from(data, 'base64');
            if (buffer.length > maxBytes) {
                errors.push({ id, error: 'File is larger than 5 MB.' });
                continue;
            }
            const uniqueName = `${Date.now()}-${nodeCrypto.randomBytes(4).toString('hex')}-${name}`;
            const targetPath = path.join(attachmentDir, uniqueName);
            const relativePath = path.relative(workspaceRoot, targetPath);
            if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                errors.push({ id, error: 'Attachment path escaped the workspace.' });
                continue;
            }
            await fs.promises.writeFile(targetPath, buffer, { flag: 'wx' });
            const normalizedRelativePath = relativePath.split(path.sep).join('/');
            attachments.push({
                id,
                path: normalizedRelativePath,
                stagedPath: normalizedRelativePath,
                name,
                kind: 'attachment',
                source: 'attachment',
                mime: typeof file?.mime === 'string' ? file.mime : undefined,
                size: buffer.length,
            });
        } catch (error) {
            errors.push({ id, error: error instanceof Error ? error.message : String(error) });
        }
    }

    if (files.length > maxFiles) {
        files.slice(maxFiles).forEach((file: any, index: number) => {
            errors.push({ id: file?.id || `${requestId}-overflow-${index}`, error: 'Attach up to 8 files per turn.' });
        });
    }

    return { request_id: requestId, attachments, errors };
}

export function safeAttachmentSegment(value: string): string {
    return String(value || 'default')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 80) || 'default';
}

export function safeAttachmentName(value: string): string {
    const base = path.basename(String(value || 'attachment'));
    return base
        .replace(/[^a-zA-Z0-9._ -]+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 120) || 'attachment';
}
