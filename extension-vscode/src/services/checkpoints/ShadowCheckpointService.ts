import fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"
import EventEmitter from "events"
import simpleGit, { SimpleGit, SimpleGitOptions } from "simple-git"
import * as vscode from "vscode"
import {
    CheckpointDiff,
    CheckpointFileChange,
    CheckpointRestorePreview,
    CheckpointRestoreRequest,
    CheckpointRestoreResult,
    CheckpointResult,
    CheckpointEventMap,
} from "./types"
import { getExcludePatterns } from "./excludes"

// Simple p-wait-for replacement
const waitFor = async (condition: () => Promise<boolean> | boolean, options: { interval: number, timeout: number }) => {
    const start = Date.now();
    while (Date.now() - start < options.timeout) {
        if (await condition()) return;
        await new Promise(resolve => setTimeout(resolve, options.interval));
    }
    throw new Error("Timeout waiting for condition");
};

async function fileExistsAtPath(path: string) {
    try {
        await fs.access(path)
        return true
    } catch {
        return false
    }
}

function createSanitizedGit(baseDir: string): SimpleGit {
    const sanitizedEnv: Record<string, string> = {}
    const removedVars: string[] = []

    for (const [key, value] of Object.entries(process.env)) {
        if (
            key === "GIT_DIR" ||
            key === "GIT_WORK_TREE" ||
            key === "GIT_INDEX_FILE" ||
            key === "GIT_OBJECT_DIRECTORY" ||
            key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
            key === "GIT_CEILING_DIRECTORIES"
        ) {
            removedVars.push(`${key}=${value}`)
            continue
        }
        if (value !== undefined) {
            sanitizedEnv[key] = value
        }
    }

    if (removedVars.length > 0) {
        console.log(`[createSanitizedGit] Removed git env vars: ${removedVars.join(", ")}`)
    }

    const options: Partial<SimpleGitOptions> = {
        baseDir,
        config: [],
    }

    const git = simpleGit(options)
    git.env(sanitizedEnv)
    return git
}

const LARGE_FILE_THRESHOLD_BYTES = 1024 * 1024

function shortHash(hash: string) {
    return hash.length <= 8 ? hash : hash.slice(0, 8)
}

function parseNumstat(raw: string) {
    const entries = new Map<string, { additions: number; deletions: number; binary: boolean }>()
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parts = trimmed.split(/\s+/)
        if (parts.length < 3) continue
        const filePath = parts[parts.length - 1]
        const binary = parts[0] === "-" || parts[1] === "-"
        entries.set(filePath, {
            additions: binary ? 0 : Number.parseInt(parts[0], 10) || 0,
            deletions: binary ? 0 : Number.parseInt(parts[1], 10) || 0,
            binary,
        })
    }
    return entries
}

function parseNameStatus(raw: string): CheckpointFileChange[] {
    const changes: CheckpointFileChange[] = []
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parts = trimmed.split(/\s+/)
        if (parts.length < 2) continue
        const code = parts[0]
        let status: CheckpointFileChange["status"] = "changed"
        let filePath = parts[1]
        let oldPath: string | undefined
        if (code.startsWith("A")) status = "added"
        else if (code.startsWith("M")) status = "modified"
        else if (code.startsWith("D")) status = "deleted"
        else if (code.startsWith("R")) {
            status = "renamed"
            if (parts.length >= 3) {
                oldPath = parts[1]
                filePath = parts[2]
            }
        } else if (code.startsWith("C")) {
            status = "copied"
            if (parts.length >= 3) {
                oldPath = parts[1]
                filePath = parts[2]
            }
        }
        changes.push({ path: filePath, old_path: oldPath, status })
    }
    return changes
}

async function isLikelyBinaryFile(filePath: string) {
    try {
        const handle = await fs.open(filePath, "r")
        try {
            const buffer = Buffer.alloc(8192)
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
            return buffer.subarray(0, bytesRead).includes(0)
        } finally {
            await handle.close()
        }
    } catch {
        return false
    }
}

