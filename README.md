# GitIgnore Assistant

A Visual Studio Code extension to easily add, remove, or clean entries in your `.gitignore` file.

## Features

- Add or remove files and folders from the workspace `.gitignore` using the Explorer or Command Palette.
- Clean the `.gitignore` file by removing duplicates, empty lines, and optionally sorting entries.
- Ensure configured base entries are always present.
- Automatically create a `.gitignore` if one does not exist, seeded with the configured base entries (defaults to `.DS_Store`).
- Detect existing entries to prevent duplicates.

## Usage

1. In the Explorer, right-click a file or folder.  
2. Choose **`Add to .gitignore`** to append it to the `.gitignore` file.  
3. Choose **`Remove from .gitignore`** to delete an existing entry.  
4. Choose **`Clean .gitignore`** to remove duplicates, empty lines, and optionally sort entries.  
5. While editing the `.gitignore` file, **`Clean .gitignore`** is also available in the editor context menu.

Commands can also be invoked from the **Command Palette** (`⌘⇧P` / `Ctrl+Shift+P`). When run from the palette, you'll be prompted to select one or more files or folders.

## Requirements

This extension operates on the `.gitignore` file located at the root of the workspace. It does not manage `.gitignore` files in subfolders or handle global Git ignore files.

## Extension Settings

### Base Entries

Defines the list of entries that should always appear at the top of the workspace `.gitignore`. These entries are automatically ensured whenever files are added, removed, or the **Clean** command is run. You can remove the default `.DS_Store` entry or add your own (e.g. `node_modules/`, `.env`) to customize the behavior. Set this array to empty to disable base entries entirely.

### Show Notifications

When enabled, the extension will show notifications when files or folders are added or removed from `.gitignore`, show a summary of the **Clean** command, as well as warnings if an operation cannot be completed. When disabled, extension logs can still be found in the Output Panel under **GitIgnore Assistant**.

### Sort When Cleaning

Controls whether **Clean** command sorts entries alphabetically (`true` by default). Set to `false` to keep the existing order while still removing duplicates and empty lines.
