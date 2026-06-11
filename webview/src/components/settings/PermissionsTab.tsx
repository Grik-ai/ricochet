import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Filter, History, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

type PermissionAction = 'allow' | 'deny';
type PermissionScope = 'project' | 'session' | 'global';

interface PermissionRule {
    id?: string;
    tool: string;
    path?: string;
    command_prefix?: string;
    action: PermissionAction;
    scope: PermissionScope;
    project?: string;
    session_id?: string;
    expires_at?: number;
    created_at?: number;
}

interface PermissionAuditEntry {
    timestamp: number;
    tool: string;
    target?: string;
    project?: string;
    session_id?: string;
    decision: string;
    source: string;
    reason?: string;
}

interface PermissionsPayload {
    rules?: PermissionRule[];
    audit?: PermissionAuditEntry[];
}

const TOOL_OPTIONS = [
    { id: 'execute_command', label: 'Run commands' },
    { id: 'write_file', label: 'Write files' },
    { id: 'replace_file_content', label: 'Edit files' },
    { id: 'batch_edit', label: 'Batch edit files' },
    { id: 'browser_open', label: 'Open browser' },
    { id: 'browser_click', label: 'Click browser' },
    { id: 'browser_type', label: 'Type in browser' },
    { id: 'mcp', label: 'MCP tools' },
    { id: '*', label: 'All tools' },
];

function toolLabel(tool: string) {
    return TOOL_OPTIONS.find(option => option.id === tool)?.label || tool;
}

function formatTime(timestamp?: number) {
    if (!timestamp) return 'n/a';
    return new Date(timestamp * 1000).toLocaleString();
}

function formatTarget(rule: PermissionRule) {
    return rule.command_prefix || rule.path || '*';
}

function Badge({ children, tone }: { children: string; tone: 'green' | 'red' | 'blue' | 'muted' }) {
    const styles = {
        green: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
        red: 'bg-red-500/10 text-red-300 border-red-500/25',
        blue: 'bg-sky-500/10 text-sky-300 border-sky-500/25',
        muted: 'bg-white/5 text-white/50 border-white/10',
    };
    return <span className={`inline-flex h-5 items-center rounded border px-2 text-[10px] font-medium ${styles[tone]}`}>{children}</span>;
}