export class ShadowCheckpointService extends EventEmitter {
    public readonly taskId: string
    public readonly checkpointsDir: string
    public readonly workspaceDir: string

    protected _checkpoints: string[] = []
    protected _baseHash?: string

    protected readonly dotGitDir: string
    protected git?: SimpleGit
    protected readonly log: (message: string) => void
    protected shadowGitConfigWorktree?: string

    public get baseHash() {
        return this._baseHash
    }

    protected set baseHash(value: string | undefined) {
        this._baseHash = value
    }

    public get isInitialized() {
        return !!this.git
    }

    public getCheckpoints(): string[] {
        return this._checkpoints.slice()
    }

    constructor(taskId: string, checkpointsDir: string, workspaceDir: string, log: (message: string) => void) {
        super()
        this.taskId = taskId
        this.checkpointsDir = checkpointsDir
        this.workspaceDir = workspaceDir
        this.dotGitDir = path.join(this.checkpointsDir, ".git")
        this.log = log
    }

    public async initShadowGit(onInit?: () => Promise<void>) {
        if (this.git) {
            throw new Error("Shadow git repo already initialized")
        }

        // Simplified nested git check: just warn if .git exists in workspace but isn't root
        // For now, we assume user is responsible.
        // Full check could be added later.

        await fs.mkdir(this.checkpointsDir, { recursive: true })
        const git = createSanitizedGit(this.checkpointsDir)

        let created = false
        const startTime = Date.now()

        if (await fileExistsAtPath(this.dotGitDir)) {
            this.log(`[ShadowCheckpointService] using existing shadow git repo at ${this.dotGitDir}`)
            const worktree = (await git.getConfig("core.worktree")).value || undefined
            this.shadowGitConfigWorktree = worktree

            if (worktree !== this.workspaceDir) {
                throw new Error(
                    `Checkpoints can only be used in the original workspace: ${worktree} !== ${this.workspaceDir}`,
                )
            }

            await this.writeExcludeFile()
            this.baseHash = await git.revparse(["HEAD"])
        } else {
            this.log(`[ShadowCheckpointService] creating shadow git repo at ${this.checkpointsDir}`)
            await git.init()
            await git.addConfig("core.worktree", this.workspaceDir)
            await git.addConfig("commit.gpgSign", "false")
            await git.addConfig("user.name", "Ricochet")
            await git.addConfig("user.email", "noreply@ricochet.ai")
            await this.writeExcludeFile()
            await this.stageAll(git)
            const { commit } = await git.commit("initial commit", { "--allow-empty": null })
            this.baseHash = commit
            created = true
        }

        const duration = Date.now() - startTime
        this.log(`[ShadowCheckpointService] initialized shadow repo with base commit ${this.baseHash} in ${duration}ms`)
        this.git = git
        await onInit?.()

        this.emit("initialize", {
            type: "initialize",
            workspaceDir: this.workspaceDir,
            baseHash: this.baseHash,
            created,
            duration,
        })
    }

    protected async writeExcludeFile() {
        await fs.mkdir(path.join(this.dotGitDir, "info"), { recursive: true })
        const patterns = await getExcludePatterns(this.workspaceDir)
        await fs.writeFile(path.join(this.dotGitDir, "info", "exclude"), patterns.join("\n"))
    }

    private async stageAll(git: SimpleGit) {
        try {
            await git.add([".", "--ignore-errors"])
        } catch (error) {
            this.log(`[ShadowCheckpointService] failed to add files: ${error}`)
        }
    }

    public async saveCheckpoint(message: string): Promise<CheckpointResult | undefined> {
        if (!this.git) throw new Error("Shadow git repo not initialized")

        const startTime = Date.now()
        await this.stageAll(this.git)
        const result = await this.git.commit(message)
        const fromHash = this._checkpoints[this._checkpoints.length - 1] ?? this.baseHash!
        const toHash = result.commit || fromHash
        if (result.commit) {
            this._checkpoints.push(toHash)
        }

        const duration = Date.now() - startTime

        if (result.commit) {
            this.emit("checkpoint", {
                type: "checkpoint",
                fromHash,
                toHash,
                duration,
            })
            return result
        }
        return undefined
    }

