import { describe, expect, it } from 'vitest';
import { upsertRun, upsertWorker } from './BatchDashboard';
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
});
