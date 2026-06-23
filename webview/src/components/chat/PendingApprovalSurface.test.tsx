import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { approvalChoiceViewModels, PermissionRequestPanel } from './PermissionRequestPanel';
import { PendingApprovalSurface } from './PendingApprovalSurface';

describe('PendingApprovalSurface', () => {
    it('renders ask_user_choice requests in the sticky approval region', () => {
        const html = renderToStaticMarkup(
            <PendingApprovalSurface
                requests={[{
                    id: 'choice-1',
                    kind: 'choice',
                    question: 'The agent wants to execute the following tools',
                    choices: ['Yes', "Yes, and don't ask again for this tool", 'No'],
                }]}
                onResponse={() => undefined}
            />
        );

        expect(html).toContain('data-ricochet-pending-approval');
        expect(html).toContain('Approval required');
        expect(html).toContain('Approve');
        expect(html).toContain('Always allow');
        expect(html).toContain('Deny');
    });

    it('keeps the original choice value for permission responses', () => {
        const choices = approvalChoiceViewModels({
            id: 'choice-2',
            kind: 'choice',
            question: 'Choose next step',
            choices: ['Proceed', 'Revise plan'],
            choiceMetadata: [{ value: 'Proceed', label: 'Implement plan', recommended: true }],
        });

        expect(choices[0]).toMatchObject({
            value: 'Proceed',
            label: 'Implement plan',
            primary: true,
        });
    });

    it('sends the original choice value from action buttons', () => {
        const onResponse = vi.fn();
        const tree = PermissionRequestPanel({
            request: {
                id: 'choice-3',
                kind: 'choice',
                question: 'Choose next step',
                choices: ['Proceed', 'Revise plan'],
                choiceMetadata: [{ value: 'Proceed', label: 'Implement plan', recommended: true }],
            },
            onResponse,
            inline: true,
        }) as React.ReactElement;

        const buttons = findButtons(tree);
        buttons[0].props.onClick();

        expect(onResponse).toHaveBeenCalledWith('choice-3', 'Proceed');
    });
});

function findButtons(node: React.ReactNode): React.ReactElement[] {
    if (!React.isValidElement(node)) return [];
    const current = node.type === 'button' ? [node] : [];
    const children = React.Children.toArray(node.props?.children);
    return [...current, ...children.flatMap(findButtons)];
}
