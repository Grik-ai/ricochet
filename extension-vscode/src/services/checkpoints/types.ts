import { CommitResult } from "simple-git"

export type CheckpointResult = Partial<CommitResult> & Pick<CommitResult, "commit">

export type CheckpointDiff = {
    paths: {
        relative: string
        absolute: string
    }
    content: {
        before: string
        after: string
    }
}

export type CheckpointFileChange = {
    path: string
    old_path?: string
    status: "added" | "modified" | "deleted" | "renamed" | "copied" | "changed" | string
    additions?: number
    deletions?: number
    binary?: boolean
    large?: boolean
    ignored?: boolean
    preview?: string
    error?: string
}

export type CheckpointRestorePreview = {
    checkpoint_hash: string
    current_hash?: string
    safety_required: boolean
    summary: string
    files: CheckpointFileChange[]
    warnings?: string[]
    restore_modes: string[]
    diff_stat?: string
    generated_at: number
}

export type CheckpointRestoreRequest = {
    checkpoint_hash: string
    mode: "full" | "selected_files" | "patch_only" | "export_snapshot" | string
    paths?: string[]
    create_safety_checkpoint: boolean
}

export type CheckpointRestoreResult = {
    restored_hash?: string
    safety_checkpoint_hash?: string
    files_restored?: string[]
    skipped_files?: string[]
    patch_path?: string
    export_path?: string
    mode: string
    duration_ms?: number
}

export interface CheckpointServiceOptions {
    taskId: string
    workspaceDir: string
    shadowDir: string // globalStorageUri.fsPath

    log?: (message: string) => void
}

export interface CheckpointEventMap {
    initialize: { type: "initialize"; workspaceDir: string; baseHash: string; created: boolean; duration: number }
    checkpoint: {
        type: "checkpoint"
        fromHash: string
        toHash: string
        duration: number
        suppressMessage?: boolean
    }
    restore: { type: "restore"; commitHash: string; duration: number }
    error: { type: "error"; error: Error }
}
