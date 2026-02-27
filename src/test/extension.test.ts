import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

suite('GitIgnore Assistant Extension', () => {
	let tempDir: string;
	let workspaceFolder: vscode.WorkspaceFolder | undefined;

	suiteSetup(async function () {
		this.timeout(20000);
		tempDir = path.join(os.tmpdir(), 'gitignore-assistant-test-workspace');
		await fs.mkdir(tempDir, { recursive: true });
		await clearDirectory(tempDir);
		await resetWorkspaceFolders();
		const folderUri = vscode.Uri.file(tempDir);
		workspaceFolder = await addWorkspaceFolder(folderUri, 'GitIgnore Assistant Test Workspace');
	});

	suiteTeardown(async function () {
		this.timeout(10000);
		if (workspaceFolder) {
			const folders = vscode.workspace.workspaceFolders ?? [];
			const index = folders.findIndex((folder) => folder.uri.fsPath === workspaceFolder?.uri.fsPath);
			if (index >= 0) {
				vscode.workspace.updateWorkspaceFolders(index, 1);
			}
		}
		await clearDirectory(tempDir);
	});

	setup(async function () {
		this.timeout(5000);
		const folder = ensureWorkspace();
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		try {
			await vscode.workspace.fs.delete(gitignoreUri);
		} catch {
			// Ignore if the file does not exist yet.
		}
	});

	test('Add command creates .gitignore with entry and base rule', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const fileUri = await createFile(folder, 'src/add-example.ts');
		await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', fileUri);

		const content = await readGitignore(folder);
		assert.ok(content.includes('.DS_Store'), '.gitignore should contain .DS_Store');
		assert.ok(
			content.includes('/src/add-example.ts'),
			'.gitignore should contain an anchored path for the added file'
		);
		const lines = content.trim().split('\n');
		const blankLines = lines.filter((line) => line.trim() === '').length;
		assert.strictEqual(blankLines, 0, 'Entries should not be surrounded by blank lines.');
	});

	test('Remove command deletes entry but keeps base rule', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const directoryUri = vscode.Uri.joinPath(folder.uri, 'assets');
		const ignoredFolder = vscode.Uri.joinPath(directoryUri, 'ignored');
		await vscode.workspace.fs.createDirectory(ignoredFolder);

		await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', ignoredFolder);
		let content = await readGitignore(folder);
		assert.ok(
			content.includes('/assets/ignored/'),
			'.gitignore should contain the anchored folder entry before removal'
		);

		await vscode.commands.executeCommand('gitignore-assistant.removeFromGitignore', ignoredFolder);
		content = await readGitignore(folder);
		assert.ok(content.includes('.DS_Store'), '.gitignore should still contain .DS_Store');
		assert.ok(!content.includes('/assets/ignored/'), '.gitignore should not contain the removed folder entry');
		const linesAfterRemoval = content.trim().split('\n');
		const blankLinesAfterRemoval = linesAfterRemoval.filter((line) => line.trim() === '').length;
		assert.strictEqual(
			blankLinesAfterRemoval,
			0,
			'.gitignore should not contain blank lines after removing entries'
		);
	});

	test('Add command ignores duplicate entries', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const duplicateFile = await createFile(folder, 'logs/app.log');

		await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', duplicateFile);
		await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', duplicateFile);

	    const content = await readGitignore(folder);
	    const occurrences = content
		    .split('\n')
		    .filter((line) => line.trim() === '/logs/app.log').length;
		assert.strictEqual(occurrences, 1, 'Duplicate entries should not be added to .gitignore');
	});

		test('Add command respects addWithLeadingSlash setting', async function () {
			this.timeout(10000);
			const folder = ensureWorkspace();
			const configuration = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
			const previous = configuration.get<boolean>('addWithLeadingSlash');
			await configuration.update('addWithLeadingSlash', false, vscode.ConfigurationTarget.WorkspaceFolder);

			try {
				const fileUri = await createFile(folder, 'src/unanchored.ts');
				await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', fileUri);

				const content = await readGitignore(folder);
				const lines = content.trim().split('\n');
				assert.ok(lines.includes('src/unanchored.ts'), 'Entry should not be anchored when setting is disabled');
				assert.ok(!lines.includes('/src/unanchored.ts'), 'Anchored variant should be omitted when setting is disabled');
			} finally {
				await configuration.update('addWithLeadingSlash', previous, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		});

	test('Clean command removes duplicates, empty lines, and sorts entries', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		const initialContent = ['# comment', '', 'node_modules/', 'dist/', 'node_modules/', 'build/', '', 'build/'].join('\n');
		await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(`${initialContent}\n`));

		const configuration = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
		const prevRemoveEmpty = configuration.get<boolean>('removeEmptyLines');
		const prevRemoveComments = configuration.get<boolean>('removeComments');
		const prevSort = configuration.get<boolean>('sortWhenCleaning');

		await configuration.update('removeEmptyLines', true, vscode.ConfigurationTarget.WorkspaceFolder);
		await configuration.update('removeComments', true, vscode.ConfigurationTarget.WorkspaceFolder);
		await configuration.update('sortWhenCleaning', true, vscode.ConfigurationTarget.WorkspaceFolder);

		try {
			await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore');
			const cleaned = await readGitignore(folder);
			const lines = cleaned.trim().split('\n');
			assert.deepStrictEqual(
				lines,
				['.DS_Store', 'build/', 'dist/', 'node_modules/'],
				'Clean command should remove duplicates, empty lines, comments, and sort entries alphabetically when enabled'
			);
		} finally {
			await configuration.update('removeEmptyLines', prevRemoveEmpty, vscode.ConfigurationTarget.WorkspaceFolder);
			await configuration.update('removeComments', prevRemoveComments, vscode.ConfigurationTarget.WorkspaceFolder);
			await configuration.update('sortWhenCleaning', prevSort, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

		test('Clean command preserves comments and empty lines by default', async function () {
			this.timeout(10000);
			const folder = ensureWorkspace();
			const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
			const initial = ['# keep me', '', 'dist/', '', 'dist/', 'logs/app.log', 'logs/app.log'].join('\n');
			await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(`${initial}\n`));

			const configuration = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
			const prevSort = configuration.get<boolean>('sortWhenCleaning');
			await configuration.update('sortWhenCleaning', false, vscode.ConfigurationTarget.WorkspaceFolder);

			try {
				await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore');

				const cleaned = await readGitignore(folder);
				const lines = cleaned.trim().split('\n');
				assert.deepStrictEqual(
					lines,
					['.DS_Store', '# keep me', '', 'dist/', '', 'logs/app.log'],
					'Clean command should keep comments and empty lines when removal settings are disabled'
				);
			} finally {
				await configuration.update('sortWhenCleaning', prevSort, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		});

	test('Clean command respects sorting setting', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		const initialContent = ['node_modules/', 'dist/', 'build/', 'dist/'].join('\n');
		await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(`${initialContent}\n`));

		const configuration = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
		const previousValue = configuration.get<boolean>('sortWhenCleaning');
		await configuration.update('sortWhenCleaning', false, vscode.ConfigurationTarget.WorkspaceFolder);

		try {
			await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore');
			const cleaned = await readGitignore(folder);
			const lines = cleaned.trim().split('\n');
			assert.deepStrictEqual(
				lines,
				['.DS_Store', 'node_modules/', 'dist/', 'build/'],
				'Clean command should preserve original order when sorting is disabled'
			);
		} finally {
			await configuration.update('sortWhenCleaning', previousValue, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

		test('Trailing slash for folders setting is respected', async function () {
			this.timeout(10000);
			const folder = ensureWorkspace();
			const config = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
			const prev = config.get<boolean>('trailingSlashForFolders');
			await config.update('trailingSlashForFolders', false, vscode.ConfigurationTarget.WorkspaceFolder);
			try {
				const dir = vscode.Uri.joinPath(folder.uri, 'build');
				await vscode.workspace.fs.createDirectory(dir);
				await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', dir);
						const content = await readGitignore(folder);
						const lines = content.trim().split('\n');
						assert.ok(
							lines.includes('/build'),
							'Folder entry at root should be anchored and should not have a trailing slash when disabled'
						);
			} finally {
				await config.update('trailingSlashForFolders', prev, vscode.ConfigurationTarget.WorkspaceFolder);
			}
		});

		test('Root anchoring rules are applied', async function () {
			this.timeout(10000);
			const folder = ensureWorkspace();
			// Root dotfile should NOT be anchored
			const envFile = vscode.Uri.joinPath(folder.uri, '.env');
			await vscode.workspace.fs.writeFile(envFile, textEncoder.encode(''));
			await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', envFile);

			// Root folder and dotfolder should be anchored
			const vscodeDir = vscode.Uri.joinPath(folder.uri, '.vscode');
			await vscode.workspace.fs.createDirectory(vscodeDir);
			await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', vscodeDir);

			// Root regular file should be anchored
			const pkgFile = vscode.Uri.joinPath(folder.uri, 'package.json');
			await vscode.workspace.fs.writeFile(pkgFile, textEncoder.encode('{}'));
			await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', pkgFile);

			const content = await readGitignore(folder);
			const lines = content.trim().split('\n');
			assert.ok(lines.includes('.env'), 'Root dotfile should not be prefixed with /');
			assert.ok(lines.includes('/.vscode/'), 'Root dotfolder should be prefixed with / and end with /');
			assert.ok(lines.includes('/package.json'), 'Root file should be prefixed with /');
		});

		test('Patterns are preserved during clean', async function () {
			this.timeout(10000);
			const folder = ensureWorkspace();
			const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
			const initial = ['*.log', '!important.log', '**/cache/*', 'dist/'].join('\n');
			await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(`${initial}\n`));
			await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore');
			const cleaned = await readGitignore(folder);
			const lines = cleaned.trim().split('\n');
			assert.ok(lines.includes('*.log'), 'Glob pattern should be preserved');
			assert.ok(lines.includes('!important.log'), 'Negation pattern should be preserved');
			assert.ok(lines.includes('**/cache/*'), 'Double-star pattern should be preserved');
		});

				test('Auth.json anchored and unanchored are de-duplicated without adding leading / to files when cleaning', async function () {
				this.timeout(10000);
				const folder = ensureWorkspace();
				const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
				const initial = ['auth.json', '/auth.json'].join('\n');
				await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(`${initial}\n`));
				await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore');
				const cleaned = await readGitignore(folder);
				const lines = cleaned.trim().split('\n');
					assert.ok(lines.includes('auth.json'), 'Canonical file should not be anchored when cleaning');
					const occurrences = lines.filter((l) => l === 'auth.json').length;
				assert.strictEqual(occurrences, 1, 'Should keep a single canonical file entry');
			});

			test('Trailing slash duplicates are not counted when disabled', async function () {
				this.timeout(10000);
				const folder = ensureWorkspace();
				const config = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
				const prev = config.get<boolean>('trailingSlashForFolders');
				await config.update('trailingSlashForFolders', false, vscode.ConfigurationTarget.WorkspaceFolder);
				try {
					const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
					const initial = ['/node_modules', '/node_modules/'].join('\n');
					await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(`${initial}\n`));
					await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore');
					const cleaned = await readGitignore(folder);
					const lines = cleaned.trim().split('\n');
					assert.ok(lines.includes('/node_modules'), 'Canonical folder should not include trailing slash when disabled');
					const occurrences = lines.filter((l) => l === '/node_modules').length;
					assert.strictEqual(occurrences, 1, 'Should keep a single canonical folder entry');
				} finally {
					await config.update('trailingSlashForFolders', prev, vscode.ConfigurationTarget.WorkspaceFolder);
				}
			});

	test('Clean command runs on root .gitignore when invoked with resource', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode('dist/\n\nnode_modules/\n'));

		const configuration = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
		const prevSort = configuration.get<boolean>('sortWhenCleaning');
		await configuration.update('sortWhenCleaning', false, vscode.ConfigurationTarget.WorkspaceFolder);

		try {
			await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore', gitignoreUri);

			const cleaned = await readGitignore(folder);
			const lines = cleaned.trim().split('\n');
			assert.deepStrictEqual(
				lines,
				['.DS_Store', 'dist/', '', 'node_modules/'],
				'Clean command should process root .gitignore when invoked from the editor context menu'
			);
		} finally {
			await configuration.update('sortWhenCleaning', prevSort, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

	test('Clean command ignores non-root .gitignore resources', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const nestedDir = vscode.Uri.joinPath(folder.uri, 'packages');
		await vscode.workspace.fs.createDirectory(nestedDir);
		const nestedGitignore = vscode.Uri.joinPath(nestedDir, '.gitignore');
		await vscode.workspace.fs.writeFile(nestedGitignore, textEncoder.encode('dist/\n'));

		await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore', nestedGitignore);

		try {
			await readGitignore(folder);
			assert.fail('Root .gitignore should not be created when cleaning a non-root file.');
		} catch (error) {
			assert.ok(error instanceof vscode.FileSystemError, 'Expected FileSystemError when reading missing .gitignore');
			if (error instanceof vscode.FileSystemError) {
				assert.strictEqual(error.code, 'FileNotFound');
			}
		}
	});

	test('Custom base entries configuration is enforced', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const configuration = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
		const inspect = configuration.inspect<string[]>('baseEntries');
		await configuration.update('baseEntries', ['.env', 'dist/'], vscode.ConfigurationTarget.WorkspaceFolder);

		try {
			const fileUri = await createFile(folder, 'src/custom-base.ts');
			await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', fileUri);

			const content = await readGitignore(folder);
			const lines = content.trim().split('\n');
			assert.ok(lines.includes('.env'), '.gitignore should include custom base entries');
			assert.ok(lines.includes('dist/'), '.gitignore should include custom base entries');
			assert.ok(!lines.includes('.DS_Store'), '.gitignore should not include default base entry when overridden');
		} finally {
			await configuration.update('baseEntries', inspect?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

	test('Base entries can be cleared to allow removal', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const configuration = vscode.workspace.getConfiguration('gitignoreAssistant', folder.uri);
		const inspect = configuration.inspect<string[]>('baseEntries');
		await configuration.update('baseEntries', [], vscode.ConfigurationTarget.WorkspaceFolder);

		let dsStoreUri: vscode.Uri | undefined;
		try {
			const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
			await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode('.DS_Store\n'));
			dsStoreUri = await createFile(folder, '.DS_Store');
			await vscode.commands.executeCommand('gitignore-assistant.removeFromGitignore', dsStoreUri);

			const content = await readGitignore(folder);
			assert.ok(!content.includes('.DS_Store'), '.gitignore should not re-add default base entry when cleared');
		} finally {
			if (dsStoreUri) {
				try {
					await vscode.workspace.fs.delete(dsStoreUri, { recursive: false, useTrash: false });
				} catch {
					// ignore cleanup errors
				}
			}
			await configuration.update('baseEntries', inspect?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder);
		}
	});

	test('Symlinks are treated as files without trailing slash', async function () {
		this.timeout(10000);

		// Skip on Windows without symlink permissions
		if (process.platform === 'win32') {
			try {
				const testPath = path.join(tempDir, '.permission-test');
				await fs.symlink('.', testPath, 'junction');
				await fs.unlink(testPath);
			} catch {
				return this.skip();
			}
		}

		const folder = ensureWorkspace();

		// Create a real directory as symlink target
		const targetDir = vscode.Uri.joinPath(folder.uri, 'storage', 'app', 'public');
		await vscode.workspace.fs.createDirectory(targetDir);

		// Create a symlink to the directory (like Laravel's public/storage)
		const publicDir = vscode.Uri.joinPath(folder.uri, 'public');
		await vscode.workspace.fs.createDirectory(publicDir);
		const symlinkPath = path.join(publicDir.fsPath, 'storage');
		const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
		await fs.symlink(targetDir.fsPath, symlinkPath, symlinkType);
		const symlinkUri = vscode.Uri.file(symlinkPath);

		// Add symlink to .gitignore
		await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', symlinkUri);

		// Verify symlink is treated as a file (no trailing slash)
		const content = await readGitignore(folder);
		const lines = content.trim().split('\n');
		assert.ok(
			lines.includes('/public/storage'),
			'Symlink should be added without trailing slash (treated as file)'
		);
		assert.ok(
			!lines.some((line) => line === '/public/storage/'),
			'Symlink should not have trailing slash (not treated as directory)'
		);
	});

	test('Clean command removes trailing slash from symlink entries', async function () {
		this.timeout(10000);

		// Skip on Windows without symlink permissions
		if (process.platform === 'win32') {
			try {
				const testPath = path.join(tempDir, '.permission-test');
				await fs.symlink('.', testPath, 'junction');
				await fs.unlink(testPath);
			} catch {
				return this.skip();
			}
		}

		const folder = ensureWorkspace();

		// Create a real directory as symlink target (different from first test)
		const targetDir = vscode.Uri.joinPath(folder.uri, 'app', 'uploads');
		await vscode.workspace.fs.createDirectory(targetDir);

		// Create a symlink to the directory (different path from first test)
		const publicDir = vscode.Uri.joinPath(folder.uri, 'public');
		await vscode.workspace.fs.createDirectory(publicDir);
		const symlinkPath = path.join(publicDir.fsPath, 'uploads');
		const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
		await fs.symlink(targetDir.fsPath, symlinkPath, symlinkType);

		// Manually create .gitignore with symlink entry WITH trailing slash (incorrect)
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		const initialContent = '.DS_Store\n/public/uploads/\n';
		await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(initialContent));

		// Run clean command
		await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore');

		// Verify trailing slash was removed from symlink entry
		const content = await readGitignore(folder);
		const lines = content.trim().split('\n');
		assert.ok(
			lines.includes('/public/uploads'),
			'Symlink entry should be cleaned to remove trailing slash'
		);
		assert.ok(
			!lines.some((line) => line === '/public/uploads/'),
			'Symlink entry should not have trailing slash after cleaning'
		);
	});

	test('Add command resolves subfolder inside symlink to the symlink itself', async function () {
		this.timeout(10000);

		// Skip on Windows without symlink permissions
		if (process.platform === 'win32') {
			try {
				const testPath = path.join(tempDir, '.permission-test');
				await fs.symlink('.', testPath, 'junction');
				await fs.unlink(testPath);
			} catch {
				return this.skip();
			}
		}

		const folder = ensureWorkspace();

		// Create a real directory with a subfolder as symlink target
		const targetDir = vscode.Uri.joinPath(folder.uri, 'storage', 'docs');
		await vscode.workspace.fs.createDirectory(targetDir);
		const imagesDir = vscode.Uri.joinPath(targetDir, 'images');
		await vscode.workspace.fs.createDirectory(imagesDir);

		// Create a symlink: public/docs -> storage/docs
		const publicDir = vscode.Uri.joinPath(folder.uri, 'public');
		await vscode.workspace.fs.createDirectory(publicDir);
		const symlinkPath = path.join(publicDir.fsPath, 'docs');
		const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
		await fs.symlink(targetDir.fsPath, symlinkPath, symlinkType);

		// Add the subfolder inside the symlink (public/docs/images)
		const subfolderUri = vscode.Uri.file(path.join(symlinkPath, 'images'));
		await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', subfolderUri);

		// Verify the symlink itself is added, not the subfolder
		const content = await readGitignore(folder);
		const lines = content.trim().split('\n');
		assert.ok(
			lines.includes('/public/docs'),
			'Symlink ancestor should be added instead of subfolder inside it'
		);
		assert.ok(
			!lines.some((line) => line.includes('/public/docs/images')),
			'Subfolder inside symlink should not be added directly'
		);
	});

	test('Add command deduplicates when multiple items inside same symlink are selected', async function () {
		this.timeout(10000);

		// Skip on Windows without symlink permissions
		if (process.platform === 'win32') {
			try {
				const testPath = path.join(tempDir, '.permission-test');
				await fs.symlink('.', testPath, 'junction');
				await fs.unlink(testPath);
			} catch {
				return this.skip();
			}
		}

		const folder = ensureWorkspace();

		// Create a real directory with subfolders as symlink target
		const targetDir = vscode.Uri.joinPath(folder.uri, 'storage', 'assets');
		await vscode.workspace.fs.createDirectory(targetDir);
		const cssDir = vscode.Uri.joinPath(targetDir, 'css');
		await vscode.workspace.fs.createDirectory(cssDir);
		const jsDir = vscode.Uri.joinPath(targetDir, 'js');
		await vscode.workspace.fs.createDirectory(jsDir);

		// Create a symlink: public/assets -> storage/assets
		const publicDir = vscode.Uri.joinPath(folder.uri, 'public');
		await vscode.workspace.fs.createDirectory(publicDir);
		const symlinkPath = path.join(publicDir.fsPath, 'assets');
		const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
		await fs.symlink(targetDir.fsPath, symlinkPath, symlinkType);

		// Multi-select two subfolders inside the symlink
		const cssUri = vscode.Uri.file(path.join(symlinkPath, 'css'));
		const jsUri = vscode.Uri.file(path.join(symlinkPath, 'js'));
		await vscode.commands.executeCommand('gitignore-assistant.addToGitignore', cssUri, [cssUri, jsUri]);

		// Verify only one entry for the symlink itself
		const content = await readGitignore(folder);
		const lines = content.trim().split('\n');
		const symlinkEntries = lines.filter((line) => line === '/public/assets');
		assert.strictEqual(symlinkEntries.length, 1, 'Only one entry for the symlink should exist');
		assert.ok(
			!lines.some((line) => line.includes('/public/assets/css') || line.includes('/public/assets/js')),
			'Subfolders inside symlink should not be added directly'
		);
	});

	function ensureWorkspace(): vscode.WorkspaceFolder {
		if (!workspaceFolder) {
			throw new Error('Test workspace not initialized.');
		}
		return workspaceFolder;
	}

	async function createFile(folder: vscode.WorkspaceFolder, relativePath: string): Promise<vscode.Uri> {
		const segments = relativePath.split('/');
		const fileName = segments.pop() ?? relativePath;
		const directoryUri = segments.length
			? vscode.Uri.joinPath(folder.uri, ...segments)
			: folder.uri;
		if (segments.length) {
			await vscode.workspace.fs.createDirectory(directoryUri);
		}
		const fileUri = vscode.Uri.joinPath(directoryUri, fileName);
		await vscode.workspace.fs.writeFile(fileUri, textEncoder.encode('// fixture content'));
		return fileUri;
	}

	async function readGitignore(folder: vscode.WorkspaceFolder): Promise<string> {
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		const buffer = await vscode.workspace.fs.readFile(gitignoreUri);
		return textDecoder.decode(buffer);
	}

	async function addWorkspaceFolder(uri: vscode.Uri, name: string): Promise<vscode.WorkspaceFolder> {
		const existing = vscode.workspace.getWorkspaceFolder(uri);
		if (existing) {
			return existing;
		}
		return new Promise<vscode.WorkspaceFolder>((resolve, reject) => {
			const insertionIndex = vscode.workspace.workspaceFolders?.length ?? 0;
			const timeout = setTimeout(() => {
				disposable.dispose();
				reject(new Error('Timed out waiting for workspace folder registration.'));
			}, 10000);
			const disposable = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
				const match = event.added.find((folder) => folder.uri.fsPath === uri.fsPath);
				if (match) {
					clearTimeout(timeout);
					disposable.dispose();
					resolve(match);
				}
			});
			const inserted = vscode.workspace.updateWorkspaceFolders(insertionIndex, 0, {
				uri,
				name
			});
			if (!inserted) {
				clearTimeout(timeout);
				disposable.dispose();
				reject(new Error('Workspace folder could not be added.'));
				return;
			}
			const immediate = vscode.workspace.getWorkspaceFolder(uri);
			if (immediate) {
				clearTimeout(timeout);
				disposable.dispose();
				resolve(immediate);
			}
		});
	}

	async function clearDirectory(directory: string): Promise<void> {
		const entries = await fs.readdir(directory).catch(() => []);
		await Promise.all(
			entries.map((entry) =>
				fs.rm(path.join(directory, entry), {
					recursive: true,
					force: true
				})
			)
		);
	}

	async function resetWorkspaceFolders(): Promise<void> {
		const existing = vscode.workspace.workspaceFolders ?? [];
		if (!existing.length) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
				disposable.dispose();
				resolve();
			});
			const removed = vscode.workspace.updateWorkspaceFolders(0, existing.length);
			if (!removed) {
				disposable.dispose();
				reject(new Error('Failed to reset workspace folders.'));
			}
		});
	}
});
