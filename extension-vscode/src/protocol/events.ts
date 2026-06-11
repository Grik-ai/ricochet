export const PERMISSION_CHOICES = ['Yes', 'Always Allow', 'No'] as const;

export type InteractionRequestKind = 'permission' | 'choice';

export interface InteractionRequestPayload {
    id: string;
    sessionId?: string;
    question: string;
    choices: string[];
    choiceMetadata?: Array<{
        value: string;
        label?: string;
        description?: string;
        recommended?: boolean;
        danger?: boolean;
    }>;
    kind: InteractionRequestKind;
}

export interface WebviewMessage<TPayload = unknown> {
    type: string;
    payload?: TPayload;
}
