# GitIgnore Assistant

A Visual Studio Code extension to easily add, remove, or clean entries in your `.gitignore` file.

## Features

- Add or remove files and folders from the workspace `.gitignore` directly from the Explorer or Command Palette.
- Automatically creates a `.gitignore` if one does not exist, seeding it with `.DS_Store`.
- Detects existing entries to prevent duplicates.
- One-click cleanup with **`Clean .gitignore`** removes duplicates, strips empty lines, and optionally sorts entries alphabetically.
- Works seamlessly with any Git project.

## Usage

1. In the Explorer, right-click a file or folder.  
2. Choose **`Add to .gitignore`** to append it to the root `.gitignore` file.  
3. Choose **`Remove from .gitignore`** to delete an existing entry.  
4. Choose **`Clean .gitignore`** to tidy the file — remove duplicates and empty lines, and optionally sort entries.

Commands can also be invoked from the **Command Palette** (`⌘⇧P` / `Ctrl+Shift+P`). When run from the palette, you'll be prompted to select one or more files or folders.

## Requirements

This extension operates on the `.gitignore` file located at the root of the workspace. It does not manage `.gitignore` files in subfolders or handle global Git ignore files.

## Extension Settings

### Show Notifications

When enabled, the extension will show notifications when files or folders are added or removed from `.gitignore`, as well as warnings if an operation cannot be completed.

### Sort When Cleaning

Controls whether **`Clean .gitignore`** sorts entries alphabetically (`true` by default). Set to `false` to keep the existing order while still removing duplicates and empty lines.

## Notes

- `.DS_Store` is always ensured to be present in newly created `.gitignore` files to help keep macOS metadata out of version control.
