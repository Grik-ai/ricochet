type DevMessage = {
    type: string;
    payload?: any;
};

type DevAccountState = 'free' | 'pro' | 'sync' | 'expired' | 'quota';
type DevBatchRun = {
    id: string;
    session_id?: string;
    goal: string;
    status: string;
    max_workers: number;
    base_branch?: string;
    base_commit?: string;
    base_checkpoint_hash?: string;
    workers: DevBatchWorker[];
    merge_plan?: {
        status?: string;
        apply_order?: string[];
        conflicts?: string[];
        warnings?: string[];
        selected?: string[];
    };
    created_at?: number;
    updated_at?: number;
};
type DevBatchWorker = {
    id: string;
    run_id: string;
    title: string;
    status: string;
    worktree_id?: string;
    branch?: string;
    path?: string;
    scope_paths?: string[];
    attempt?: number;
    summary?: string;
    artifact_dir?: string;
    verification_commands?: string[];
    verification_status?: string;
    output_preview?: string;
    permissions?: string[];
    diff_stat?: string;
    tests?: Array<{ command?: string; status?: string; log_path?: string; exit_code?: number }>;
    artifacts?: Array<{ type: string; path: string; size?: number }>;
    error?: string;
    started_at?: number;
    completed_at?: number;
};

type DevVSCodeApi = {
    postMessage: (message: DevMessage) => void;
    getState: () => any;
    setState: <T>(state: T) => T;
};

declare global {
    interface Window {
        RICOCHET_WEBVIEW_DEV_SERVER?: boolean;
        RICOCHET_WEBVIEW_DEV_SERVER_URL?: string;
    }
}

const SESSION_ID = 'dev-chat-lab';
const MODEL_PROVIDERS = [
    {
        id: 'grik',
        name: 'Ricochet Cloud',
        hasKey: false,
        hasUserKey: false,
        keySource: 'hosted',
        accessMode: 'subscription',
        available: true,
        models: [
            {
                id: 'openai/gpt-5.5',
                name: 'GPT-5.5 (Subscription)',
                contextWindow: 1_000_000,
                inputPrice: 5,
                outputPrice: 30,
                isFree: false,
                supportsTools: true,
                recommended: true,
                accessMode: 'subscription',
                keySource: 'hosted',
                requiresSubscription: true,
                apiType: 'responses',
            },
        ],
    },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        hasKey: false,
        hasUserKey: false,
        keySource: 'none',
        accessMode: 'free',
        available: true,
        models: [
            {
                id: 'qwen/qwen3-coder:free',
                name: 'Qwen 3 Coder (Free)',
                contextWindow: 262_000,
                inputPrice: 0,
                outputPrice: 0,
                isFree: true,
                supportsTools: true,
                recommended: true,
                accessMode: 'free',
            },
        ],
    },
    {
        id: 'openai',
        name: 'OpenAI',
        hasKey: false,
        hasUserKey: false,
        keySource: 'none',
        accessMode: 'byok',
        available: false,
        models: [
            {
                id: 'gpt-5.5',
                name: 'GPT-5.5',
                contextWindow: 1_000_000,
                inputPrice: 5,
                outputPrice: 30,
                isFree: false,
                supportsTools: true,
                recommended: true,
                accessMode: 'byok',
            },
        ],
    },
];

let storedState: unknown = {};
let activeTimers: number[] = [];
let terminalLabState = { fixture: 'all', mode: 'snapshot', width: 100 };
let devBatchRuns: DevBatchRun[] = [];

export function installRicochetDevHarness() {
    if (!import.meta.env.DEV) return;

    if (!window.acquireVsCodeApi) {
        document.documentElement.classList.add('ricochet-browser-dev');
        window.acquireVsCodeApi = (() => createFakeVSCodeApi()) as any;
    }

    window.setTimeout(() => {
        postToWebview(accountState('pro'));
        postToWebview(billingState('pro'));
        mountDevPanel();
    }, 0);
}

function createFakeVSCodeApi(): DevVSCodeApi {
    return {
        postMessage: (message: DevMessage) => {
            handleWebviewRequest(message);
        },
        getState: () => storedState,
        setState: <T,>(state: T) => {
            storedState = state;
            return state;
        },
    };
}

function handleWebviewRequest(message: DevMessage) {
    const type = message?.type;
    const payload = message?.payload || {};

    switch (type) {
        case 'list_sessions':
            postToWebview({
                type: 'session_list',
                payload: {
                    sessions: [
                        {
                            id: SESSION_ID,
                            title: 'Dev Lab: Polybot timeline',
                            lastModified: Date.now(),
                            messageCount: polybotMessages().length,
                            workspaceDir: '/Users/dev/Polybot',
                            usage: devUsageSnapshot(SESSION_ID),
                        },
                        {
                            id: 'dev-empty',
                            title: 'Dev Lab: empty live run',
                            lastModified: Date.now() - 60_000,
                            messageCount: 0,
                            workspaceDir: '/Users/dev/Polybot',
                        },
                    ],
                },
            });
            break;
        case 'load_session':
            loadFixture(payload.id || SESSION_ID);
            break;
        case 'create_session':
            postToWebview({ type: 'session_created', payload: { id: SESSION_ID } });
            loadFixture(SESSION_ID);
            break;
        case 'get_state':
            postToWebview({ type: 'state', payload: { session_id: payload.sessionId || SESSION_ID, messages: polybotMessages(), todos: demoTodos() } });
            break;
        case 'get_workspace_state':
            postToWebview({ type: 'workspace_state', payload: { name: 'Ricochet Dev Lab' } });
            break;
        case 'get_settings':
            postToWebview({
                type: 'settings_loaded',
                payload: {
                    provider: 'grik',
                    model: 'openai/gpt-5.5',
                    apiKeys: {},
                    mode_models: { enabled: false, plan: {}, act: {} },
                    auto_approval: {},
                    terminal: { output_line_limit: 500 },
                    context: { auto_condense: true, condense_threshold: 70 },
                },
            });
            break;
        case 'get_models':
            postToWebview({ type: 'models', payload: { providers: MODEL_PROVIDERS } });
            break;
        case 'get_mcp_servers':
            postToWebview({ type: 'mcp_servers', payload: { servers: [] } });
            break;
        case 'get_context_status':
            postToWebview(contextStatus());
            break;
        case 'get_usage':
            postToWebview({
                type: 'usage_update',
                payload: devUsageSnapshot(payload.session_id || SESSION_ID),
            });
            break;
        case 'get_live_mode_status':
            postToWebview(devLiveModeStatus(payload.session_id || SESSION_ID, false));
            break;
        case 'toggle_live_mode':
            postToWebview(devLiveModeStatus(payload.session_id || SESSION_ID, true));
            break;
        case 'auth_refresh':
            postToWebview(accountState('pro'));
            postToWebview(billingState('pro'));
            break;
        case 'auth_login':
            postToWebview({
                type: 'device_auth_started',
                payload: {
                    userCode: 'GRIK-DEV',
                    verificationUrl: 'https://grik.io/device',
                    expiresAt: Date.now() + 900_000,
                    interval: 2,
                },
            });
            schedule(900, () => {
                postToWebview({ type: 'device_auth_complete', payload: { ok: true } });
                postToWebview(accountState('pro'));
                postToWebview(billingState('pro'));
            });
            break;
        case 'auth_logout':
            postToWebview(accountState('free'));
            postToWebview(billingState('free'));
            break;
        case 'clear_chat':
            clearTimers();
            postToWebview({ type: 'chat_cleared' });
            break;
        case 'send_message':
            playLiveRun(payload.run_id || `run-${Date.now()}`, payload.session_id || SESSION_ID, String(payload.content || 'Dev run'));
            break;
        case 'batch_run_list':
            postToWebview({ type: 'batch_runs', payload: { runs: devBatchRuns } });
            break;
        case 'batch_run_create':
            {
                const run = createDevBatchRunFromRequest(payload);
                devBatchRuns = upsertDevBatchRun(devBatchRuns, run);
                postToWebview({ type: 'batch_run_create_result', payload: run });
                postToWebview({ type: 'batch_run', payload: run });
            }
            break;
        case 'batch_run_start':
            updateDevBatchRun(payload.run_id, run => ({
                ...run,
                status: 'running',
                updated_at: Date.now(),
                workers: run.workers.map((worker, index) => ({
                    ...worker,
                    status: index === 0 ? 'running' : worker.status === 'queued' ? 'queued' : worker.status,
                    started_at: worker.started_at || Date.now(),
                })),
            }), 'batch_run_start_result');
            break;
        case 'batch_run_abort':
            updateDevBatchRun(payload.run_id, run => ({
                ...run,
                status: 'aborted',
                updated_at: Date.now(),
                workers: run.workers.map(worker => /running|queued/i.test(worker.status)
                    ? { ...worker, status: 'aborted', completed_at: Date.now(), error: 'Aborted from dev fixture.' }
                    : worker),
            }), 'batch_run_abort_result');
            break;
        case 'batch_run_cleanup':
            updateDevBatchRun(payload.run_id, run => ({ ...run, status: 'cleaned', updated_at: Date.now() }), 'batch_run_cleanup_result');
            break;
        case 'batch_worker_diff':
            postToWebview({ type: 'batch_worker_diff_result', payload: devBatchWorkerDiff(payload.worker_id) });
            postToWebview({ type: 'batch_worker_diff', payload: devBatchWorkerDiff(payload.worker_id) });
            break;
        case 'batch_worker_apply':
            updateDevBatchWorker(payload.worker_id, worker => ({
                ...worker,
                status: 'applied',
                completed_at: worker.completed_at || Date.now(),
                summary: worker.summary || 'Worker changes applied in dev fixture.',
            }), 'batch_worker_apply_result');
            break;
        case 'batch_worker_retry':
            updateDevBatchWorker(payload.worker_id, worker => ({
                ...worker,
                status: 'running',
                attempt: (worker.attempt || 1) + 1,
                error: undefined,
                output_preview: 'Retrying failed worker in dev fixture.',
                started_at: Date.now(),
                completed_at: undefined,
            }), 'batch_worker_retry_result');
            break;
        case 'batch_worker_artifacts':
            {
                const worker = findDevBatchWorker(payload.worker_id);
                postToWebview({
                    type: 'batch_worker_artifacts',
                    payload: {
                        worker_id: payload.worker_id,
                        artifacts: worker?.artifacts || [],
                    },
                });
            }
            break;
        case 'search_files':
            postToWebview({
                type: 'file_search_results',
                payload: [
                    { path: 'webview/src/components/chat/ChatView.tsx', name: 'ChatView.tsx' },
                    { path: 'webview/src/hooks/useChat.ts', name: 'useChat.ts' },
                ],
            });
            break;
        default:
            // Keep unknown requests visible during dev without breaking the UI.
            console.debug('[Ricochet Dev Harness] ignored request', message);
    }
}

