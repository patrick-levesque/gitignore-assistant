# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

GitIgnore Assistant is a VSCode extension that helps users manage their workspace `.gitignore` files. It provides commands to add/remove entries and clean the `.gitignore` file by removing duplicates, sorting, and applying formatting rules. The extension only operates on root-level `.gitignore` files in workspace folders, not nested ones.

## Development Commands

```bash
# Install dependencies
npm install

# Compile TypeScript to out/ directory
npm run compile

# Watch mode for development (recompiles on file changes)
npm run watch

# Run linter
npm run lint

# Run all tests
npm test

# Run tests in watch mode (useful during development)
npm run watch & npm test
```

## Architecture

### Single-File Design
The entire extension logic is in [src/extension.ts](src/extension.ts). There are no separate modules or utilities - all functions are in one file (~980 lines). This is intentional for this small extension.

### Core Concepts

**GitignoreState**: A mutable state object (`{ uri, lines, dirty }`) that tracks the `.gitignore` file content and whether changes need to be written. The `dirty` flag indicates pending modifications.

**Operations Pattern**: Add and remove operations use a common `GitignoreOperation` function signature that takes state, target URI, workspace, and base entries, returning an `OperationResult`. This allows batch processing of multiple files across workspaces.

**Entry Normalization**: The extension enforces Git best practices:
- Files and folders are anchored with leading `/` (e.g., `/node_modules/`), except single root dotfiles (e.g., `.env`, `.DS_Store`)
- Folders can optionally end with trailing `/` based on `trailingSlashForFolders` setting
- **Symbolic links are treated as files** (no trailing slash), matching Git's behavior - see `isRealDirectory()` helper ([extension.ts:647-652](src/extension.ts#L647-L652))
- Duplicate detection is case-sensitive and ignores leading/trailing whitespace

**Base Entries**: Configurable entries (default: `.DS_Store`) that are automatically enforced in every `.gitignore`. They're added at the beginning of the file and cannot be removed by users unless the base entries setting is cleared.

### Command Flow

1. **Add/Remove Commands** ([extension.ts:36-106](src/extension.ts#L36-L106)):
   - Accept URIs from Explorer context menu or Command Palette
   - Group targets by workspace folder
   - Load or create `.gitignore` for each workspace
   - Execute operation on each target
   - Enforce base entries and cleanup blank lines
   - Write changes if state is dirty

2. **Clean Command** ([extension.ts:108-191](src/extension.ts#L108-L191)):
   - Only works on workspace root `.gitignore` (not nested files)
   - Removes duplicates (always)
   - Optionally removes empty lines and comments
   - Optionally sorts entries alphabetically
   - Applies folder trailing slash formatting based on settings
   - Enforces base entries

### Duplicate Detection Logic ([extension.ts:218-348](src/extension.ts#L218-L348))

The `cleanGitignoreEntries` function uses a key-based deduplication system:
- **Pattern lines** (with `*`, `?`, `!`, `[`, `]`, or `**`) are preserved as-is and compared literally
- **Regular entries** are normalized to a key by stripping leading/trailing slashes (`stripAnchorsAndSlashes`)
- The extension detects if entries are folders by checking:
  1. If any variant has folder syntax (trailing `/`)
  2. If the file exists on disk as a **real directory** (not a symlink) - uses `isRealDirectory()` to exclude symlinks
- If a file exists and is a symlink, trailing slash is removed regardless of original syntax
- If a file doesn't exist on disk, the original user syntax is preserved
- Duplicates keep the first occurrence with its original anchoring/slashing

### Context Awareness

The extension uses VSCode's `setContext` to conditionally show the "Clean .gitignore" command only when editing the workspace root `.gitignore` file. This is tracked by monitoring active editor changes ([extension.ts:57-63](src/extension.ts#L57-L63), [extension.ts:350-368](src/extension.ts#L350-L368)).

## Testing

Tests are in [src/test/extension.test.ts](src/test/extension.test.ts) and use VSCode's testing framework with Mocha. Tests create a temporary workspace folder and exercise commands through `vscode.commands.executeCommand`.

**Key test utilities**:
- `createFile()`: Creates test files/folders in the workspace
- `readGitignore()`: Reads `.gitignore` content for assertions
- `addWorkspaceFolder()`: Dynamically adds workspace folders during test execution

Tests cover:
- Add/remove operations with duplicate detection
- Clean command with various setting combinations
- Configuration options (leading slash, trailing slash, sorting, base entries)
- Root-level anchoring rules for dotfiles vs regular files
- Pattern preservation (wildcards, negations)
- Symbolic link handling (add command and clean command treat symlinks as files)

## Configuration

The extension has 7 settings under `gitignoreAssistant.*`:
- `baseEntries`: Array of entries always present (default: `[".DS_Store"]`)
- `addWithLeadingSlash`: Anchor entries with `/` except root dotfiles (default: `true`)
- `trailingSlashForFolders`: Add trailing `/` to folder entries (default: `true`)
- `removeEmptyLines`: Clean command removes empty lines (default: `false`)
- `removeComments`: Clean command removes comments (default: `false`)
- `sortWhenCleaning`: Clean command sorts alphabetically (default: `false`)
- `showNotifications`: Display info/warning notifications (default: `true`)

## Important Implementation Details

1. **File System Operations**: Uses `vscode.workspace.fs` API, not Node.js `fs`. This works with remote workspaces and virtual file systems.

2. **Line Parsing**: Uses `\n` as line separator after normalizing `\r\n`. Serialization always adds a trailing newline ([extension.ts:810-827](src/extension.ts#L810-L827)).

3. **Cleanup Logic**: The `cleanupLines` function ([extension.ts:829-848](src/extension.ts#L829-L848)) collapses consecutive empty lines and trims trailing empty lines, preventing blank line accumulation.

4. **Error Handling**: Uses `isFileNotFound` helper to detect missing files. The extension gracefully creates `.gitignore` if it doesn't exist when adding entries.

5. **Workspace Context**: The extension handles multi-root workspaces by processing operations per workspace folder. Items outside any workspace are skipped with warnings.

## Extension Manifest

The extension activates `onStartupFinished` to register context state tracking for the active editor. This is not a typical activation event but is used to enable conditional context menu items immediately.

Commands are accessible via:
- Explorer context menu (right-click on files/folders)
- Editor context menu (when editing root `.gitignore`)
- Command Palette (`GitIgnore Assistant: ...`)
