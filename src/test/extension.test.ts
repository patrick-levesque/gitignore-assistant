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
			content.includes('src/add-example.ts'),
			'.gitignore should contain the relative path for the added file'
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
			content.includes('assets/ignored/'),
			'.gitignore should contain the folder entry before removal'
		);

		await vscode.commands.executeCommand('gitignore-assistant.removeFromGitignore', ignoredFolder);
		content = await readGitignore(folder);
		assert.ok(content.includes('.DS_Store'), '.gitignore should still contain .DS_Store');
		assert.ok(!content.includes('assets/ignored/'), '.gitignore should not contain the removed folder entry');
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
			.filter((line) => line.trim() === 'logs/app.log').length;
		assert.strictEqual(occurrences, 1, 'Duplicate entries should not be added to .gitignore');
	});

	test('Clean command removes duplicates, empty lines, and sorts entries', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		const initialContent = ['# comment', '', 'node_modules/', 'dist/', 'node_modules/', 'build/', '', 'build/'].join('\n');
		await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(`${initialContent}\n`));

		await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore');

		const cleaned = await readGitignore(folder);
		const lines = cleaned.trim().split('\n');
		assert.deepStrictEqual(
			lines,
			['.DS_Store', '# comment', 'build/', 'dist/', 'node_modules/'],
			'Clean command should remove duplicates, empty lines, and sort entries alphabetically'
		);
	});

	test('Clean command respects sorting setting', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		const initialContent = ['node_modules/', 'dist/', 'build/', 'dist/'].join('\n');
		await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(`${initialContent}\n`));

		const configuration = vscode.workspace.getConfiguration('gitignoreAssistant');
		const previousValue = configuration.get<boolean>('sortWhenCleaning');
		await configuration.update('sortWhenCleaning', false, vscode.ConfigurationTarget.Workspace);

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
			await configuration.update('sortWhenCleaning', previousValue, vscode.ConfigurationTarget.Workspace);
		}
	});

	test('Clean command runs on root .gitignore when invoked with resource', async function () {
		this.timeout(10000);
		const folder = ensureWorkspace();
		const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
		await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode('dist/\n\nnode_modules/\n'));

		await vscode.commands.executeCommand('gitignore-assistant.cleanGitignore', gitignoreUri);

		const cleaned = await readGitignore(folder);
		const lines = cleaned.trim().split('\n');
		assert.deepStrictEqual(
			lines,
			['.DS_Store', 'dist/', 'node_modules/'],
			'Clean command should process root .gitignore when invoked from the editor context menu'
		);
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
