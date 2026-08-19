# Agent Note: Normalize release manifest paths across platforms

Status: implemented

English | [中文](2026-08-19-release-bump-path-normalization.zh.md)

## Problem

The release bump planner passed manifest paths produced with `path.join()` to comparisons and Git pathspecs. On Windows those paths contain backslashes, while release-family discovery and repository-relative paths use `/`. A path-format mismatch could make the planner miss a publishable manifest or pass a platform-specific path to `git add`.

## Decision

Release bump plans represent every repository-relative manifest path with `/`, independent of the host platform. Filesystem reads still pass those paths through `path.join()` at the I/O point. The planner uses the normalized form for both dsh and vendored manifests, so comparison and Git operations consume one representation.

## Alternatives considered

- Keep native separators throughout: rejected because repository-relative paths are also compared with glob and Git pathspec values, which use `/`.
- Normalize only immediately before `git add`: rejected because comparisons can already diverge before the Git operation.
- Store absolute paths in the plan: rejected because release plans and logs need stable repository-relative paths, and absolute paths are not valid portable Git pathspecs.

## Consequences

Release bump planning is deterministic across POSIX and Windows hosts. The filesystem write path remains native at the final I/O call, while log labels, comparisons, and Git arguments remain repository-relative.

## Testing

The release-family suite verifies that a Windows-style package directory becomes a slash-normalized `package.json` path. Existing release-family and payload tests continue to cover the surrounding planning behavior.
