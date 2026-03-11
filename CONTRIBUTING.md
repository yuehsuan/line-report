# Contributing Guide

This file is a reusable template for commit naming, release tags, and release notes.

It is intentionally generic so it can be copied into other repositories with minimal changes.

## Goals

- keep git history easy to scan
- make release naming predictable
- reduce ambiguous commit and release messages

## Commit Message Format

Use this format for normal commits:

```text
<type>: <Chinese summary>
```

Example:

```text
fix: 修正通知分流與重試機制
```

## Allowed Commit Types

Use these prefixes by default:

- `fix`: bug fix, incorrect behavior, risk reduction
- `feat`: new feature, new capability, new workflow
- `docs`: documentation, README, runbook, comments
- `test`: test additions or test refactors
- `refactor`: code cleanup without intended behavior change
- `chore`: version bumps, dependency updates, maintenance work
- `ci`: CI/CD workflow or automation changes

## Commit Summary Rules

The summary should:

- be written in Chinese
- describe the result, not the editing process
- focus on one main change
- stay specific and readable
- avoid release version numbers unless the commit is explicitly a version bump

Good examples:

- `fix: 修正通知分流與重試機制`
- `feat: 新增背景工作健康檢查`
- `docs: 更新部署與回滾說明`
- `ci: 調整映像建置與部署流程`
- `chore: 更新版本號至 2.6.0`

Bad examples:

- `update`
- `misc`
- `final`
- `修改一些東西`
- `完整化readme`

## Release Tag Format

Use semantic versioning for formal releases:

```text
v<major>.<minor>.<patch>
```

Examples:

- `v1.0.0`
- `v1.2.0`
- `v1.2.3`

### Versioning Guidance

- `major`: incompatible change or clearly defined major release
- `minor`: new feature or meaningful workflow improvement without breaking compatibility
- `patch`: bug fix, wording fix, or small operational improvement

Do not use date-based strings as formal release tags.

Avoid:

- `v20260310-9`
- `release-2026-03-10`

If CI needs temporary build tags, use a separate non-release format such as:

- `ci-YYYYMMDD-run_number`
- `sha-<short_commit>`

Formal releases should stay `vX.Y.Z`.

## Release Title Format

If creating a GitHub Release or similar release record, use:

```text
<tag> - <Chinese release title>
```

Examples:

- `v1.2.0 - 新增健康檢查與通知分流`
- `v1.2.1 - 修正重送與部署細節`
- `v2.0.0 - 調整執行架構與版本策略`

## Release Notes Structure

Keep release notes short and predictable.

Recommended sections:

- `重點`
- `修正`
- `部署/維運`
- `注意事項`

Example:

```text
重點
- 完成主要功能調整
- 優化監控與通知流程

修正
- 修正重試與錯誤處理
- 修正文案與操作說明

部署/維運
- 調整 CI/CD 行為與版本規則
- 更新回滾與部署文件

注意事項
- 仍有少數既有告警或資料前置條件需要持續觀察
```

## Practical Defaults

When unsure, follow these defaults:

- use Chinese summaries for commits
- use semantic version tags for releases
- keep CI build tags separate from formal release tags
- keep commit titles specific
- keep release notes focused on user-visible and operationally relevant changes

## Minimal Rules

- Do not use vague commit titles like `update`, `misc`, or `final`.
- Do not use non-semantic version strings for formal releases.
- Do not combine unrelated changes into one commit if they can be split clearly.