    public async restoreCheckpoint(commitHash: string) {
        await this.restoreWithOptions({
            checkpoint_hash: commitHash,
            mode: "full",
            create_safety_checkpoint: true,
        })
    }

    public async previewRestore(commitHash: string): Promise<CheckpointRestorePreview> {
        if (!this.git) throw new Error("Shadow git repo not initialized")
        if (!commitHash.trim()) throw new Error("Checkpoint hash is required")

        await this.stageAll(this.git)
        const [currentHash, diffStat, nameStatus, numstat] = await Promise.all([
            this.git.raw(["write-tree"]).then(value => value.trim()).catch(() => ""),
            this.git.diff(["--cached", "--stat", commitHash]).catch(() => ""),
            this.git.diff(["--cached", "--name-status", "--find-renames", commitHash]),
            this.git.diff(["--cached", "--numstat", commitHash]).catch(() => ""),
        ])
        const counts = parseNumstat(numstat)
        const cwdPath = this.shadowGitConfigWorktree || this.workspaceDir
        const files: CheckpointFileChange[] = []

        for (const change of parseNameStatus(nameStatus)) {
            const count = counts.get(change.path)
            if (count) {
                change.additions = count.additions
                change.deletions = count.deletions
                change.binary = count.binary
            }
            const absPath = path.join(cwdPath, change.path)
            try {
                const stat = await fs.stat(absPath)
                change.large = stat.size > LARGE_FILE_THRESHOLD_BYTES
                if (!change.binary) {
                    change.binary = await isLikelyBinaryFile(absPath)
                }
            } catch {
                // Deleted files are expected to be absent in the current worktree.
            }
            if (!change.binary) {
                change.preview = await fs.readFile(absPath, "utf8").then(text => {
                    return text.length > 800 ? `${text.slice(0, 800)}\n...` : text
                }).catch(() => "")
            }
            files.push(change)
        }

        const warnings: string[] = []
        const nested = await this.findNestedGitRepository().catch(() => "")
        if (nested) {
            warnings.push(`Nested git repository detected at ${nested}; review checkpoint excludes before restoring.`)
        }
        if (files.length > 25) {
            warnings.push(`${files.length} files would change. Prefer selected restore or patch review for broad changes.`)
        }

        return {
            checkpoint_hash: commitHash,
            current_hash: currentHash,
            safety_required: files.length > 0,
            summary: files.length > 0
                ? `${files.length} file(s) differ from checkpoint ${shortHash(commitHash)}.`
                : "No file changes detected.",
            files,
            warnings,
            restore_modes: ["full", "selected_files", "patch_only", "export_snapshot"],
            diff_stat: diffStat.trim(),
            generated_at: Date.now(),
        }
    }

