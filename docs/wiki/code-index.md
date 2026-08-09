---
slug: code-index
title: Code Index (Experimental)
summary: Cross-project code search — symbols, keywords, and semantic embeddings over every repo the app knows, exposed to sessions as search-code / find-symbol / find-usages / code-index-status with project and fleet scopes.
related: [mcp-server-overview, memory-knowledge-base, observer-agent, hotkeys-settings]
---

# Code Index (Experimental)

## What it is

A persistent search index over the **code** of every repository the app knows about — not just one project. It reuses the memory knowledge base's retrieval stack (bge-small embeddings, sqlite-vec, reciprocal-rank fusion) against a second corpus: source files, segmented at symbol boundaries by tree-sitter. Sessions query it through four MCP tools instead of cold-crawling a codebase with grep, and can widen a search past their own repo — the axis no per-repo code indexer offers.

Experimental and **off by default**: enable it in Settings → "Code index (experimental)". No restart needed; indexing starts on save.

## What gets indexed

Repos are discovered from two sources: top-level git repos in the base projects directory, and the working directory of every live session (pipeline worktrees are normalised to their main repo — a worktree never appears as its own repo). Three layers per file:

| Layer | Built from | Answers |
|-------|-----------|---------|
| Symbols | tree-sitter parse (TS/TSX/JS/Python) — functions, classes, methods, interfaces, types, enums | "where is `resolveToken` defined" |
| Keyword | FTS5 over chunk text, identifier-aware tokenisation | exact names, rare tokens |
| Semantic | symbol-boundary chunks headed with `repo · path · Qualified.name`, embedded via bge-small | "the code that retries with backoff" |

Files are listed via `git ls-files`, so **gitignored files are never indexed** (`.env` is out by construction). Vendored/generated paths (node_modules, dist, lockfiles, minified bundles), binaries, and oversize files are skipped; other languages index as plain text chunks (searchable, no symbols). Snippets additionally pass the observer's secret redactor on the way out, so a committed key in an old repo is not surfaced into another project's session.

**Two-phase indexing:** symbols + keywords land within seconds of enabling; semantic embeddings backfill in the background on the observer's quiet-time job (only while all sessions are idle). Until backfill completes, searches run on the first two layers — `code-index-status` shows per-repo embedding %.

## The tools

| Tool | Purpose |
|------|---------|
| `search-code` | Hybrid ranked search: query by identifier, phrase, or concept; optional `kind` and `path` filters |
| `find-symbol` | Definitions by exact or fuzzy name — signature, kind, `path:line` |
| `find-usages` | References to an identifier (honest label: text-match, not AST resolution; definition lines marked) |
| `code-index-status` | Per-repo coverage, backfill %, truncation flags, whether indexing is running |

**Scopes:** every query tool takes `scope`. `project` (default) = the calling session's repo, resolved from its cwd through git (worktrees resolve to their main repo). `fleet` = every indexed repo — the "have I written this before?" scope; cross-repo hits carry a `⇠ different repo` marker. Scope is enforced in the main process, not trusted from the caller.

## Gotchas

- **"No results" has two meanings.** Always check `code-index-status` before concluding code doesn't exist — the repo may still be indexing, embeddings may not be backfilled, or the caller's cwd may not be inside any indexed repo (then `project` scope is empty and only `fleet` returns anything).
- **Truncation is announced, never silent.** A repo over the file cap indexes its newest files only and reports `TRUNCATED` in status; oversize-file skip counts are also reported.
- `find-usages` is text-match: same-named identifiers from different scopes are not distinguished.
- Non-git directories are not indexed at all in v1.
- Repos listed in the `excludedRepos` setting are invisible at every scope, including fleet — the per-repo privacy control.
- The whole index lives in `code-index.db` (size, chunk counts, and deletion in the Cleanup panel). Deleting it is safe; it rebuilds while the feature is enabled.

## How it relates to other features

The index is owned by the main process; MCP sessions reach it over the same embed socket as memory search, so one loaded model serves any number of sessions. The embedding backfill runs as an observer quiet-time job (debt-based, idle-gated). Cleanup panel and Settings hold the human controls. Future phases (not yet built): a `related` scope, a code search panel with spawn-at-result, memory-note ↔ code links, and stale-note detection when a referenced symbol disappears.
