### 1.1.2 - 2026-02-27
- Add symlink ancestor detection: adding a path inside a symlink folder now adds the symlink itself instead of the nested path

### 1.1.1 - 2025-11-12
- Fix symbolic link handling to treat symlinks as files instead of directories
- Update clean command to remove trailing slashes from symbolic link entries
- Update README and settings description

### 1.1.0 - 2025-10-14
- Implement Git best-practice formatting
- Add settings to control leading and trailing slashes for files and folder entries
- Add settings to remove empty lines and comments when cleaning `.gitignore`
- Update default settings to preserve existing formatting
- Update README

### 1.0.5 - 2025-10-08
- Ensure base entries are present before sorting when cleaning `.gitignore`

### 1.0.4 - 2025-10-08
- Remove unnecessary refresh of Explorer and Source Control views after `.gitignore` updates

### 1.0.3 - 2025-10-07
- Activate extension on `onStartupFinished` event
- Use `createOutputChannel` to log messages in a dedicated output channel
- Update README

### 1.0.2 - 2025-10-07
- Add clean command to remove duplicates and empty lines, with optional alphabetical sorting
- Add setting to enable or disable sorting for the clean command
- Add setting to define base `.gitignore` entries that are always enforced by the extension
- Update extension icon for light theme
- Update README

### 1.0.1 - 2025-10-07
- Move menu items into their own group
- Update README

### 1.0.0 - 2025-10-06
- Initial release
- Add Explorer context menu actions to add or remove files and folders from `.gitignore`
- Automatically create `.gitignore` files when missing, with a default `.DS_Store` entry
- Prevent duplicate entries and remove empty lines
- Automatically refreshes Explorer and Source Control views after `.gitignore` updates
- Add setting to enable or disable notifications