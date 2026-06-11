import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVSCodeApi } from '../../hooks/useVSCodeApi';
import {
    AlertTriangle,
    Check,
    ChevronDown,
    ChevronRight,
    Copy,
    Cpu,
    ExternalLink,
    FolderOpen,
    GitBranch,
    Loader2,
    Plus,
    RefreshCw,
    Search,
    Shield,
    SlidersHorizontal,
    Target,
    ToggleLeft,
    ToggleRight,
    Trash2,
    Wrench,
    X,
} from 'lucide-react';

export interface SkillManifest {
    name: string;
    display_name?: string;
    type?: string;
    description?: string;
    when_to_use?: string;
    argument_hint?: string;
    argument_names?: string[];
    allowed_tools?: string[];
    model?: string;
    effort?: string;
    context?: string;
    source?: string;
    enabled: boolean;
    user_invocable?: boolean;
    enforcement?: string;
    author?: string;
    version?: string;
    icon?: string;
    documentation_url?: string;
    trigger_hint?: string[];
    content_path?: string;
    path?: string;
    load_status?: string;
    validation_errors?: string[];
    can_edit?: boolean;
    can_delete?: boolean;
    scope?: string;
    visibility?: string;
    implicit_invocation?: boolean;
}

type StatusFilter = 'all' | 'enabled' | 'disabled' | 'problems';
type SourceFilter = 'all' | 'bundled' | 'project' | 'legacy' | 'root_rule';
type SortMode = 'source' | 'name' | 'status';

interface SkillGroup {
    source: string;
    label: string;
    description: string;
    skills: SkillManifest[];
}

interface SkillsTabProps {
    customInstructions: string;
    setCustomInstructions: (val: string) => void;
}

interface SkillFilters {
    query: string;
    status: StatusFilter;
    source: SourceFilter;
    sort: SortMode;
    autoInvocableOnly: boolean;
}

export function skillHasProblems(skill: SkillManifest): boolean {
    return (skill.load_status && skill.load_status !== 'ok') || Boolean(skill.validation_errors?.length);
}

export function skillPath(skill: SkillManifest): string {
    return skill.content_path || skill.path || '';
}

export function skillScope(skill: SkillManifest): string {
    if (skill.scope) return skill.scope;
    if (skill.type === 'root_rule') return 'root_rule';
    if (skill.source === 'bundled') return 'bundled';
    if (skill.source === 'legacy') return 'legacy';
    if (skill.source === 'project') return 'project';
    return skill.source || skill.type || 'skill';
}

export function skillSourceLabel(skill: SkillManifest): string {
    switch (skillScope(skill)) {
        case 'bundled':
            return 'Bundled skill';
        case 'project':
            return 'Project skill';
        case 'legacy':
            return 'Legacy skill';
        case 'root_rule':
            return 'Root rule';
        default:
            return skill.source || skill.type || 'Skill';
    }
}

export function skillStatusCopy(skill: SkillManifest): string {
    if (skillHasProblems(skill)) return 'Needs attention';
    if (!skill.enabled || skill.visibility === 'off') return 'Disabled by local settings';
    if (skill.type === 'root_rule') return 'Root rule always applies';
    if (skill.visibility === 'user-invocable-only') return 'Manual invocation only';
    if (skill.implicit_invocation === false) return 'Enabled for manual use';
    return 'Enabled for this workspace';
}

export function buildSkillSummary(skills: SkillManifest[]) {
    return {
        total: skills.length,
        enabled: skills.filter((skill) => skill.enabled && !skillHasProblems(skill)).length,
        disabled: skills.filter((skill) => !skill.enabled || skill.visibility === 'off').length,
        problems: skills.filter(skillHasProblems).length,
        project: skills.filter((skill) => skillScope(skill) === 'project').length,
    };
}