export function PermissionsTab() {
    const { postMessage, onMessage } = useVSCodeApi();
    const [rules, setRules] = useState<PermissionRule[]>([]);
    const [audit, setAudit] = useState<PermissionAuditEntry[]>([]);
    const [action, setAction] = useState<PermissionAction>('deny');
    const [scope, setScope] = useState<PermissionScope>('project');
    const [tool, setTool] = useState('execute_command');
    const [target, setTarget] = useState('');
    const [commandPrefix, setCommandPrefix] = useState('');
    const [sessionId, setSessionId] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [clearingAudit, setClearingAudit] = useState(false);
    const [decisionFilter, setDecisionFilter] = useState('all');
    const [sourceFilter, setSourceFilter] = useState('all');
    const [toolFilter, setToolFilter] = useState('all');

    useEffect(() => {
        postMessage({ type: 'get_permissions' });
    }, [postMessage]);

    useEffect(() => {
        const unsubscribe = onMessage((message) => {
            if (message.type === 'permissions') {
                const payload = message.payload as PermissionsPayload;
                setRules(payload.rules || []);
                setAudit(payload.audit || []);
                setSaving(false);
                setRemovingId(null);
                setClearingAudit(false);
                setError(null);
            }
            if (message.type === 'permission_rule_added') {
                const payload = message.payload as { error?: string };
                setSaving(false);
                if (payload?.error) {
                    setError(payload.error);
                } else {
                    setError(null);
                    setTarget('');
                    setCommandPrefix('');
                    setSessionId('');
                }
            }
            if (message.type === 'permission_rule_removed') {
                const payload = message.payload as { error?: string };
                setRemovingId(null);
                if (payload?.error) {
                    setError(payload.error);
                } else {
                    setError(null);
                }
            }
            if (message.type === 'permission_audit_cleared') {
                const payload = message.payload as { error?: string };
                setClearingAudit(false);
                if (payload?.error) {
                    setError(payload.error);
                } else {
                    setError(null);
                }
            }
        });
        return () => unsubscribe();
    }, [onMessage]);

    const auditSources = useMemo(() => Array.from(new Set(audit.map((entry) => entry.source).filter(Boolean))).sort(), [audit]);
    const auditTools = useMemo(() => Array.from(new Set(audit.map((entry) => entry.tool).filter(Boolean))).sort(), [audit]);
    const filteredAudit = useMemo(() => {
        return audit.filter((entry) => {
            if (decisionFilter !== 'all' && entry.decision !== decisionFilter) return false;
            if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false;
            if (toolFilter !== 'all' && entry.tool !== toolFilter) return false;
            return true;
        });
    }, [audit, decisionFilter, sourceFilter, toolFilter]);
    const recentAudit = useMemo(() => [...filteredAudit].reverse().slice(0, 80), [filteredAudit]);

    const addRule = () => {
        const trimmedTool = tool.trim();
        const trimmedTarget = target.trim();
        const trimmedCommandPrefix = commandPrefix.trim();
        const trimmedSessionId = sessionId.trim();

        if (!trimmedTool) {
            setError('Tool is required.');
            return;
        }
        if (scope === 'session' && !trimmedSessionId) {
            setError('Session scope requires a session id.');
            return;
        }

        const payload: PermissionRule = {
            tool: trimmedTool,
            action,
            scope,
        };
        if (trimmedTarget) payload.path = trimmedTarget;
        if (trimmedCommandPrefix) payload.command_prefix = trimmedCommandPrefix;
        if (trimmedSessionId) payload.session_id = trimmedSessionId;

        setSaving(true);
        setError(null);
        postMessage({ type: 'add_permission_rule', payload });
    };

    const removeRule = (id?: string) => {
        if (!id) {
            setError('Permission rule id is missing.');
            return;
        }
        setRemovingId(id);
        setError(null);
        postMessage({ type: 'remove_permission_rule', payload: { id } });
    };

    const clearAudit = () => {
        setClearingAudit(true);
        setError(null);
        postMessage({ type: 'clear_permission_audit' });
    };

    return (
        <div className="h-full min-h-0 space-y-5 text-[#cccccc]">
            <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-sky-300" />
                        <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Permission Rules</h3>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => postMessage({ type: 'get_permissions' })}>
                        <RefreshCw className="h-3.5 w-3.5" />
                        Refresh
                    </Button>
                </div>

                <div className="grid gap-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
                    <Select value={action} onValueChange={(value) => setAction(value as PermissionAction)}>
                        <SelectTrigger className={action === 'deny' ? 'bg-red-500/10 text-red-200' : 'bg-emerald-500/10 text-emerald-200'}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="deny">Deny</SelectItem>
                            <SelectItem value="allow">Allow</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={scope} onValueChange={(value) => setScope(value as PermissionScope)}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="project">Project</SelectItem>
                            <SelectItem value="session">Session</SelectItem>
                            <SelectItem value="global">Global</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={tool} onValueChange={setTool}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {TOOL_OPTIONS.map((option) => (
                                <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button onClick={addRule} disabled={saving} className="min-w-24">
                        {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        Add
                    </Button>
                </div>

                <div className="grid gap-2 lg:grid-cols-3">
                    <Input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Target path or exact command" />
                    <Input value={commandPrefix} onChange={(event) => setCommandPrefix(event.target.value)} placeholder="Command prefix" />
                    <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="Session id" disabled={scope !== 'session'} />
                </div>

                {error && (
                    <div className="flex items-center gap-2 rounded border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {error}
                    </div>
                )}

                <div className="overflow-hidden rounded border border-white/10">
                    <div className="grid grid-cols-[82px_120px_minmax(120px,1fr)_90px_145px_38px] bg-white/[0.03] px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-white/40">
                        <span>Action</span>
                        <span>Tool</span>
                        <span>Target</span>
                        <span>Scope</span>
                        <span>Created</span>
                        <span />
                    </div>
                    <div className="max-h-64 overflow-y-auto custom-scrollbar">
                        {rules.length === 0 ? (
                            <div className="px-3 py-8 text-center text-xs text-white/35">No persistent rules</div>
                        ) : (
                            rules.map((rule, index) => (
                                <div key={rule.id || `${rule.tool}-${rule.path || rule.command_prefix || '*'}-${rule.scope}-${index}`} className="grid grid-cols-[82px_120px_minmax(120px,1fr)_90px_145px_38px] items-center gap-2 border-t border-white/5 px-3 py-2 text-xs">
                                    <Badge tone={rule.action === 'deny' ? 'red' : 'green'}>{rule.action}</Badge>
                                    <span className="truncate text-[11px] text-white/70" title={rule.tool}>{toolLabel(rule.tool)}</span>
                                    <span className="truncate font-mono text-[11px] text-white/60" title={formatTarget(rule)}>{formatTarget(rule)}</span>
                                    <Badge tone={rule.scope === 'global' ? 'blue' : 'muted'}>{rule.scope}</Badge>
                                    <span className="truncate text-[11px] text-white/40">{formatTime(rule.created_at)}</span>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 text-white/35 hover:text-red-300"
                                        title="Remove rule"
                                        onClick={() => removeRule(rule.id)}
                                        disabled={removingId === rule.id}
                                    >
                                        {removingId === rule.id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                    </Button>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </section>

            <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <History className="h-4 w-4 text-white/45" />
                        <h3 className="text-xs font-medium uppercase tracking-wide text-[#888]">Audit Log</h3>
                        <span className="text-[10px] text-white/35">{filteredAudit.length}/{audit.length}</span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={clearAudit} disabled={clearingAudit || audit.length === 0} className="text-white/50 hover:text-red-300">
                        {clearingAudit ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        Clear
                    </Button>
                </div>

                <div className="grid gap-2 lg:grid-cols-[auto_1fr_1fr_1fr]">
                    <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-white/35">
                        <Filter className="h-3.5 w-3.5" />
                        Filter
                    </div>
                    <Select value={decisionFilter} onValueChange={setDecisionFilter}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All decisions</SelectItem>
                            <SelectItem value="allow">Allow</SelectItem>
                            <SelectItem value="deny">Deny</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={sourceFilter} onValueChange={setSourceFilter}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All sources</SelectItem>
                            {auditSources.map((source) => (
                                <SelectItem key={source} value={source}>{source}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={toolFilter} onValueChange={setToolFilter}>
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All tools</SelectItem>
                            {auditTools.map((auditTool) => (
                                <SelectItem key={auditTool} value={auditTool}>{auditTool}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="overflow-hidden rounded border border-white/10">
                    <div className="grid grid-cols-[150px_72px_105px_115px_minmax(120px,1fr)] bg-white/[0.03] px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-white/40">
                        <span>Time</span>
                        <span>Decision</span>
                        <span>Source</span>
                        <span>Tool</span>
                        <span>Target</span>
                    </div>
                    <div className="max-h-72 overflow-y-auto custom-scrollbar">
                        {recentAudit.length === 0 ? (
                            <div className="px-3 py-8 text-center text-xs text-white/35">{audit.length === 0 ? 'No audit entries' : 'No audit entries match the filters'}</div>
                        ) : (
                            recentAudit.map((entry, index) => (
                                <div key={`${entry.timestamp}-${entry.tool}-${index}`} className="grid grid-cols-[150px_72px_105px_115px_minmax(120px,1fr)] items-center gap-2 border-t border-white/5 px-3 py-2 text-xs">
                                    <span className="truncate text-[11px] text-white/40">{formatTime(entry.timestamp)}</span>
                                    <div className="flex items-center gap-1">
                                        {entry.decision === 'allow' ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <X className="h-3.5 w-3.5 text-red-300" />}
                                        <span className={entry.decision === 'allow' ? 'text-emerald-300' : 'text-red-300'}>{entry.decision}</span>
                                    </div>
                                    <span className="truncate text-[11px] text-white/50">{entry.source}</span>
                                    <span className="truncate text-[11px] text-white/65" title={entry.tool}>{toolLabel(entry.tool)}</span>
                                    <span className="truncate font-mono text-[11px] text-white/45" title={entry.reason || entry.target || ''}>
                                        {entry.target || entry.reason || '*'}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
