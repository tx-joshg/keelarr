# CLAUDE.md

<!-- parallel-agent-git-hygiene -->
## Working alongside other agents

Assume other Claude agents or threads may be changing this repository at the same time.

The "target branch" is the branch PRs merge into (usually the default branch; check recent merged PRs if unsure).

1. Work on your own branch. Never commit directly to the target branch.
2. If you share a checkout with another agent (for example several sessions on the same machine), create a separate git worktree for your branch.
3. Before editing, check other active threads and open PRs for files they are changing. If a file is already owned by another thread, coordinate instead of editing it.
4. Fetch and rebase onto the latest target branch before pushing, and again right before merging. Re-run tests after each rebase.
5. Land changes only through PRs into the target branch.
6. In shared folders, write to a subfolder named for your thread or task.
