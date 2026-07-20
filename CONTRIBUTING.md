# Contributing to Session Manager

Thanks for your interest in contributing! Session Manager is a small project, so the process is deliberately lightweight.

## How contributions work

- **Found a bug?** [Open a bug report](https://github.com/ryj-dev/session-manager/issues/new?template=bug_report.md). Include your macOS version, app version, and steps to reproduce.
- **Want a feature?** [Open a feature request](https://github.com/ryj-dev/session-manager/issues/new?template=feature_request.md) first, before writing code. This avoids you spending time on something that might not fit the project's direction.
- **Have a fix or feature ready?** Fork the repo, create a branch, and open a pull request against `main`.

For anything beyond a small fix (typos, obvious one-liners), please open an issue first so we can discuss the approach.

## Development setup

Requirements:

- macOS (the app currently targets macOS; arm64 is the primary platform)
- Node.js 20+
- [Claude Code](https://claude.com/claude-code) installed, since the app manages Claude Code sessions

```sh
git clone https://github.com/<your-username>/session-manager.git
cd session-manager
npm install
npm run dev        # launches the app with hot reload via electron-vite
```

Other useful commands:

```sh
npm test           # run unit tests (node --test over src/main/*.test.ts)
npm run build      # type-check and build all processes
npm run dist:mac   # produce a distributable .dmg in release/
```

## Project layout

```
src/main/       Electron main process — PTY/session management, hook server,
                MCP server, pipeline orchestration, persistence
src/preload/    Context-bridge API between main and renderer
src/renderer/   React UI — graph view, terminals, canvas, settings
docs/wiki/      Bundled feature wiki (shipped read-only in the app)
resources/      Static assets bundled into the app
scripts/        Build and release helpers
```

## Pull request guidelines

- **Keep PRs focused.** One fix or feature per PR is much easier to review than a grab-bag.
- **Match the existing style.** The codebase is TypeScript throughout; follow the conventions of the file you're editing rather than introducing new patterns.
- **Add or update tests** when you change logic in `src/main/` that has existing test coverage (`*.test.ts` files). UI changes don't currently have automated tests — describe how you verified them manually in the PR.
- **Run before pushing:** `npm test` and `npm run build` should both pass.
- **Describe the "why".** In the PR description, explain what problem this solves and how you tested it. Screenshots or short recordings are very welcome for UI changes.
- **Update the wiki if behavior changes.** If your change alters how a feature works, update the matching article in `docs/wiki/` — it ships inside the app as the authoritative feature docs.

## Reviews and releases

PRs are reviewed as time permits — this is a spare-time project, so please be patient. Merged changes ship in the next tagged release (versioned `v0.x.y`, distributed via GitHub Releases and Homebrew).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) that covers the project.
