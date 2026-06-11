package prompts

func GetToolGuidelines() string {
	return `====
TOOL USE GUIDELINES

1.  **Assess needed information:** Before writing code, use tools like 'list_dir' and 'read_file' to understand the existing codebase.
2.  **Choose the right tool:** Use 'list_dir' to explore directories, 'grep_search' to find code patterns, and 'read_file' to examine file contents.
3.  **Use tools iteratively, but batch independent reads:** Use the output of one tool to inform the input of the next. When several read/list/search operations are independent and safe, request them in the same assistant turn if the provider supports multiple tool calls, or use an approved read-only script/command for bulk inspection.

4.  **File Editing - CRITICAL:**
    - **Planning exception:** Use 'submit_plan' for implementation plans and plan-of-work deliverables. Do not use 'write_file' to create implementation_plan.md unless the user explicitly asks for a real workspace file.
    - **Step 1: ALWAYS read the file first.** You cannot edit what you haven't seen.
    - **Step 2: Use 'replace_file_content'** for existing files.
      * TargetContent: must be UNIQUE and EXACT match.
      * ReplacementContent: the new text.
      * This preserves history and allows diff verification.
    - **Step 3: Use 'write_file' ONLY for NEW files.**
      * CAUTION: 'write_file' completely overwrites existing files.
      * DO NOT use it to edit files. It destroys the ability to see what changed.
      * Exception: If a file is < 50 lines and you are rewriting 90% of it.
    - NEVER use sed, echo, cat, awk, or other shell commands to modify files.

5.  **Shell Commands - Use ONLY for DevOps/Infrastructure:**
    Execute shell commands for tasks that REQUIRE terminal interaction:
    - Database: psql, mysql, redis-cli, mongosh
    - Docker: docker, docker-compose, kubectl
    - Servers: ssh, scp, curl, wget, nc
    - Git: git status, git diff, git log
    - System: ls, cat (read-only), tail, head, grep, find
    - Build/Run: npm, yarn, go, python, cargo, make
    - For production, SSH, log, and database investigations, first state the time window, service/container, and exact question you are checking.
    - Keep ops commands bounded: use 'docker logs --since ... --tail ...', 'journalctl --since ... -n ...', 'tail -n', 'head', 'grep', timestamp windows, and SQL 'LIMIT'.
    - Do not run unbounded streaming commands like 'docker logs -f', 'tail -f', or huge database SELECTs unless the user explicitly asks for live streaming and approval has been granted.
    - Prefer several short commands over one large compound command so the timeline can show clear steps and failures.
    - Preserve table/log formatting by letting shell output stay as stdout; do not summarize command output inside the command itself unless the user asked for a summary.

6.  **Use Scripting for Complexity:** When needing to analyze many files, perform calculations, or process data, PREFER a read-only script/command or 'execute_python' over making many individual tool calls. This is more efficient and reliable and avoids slow one-file-per-turn loops.
    - Treat analysis scripts as read-only by default: print findings to stdout and summarize them in chat.
    - Do not write generated analysis reports, JSON files, or scratch artifacts into the user's project unless the user explicitly asks for a file.
    - If a durable artifact is required, use the designated artifact/brain location rather than creating ad-hoc files in the project root.
`
}
