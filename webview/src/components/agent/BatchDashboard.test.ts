import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BatchDashboard, updateWorkerInRuns, upsertRun, upsertWorker } from './BatchDashboard';
import type { BatchRunPayload } from '../../types/protocol';

function makeRun(id: string, status = 'draft'): BatchRunPayload {
    return {
        id,
        session_id: 'session-1',
        goal: `Run ${id}`,
        status,
        max_workers: 3,
        workers: [],
    };
}

describe('BatchDashboard helpers', () => {
    it('prepends a new run so the latest batch is easy to review', () => {
        const runs = [makeRun('run-a')];

        expect(upsertRun(runs, makeRun('run-b')).map(run => run.id)).toEqual(['run-b', 'run-a']);
    });

    it('replaces an existing run without changing list order', () => {
        const runs = [makeRun('run-a'), makeRun('run-b')];
        const next = upsertRun(runs, makeRun('run-b', 'ready'));

        expect(next.map(run => run.id)).toEqual(['run-a', 'run-b']);
        expect(next[1].status).toBe('ready');
    });

    it('updates a worker in its owning run from live batch events', () => {
        const run = makeRun('run-a');
        run.workers = [{ id: 'run-a-w1', run_id: 'run-a', title: 'Worker', status: 'queued' }];

        const next = upsertWorker([run], {
            id: 'run-a-w1',
            run_id: 'run-a',
            title: 'Worker',
            status: 'completed',
            summary: 'done',
        });

        expect(next[0].workers?.[0]).toMatchObject({ status: 'completed', summary: 'done' });
    });

    it('adds worker artifacts from batch worker artifact events', () => {
        const run = makeRun('run-a');
        run.workers = [{ id: 'run-a-w1', run_id: 'run-a', title: 'Worker', status: 'completed' }];

        const next = updateWorkerInRuns([run], 'run-a-w1', worker => ({
            ...worker,
            artifacts: [{ type: 'summary', path: 'artifacts/worker-summary.md', size: 128 }],
        }));

        expect(next[0].workers?.[0].artifacts?.[0]).toMatchObject({
            type: 'summary',
            path: 'artifacts/worker-summary.md',
        });
    });

    it('explains Batch as advanced worktree workers without visible divider classes', () => {
        const html = renderToStaticMarkup(createElement(BatchDashboard, {
            sessionId: 'session-1',
            defaultGoal: 'Audit project',
        }));

        expect(html).toContain('Advanced parallel worktree workers');
        expect(html).toContain('Ordinary chat runs do not need anything here');
        expect(html).not.toMatch(/\bborder(?:-| )/);
        expect(html).not.toContain('divide-');
    });
});