function mountDevPanel() {
    if (document.getElementById('ricochet-dev-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'ricochet-dev-panel';
    panel.innerHTML = `
        <div class="rdp-header">
            <div class="rdp-title">Ricochet Dev Lab</div>
            <button class="rdp-toggle" data-action="toggle" title="Collapse dev panel">-</button>
        </div>
        <div class="rdp-body">
            <button data-action="polybot">Load Polybot fixture</button>
            <button data-action="live">Play live run</button>
            <button data-action="all">All timeline events</button>
            <button data-action="swarm">Swarm agents</button>
            <button data-action="swarm-dashboard">Swarm dashboard</button>
            <button data-action="batch-workers">Batch workers</button>
            <button data-action="ether">Ether messages</button>
            <button data-action="failed">Failed command + review</button>
            <button data-action="terminal">Terminal Lab</button>
            <button data-action="free">Free account</button>
            <button data-action="pro">Pro account</button>
            <button data-action="expired">Expired</button>
            <button data-action="quota">Quota exceeded</button>
            <button data-action="sync">Sync issue</button>
            <button data-action="clear">Clear</button>
        </div>
    `;
    panel.style.cssText = [
        'position:fixed',
        'right:12px',
        'top:12px',
        'z-index:2147483647',
        'display:flex',
        'flex-direction:column',
        'gap:7px',
        'width:176px',
        'padding:8px',
        'border:1px solid rgba(255,255,255,.16)',
        'border-radius:8px',
        'background:rgba(30,30,30,.94)',
        'box-shadow:0 16px 48px rgba(0,0,0,.35)',
        'backdrop-filter:blur(10px)',
        'font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,sans-serif',
        'color:#ddd',
    ].join(';');

    const style = document.createElement('style');
    style.textContent = `
        #ricochet-dev-panel .rdp-header { display:flex; align-items:center; gap:6px; }
        #ricochet-dev-panel .rdp-title { min-width:0; flex:1; font-size: 10px; font-weight: 700; color: #aaa; text-transform: uppercase; letter-spacing: .06em; }
        #ricochet-dev-panel .rdp-body { display:flex; flex-direction:column; gap:6px; }
        #ricochet-dev-panel.rdp-collapsed { width:auto; }
        #ricochet-dev-panel.rdp-collapsed .rdp-body { display:none; }
        #ricochet-dev-panel button { height: 25px; border: 1px solid rgba(255,255,255,.10); border-radius: 6px; background: rgba(255,255,255,.052); color: #ddd; cursor: pointer; text-align: left; padding: 0 8px; }
        #ricochet-dev-panel .rdp-toggle { width:24px; height:22px; padding:0; text-align:center; color:#aaa; }
        #ricochet-dev-panel button:hover { background: rgba(14,99,156,.38); border-color: rgba(120,180,255,.35); }
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);

    panel.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        const action = target?.getAttribute('data-action');
        if (!action) return;
        if (action === 'polybot') loadFixture(SESSION_ID);
        if (action === 'live') {
            postToWebview({ type: 'chat_cleared' });
            playLiveRun(`run-dev-${Date.now()}`, SESSION_ID, 'проверь проект');
        }
        if (action === 'all') {
            postToWebview({ type: 'chat_cleared' });
            playAllTimelineEvents(`run-all-${Date.now()}`, SESSION_ID);
        }
        if (action === 'failed') {
            postToWebview({ type: 'chat_cleared' });
            playFailedRun(`run-failed-${Date.now()}`, SESSION_ID);
        }
        if (action === 'swarm') {
            postToWebview({ type: 'chat_cleared' });
            playSwarmRun(`run-swarm-${Date.now()}`, SESSION_ID, false);
        }
        if (action === 'swarm-dashboard') {
            postToWebview({ type: 'chat_cleared' });
            playSwarmRun(`run-swarm-dashboard-${Date.now()}`, SESSION_ID, true);
        }
        if (action === 'batch-workers') {
            postToWebview({ type: 'chat_cleared' });
            playBatchWorkersFixture(`run-batch-${Date.now()}`, SESSION_ID);
        }
        if (action === 'ether') {
            postToWebview({ type: 'chat_cleared' });
            playEtherMessageFixture(`run-ether-${Date.now()}`, SESSION_ID);
        }
        if (action === 'terminal') {
            mountTerminalLabPanel();
            void loadTerminalLab();
        }
        if (action === 'free' || action === 'pro' || action === 'sync' || action === 'expired' || action === 'quota') {
            postToWebview(accountState(action as DevAccountState));
            postToWebview(billingState(action as DevAccountState));
        }
        if (action === 'clear') {
            clearTimers();
            postToWebview({ type: 'chat_cleared' });
        }
        if (action === 'toggle') {
            panel.classList.toggle('rdp-collapsed');
            const toggle = panel.querySelector('.rdp-toggle');
            if (toggle) toggle.textContent = panel.classList.contains('rdp-collapsed') ? '+' : '-';
        }
    });
}

function mountTerminalLabPanel() {
    let panel = document.getElementById('ricochet-terminal-lab');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'ricochet-terminal-lab';
        panel.innerHTML = `
            <div class="rtl-head">
                <div>
                    <div class="rtl-title">Terminal Lab</div>
                    <div class="rtl-subtitle">Real Go CLI snapshot</div>
                </div>
                <button data-terminal-action="close" title="Close">×</button>
            </div>
            <div class="rtl-controls">
                <button data-terminal-fixture="all">All</button>
                <button data-terminal-fixture="polybot">Polybot</button>
                <button data-terminal-fixture="failed">Failed</button>
                <button data-terminal-fixture="slash-menu">Slash menu</button>
                <button data-terminal-mode="snapshot">Snapshot</button>
                <button data-terminal-mode="jsonl">JSONL</button>
                <button data-terminal-width="80">80</button>
                <button data-terminal-width="100">100</button>
                <button data-terminal-width="120">120</button>
                <button data-terminal-action="refresh">Refresh</button>
            </div>
            <pre class="rtl-output">Loading terminal lab...</pre>
        `;
        panel.style.cssText = [
            'position:fixed',
            'left:16px',
            'bottom:16px',
            'z-index:2147483646',
            'width:min(980px,calc(100vw - 32px))',
            'height:min(680px,calc(100vh - 32px))',
            'display:flex',
            'flex-direction:column',
            'border:1px solid rgba(255,255,255,.12)',
            'border-radius:10px',
            'background:rgba(18,18,18,.97)',
            'box-shadow:0 22px 70px rgba(0,0,0,.48)',
            'color:#ddd',
            'font:12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,sans-serif',
            'overflow:hidden',
        ].join(';');
        const style = document.createElement('style');
        style.textContent = `
            #ricochet-terminal-lab .rtl-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.08); }
            #ricochet-terminal-lab .rtl-title { font-weight:700; color:#f2f2f2; }
            #ricochet-terminal-lab .rtl-subtitle { color:#888; font-size:11px; }
            #ricochet-terminal-lab .rtl-controls { display:flex; flex-wrap:wrap; gap:6px; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,.06); }
            #ricochet-terminal-lab button { height:24px; border:1px solid rgba(255,255,255,.10); border-radius:6px; background:rgba(255,255,255,.045); color:#ddd; cursor:pointer; padding:0 8px; }
            #ricochet-terminal-lab button:hover { background:rgba(14,99,156,.34); border-color:rgba(120,180,255,.35); }
            #ricochet-terminal-lab .rtl-output { flex:1; margin:0; padding:12px; overflow:auto; white-space:pre; background:#0f0f0f; color:#d7d7d7; font:12px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
        `;
        document.head.appendChild(style);
        document.body.appendChild(panel);
        panel.addEventListener('click', event => {
            const target = event.target as HTMLElement | null;
            if (!target) return;
            const fixture = target.getAttribute('data-terminal-fixture');
            const mode = target.getAttribute('data-terminal-mode');
            const width = target.getAttribute('data-terminal-width');
            const action = target.getAttribute('data-terminal-action');
            if (fixture) terminalLabState = { ...terminalLabState, fixture };
            if (mode) terminalLabState = { ...terminalLabState, mode };
            if (width) terminalLabState = { ...terminalLabState, width: Number(width) };
            if (action === 'close') {
                panel?.remove();
                return;
            }
            if (fixture || mode || width || action === 'refresh') {
                void loadTerminalLab();
            }
        });
    }
}

async function loadTerminalLab() {
    const panel = document.getElementById('ricochet-terminal-lab');
    const output = panel?.querySelector('.rtl-output') as HTMLPreElement | null;
    if (!output) return;
    const { fixture, mode, width } = terminalLabState;
    output.textContent = `Loading ${fixture} ${mode} at ${width} columns...`;
    try {
        const params = new URLSearchParams({
            fixture,
            mode,
            width: String(width),
            height: '120',
        });
        const response = await fetch(`/__ricochet_dev/terminal-lab?${params}`);
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.error || data?.stderr || `HTTP ${response.status}`);
        }
        output.textContent = data.output || data.stderr || '(no terminal output)';
    } catch (error) {
        output.textContent = `Terminal Lab failed\n\n${error instanceof Error ? error.message : String(error)}`;
    }
}

function loadFixture(id: string) {
    clearTimers();
    postToWebview({
        type: 'session_loaded',
        payload: {
            id: id === 'dev-empty' ? 'dev-empty' : SESSION_ID,
            messages: id === 'dev-empty' ? [] : polybotMessages(),
            todos: id === 'dev-empty' ? [] : demoTodos(),
        },
    });
    postToWebview(contextStatus());
}

function playLiveRun(runId: string, sessionId: string, prompt: string) {
    clearTimers();
    const now = Date.now();
    const events: Array<[number, DevMessage]> = [
        [0, chatUpdate(sessionId, runId, { id: `user-${runId}`, role: 'user', content: prompt, timestamp: now, run_id: runId, turn_id: runId })],
        [200, progress(sessionId, runId, 'Planning task', 'Preparing project analysis', true)],
        [500, tool(sessionId, runId, 'list_directory', 'running', 'tool_started', 'Polybot')],
        [850, tool(sessionId, runId, 'list_directory', 'completed', 'tool_finished', 'Polybot', ['Polybot/src'])],
        [1100, tool(sessionId, runId, 'read_file', 'completed', 'tool_finished', 'src/main.rs', ['Polybot/src/main.rs'])],
        [1350, command(sessionId, runId, 'cargo check', 'running')],
        [1900, command(sessionId, runId, 'cargo check', 'completed', 'Finished dev [unoptimized + debuginfo] target(s) in 1.24s', 0, 1240)],
        [2020, { type: 'usage_update', payload: devUsageSnapshot(sessionId, now + 2020) }],
        [2150, chatUpdate(sessionId, runId, {
            id: `assistant-draft-${runId}`,
            role: 'assistant',
            content: 'I found the project structure and verified the main Rust crate. The code compiles, and the next step is checking tests and feature gates.',
            timestamp: now + 2150,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            toolCalls: [{ id: 'tool-read-main', name: 'read_file', arguments: { path: 'src/main.rs' }, status: 'completed' }],
            metadata: { runPhase: 'intermediate' },
        })],
        [2600, command(sessionId, runId, 'cargo test', 'failed', 'error: failed to run custom build command for `xgboost-sys`', 101, 2100)],
        [3050, progress(sessionId, runId, 'Verification completed', 'Tests are blocked by local xgboost native dependency.', false, 'COMPLETED')],
        [3300, chatUpdate(sessionId, runId, {
            id: `assistant-final-${runId}`,
            role: 'assistant',
            content: 'Project analysis complete. `cargo check` passes, but `cargo test` is blocked by the local `xgboost-sys` native dependency. The Dockerfile already installs the required system package, so local dev needs the same dependency or a feature-gated test path.',
            timestamp: now + 3300,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            metadata: { runPhase: 'final' },
        })],
        [3500, { type: 'ask_completion_result', payload: { session_id: sessionId, run_id: runId } }],
        [3600, contextStatus(sessionId, runId)],
    ];
    events.forEach(([delay, event]) => schedule(delay, () => postToWebview(event)));
}

function playFailedRun(runId: string, sessionId: string) {
    clearTimers();
    const now = Date.now();
    const events: Array<[number, DevMessage]> = [
        [0, chatUpdate(sessionId, runId, { id: `user-${runId}`, role: 'user', content: 'исправь ошибки и покажи review state', timestamp: now, run_id: runId, turn_id: runId })],
        [250, progress(sessionId, runId, 'Running task', 'Applying a risky edit fixture', true)],
        [600, tool(sessionId, runId, 'replace_file_content', 'failed', 'tool_failed', 'src/error.rs', ['Polybot/src/error.rs'], 'File updated, but verification rejected the edit.')],
        [900, {
            type: 'pending_edits',
            payload: {
                session_id: sessionId,
                run_id: runId,
                edits: [
                    {
                        filePath: '/Users/dev/Polybot/src/error.rs',
                        relativePath: 'src/error.rs',
                        displayName: 'error.rs',
                        additions: 8,
                        deletions: 4,
                        status: 'failed',
                        state: 'failed',
                        error: 'VERIFICATION REJECTED',
                        proposalId: 'dev-edit-error-rs',
                        reviewable: false,
                    },
                ],
            },
        }],
        [1200, command(sessionId, runId, 'brew install xgboost', 'failed', 'Error: Cannot install in CI fixture mode', 1, 420)],
        [1600, chatUpdate(sessionId, runId, {
            id: `assistant-final-${runId}`,
            role: 'assistant',
            content: 'The edit was rejected by verification, and the install command failed. This fixture is useful for checking Review and Errors rendering.',
            timestamp: now + 1600,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            errorInfo: {
                kind: 'provider_server',
                title: 'Verification rejected',
                message: 'The simulated edit failed review checks.',
                retryable: true,
                timestamp: now + 1600,
            },
            metadata: { runPhase: 'final' },
        })],
        [1800, { type: 'ask_completion_result', payload: { session_id: sessionId, run_id: runId } }],
    ];
    events.forEach(([delay, event]) => schedule(delay, () => postToWebview(event)));
}

function playAllTimelineEvents(runId: string, sessionId: string) {
    clearTimers();
    createAllTimelineFixtureTimeline(runId, sessionId).forEach(([delay, event]) => {
        schedule(delay, () => postToWebview(event));
    });
}

function playSwarmRun(runId: string, sessionId: string, openDashboard: boolean) {
    clearTimers();
    createSwarmFixtureTimeline(runId, sessionId).forEach(([delay, event]) => {
        schedule(delay, () => postToWebview(event));
    });
    if (openDashboard) {
        schedule(1320, () => postToWebview({ type: 'open_agent', payload: { tab: 'events' } }));
    }
}

function playBatchWorkersFixture(runId: string, sessionId: string) {
    clearTimers();
    const run = createSeededDevBatchRun(sessionId);
    devBatchRuns = [run];
    const events: Array<[number, DevMessage]> = [
        [0, { type: 'session_created', payload: { id: sessionId, session_id: sessionId } }],
        [10, { type: 'api_req_started', payload: { session_id: sessionId, run_id: runId } }],
        [80, progress(sessionId, runId, 'Preparing batch worker fixture', 'Creating reviewed worktree workers for the Batch dashboard.', true)],
        [180, { type: 'batch_runs', payload: { runs: devBatchRuns } }],
        [260, { type: 'batch_run', payload: run }],
        [360, { type: 'batch_event', payload: batchEvent('run_updated', run, undefined, 'running') }],
        [460, workerProgress(sessionId, runId, 'agent-batch-core', 'Batch Core Worker', 'running', true, 'Executing isolated core changes.', 'worker_running', '#5E81AC', 2, 1)],
        [560, workerProgress(sessionId, runId, 'agent-batch-ui', 'Batch UI Worker', 'running', true, 'Reviewing dashboard rendering states.', 'worker_running', '#A3BE8C', 2, 1)],
        [640, { type: 'open_agent', payload: { tab: 'batch' } }],
        [900, { type: 'usage_update', payload: devUsageSnapshot(sessionId, Date.now(), 'worker') }],
    ];
    events.forEach(([delay, event]) => schedule(delay, () => postToWebview(event)));
}

function playEtherMessageFixture(runId: string, sessionId: string) {
    clearTimers();
    createEtherFixtureTimeline(runId, sessionId).forEach(([delay, event]) => {
        schedule(delay, () => postToWebview(event));
    });
}

function devLiveModeStatus(sessionId = SESSION_ID, enabled = false): DevMessage {
    return {
        type: 'live_mode_status',
        payload: {
            enabled,
            connectedVia: enabled ? 'telegram' : null,
            sessionId,
            stage: enabled ? 'idle' : undefined,
            lastMessage: enabled ? 'Waiting for sent message...' : undefined,
            lastActivity: enabled ? 'Telegram paired for dev fixture' : undefined,
            isDaemon: true,
            channels: {
                telegram: { configured: true, active: enabled, label: 'Telegram', owner: '@igor_dev' },
                discord: { configured: false, active: false, label: 'Discord' },
            },
            lastSource: enabled ? 'telegram' : null,
            allowRemoteSessionStart: true,
        },
    };
}

export function createEtherFixtureTimeline(runId = 'run-ether-fixture', sessionId = SESSION_ID, now = Date.now()): Array<[number, DevMessage]> {
    const telegramText = 'Проверь проект через Ether и кратко ответь.';
    const discordText = 'И покажи, что Discord message тоже попал в этот flow.';
    return [
        [0, { type: 'session_created', payload: { id: sessionId, session_id: sessionId } }],
        [10, { type: 'api_req_started', payload: { session_id: sessionId, run_id: runId } }],
        [20, {
            type: 'live_mode_status',
            payload: {
                enabled: true,
                connectedVia: 'telegram+discord',
                sessionId,
                stage: 'idle',
                lastMessage: 'Waiting for sent message...',
                lastActivity: 'Telegram and Discord paired for dev fixture',
                isDaemon: true,
                channels: {
                    telegram: { configured: true, active: true, label: 'Telegram', owner: '@igor_dev' },
                    discord: { configured: true, active: true, label: 'Discord', owner: '#ricochet-dev' },
                },
                lastSource: 'telegram',
                allowRemoteSessionStart: true,
            },
        }],
        [180, { type: 'ether_activity', payload: { stage: 'receiving', source: 'telegram', username: 'Igor', preview: telegramText } }],
        [260, chatUpdate(sessionId, runId, {
            id: `ether-user-${runId}`,
            role: 'user',
            content: telegramText,
            timestamp: now + 260,
            run_id: runId,
            turn_id: runId,
            via: 'telegram',
            remoteUsername: 'Igor',
        })],
        [380, { type: 'ether_activity', payload: { stage: 'processing', source: 'telegram', username: 'Igor', preview: 'Processing Telegram request...' } }],
        [520, { type: 'ether_activity', payload: { stage: 'receiving', source: 'discord', username: 'Mila', preview: discordText } }],
        [600, chatUpdate(sessionId, runId, {
            id: `ether-discord-user-${runId}`,
            role: 'user',
            content: discordText,
            timestamp: now + 600,
            run_id: runId,
            turn_id: runId,
            via: 'discord',
            remoteUsername: 'Mila',
        })],
        [760, { type: 'ether_activity', payload: { stage: 'processing', source: 'discord', username: 'Mila', preview: 'Merging Discord follow-up into the same Ether run.' } }],
        [860, progress(sessionId, runId, 'Ether messages received', 'Processing sent Telegram and Discord messages.', true)],
        [1080, tool(sessionId, runId, 'list_directory', 'completed', 'tool_finished', 'Polybot', ['Polybot/src'])],
        [1300, command(sessionId, runId, 'cargo check', 'completed', 'Finished dev target(s) in 1.24s', 0, 1240)],
        [1540, progress(sessionId, runId, 'Ether response ready', 'Sending response back to Telegram and Discord.', false, 'COMPLETED')],
        [1700, { type: 'ether_activity', payload: { stage: 'responding', source: 'discord', username: 'Mila', preview: 'Sending concise project status to Ether channels.' } }],
        [1840, chatUpdate(sessionId, runId, {
            id: `ether-assistant-final-${runId}`,
            role: 'assistant',
            content: 'Ether fixture complete. I received sent messages from Telegram and Discord, checked the project fixture, and sent back a concise status response.',
            timestamp: now + 1840,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            metadata: { runPhase: 'final' },
        })],
        [2000, { type: 'ask_completion_result', payload: { session_id: sessionId, run_id: runId } }],
        [2100, contextStatus(sessionId, runId)],
    ];
}

export function createAllTimelineFixtureTimeline(runId = 'run-all-timeline-fixture', sessionId = SESSION_ID, now = Date.now()): Array<[number, DevMessage]> {
    const approvalId = `approval-${runId}`;
    return [
        [0, chatUpdate(sessionId, runId, {
            id: `user-${runId}`,
            role: 'user',
            content: 'Run the full timeline fixture',
            timestamp: now,
            run_id: runId,
            turn_id: runId,
        })],
        [150, progress(sessionId, runId, 'Planning task', 'Preparing full timeline fixture', true)],
        [240, progress(sessionId, runId, 'Inspecting project tree', 'Scanning folders before file reads.', true)],
        [320, tool(sessionId, runId, 'list_directory', 'running', 'tool_started', 'Polybot')],
        [520, tool(sessionId, runId, 'list_directory', 'completed', 'tool_finished', 'Polybot', ['Polybot/src', 'Polybot/tests'])],
        [720, tool(sessionId, runId, 'search_files', 'completed', 'tool_finished', 'query: error handling', ['Polybot/src/error.rs', 'Polybot/tests/math_comprehensive_tests.rs'])],
        [820, {
            type: 'file_search_results',
            payload: [
                { path: 'Polybot/src/error.rs', name: 'error.rs' },
                { path: 'Polybot/src/main.rs', name: 'main.rs' },
                { path: 'Polybot/tests/math_comprehensive_tests.rs', name: 'math_comprehensive_tests.rs' },
            ],
        }],
        [940, tool(sessionId, runId, 'read_file', 'completed', 'tool_finished', 'src/main.rs', ['Polybot/src/main.rs'], undefined, { readLineStart: 1, readLineEnd: 150 })],
        [1010, tool(sessionId, runId, 'read_file', 'completed', 'tool_finished', 'src/main.rs', ['Polybot/src/main.rs'], undefined, { readLineStart: 151, readLineEnd: 297 })],
        [1080, command(sessionId, runId, 'cargo check', 'running')],
        [1320, command(sessionId, runId, 'cargo check', 'completed', 'Finished `dev` profile target(s) in 1.24s', 0, 1240)],
        [1460, command(sessionId, runId, 'cargo test', 'failed', 'error: failed to run custom build command for `xgboost-sys`', 101, 2100)],
        [1580, errorProgress(sessionId, runId, 'Native dependency missing: xgboost-sys')],
        [1640, command(sessionId, runId, 'brew install xgboost', 'failed', 'Error: Cannot install in CI fixture mode', 1, 420)],
        [1700, tool(sessionId, runId, 'subagent_worker', 'completed', 'tool_finished', 'review agent', [])],
        [1740, workerProgress(sessionId, runId, 'agent-review', 'Review Agent', 'completed', false, 'Checked review state rendering.', 'worker_completed', '#B48EAD', 0, 1, 'Review state verified.')],
        [1820, tool(sessionId, runId, 'replace_file_content', 'completed', 'tool_finished', 'src/main.rs', ['Polybot/src/main.rs'])],
        [1980, tool(sessionId, runId, 'apply_patch', 'failed', 'tool_failed', 'src/error.rs', ['Polybot/src/error.rs'], 'File updated, but VERIFICATION REJECTED: src/error.rs')],
        [2140, {
            type: 'pending_edits',
            payload: {
                session_id: sessionId,
                run_id: runId,
                edits: [
                    {
                        filePath: '/Users/dev/Polybot/src/error.rs',
                        relativePath: 'src/error.rs',
                        displayName: 'error.rs',
                        additions: 8,
                        deletions: 4,
                        status: 'failed',
                        state: 'failed',
                        error: 'VERIFICATION REJECTED',
                        proposalId: `edit-${runId}`,
                        reviewable: false,
                    },
                ],
            },
        }],
        [2300, tool(sessionId, runId, 'request_permission', 'running', 'tool_started', 'Allow editing src/error.rs?')],
        [2420, {
            type: 'request_permission',
            payload: {
                id: approvalId,
                sessionId,
                runId,
                run_id: runId,
                toolName: 'apply_patch',
                question: 'Allow editing src/error.rs?',
                choices: ['yes', 'no'],
            },
        }],
        [2740, {
            type: 'permission_response_received',
            payload: {
                id: approvalId,
                session_id: sessionId,
                run_id: runId,
                answer: 'yes',
            },
        }],
        [2920, hubTaskProgress(sessionId, runId, 'Fix rejected error handling edit')],
        [3040, {
            type: 'tasks_updated',
            payload: {
                tasks: [
                    { id: 101, title: 'Fix rejected error handling edit', status: 'active', column: 'in_progress', priority: 3 },
                ],
            },
        }],
        [3220, {
            type: 'checkpoint_event',
            payload: {
                session_id: sessionId,
                run_id: runId,
                event: 'checkpoint_created',
                hash: 'abc123timeline',
                message: 'Checkpoint created before final report',
                duration_ms: 320,
                timestamp: now + 3220,
            },
        }],
        [3420, {
            type: 'context_compaction',
            payload: {
                session_id: sessionId,
                run_id: runId,
                event: 'context_condensed',
                summary: 'Condensed large fixture context',
                tokens_before: 82_000,
                tokens_after: 31_000,
                timestamp: now + 3420,
            },
        }],
        [3640, chatUpdate(sessionId, runId, {
            id: `assistant-draft-${runId}`,
            role: 'assistant',
            content: 'The timeline fixture has exercised project exploration, search, file reads, commands, edits, review, approval, artifacts, and Hub Tasks.',
            timestamp: now + 3640,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            toolCalls: [{ id: 'tool-fixture-read', name: 'read_file', arguments: { path: 'src/main.rs' }, status: 'completed' }],
            metadata: { runPhase: 'intermediate' },
        })],
        [3900, progress(sessionId, runId, 'Verification completed', 'All timeline event families were emitted.', false, 'COMPLETED')],
        [4120, chatUpdate(sessionId, runId, {
            id: `assistant-final-${runId}`,
            role: 'assistant',
            content: 'All timeline events fixture complete. The transcript should show `Explored`, `Ran`, `Edited`, `Review`, `Approvals`, `Artifacts`, `Created Hub Tasks`, and a final answer without raw system leftovers.',
            timestamp: now + 4120,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            metadata: { runPhase: 'final' },
        })],
        [4340, { type: 'ask_completion_result', payload: { session_id: sessionId, run_id: runId } }],
        [4440, contextStatus(sessionId, runId)],
    ];
}

export function createSwarmFixtureTimeline(runId = 'run-swarm-fixture', sessionId = SESSION_ID, now = Date.now()): Array<[number, DevMessage]> {
    return [
        [0, { type: 'session_created', payload: { id: sessionId, session_id: sessionId } }],
        [10, { type: 'api_req_started', payload: { session_id: sessionId, run_id: runId } }],
        [20, chatUpdate(sessionId, runId, {
            id: `user-${runId}`,
            role: 'user',
            content: 'Run a swarm analysis across architecture, tests, and UI.',
            timestamp: now,
            run_id: runId,
            turn_id: runId,
        })],
        [120, progress(sessionId, runId, 'Preparing agents', 'Splitting the mission across specialized agents.', true)],
        [240, tool(sessionId, runId, 'start_swarm', 'running', 'tool_started', 'architecture, tests, ui')],
        [360, tool(sessionId, runId, 'start_swarm', 'completed', 'tool_finished', 'architecture, tests, ui', [], undefined, {
            output_preview: 'agent-architecture -> Architecture Mapper\nagent-tests -> Test Runner\nagent-ui -> UI Reviewer',
        })],
        [460, workerProgress(sessionId, runId, 'agent-architecture', 'Architecture Mapper', 'queued', true, 'Waiting for an isolated repository scan.', 'worker_spawned', '#5E81AC', 1, 0)],
        [520, workerProgress(sessionId, runId, 'agent-tests', 'Test Runner', 'queued', true, 'Waiting for verification slot.', 'worker_spawned', '#EBCB8B', 1, 0)],
        [580, workerProgress(sessionId, runId, 'agent-ui', 'UI Reviewer', 'queued', true, 'Waiting to inspect chat and dashboard UI.', 'worker_spawned', '#A3BE8C', 1, 0)],
        [760, workerProgress(sessionId, runId, 'agent-architecture', 'Architecture Mapper', 'running', true, 'Scanning core, extension, and webview boundaries.', 'worker_running', '#5E81AC', 1, 1)],
        [920, workerProgress(sessionId, runId, 'agent-tests', 'Test Runner', 'running', true, 'Running focused webview and Go tests.', 'worker_running', '#EBCB8B', 2, 2)],
        [1080, workerProgress(sessionId, runId, 'agent-ui', 'UI Reviewer', 'running', true, 'Checking Mission Dashboard agent cards.', 'worker_running', '#A3BE8C', 3, 3)],
        [1280, command(sessionId, runId, 'npm test -- --run AgentView BatchDashboard', 'running')],
        [1480, chatUpdate(sessionId, runId, {
            id: `assistant-draft-${runId}`,
            role: 'assistant',
            content: 'Three agents are active. I have enough parent context to summarize direction, but I am waiting for agent results before finalizing.',
            timestamp: now + 1480,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            toolCalls: [{ id: `swarm-tool-${runId}`, name: 'start_swarm', arguments: { workers: ['architecture', 'tests', 'ui'] }, status: 'completed' }],
            metadata: { runPhase: 'intermediate' },
        })],
        [1680, progress(sessionId, runId, 'Coordinator parent turn completed', 'Parent turn complete while agents continue in the background.', false, 'COMPLETED')],
        [1880, workerProgress(sessionId, runId, 'agent-architecture', 'Architecture Mapper', 'completed', false, 'Mapped core/runtime/webview ownership and found no blocking architecture issue.', 'worker_completed', '#5E81AC', 2, 2, 'Architecture boundaries verified.')],
        [2080, command(sessionId, runId, 'npm test -- --run AgentView BatchDashboard', 'completed', '24 tests passed for agent dashboard surfaces.', 0, 1620)],
        [2280, workerProgress(sessionId, runId, 'agent-tests', 'Test Runner', 'completed', false, 'Focused tests passed in the fixture run.', 'worker_completed', '#EBCB8B', 1, 1, 'Tests passed.')],
        [2480, workerProgress(sessionId, runId, 'agent-ui', 'UI Reviewer', 'completed', false, 'Reviewed chat agent summary and Mission Dashboard agent panel.', 'worker_completed', '#A3BE8C', 0, 3, 'UI review completed.')],
        [2640, { type: 'usage_update', payload: devUsageSnapshot(sessionId, now + 2640, 'worker') }],
        [2840, progress(sessionId, runId, 'Mission completed', 'All agents completed and the coordinator synthesized their results.', false, 'COMPLETED')],
        [3060, chatUpdate(sessionId, runId, {
            id: `assistant-final-${runId}`,
            role: 'assistant',
            content: 'Swarm fixture complete. Architecture, tests, and UI agents finished successfully. Mission Dashboard should show agent lifecycle entries, agent cards, and completed agent counts.',
            timestamp: now + 3060,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            metadata: { runPhase: 'final' },
        })],
        [3260, { type: 'ask_completion_result', payload: { session_id: sessionId, run_id: runId } }],
        [3360, contextStatus(sessionId, runId)],
    ];
}

function polybotMessages() {
    const now = Date.now() - 120_000;
    const runId = 'run-polybot-fixture';
    return [
        {
            id: 'polybot-user-1',
            role: 'user',
            content: 'проанализируй проект',
            timestamp: now,
            run_id: runId,
            turn_id: runId,
        },
        {
            id: 'polybot-assistant-draft',
            role: 'assistant',
            content: 'I explored the Polybot structure and found the main architecture, tests, and Rust modules. This is a draft result while tool work is still attached.',
            timestamp: now + 20_000,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            metadata: { runPhase: 'intermediate' },
            activities: [
                { type: 'list_dir', file: 'Polybot', counts: { files: 12, folders: 8 }, status: 'completed', timestamp: now + 4_000 },
                { type: 'list_dir', file: 'Polybot/src', counts: { files: 9, folders: 3 }, status: 'completed', timestamp: now + 5_000 },
                { type: 'analyze', file: 'Polybot/src/config.rs', lineRange: 'L1-L150', status: 'completed', timestamp: now + 6_000 },
                { type: 'analyze', file: 'Polybot/README.md', lineRange: 'L1-L120', status: 'completed', timestamp: now + 8_000 },
                { type: 'command', command: 'cargo check', resultPreview: 'Finished dev target(s) in 1.24s', exitCode: 0, durationMs: 1240, status: 'completed', timestamp: now + 11_000 },
                { type: 'command', command: 'cargo test', resultPreview: 'error: failed to run custom build command for `xgboost-sys`', exitCode: 101, durationMs: 2100, status: 'failed', timestamp: now + 14_000 },
            ],
        },
        {
            id: 'polybot-assistant-final',
            role: 'assistant',
            content: 'Polybot analysis complete. The project compiles with `cargo check`; tests are blocked locally by the native XGBoost dependency. The Dockerfile documents the expected system dependency, so the next action is aligning local setup or gating ML tests.',
            timestamp: now + 35_000,
            run_id: runId,
            turn_id: runId,
            isStreaming: false,
            metadata: { runPhase: 'final' },
        },
    ];
}

function demoTodos() {
    return [
        { id: 'dev-todo-1', content: 'Explore project structure', status: 'completed', priority: 'medium' },
        { id: 'dev-todo-2', content: 'Run compile checks', status: 'completed', priority: 'medium' },
        { id: 'dev-todo-3', content: 'Document blocked tests', status: 'completed', priority: 'medium' },
    ];
}

function chatUpdate(sessionId: string, runId: string, message: any): DevMessage {
    return { type: 'chat_update', payload: { session_id: sessionId, run_id: runId, message } };
}

function progress(sessionId: string, runId: string, status: string, summary: string, isActive: boolean, result?: string): DevMessage {
    return {
        type: 'task_progress',
        payload: {
            session_id: sessionId,
            run_id: runId,
            turn_id: runId,
            task_name: 'Dev Lab Agent',
            status,
            summary,
            is_active: isActive,
            result,
            event: result ? 'completed' : 'mission_progress',
            timestamp: Date.now(),
        },
    };
}

function workerProgress(
    sessionId: string,
    runId: string,
    workerId: string,
    name: string,
    status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'aborted',
    isActive: boolean,
    summary: string,
    event: 'worker_spawned' | 'worker_running' | 'worker_completed' | 'worker_failed' | 'mission_timed_out' | 'worker_aborted',
    color: string,
    queued: number,
    running: number,
    result?: string,
): DevMessage {
    return {
        type: 'task_progress',
        payload: {
            session_id: sessionId,
            run_id: runId,
            turn_id: runId,
            task_name: name,
            agent_identifier: workerId,
            agent_color: color,
            status,
            summary,
            is_active: isActive,
            result,
            event,
            worker_queued: queued,
            worker_running: running,
            timestamp: Date.now(),
            completed_at: isActive ? undefined : Date.now(),
        },
    };
}

function hubTaskProgress(sessionId: string, runId: string, title: string): DevMessage {
    return {
        type: 'task_progress',
        payload: {
            session_id: sessionId,
            run_id: runId,
            turn_id: runId,
            task_name: 'Dev Lab Agent',
            status: `Created Hub Task: ${title}`,
            summary: 'Created a persistent Hub Task from review work.',
            is_active: true,
            result: 'TASK_CREATED',
            event: 'hub_task_created',
            timestamp: Date.now(),
        },
    };
}

function errorProgress(sessionId: string, runId: string, message: string): DevMessage {
    return {
        type: 'task_progress',
        payload: {
            session_id: sessionId,
            run_id: runId,
            turn_id: runId,
            task_name: 'Dev Lab Agent',
            status: message,
            summary: message,
            is_active: true,
            result: 'ERROR',
            event: 'error',
            timestamp: Date.now(),
        },
    };
}

function tool(
    sessionId: string,
    runId: string,
    toolName: string,
    status: 'running' | 'completed' | 'failed',
    event: 'tool_started' | 'tool_finished' | 'tool_failed',
    argsSummary: string,
    affectedFiles: string[] = [],
    error?: string,
    options: Record<string, unknown> = {}
): DevMessage {
    return {
        type: 'tool_lifecycle',
        payload: {
            session_id: sessionId,
            run_id: runId,
            turn_id: runId,
            tool_use_id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            tool_name: toolName,
            status,
            event,
            args_summary: argsSummary,
            affected_files: affectedFiles,
            error,
            started_at: Date.now(),
            completed_at: status === 'running' ? undefined : Date.now() + 200,
            duration_ms: status === 'running' ? undefined : 200,
            timestamp: Date.now(),
            ...options,
        },
    };
}

function command(sessionId: string, runId: string, commandText: string, status: 'running' | 'completed' | 'failed', resultPreview = '', exitCode?: number, durationMs?: number): DevMessage {
    return {
        type: 'command_event',
        payload: {
            session_id: sessionId,
            run_id: runId,
            turn_id: runId,
            command_id: commandText.replace(/\W+/g, '-').toLowerCase(),
            event: status === 'failed' ? 'command_failed' : status === 'completed' ? 'command_succeeded' : 'command_started',
            status,
            command: commandText,
            cwd: '/Users/dev/Polybot',
            shell: 'zsh',
            resultPreview,
            error: status === 'failed' ? resultPreview : undefined,
            exitCode,
            durationMs,
            startedAt: Date.now(),
            completedAt: status === 'running' ? undefined : Date.now() + (durationMs || 300),
            timestamp: Date.now(),
        },
    };
}

function createSeededDevBatchRun(sessionId: string): DevBatchRun {
    const now = Date.now();
    const runId = `batch-dev-${now}`;
    return {
        id: runId,
        session_id: sessionId,
        goal: 'Review worker-mode UI, command rendering, and Mission Dashboard batch state',
        status: 'running',
        max_workers: 3,
        base_branch: 'main',
        base_commit: 'devfixture',
        base_checkpoint_hash: 'checkpoint-dev-batch',
        created_at: now - 4000,
        updated_at: now,
        merge_plan: {
            status: 'reviewing',
            apply_order: [`${runId}-core`, `${runId}-ui`],
            warnings: ['One worker failed and needs retry before merge.'],
            selected: [`${runId}-core`, `${runId}-ui`],
        },
        workers: [
            {
                id: `${runId}-core`,
                run_id: runId,
                title: 'Core worker lifecycle',
                status: 'running',
                worktree_id: 'wt-core',
                branch: 'ricochet/batch-core',
                path: '/Users/dev/Ricochet/.ricochet/batch/core',
                scope_paths: ['core/internal/agent', 'core/internal/tui'],
                attempt: 1,
                verification_commands: ['go test ./core/internal/agent ./core/internal/tui'],
                verification_status: 'running',
                output_preview: 'Inspecting worker lifecycle events and terminal renderer.',
                permissions: ['read', 'test'],
                started_at: now - 2500,
            },
            {
                id: `${runId}-ui`,
                run_id: runId,
                title: 'Dashboard UI worker',
                status: 'completed',
                worktree_id: 'wt-ui',
                branch: 'ricochet/batch-ui',
                path: '/Users/dev/Ricochet/.ricochet/batch/ui',
                scope_paths: ['webview/src/components/agent', 'webview/src/dev'],
                attempt: 1,
                summary: 'Added worker cards, diff previews, and compact batch status checks.',
                verification_commands: ['npm test -- --run BatchDashboard AgentView'],
                verification_status: 'passed',
                output_preview: 'UI worker completed with reviewable changes.',
                permissions: ['read', 'edit', 'test'],
                diff_stat: ' webview/src/components/agent/BatchDashboard.tsx | 42 ++++++++++++++\n webview/src/dev/devHarness.ts                   | 88 +++++++++++++++++++++++++++++',
                tests: [{ command: 'npm test -- --run BatchDashboard AgentView', status: 'passed', exit_code: 0 }],
                artifacts: [
                    { type: 'summary', path: 'artifacts/ui-worker-summary.md', size: 2400 },
                    { type: 'patch', path: 'artifacts/ui-worker.patch', size: 9200 },
                ],
                started_at: now - 3600,
                completed_at: now - 400,
            },
            {
                id: `${runId}-tests`,
                run_id: runId,
                title: 'Verification worker',
                status: 'failed',
                worktree_id: 'wt-tests',
                branch: 'ricochet/batch-tests',
                path: '/Users/dev/Ricochet/.ricochet/batch/tests',
                scope_paths: ['webview/src/dev', 'webview/src/hooks'],
                attempt: 1,
                verification_commands: ['npm test -- --run devHarness'],
                verification_status: 'failed',
                output_preview: 'Regression failed while checking worker summary count.',
                error: 'Expected 3 workers, received 2.',
                permissions: ['read', 'test'],
                diff_stat: ' webview/src/dev/devHarness.test.ts | 18 ++++++',
                tests: [{ command: 'npm test -- --run devHarness', status: 'failed', exit_code: 1 }],
                artifacts: [{ type: 'log', path: 'artifacts/verification-worker.log', size: 5100 }],
                started_at: now - 3000,
                completed_at: now - 650,
            },
        ],
    };
}

function createDevBatchRunFromRequest(payload: any): DevBatchRun {
    const now = Date.now();
    const runId = `batch-${now}`;
    const workers = Array.isArray(payload.workers) && payload.workers.length
        ? payload.workers
        : ['Core changes', 'Verification and tests', 'UI wiring'];
    return {
        id: runId,
        session_id: payload.session_id || SESSION_ID,
        goal: String(payload.goal || 'Dev batch run'),
        status: 'draft',
        max_workers: Math.min(Math.max(Number(payload.max_workers || workers.length || 3), 1), 5),
        base_branch: 'main',
        base_commit: 'devfixture',
        created_at: now,
        updated_at: now,
        workers: workers.map((title: string, index: number) => ({
            id: `${runId}-w${index + 1}`,
            run_id: runId,
            title,
            status: 'queued',
            branch: `ricochet/${runId}-w${index + 1}`,
            path: `/Users/dev/Ricochet/.ricochet/batch/${runId}-w${index + 1}`,
            scope_paths: ['webview/src', 'core/internal'],
            attempt: 1,
            verification_commands: Array.isArray(payload.verification_commands) ? payload.verification_commands : [],
            permissions: ['read', 'edit', 'test'],
        })),
    };
}

function upsertDevBatchRun(runs: DevBatchRun[], run: DevBatchRun): DevBatchRun[] {
    const index = runs.findIndex(item => item.id === run.id);
    if (index === -1) return [run, ...runs];
    const next = [...runs];
    next[index] = run;
    return next;
}

function updateDevBatchRun(runId: string, update: (run: DevBatchRun) => DevBatchRun, resultType: string) {
    const run = devBatchRuns.find(item => item.id === runId);
    if (!run) {
        postToWebview({ type: 'batch_error', payload: { error: `Unknown dev batch run ${runId}` } });
        return;
    }
    const next = update(run);
    devBatchRuns = upsertDevBatchRun(devBatchRuns, next);
    postToWebview({ type: resultType, payload: next });
    postToWebview({ type: 'batch_run', payload: next });
    postToWebview({ type: 'batch_event', payload: batchEvent('run_updated', next, undefined, next.status) });
}

function updateDevBatchWorker(workerId: string, update: (worker: DevBatchWorker) => DevBatchWorker, resultType: string) {
    const updatedWorkers: DevBatchWorker[] = [];
    devBatchRuns = devBatchRuns.map(run => {
        let changed = false;
        const workers = run.workers.map(worker => {
            if (worker.id !== workerId) return worker;
            const nextWorker = update(worker);
            updatedWorkers.push(nextWorker);
            changed = true;
            return nextWorker;
        });
        return changed ? { ...run, workers, updated_at: Date.now() } : run;
    });
    const worker = updatedWorkers[0];
    if (!worker) {
        postToWebview({ type: 'batch_error', payload: { error: `Unknown dev batch worker ${workerId}` } });
        return;
    }
    postToWebview({ type: resultType, payload: worker });
    postToWebview({ type: 'batch_worker', payload: worker });
    postToWebview({ type: 'batch_event', payload: batchEvent('worker_updated', undefined, worker, worker.status) });
}

function findDevBatchWorker(workerId: string): DevBatchWorker | undefined {
    return devBatchRuns.flatMap(run => run.workers).find(worker => worker.id === workerId);
}

function devBatchWorkerDiff(workerId: string) {
    const worker = findDevBatchWorker(workerId);
    return {
        worker_id: workerId,
        diff_stat: worker?.diff_stat || 'No diff available for this dev worker yet.',
        patch: worker?.diff_stat || '',
    };
}

function batchEvent(event: string, run?: DevBatchRun, worker?: DevBatchWorker, status?: string) {
    return {
        event,
        run_id: run?.id || worker?.run_id || 'batch-dev',
        worker_id: worker?.id,
        status,
        run,
        worker,
        message: worker ? `${worker.title}: ${worker.status}` : run ? `${run.goal}: ${run.status}` : event,
        timestamp: Date.now(),
    };
}

function accountState(state: DevAccountState): DevMessage {
    if (state === 'free') {
        return {
            type: 'auth_state',
            payload: {
                authenticated: false,
                user: null,
                apiBaseUrl: 'https://grik.io/api/v1',
                webBaseUrl: 'https://grik.io',
                syncStatus: 'ready',
            },
        };
    }
    return {
        type: 'auth_state',
        payload: {
            authenticated: true,
            user: { id: 'dev-user', name: 'Dev User', email: 'dev@grik.io' },
            expiresAt: Date.now() + 3_600_000,
            apiBaseUrl: 'https://grik.io/api/v1',
            webBaseUrl: 'https://grik.io',
            syncStatus: state === 'sync' ? 'degraded' : 'ready',
            error: state === 'sync' ? 'Cannot reach Grik API in fixture mode.' : undefined,
        },
    };
}

function billingState(state: DevAccountState): DevMessage {
    if (state === 'free') {
        return { type: 'billing_state', payload: { credits: [], entitlements: [], budget: null, syncStatus: 'ready' } };
    }
    if (state === 'sync') {
        return { type: 'billing_state', payload: { credits: [], entitlements: [], budget: null, syncStatus: 'degraded', error: 'Billing sync fixture error.' } };
    }
    if (state === 'expired') {
        return {
            type: 'billing_state',
            payload: {
                credits: [{ product: 'ricochet_code', balance: 0 }],
                entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'expired', currentPeriodEnd: '2026-05-22T00:00:00Z' }],
                budget: { allowed: false, product: 'ricochet_code', plan: 'pro', balance: 0 },
                syncStatus: 'ready',
            },
        };
    }
    if (state === 'quota') {
        return {
            type: 'billing_state',
            payload: {
                credits: [{ product: 'ricochet_code', balance: 4 }],
                entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'active', currentPeriodEnd: '2026-07-22T00:00:00Z' }],
                budget: {
                    allowed: false,
                    product: 'ricochet_code',
                    plan: 'pro',
                    balance: 4,
                    monthly_credits: 5000,
                    window_used: 5000,
                    window_limit: 5000,
                    window_remaining: 0,
                    task_used: 500,
                    task_limit: 500,
                    task_remaining: 0,
                    upgrade_url: 'https://grik.io/en/pricing?product=ricochet-code',
                },
                syncStatus: 'ready',
            },
        };
    }
    return {
        type: 'billing_state',
        payload: {
            credits: [{ product: 'ricochet_code', balance: 1280 }, { product: 'video', balance: 40 }],
            entitlements: [{ product: 'ricochet_code', plan: 'pro', status: 'active', currentPeriodEnd: '2026-07-22T00:00:00Z' }],
            budget: {
                allowed: true,
                product: 'ricochet_code',
                plan: 'pro',
                balance: 1280,
                monthly_credits: 5000,
                window_used: 4100,
                window_limit: 5000,
                window_remaining: 900,
                task_used: 150,
                task_limit: 500,
                task_remaining: 350,
                upgrade_url: 'https://grik.io/en/pricing?product=ricochet-code',
            },
            syncStatus: 'ready',
        },
    };
}

function devUsageSnapshot(sessionId: string, timestamp = Date.now(), operation: 'chat' | 'worker' | 'tool' = 'chat') {
    return {
        sessionId,
        inputTokens: 18_400,
        outputTokens: 4_900,
        cachedInputTokens: 3_200,
        cacheCreationTokens: 1_400,
        reasoningOutputTokens: 720,
        estimatedCostUsd: 0.18,
        requestCount: 3,
        actualCount: 2,
        estimatedCount: 1,
        source: 'actual',
        contextTokens: 42_000,
        contextWindow: 128_000,
        models: [
            {
                provider: 'grik',
                model: 'openai/gpt-5.5',
                keySource: 'hosted',
                inputTokens: 14_000,
                outputTokens: 3_900,
                cachedInputTokens: 2_100,
                cacheCreationTokens: 900,
                reasoningOutputTokens: 600,
                estimatedCostUsd: 0.14,
                requestCount: 2,
            },
            {
                provider: 'openrouter',
                model: 'qwen/qwen3-coder:free',
                keySource: 'none',
                inputTokens: 4_400,
                outputTokens: 1_000,
                cachedInputTokens: 1_100,
                cacheCreationTokens: 500,
                reasoningOutputTokens: 120,
                estimatedCostUsd: 0.04,
                requestCount: 1,
            },
        ],
        events: [
            {
                sessionId,
                runId: 'run-polybot-fixture',
                turnId: 'turn-usage-1',
                provider: 'grik',
                model: 'openai/gpt-5.5',
                keySource: 'hosted',
                operation,
                inputTokens: 7_800,
                outputTokens: 1_900,
                cachedInputTokens: 1_200,
                cacheCreationTokens: 500,
                reasoningOutputTokens: 320,
                estimatedCostUsd: 0.08,
                source: 'actual',
                timestamp: timestamp - 2 * 60 * 60 * 1000,
            },
            {
                sessionId,
                runId: 'run-polybot-fixture',
                turnId: 'turn-usage-2',
                provider: 'grik',
                model: 'openai/gpt-5.5',
                keySource: 'hosted',
                operation: operation === 'worker' ? 'worker' : 'tool',
                inputTokens: 6_200,
                outputTokens: 2_000,
                cachedInputTokens: 900,
                cacheCreationTokens: 400,
                reasoningOutputTokens: 280,
                estimatedCostUsd: 0.06,
                source: 'actual',
                timestamp: timestamp - 25 * 60 * 60 * 1000,
            },
            {
                sessionId,
                runId: 'run-polybot-fixture',
                turnId: 'turn-usage-3',
                provider: 'openrouter',
                model: 'qwen/qwen3-coder:free',
                keySource: 'none',
                operation,
                inputTokens: 4_400,
                outputTokens: 1_000,
                cachedInputTokens: 1_100,
                cacheCreationTokens: 500,
                reasoningOutputTokens: 120,
                estimatedCostUsd: 0.04,
                source: 'estimated',
                timestamp: timestamp - 12 * 24 * 60 * 60 * 1000,
            },
        ],
    };
}

function contextStatus(sessionId = SESSION_ID, runId = 'run-polybot-fixture'): DevMessage {
    return {
        type: 'context_status',
        payload: {
            session_id: sessionId,
            run_id: runId,
            tokens_used: 11_200,
            tokens_max: 128_000,
            percentage: 9,
            report: {
                session_id: sessionId,
                run_id: runId,
                tokens_used: 11_200,
                tokens_max: 128_000,
                percentage: 9,
                top_contributors: [
                    { id: 'README.md', type: 'file', source: 'README.md', tokens: 2400, percent: 21 },
                    { id: 'src/main.rs', type: 'file', source: 'src/main.rs', tokens: 1800, percent: 16 },
                ],
            },
        },
    };
}

function postToWebview(message: DevMessage) {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
}

function schedule(delayMs: number, callback: () => void) {
    const timer = window.setTimeout(callback, delayMs);
    activeTimers.push(timer);
}

function clearTimers() {
    activeTimers.forEach(timer => window.clearTimeout(timer));
    activeTimers = [];
}
