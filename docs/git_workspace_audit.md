# `git_workspace_audit` (read-only Git preflight)

This MCP tool replaces repeated ad-hoc Git inspection commands with a single structured, workspace-scoped read. It is exposed from the `readonly` profile upward and accepts **no user-controlled shell commands, paths or flags**.

## Included

- Active branch and HEAD (including detached HEAD).
- Tracking branch, ahead/behind computed from **local remote-tracking refs**.
- Remote names (never remote URLs), five recent local commit subjects.
- Counts of staged, worktree, untracked, deleted and conflicted paths.
- Up to 30 changed-path samples, 20 untracked-directory groups, and 30 risk entries.
- Simulink generated cache patterns, `.mat` data that merits **manual review**, and paths >= 10 MiB.

A successful call is a snapshot, not an authorization to stage, commit or push. `*.mat` is not automatically disposable; ignored files are not enumerated. If 5,000 status entries are reached, counts are explicitly partial (`truncated=true`).

## Safety

The implementation uses `execFile("git", fixedArgs)`; it performs no `fetch`, `push`, `add`, `commit`, file removal or ignore-rule edits. `--no-optional-locks` and `core.fsmonitor=false` reduce side-effect risks. It refuses a repository whose Git top-level directory differs from the active workspace root, so a child-workspace audit cannot silently inspect its parent Git repository.

## Adoption

1. Check the structured report before any repository mutation.
2. Review suspicious `.mat`, `.slxc`, `slprj/` and large-file paths individually.
3. Run Git mutation tools separately with the normal approval and path controls.
4. Benchmark against the existing sequence of `git status`, `git diff --stat`, `git ls-files --others --exclude-standard`, and upstream checks.
5. Treat ahead/behind as stale until a **separately authorized** `git fetch` updates local tracking refs.

## Validation

The Git fixture suite asserts read-only behavior (index and HEAD unchanged), status count correctness, cache/data/large-file classification, local upstream divergence, repository-root containment, rename parsing and truncation. Full `npm run verify` tests profile exposure, MCP output schemas and HTTP Reviewer visibility.
