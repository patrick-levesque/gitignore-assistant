# GitIgnore Assistant

A Visual Studio Code extension to easily add, remove, or clean entries in your `.gitignore` file.

## Features

- Add or remove files and folders from the workspace `.gitignore` using the Explorer or Command Palette.
- Clean the `.gitignore` file by removing duplicates, and optionally removing comments and empty lines, and sort entries.
- Ensure configured base entries (e.g. `.DS_Store`) are always present.
- Duplicate detection is case-sensitive but ignores leading/trailing whitespace (e.g. `node_modules`, `/node_modules `, and `/node_modules/` are considered duplicates).
- Automatically create a `.gitignore` if one does not exist, seeded with the configured base entries.
- Follow common Git best practices when adding and cleaning entries (can be disabled in settings):
	- All files and folders are anchored with a leading `/` (e.g. `/package.json`, `/.vscode/`, `/public/build/`), except for single root dotfiles (e.g. `.env`, `.DS_Store`).
	- Folder entries include a trailing slash (e.g. `/node_modules/`). 

## Usage

1. In the Explorer, right-click a file or folder.  
2. Choose **`Add to .gitignore`** to append it to the `.gitignore` file.  
3. Choose **`Remove from .gitignore`** to delete an existing entry.  
4. While editing the workspace `.gitignore` file, **`Clean .gitignore`** is available in the editor context menu.

Commands can also be invoked from the **Command Palette** (`⌘⇧P` / `Ctrl+Shift+P`). When adding/removing from the palette, you'll be prompted to select one or more files or folders.

## Requirements

This extension operates on the `.gitignore` file located at the root of the workspace. It does not manage `.gitignore` files in subfolders or handle global Git ignore files.

## Extension Settings

### Base Entries

Defines the list of entries that should always be present in the workspace `.gitignore`. These entries are automatically ensured whenever files are added, removed, or the **Clean** command is run. You can remove the default `.DS_Store` entry or add your own (e.g. `/node_modules/`, `.env`) to customize the behavior.

### Add With Leading Slash

All entries are added with a leading `/` (e.g. `/README.md`, `/public/build`), except for single root dotfiles (e.g. `.env`, `.DS_Store`). Enabled by default to follow common Git best practices. This setting only affects new entries and will not be applied when cleaning existing entries.

### Trailing Slash For Folders

Folder entries will be added AND cleaned with a trailing slash (e.g. `/node_modules/`). Enabled by default to follow common Git best practices.

### Remove Empty Lines

Control whether the **Clean** command removes all empty lines. Disabled by default to preserve intentional spacing in the `.gitignore`.

### Remove Comments

Control whether the **Clean** command removes all comment lines (lines starting with `#`). Disabled by default to preserve intentional comments in the `.gitignore`.

### Sort When Cleaning

Control whether **Clean** command sorts entries alphabetically. Disabled by default to preserve the existing order of entries.

### Show Notifications

When enabled, the extension will show notifications when files or folders are added or removed from `.gitignore`, show a summary of the **Clean** command, as well as warnings if an operation cannot be completed. When disabled, extension logs can still be found in the Output Panel under **GitIgnore Assistant**.
