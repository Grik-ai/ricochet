import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    PendingPlanDecisionSurface,
    buildPlanDecisionMessage,
    collectPendingPlanDecisionArtifacts,
    isPendingPlanDecisionArtifact,
    type PendingPlanArtifact,
} from './PendingPlanDecisionSurface';

const pendingPlan: PendingPlanArtifact = {
    id: 'plan-1',
    type: 'implementation_plan',
    title: 'Polybot Detailed Task Plan 2026',
    summary: 'Detailed task breakdown for Polybot implementation.',
    path: '.ricochet/artifacts/session/implementation_plan.md',
    session_id: 'session-1',
};

describe('PendingPlanDecisionSurface', () => {
    it('renders pending implementation plans as a bottom decision surface', () => {
        const html = renderToStaticMarkup(<PendingPlanDecisionSurface artifacts={[pendingPlan]} />);

        expect(html).toContain('data-ricochet-pending-plan');
        expect(html).toContain('Plan decision required');
        expect(html).toContain('Polybot Detailed Task Plan 2026');
        expect(html).toContain('Review');
        expect(html).toContain('Proceed');
        expect(html).toContain('Revise');
    });

    it('builds plan_decision messages without mutating review actions', () => {
        expect(buildPlanDecisionMessage(pendingPlan, 'implement')).toEqual({
            type: 'plan_decision',
            payload: {
                session_id: 'session-1',
                artifact_id: 'plan-1',
                path: '.ricochet/artifacts/session/implementation_plan.md',
                decision: 'implement',
            },
        });
    });

    it('collects only unresolved implementation plan artifacts', () => {
        const approvedPlan = { ...pendingPlan, id: 'plan-2', status: 'approved' };
        const errorPlan = { ...pendingPlan, id: 'plan-3', status: 'error' };
        const artifacts = collectPendingPlanDecisionArtifacts([
            { artifacts: [pendingPlan, approvedPlan, { type: 'report', title: 'Report' }] },
            { artifacts: [errorPlan] },
        ]);

        expect(isPendingPlanDecisionArtifact(pendingPlan)).toBe(true);
        expect(isPendingPlanDecisionArtifact(approvedPlan)).toBe(false);
        expect(artifacts.map(artifact => artifact.id)).toEqual(['plan-1', 'plan-3']);
    });
});
