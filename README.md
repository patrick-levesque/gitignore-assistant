# GitIgnore Assistant

GitIgnore Assistant keeps your project's `.gitignore` tidy without leaving Visual Studio Code.

## Features

- **Explorer integration:** right-click any file or folder in the Explorer to add or remove it from the workspace `.gitignore`.
- **Automatic bootstrapping:** if a workspace is missing a `.gitignore`, the extension creates one on demand and seeds it with `.DS_Store`.
- **Duplicate protection:** existing ignore entries are detected so they won't be added twice.

## Commands

| Command | Description |
| --- | --- |
| `GitIgnore Assistant: Add to .gitignore` | Add the selected files or folders to the workspace `.gitignore`. Available from the Explorer context menu and the Command Palette. |
| `GitIgnore Assistant: Remove from .gitignore` | Remove the selected files or folders from the workspace `.gitignore`. |

## Usage

1. In the Explorer, right-click a file or folder.
2. Choose **Add to .gitignore** to append it to the root `.gitignore` file.
3. Choose **Remove from .gitignore** to delete an existing entry.

You can also invoke the commands from the Command Palette (`⌘⇧P` / `Ctrl+Shift+P`). When run from the palette, you'll be prompted to select one or more files or folders.

## Notes

- The commands operate on the `.gitignore` at the root of each selected workspace folder.
- `.DS_Store` is always ensured to be present in newly created `.gitignore` files to help keep macOS metadata out of version control.
- Explorer decorations and the Source Control view are refreshed automatically after `.gitignore` changes so newly ignored items are visible immediately.
- Set `gitignoreAssistant.showNotifications` to `false` if you prefer to disable pop-up notifications when `.gitignore` is updated.
