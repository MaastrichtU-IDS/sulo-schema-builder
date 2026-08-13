# Pending workflows

These two workflows are finished and validated, but they are **parked here
rather than in `.github/workflows/`** because the automation account that
committed them cannot write to that path:

```
! [remote rejected] refusing to allow an OAuth App to create or update
  workflow `.github/workflows/ci.yml` without `workflow` scope
```

GitHub rejects an entire push whose diff touches `.github/workflows/`, so
committing them to the real location would have made this branch unpushable
for any further work — not just for these files.

## Activating them

```bash
git mv .github/workflows-pending/ci.yml       .github/workflows/ci.yml
git mv .github/workflows-pending/release.yml  .github/workflows/release.yml
git rm  .github/workflows-pending/README.md
git commit -m "Activate CI and release workflows"
git push
```

That push has to come from a token with the `workflow` scope — a normal
`git push` from a maintainer's machine is enough.

## What they do

| File | Trigger | Purpose |
|---|---|---|
| `ci.yml` | every push / PR | typecheck + tests for `api` and `frontend`, plus a frontend build. Ubuntu only, no Rust or Tauri, so it stays fast. |
| `release.yml` | `v*` tags, `workflow_dispatch` | Builds desktop bundles for macOS (Apple Silicon), Linux x64 and Windows x64. A tag run creates a **draft** release; a manual run only uploads workflow artifacts and cannot publish. |

Neither has ever run on a real runner. Both parse as valid YAML and the exact
sequence `ci.yml` executes passes locally, but the first `workflow_dispatch` of
`release.yml` is the real test of the matrix, the Linux dependency list and the
sidecar naming.
