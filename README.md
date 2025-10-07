# GitIgnore Assistant

A Visual Studio Code extension for quickly adding or removing files and folders from .gitignore.

## Features

- **Explorer integration:** right-click any file or folder in the Explorer to add or remove it from the workspace `.gitignore`.
- **Automatic bootstrapping:** if a workspace is missing a `.gitignore`, the extension creates one on demand and seeds it with `.DS_Store`.
- **Duplicate protection:** existing ignore entries are detected so they won't be added twice.

## Usage

1. In the Explorer, right-click a file or folder.
2. Choose **Add to .gitignore** to append it to the root `.gitignore` file.
3. Choose **Remove from .gitignore** to delete an existing entry.

You can also invoke the commands from the Command Palette (`⌘⇧P` / `Ctrl+Shift+P`). When run from the palette, you'll be prompted to select one or more files or folders.

## Extension Settings

This extension provides the following configurable settings:

#### Show Notifications

When enabled, the extension will show notifications when files or folders are added to or removed from `.gitignore`, as well as warnings if an operation cannot be completed.

## Notes

- The commands operate on the `.gitignore` at the root of the workspace folder.
- `.DS_Store` is always ensured to be present in newly created `.gitignore` files to help keep macOS metadata out of version control.
