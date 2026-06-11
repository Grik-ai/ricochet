import type { ActivityItem, ChatMessage, TaskProgress, ToolCall } from '@hooks/useChat';

export function cleanAssistantVisibleText(text: string) {
    return text
        .replace(/<(?:thinking|think)>[\s\S]*?(?:<\/(?:thinking|think)>|$)/gi, '')
        .replace(/<(?:thinking|think)\b[\s\S]*$/gi, '')
        .replace(/^\s*(?:thinking|think)>?[\s\S]*$/gi, '')
        .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, '')
        .replace(/<\/(?:thinking|think)>/gi, '')
        .split('\n')
        .filter(line => !/^\s*⚠️\s*System:\s*You are repeating yourself/i.test(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function isMeaningfulTaskProgress(progress?: TaskProgress | null): boolean {
    if (!progress) return false;
    const status = (progress.status || '').trim();
    const summary = (progress.summary || '').trim();
    const generic = /^(working|thinking|processing request|idle)$/i;
    if (progress.files?.length) return true;
    if (progress.steps?.some(step => step.trim() && !generic.test(step.trim()))) return true;
    if (status && !generic.test(status)) return true;
    if (summary && !generic.test(summary)) return true;
    return false;
}

function parseToolArguments(tool: ToolCall): Record<string, unknown> {
    try {
        return typeof tool.arguments === 'string'
            ? JSON.parse(tool.arguments)
            : (tool.arguments || {});
    } catch {
        return {};
    }
}

export function isRenderableActivity(activity?: ActivityItem | null): boolean {
    if (!activity) return false;
    return Boolean(activity.file || activity.query || activity.results || activity.type === 'edit');
}

export function isRenderableToolCall(tool?: ToolCall | null): boolean {
    if (!tool?.name) return false;
    if (tool.name === 'task_boundary') return false;
    const args = parseToolArguments(tool);
    if (tool.name === 'command_status') {
        const id = String(args.id || '');
        return id.startsWith('agent-');
    }
    return true;
}

export function hasRenderableActivity(message?: Partial<ChatMessage> | null): boolean {
    if (!message) return false;
    return Boolean(
        message.activities?.some(isRenderableActivity) ||
        message.toolCalls?.some(isRenderableToolCall)
    );
}

export function hasRenderableArtifacts(message?: Partial<ChatMessage> | null): boolean {
    const artifacts = (message as any)?.artifacts;
    if (!Array.isArray(artifacts)) return false;
    return artifacts.some((artifact: any) => {
        const type = String(artifact?.type || '').toLowerCase();
        const path = String(artifact?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        return ['implementation_plan', 'walkthrough', 'report', 'task'].includes(type)
            || /(^|\/)\.ricochet\/artifacts\//.test(path);
    });
}

export function isRenderableChatMessage(message?: Partial<ChatMessage> | null): boolean {
    if (!message) return false;
    if (message.role === 'user' || message.role === 'system') {
        return Boolean((message.content || '').trim());
    }
    if (message.role !== 'assistant') return false;
    return Boolean(
        cleanAssistantVisibleText(message.content || '') ||
        Boolean(message.errorInfo) ||
        hasRenderableActivity(message) ||
        hasRenderableArtifacts(message) ||
        message.checkpointHash
    );
}