export function buildSkillGroups(skills: SkillManifest[]): SkillGroup[] {
    const grouped = new Map<string, SkillManifest[]>();
    for (const skill of skills) {
        const source = skillScope(skill);
        grouped.set(source, [...(grouped.get(source) || []), skill]);
    }

    const orderedSources = [
        ...SOURCE_GROUP_ORDER.filter((source) => grouped.has(source)),
        ...Array.from(grouped.keys()).filter((source) => !SOURCE_GROUP_ORDER.includes(source)),
    ];

    return orderedSources.map((source) => ({
        source,
        label: sourceGroupLabel(source),
        description: sourceGroupDescription(source),
        skills: grouped.get(source) || [],
    }));
}

export function filterSkillList(skills: SkillManifest[], filters: SkillFilters): SkillManifest[] {
    const query = filters.query.trim().toLowerCase();
    const filtered = skills.filter((skill) => {
        if (filters.status === 'enabled' && (!skill.enabled || skillHasProblems(skill))) return false;
        if (filters.status === 'disabled' && skill.enabled && skill.visibility !== 'off') return false;
        if (filters.status === 'problems' && !skillHasProblems(skill)) return false;
        if (filters.source !== 'all' && skillScope(skill) !== filters.source) return false;
        if (filters.autoInvocableOnly && !skill.implicit_invocation) return false;
        if (!query) return true;
        const haystack = [
            skill.name,
            skill.display_name,
            skill.description,
            skill.when_to_use,
            skillSourceLabel(skill),
            skillPath(skill),
            ...(skill.allowed_tools || []),
            ...(skill.trigger_hint || []),
            ...(skill.validation_errors || []),
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(query);
    });

    return filtered.sort((a, b) => {
        if (filters.sort === 'name') {
            return displayName(a).localeCompare(displayName(b));
        }
        if (filters.sort === 'status') {
            const statusRank = Number(skillHasProblems(b)) - Number(skillHasProblems(a));
            if (statusRank !== 0) return statusRank;
            const enabledRank = Number(b.enabled) - Number(a.enabled);
            if (enabledRank !== 0) return enabledRank;
            return displayName(a).localeCompare(displayName(b));
        }
        const sourceRank = sourceOrder(skillScope(a)) - sourceOrder(skillScope(b));
        if (sourceRank !== 0) return sourceRank;
        return displayName(a).localeCompare(displayName(b));
    });
}

function displayName(skill: SkillManifest): string {
    return (skill.display_name || skill.name || 'Unnamed skill').replace(/[-_]/g, ' ');
}

function sourceOrder(source: string): number {
    switch (source) {
        case 'project':
            return 0;
        case 'bundled':
            return 1;
        case 'legacy':
            return 2;
        case 'root_rule':
            return 3;
        default:
            return 4;
    }
}

const SOURCE_GROUP_ORDER = ['project', 'bundled', 'legacy', 'root_rule'];

function sourceGroupLabel(source: string): string {
    switch (source) {
        case 'project':
            return 'Project';
        case 'bundled':
            return 'Bundled';
        case 'legacy':
            return 'Legacy';
        case 'root_rule':
            return 'Root rules';
        default:
            return 'Other';
    }
}

function sourceGroupDescription(source: string): string {
    switch (source) {
        case 'project':
            return '.ricochet/skills in this workspace';
        case 'bundled':
            return 'Built-in Ricochet capabilities';
        case 'legacy':
            return 'Imported legacy skill rules';
        case 'root_rule':
            return 'Repository instructions that always apply';
        default:
            return 'Additional capability sources';
    }
}

export function SkillsTab({ customInstructions, setCustomInstructions }: SkillsTabProps) {
    const { postMessage } = useVSCodeApi();
    const [skills, setSkills] = useState<SkillManifest[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
    const [sortMode, setSortMode] = useState<SortMode>('source');
    const [autoInvocableOnly, setAutoInvocableOnly] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [pendingSkills, setPendingSkills] = useState<Set<string>>(new Set());
    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [newSkillName, setNewSkillName] = useState('');
    const [newSkillDescription, setNewSkillDescription] = useState('');
    const previousSkillsRef = useRef<SkillManifest[] | null>(null);

    useEffect(() => {
        postMessage({ type: 'get_skills' });

        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            if (message.type === 'skills') {
                setSkills(message.payload?.skills || []);
                setLoading(false);
                setPendingSkills(new Set());
                setBusyAction(null);
                previousSkillsRef.current = null;
                if (message.payload?.path) {
                    setNotice(`Created ${message.payload.path}`);
                }
            }
            if (message.type === 'skill_update_failed') {
                setError(message.payload?.error || 'Skill update failed.');
                setLoading(false);
                setPendingSkills(new Set());
                setBusyAction(null);
                if (previousSkillsRef.current) {
                    setSkills(previousSkillsRef.current);
                    previousSkillsRef.current = null;
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [postMessage]);

    const summary = useMemo(() => buildSkillSummary(skills), [skills]);
    const filteredSkills = useMemo(() => filterSkillList(skills, {
        query,
        status: statusFilter,
        source: sourceFilter,
        sort: sortMode,
        autoInvocableOnly,
    }), [skills, query, statusFilter, sourceFilter, sortMode, autoInvocableOnly]);
    const skillGroups = useMemo(() => buildSkillGroups(filteredSkills), [filteredSkills]);

    const setTransientNotice = (message: string) => {
        setNotice(message);
        setError(null);
    };

    const toggleExpanded = (key: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const toggleSkill = (skill: SkillManifest) => {
        const key = skillKey(skill);
        previousSkillsRef.current = skills;
        setPendingSkills((prev) => new Set(prev).add(key));
        setError(null);
        setSkills((prev) => prev.map((item) => (
            skillKey(item) === key
                ? { ...item, enabled: !item.enabled, visibility: !item.enabled ? 'on' : 'off' }
                : item
        )));
        postMessage({
            type: 'set_skill_enabled',
            payload: { name: skill.name, content_path: skillPath(skill), enabled: !skill.enabled },
        });
    };

    const rescanSkills = () => {
        setBusyAction('rescan');
        setError(null);
        postMessage({ type: 'rescan_skills' });
    };

    const createProjectSkill = () => {
        const name = newSkillName.trim();
        if (!name) {
            setError('Skill name is required.');
            return;
        }
        setBusyAction('create');
        setError(null);
        postMessage({
            type: 'create_project_skill',
            payload: { name, description: newSkillDescription.trim() },
        });
        setShowCreate(false);
        setNewSkillName('');
        setNewSkillDescription('');
    };

    const deleteProjectSkill = (skill: SkillManifest) => {
        if (!skill.can_delete) return;
        const ok = window.confirm(`Delete project skill "${displayName(skill)}"?`);
        if (!ok) return;
        setBusyAction(`delete:${skillKey(skill)}`);
        setError(null);
        postMessage({
            type: 'delete_project_skill',
            payload: { name: skill.name, content_path: skillPath(skill) },
        });
    };

    const openSkillFile = (skill: SkillManifest) => {
        const path = skillPath(skill);
        if (!path) return;
        postMessage({ type: 'open_skill_file', payload: { path } });
    };

    const copyPath = async (skill: SkillManifest) => {
        const path = skillPath(skill);
        if (!path) return;
        try {
            await navigator.clipboard.writeText(path);
            setTransientNotice('Path copied.');
        } catch {
            setError('Could not copy path.');
        }
    };

    if (loading) {
        return (
            <div className="p-8 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="space-y-7">
            <section className="space-y-3" data-testid="custom-instructions-section">
                <div>
                    <h3 className="text-sm font-medium flex items-center gap-2">
                        <Shield className="w-4 h-4 text-primary" />
                        Custom Instructions
                    </h3>
                    <p className="text-[11px] text-muted-foreground mt-1">
                        Global rules that apply to every technical interaction.
                    </p>
                </div>

                <div className="relative group">
                    <textarea
                        value={customInstructions}
                        onChange={(event) => setCustomInstructions(event.target.value)}
                        placeholder="e.g. Always include type definitions, Use conventional commits, Be concise..."
                        className="w-full min-h-32 px-3 py-2 rounded-lg bg-muted/10 text-xs text-foreground placeholder:text-muted-foreground/50 shadow-inner outline-none resize-none transition-colors hover:bg-muted/20 focus-visible:bg-muted/20 focus-visible:ring-2 focus-visible:ring-primary/30"
                    />
                    <div className="absolute right-2 bottom-2 text-[10px] text-muted-foreground/50 opacity-0 group-focus-within:opacity-100 transition-opacity">
                        Saved with Settings
                    </div>
                </div>
            </section>

            <div className="h-px bg-border/20" />

            <section className="space-y-4" data-testid="skills-section">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                        <h3 className="text-sm font-medium flex items-center gap-2">
                            <Cpu className="w-4 h-4 text-primary" />
                            Skills
                        </h3>
                        <p className="text-[11px] text-muted-foreground mt-1">
                            Workspace capabilities, load diagnostics, and local enablement.
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={rescanSkills}
                            disabled={busyAction === 'rescan'}
                            className="h-8 px-2.5 rounded-md bg-muted/10 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-50 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                            title="Rescan skills"
                        >
                            {busyAction === 'rescan' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                            Rescan
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowCreate((value) => !value)}
                            className="h-8 px-2.5 rounded-md bg-primary text-primary-foreground text-xs hover:bg-primary/90 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Create skill
                        </button>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="skills-summary">
                    <SummaryMetric label="total" value={summary.total} />
                    <SummaryMetric label="enabled" value={summary.enabled} tone="success" />
                    <SummaryMetric label="disabled" value={summary.disabled} />
                    <SummaryMetric label="problems" value={summary.problems} tone={summary.problems > 0 ? 'warning' : 'default'} />
                    <SummaryMetric label="project" value={summary.project} />
                </div>

                {(error || notice) && (
                    <div className={`rounded-md px-3 py-2 text-xs flex items-start justify-between gap-3 ${error ? 'bg-amber-500/10 text-amber-200' : 'bg-emerald-500/10 text-emerald-200'}`}>
                        <span>{error || notice}</span>
                        <button type="button" onClick={() => { setError(null); setNotice(null); }} className="text-current/70 hover:text-current">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}

                {showCreate && (
                    <div className="rounded-lg bg-muted/10 p-3 space-y-3">
                        <div className="grid gap-2 md:grid-cols-[220px_1fr_auto]">
                            <input
                                value={newSkillName}
                                onChange={(event) => setNewSkillName(event.target.value)}
                                placeholder="skill-name"
                                className="h-8 px-2.5 rounded-md bg-background/50 text-xs outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-primary/30"
                            />
                            <input
                                value={newSkillDescription}
                                onChange={(event) => setNewSkillDescription(event.target.value)}
                                placeholder="Short description"
                                className="h-8 px-2.5 rounded-md bg-background/50 text-xs outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-primary/30"
                            />
                            <button
                                type="button"
                                onClick={createProjectSkill}
                                disabled={busyAction === 'create'}
                                className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                                {busyAction === 'create' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                                Create
                            </button>
                        </div>
                        <p className="text-[10.5px] text-muted-foreground">
                            Creates `.ricochet/skills/&lt;name&gt;/SKILL.md` in this workspace.
                        </p>
                    </div>
                )}

                <div className="space-y-3" data-testid="skills-toolbar">
                    <div className="grid gap-2 lg:grid-cols-[1fr_auto_auto]">
                        <label className="relative">
                            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                            <input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search name, triggers, tools, path..."
                                className="w-full h-8 pl-8 pr-3 rounded-md bg-muted/10 text-xs outline-none placeholder:text-muted-foreground/50 hover:bg-muted/20 focus-visible:bg-muted/20 focus-visible:ring-2 focus-visible:ring-primary/30"
                            />
                        </label>
                        <select
                            value={sourceFilter}
                            onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
                            className="h-8 px-2 rounded-md bg-muted/10 text-xs outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-primary/30"
                            aria-label="Source filter"
                        >
                            <option value="all">All sources</option>
                            <option value="project">Project</option>
                            <option value="bundled">Bundled</option>
                            <option value="legacy">Legacy</option>
                            <option value="root_rule">Root rules</option>
                        </select>
                        <select
                            value={sortMode}
                            onChange={(event) => setSortMode(event.target.value as SortMode)}
                            className="h-8 px-2 rounded-md bg-muted/10 text-xs outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-primary/30"
                            aria-label="Sort skills"
                        >
                            <option value="source">Sort by source</option>
                            <option value="name">Sort by name</option>
                            <option value="status">Sort by status</option>
                        </select>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-1">
                            {(['all', 'enabled', 'disabled', 'problems'] as StatusFilter[]).map((filter) => (
                                <button
                                    key={filter}
                                    type="button"
                                    onClick={() => setStatusFilter(filter)}
                                    className={`h-7 px-2 rounded-md text-[11px] capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${statusFilter === filter ? 'bg-primary/10 text-primary' : 'bg-muted/10 text-muted-foreground hover:text-foreground hover:bg-muted/25'}`}
                                >
                                    {filter}
                                </button>
                            ))}
                        </div>
                        <label className="h-7 inline-flex items-center gap-2 rounded-md bg-muted/10 px-2 text-[11px] text-muted-foreground hover:bg-muted/20">
                            <input
                                type="checkbox"
                                checked={autoInvocableOnly}
                                onChange={(event) => setAutoInvocableOnly(event.target.checked)}
                                className="h-3.5 w-3.5"
                            />
                            Show only auto-invocable
                        </label>
                    </div>
                </div>

                {skills.length === 0 ? (
                    <EmptyState title="No skills found" body="Create a project skill or rescan after adding .ricochet/skills/<name>/SKILL.md." />
                ) : filteredSkills.length === 0 ? (
                    <EmptyState title="No matches" body="Adjust search, status, or source filters." />
                ) : (
                    <div className="space-y-4">
                        {skillGroups.map((group) => (
                            <section key={group.source} className="space-y-2" data-testid={`skill-group-${group.source}`}>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0 flex items-center gap-2">
                                        <SourceGroupIcon source={group.source} />
                                        <div className="min-w-0">
                                            <h4 className="text-xs font-medium">{group.label}</h4>
                                            <p className="text-[10.5px] text-muted-foreground truncate">{group.description}</p>
                                        </div>
                                    </div>
                                    <span className="text-[10.5px] text-muted-foreground">{group.skills.length}</span>
                                </div>
                                <div className="grid gap-1.5">
                                    {group.skills.map((skill) => {
                                        const key = skillKey(skill);
                                        const isExpanded = expanded.has(key);
                                        const pending = pendingSkills.has(key);
                                        const hasProblem = skillHasProblems(skill);
                                        const path = skillPath(skill);
                                        return (
                                            <article
                                                key={key}
                                                className={`rounded-lg p-3 transition-colors ${hasProblem ? 'bg-amber-500/10' : !skill.enabled ? 'bg-muted/10 opacity-70' : 'bg-muted/10 hover:bg-muted/20'}`}
                                                data-testid="skill-row"
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div className="min-w-0 flex items-start gap-2.5">
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleExpanded(key)}
                                                            className="mt-0.5 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                                                            title={isExpanded ? 'Hide details' : 'Show details'}
                                                            aria-label={isExpanded ? `Hide ${displayName(skill)} details` : `Show ${displayName(skill)} details`}
                                                        >
                                                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                                        </button>
                                                        <div className="min-w-0">
                                                            <div className="flex flex-wrap items-center gap-1.5">
                                                                <h4 className="text-xs font-medium truncate max-w-[260px]">{displayName(skill)}</h4>
                                                                <SoftPill>{skillSourceLabel(skill)}</SoftPill>
                                                                {skill.context && <SoftPill>{skill.context}</SoftPill>}
                                                                {hasProblem && <SoftPill tone="warning">Problem</SoftPill>}
                                                            </div>
                                                            <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                                                                {skill.description || 'No description provided.'}
                                                            </p>
                                                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
                                                                <span className={skill.enabled && !hasProblem ? 'text-emerald-400' : hasProblem ? 'text-amber-300' : ''}>
                                                                    {skillStatusCopy(skill)}
                                                                </span>
                                                                {skill.user_invocable && <span>Manual invocation ready</span>}
                                                                {path && <span className="truncate max-w-[360px]">{path}</span>}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="flex shrink-0 items-center gap-1">
                                                        {skill.documentation_url && (
                                                            <a
                                                                href={skill.documentation_url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className={iconActionClass}
                                                                title="Open documentation"
                                                            >
                                                                <ExternalLink className="w-3.5 h-3.5" />
                                                            </a>
                                                        )}
                                                        {path && (
                                                            <button
                                                                type="button"
                                                                onClick={() => copyPath(skill)}
                                                                className={iconActionClass}
                                                                title="Copy path"
                                                            >
                                                                <Copy className="w-3.5 h-3.5" />
                                                            </button>
                                                        )}
                                                        {skill.can_edit && path && (
                                                            <button
                                                                type="button"
                                                                onClick={() => openSkillFile(skill)}
                                                                className={iconActionClass}
                                                                title="Open SKILL.md"
                                                            >
                                                                <FolderOpen className="w-3.5 h-3.5" />
                                                            </button>
                                                        )}
                                                        {skill.can_delete && (
                                                            <button
                                                                type="button"
                                                                onClick={() => deleteProjectSkill(skill)}
                                                                disabled={busyAction === `delete:${key}`}
                                                                className={`${iconActionClass} hover:text-destructive`}
                                                                title="Delete project skill"
                                                            >
                                                                {busyAction === `delete:${key}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleSkill(skill)}
                                                            disabled={pending || hasProblem}
                                                            className={`${iconActionClass} hover:text-primary disabled:hover:text-muted-foreground disabled:hover:bg-transparent`}
                                                            title={hasProblem ? 'Fix diagnostics before enabling' : skill.enabled ? 'Disable skill' : 'Enable skill'}
                                                            aria-label={skill.enabled ? `Disable ${displayName(skill)}` : `Enable ${displayName(skill)}`}
                                                        >
                                                            {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : skill.enabled ? <ToggleRight className="w-4 h-4 text-primary" /> : <ToggleLeft className="w-4 h-4" />}
                                                        </button>
                                                    </div>
                                                </div>

                                                {hasProblem && (
                                                    <div className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
                                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                                            <div className="flex items-center gap-1.5 font-medium">
                                                                <AlertTriangle className="w-3.5 h-3.5" />
                                                                Skill diagnostic
                                                            </div>
                                                            {skill.can_edit && path && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => openSkillFile(skill)}
                                                                    className="text-[10.5px] text-amber-100/80 hover:text-amber-100 underline-offset-2 hover:underline"
                                                                >
                                                                    Open SKILL.md
                                                                </button>
                                                            )}
                                                        </div>
                                                        <ul className="mt-1 space-y-1">
                                                            {(skill.validation_errors || ['Skill could not be loaded.']).map((item) => (
                                                                <li key={item}>{item}</li>
                                                            ))}
                                                        </ul>
                                                    </div>
                                                )}

                                                {isExpanded && (
                                                    <div className="mt-3 grid gap-3">
                                                        <div className="h-px bg-border/20" />
                                                        {skill.when_to_use && (
                                                            <DetailBlock label="Use when" value={skill.when_to_use} />
                                                        )}
                                                        <div className="grid gap-3 md:grid-cols-2">
                                                            <TokenBlock icon={<Wrench className="w-3 h-3" />} label="Allowed tools" values={skill.allowed_tools || []} mono />
                                                            <TokenBlock icon={<Target className="w-3 h-3" />} label="Triggers" values={skill.trigger_hint || []} />
                                                        </div>
                                                        <div className="grid gap-2 md:grid-cols-2 text-[10.5px] text-muted-foreground">
                                                            <MetaRow icon={<GitBranch className="w-3 h-3" />} label="Enforcement" value={skill.enforcement || 'suggest'} />
                                                            <MetaRow icon={<SlidersHorizontal className="w-3 h-3" />} label="Model" value={[skill.model, skill.effort].filter(Boolean).join(' / ') || 'default'} />
                                                            <MetaRow icon={<Cpu className="w-3 h-3" />} label="Invocation" value={skill.implicit_invocation ? 'Automatic and manual' : skill.user_invocable ? 'Manual only' : 'Not invocable'} />
                                                            <MetaRow icon={<Check className="w-3 h-3" />} label="Visibility" value={skill.visibility || 'on'} />
                                                        </div>
                                                    </div>
                                                )}
                                            </article>
                                        );
                                    })}
                                </div>
                            </section>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

const iconActionClass = 'rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30';

function SummaryMetric({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'success' | 'warning' }) {
    const toneClass = tone === 'warning'
        ? 'text-amber-300'
        : tone === 'success'
            ? 'text-emerald-400'
            : 'text-foreground';
    return (
        <span className="inline-flex items-baseline gap-1">
            <span className={`font-semibold ${toneClass}`}>{value}</span>
            <span>{label}</span>
        </span>
    );
}

function EmptyState({ title, body }: { title: string; body: string }) {
    return (
        <div className="p-8 text-center bg-muted/10 rounded-lg">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-[11px] text-muted-foreground mt-1">{body}</p>
        </div>
    );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className="text-[10px] font-medium text-muted-foreground mb-1">{label}</div>
            <p className="text-[11px] text-muted-foreground">{value}</p>
        </div>
    );
}

function TokenBlock({ icon, label, values, mono = false }: { icon: ReactNode; label: string; values: string[]; mono?: boolean }) {
    return (
        <div>
            <div className="flex items-center gap-1.5 mb-1.5 text-muted-foreground">
                {icon}
                <span className="text-[10px] font-medium">{label}</span>
            </div>
            {values.length === 0 ? (
                <p className="text-[10.5px] text-muted-foreground/70">None declared</p>
            ) : (
                <div className="flex flex-wrap gap-1">
                    {values.map((value) => (
                        <span key={value} className={`px-1.5 py-0.5 bg-muted/25 rounded text-[9.5px] ${mono ? 'font-mono' : ''}`}>
                            {value}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function MetaRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
    return (
        <div className="flex items-center gap-2 min-w-0">
            <span className="text-muted-foreground">{icon}</span>
            <span className="text-muted-foreground">{label}:</span>
            <span className="truncate text-foreground/80">{value}</span>
        </div>
    );
}

function SoftPill({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warning' }) {
    return (
        <span className={`rounded-full px-1.5 py-0.5 text-[9.5px] ${tone === 'warning' ? 'bg-amber-500/10 text-amber-200' : 'bg-muted/25 text-muted-foreground'}`}>
            {children}
        </span>
    );
}

function SourceGroupIcon({ source }: { source: string }) {
    const className = 'w-3.5 h-3.5 text-muted-foreground';
    if (source === 'project') return <FolderOpen className={className} />;
    if (source === 'bundled') return <Cpu className={className} />;
    if (source === 'legacy') return <Wrench className={className} />;
    if (source === 'root_rule') return <Shield className={className} />;
    return <Target className={className} />;
}

function skillKey(skill: SkillManifest): string {
    return skillPath(skill) || skill.name;
}
