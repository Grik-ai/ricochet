import type { UsageSnapshot } from './protocol';

export interface SessionMetadata {
    id: string;
    title: string;
    lastModified: number;
    messageCount: number;
    workspaceDir: string;
    usage?: UsageSnapshot;
}

export interface SessionData {
    messages: any[]; // ChatMessage[]
    todos: any[];    // Todo[]
    usage?: UsageSnapshot;
}