    public async restoreWithOptions(request: CheckpointRestoreRequest): Promise<CheckpointRestoreResult> {
        if (!this.git) throw new Error("Shadow git repo not initialized")
        const start = Date.now()
        const mode = request.mode || "full"
        const preview = await this.previewRestore(request.checkpoint_hash)
        const result: CheckpointRestoreResult = {
            restored_hash: request.checkpoint_hash,
            mode,
        }

        if (mode === "patch_only") {
            result.patch_path = await this.createPatch(request.checkpoint_hash)
            result.duration_ms = Date.now() - start
            return result
        }
        if (mode === "export_snapshot") {
            result.export_path = await this.exportSnapshot(request.checkpoint_hash)
            result.duration_ms = Date.now() - start
            return result
        }

        if (request.create_safety_checkpoint) {
            const safety = await this.saveCheckpoint(`Safety checkpoint before restore to ${shortHash(request.checkpoint_hash)}`)
            result.safety_checkpoint_hash = safety?.commit
        }

        if (mode === "selected_files") {
            const selected = request.paths || []
            if (selected.length === 0) {
                throw new Error("Selected restore requires at least one path")
            }
            const statusByPath = new Map(preview.files.map(file => [file.path, file.status]))
            const restored: string[] = []
            const skipped: string[] = []
            for (const relPath of selected) {
                const normalized = relPath.trim()
                if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
                    skipped.push(relPath)
                    continue
                }
                if (statusByPath.get(normalized) === "added") {
                    await fs.rm(path.join(this.workspaceDir, normalized), { recursive: true, force: true })
                    await this.git.raw(["rm", "--cached", "--ignore-unmatch", normalized]).catch(() => "")
                    restored.push(normalized)
                    continue
                }
                try {
                    await this.git.raw(["checkout", request.checkpoint_hash, "--", normalized])
                    restored.push(normalized)
                } catch {
                    skipped.push(normalized)
                }
            }
            await this.stageAll(this.git)
            result.files_restored = restored
            result.skipped_files = skipped
        } else if (mode === "full") {
            await this.git.clean("f", ["-d", "-f"])
            await this.git.reset(["--hard", request.checkpoint_hash])
            result.files_restored = preview.files.map(file => file.path)
        } else {
            throw new Error(`Unsupported checkpoint restore mode: ${mode}`)
        }

        const duration = Date.now() - start
        result.duration_ms = duration
        this.emit("restore", { type: "restore", commitHash: request.checkpoint_hash, duration })
        return result
    }

    public async createPatch(commitHash: string): Promise<string> {
        if (!this.git) throw new Error("Shadow git repo not initialized")
        await this.stageAll(this.git)
        const patchText = await this.git.diff(["--cached", commitHash])
        const patchDir = path.join(this.checkpointsDir, "patches")
        await fs.mkdir(patchDir, { recursive: true })
        const patchPath = path.join(patchDir, `restore-${shortHash(commitHash)}-${Date.now()}.patch`)
        await fs.writeFile(patchPath, patchText, "utf8")
        return patchPath
    }

    public async exportSnapshot(commitHash: string): Promise<string> {
        if (!this.git) throw new Error("Shadow git repo not initialized")
        const exportDir = path.join(this.checkpointsDir, "exports")
        await fs.mkdir(exportDir, { recursive: true })
        const exportPath = path.join(exportDir, `snapshot-${shortHash(commitHash)}.tar`)
        await this.git.raw(["archive", "--format=tar", "-o", exportPath, commitHash])
        return exportPath
    }

    public async getDiff({ from, to }: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
        if (!this.git) throw new Error("Shadow git repo not initialized")

        if (!from) {
            from = (await this.git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim()
        }

        await this.stageAll(this.git)
        const { files } = to ? await this.git.diffSummary([`${from}..${to}`]) : await this.git.diffSummary([from])

        const cwdPath = this.shadowGitConfigWorktree || this.workspaceDir || ""
        const result: CheckpointDiff[] = []

        for (const file of files) {
            const relPath = file.file
            const absPath = path.join(cwdPath, relPath)
            const before = await this.git.show([`${from}:${relPath}`]).catch(() => "")
            const after = to
                ? await this.git.show([`${to}:${relPath}`]).catch(() => "")
                : await fs.readFile(absPath, "utf8").catch(() => "")

            result.push({ paths: { relative: relPath, absolute: absPath }, content: { before, after } })
        }
        return result
    }

    private async findNestedGitRepository(): Promise<string> {
        const stack = [this.workspaceDir]
        while (stack.length > 0) {
            const dir = stack.pop()!
            let entries: import("fs").Dirent[]
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                continue
            }
            for (const entry of entries) {
                if (!entry.isDirectory()) continue
                if (entry.name === "node_modules" || entry.name === ".venv" || entry.name === "vendor") continue
                const fullPath = path.join(dir, entry.name)
                if (entry.name === ".git") {
                    if (dir !== this.workspaceDir) return fullPath
                    continue
                }
                stack.push(fullPath)
            }
        }
        return ""
    }
}
