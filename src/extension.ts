import * as path from 'path';
import * as vscode from 'vscode';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');
const BASE_ENTRIES = ['.DS_Store'];

interface GitignoreState {
	uri: vscode.Uri;
	lines: string[];
	dirty: boolean;
}

type OperationStatus = 'added' | 'removed' | 'skipped' | 'error';

interface OperationResult {
	entry: string;
	status: OperationStatus;
	workspaceName: string;
	detail?: string;
}

type GitignoreOperation = (
	state: GitignoreState,
	target: vscode.Uri,
	workspace: vscode.WorkspaceFolder
) => Promise<OperationResult>;

export function activate(context: vscode.ExtensionContext) {
	console.log('GitIgnore Assistant extension activated.');

	const addDisposable = vscode.commands.registerCommand(
		'gitignore-assistant.addToGitignore',
		async (resourceUri: vscode.Uri | undefined, resourceUris: vscode.Uri[] | undefined) => {
			await handleGitignoreCommand(resourceUri, resourceUris, 'add');
		}
	);

	const removeDisposable = vscode.commands.registerCommand(
		'gitignore-assistant.removeFromGitignore',
		async (resourceUri: vscode.Uri | undefined, resourceUris: vscode.Uri[] | undefined) => {
			await handleGitignoreCommand(resourceUri, resourceUris, 'remove');
		}
	);

	context.subscriptions.push(addDisposable, removeDisposable);
}

export function deactivate() {}

async function handleGitignoreCommand(
	resourceUri: vscode.Uri | undefined,
	resourceUris: vscode.Uri[] | undefined,
	mode: 'add' | 'remove'
): Promise<void> {
	const label = mode === 'add' ? 'Add to .gitignore' : 'Remove from .gitignore';
	let targets = resourceUris?.length ? resourceUris : resourceUri ? [resourceUri] : [];
	targets = dedupeUris(targets.filter((uri) => uri.scheme === 'file'));

	if (!targets.length) {
		const picks = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: true,
			canSelectMany: true,
			openLabel: label
		});
		if (!picks || !picks.length) {
			return;
		}
		targets = dedupeUris(picks.filter((uri) => uri.scheme === 'file'));
	}

	if (!targets.length) {
		const message = 'Select at least one file or folder to update .gitignore.';
		if (shouldShowNotifications()) {
			vscode.window.showWarningMessage(message);
		} else {
			console.warn(`gitignore-assistant: ${message}`);
		}
		return;
	}

	await performGitignoreUpdate(
		targets,
		mode,
		mode === 'add' ? addGitignoreEntry : removeGitignoreEntry
	);
}

async function performGitignoreUpdate(
	targetUris: vscode.Uri[],
	mode: 'add' | 'remove',
	handler: GitignoreOperation
): Promise<void> {
	const grouped = new Map<vscode.WorkspaceFolder, vscode.Uri[]>();
	const outsideWorkspace: vscode.Uri[] = [];

	for (const uri of targetUris) {
		const workspace = vscode.workspace.getWorkspaceFolder(uri);
		if (!workspace) {
			outsideWorkspace.push(uri);
			continue;
		}
		const list = grouped.get(workspace);
		if (list) {
			list.push(uri);
		} else {
			grouped.set(workspace, [uri]);
		}
	}

	if (!grouped.size) {
		const message = 'Selected items must belong to an open workspace folder.';
		if (shouldShowNotifications()) {
			vscode.window.showErrorMessage(message);
		} else {
			console.error(`gitignore-assistant: ${message}`);
		}
		return;
	}

	const results: OperationResult[] = [];
	let triggeredWrite = false;

	for (const [workspace, uris] of grouped) {
		const state = await loadOrCreateGitignore(workspace);

		for (const uri of uris) {
			try {
				const result = await handler(state, uri, workspace);
				results.push(result);
			} catch (error) {
				results.push({
					entry: toDisplayPath(workspace, uri),
					status: 'error',
					workspaceName: workspaceLabel(workspace),
					detail: toErrorMessage(error)
				});
			}
		}

		state.dirty = enforceBaseEntries(state.lines) || state.dirty;
		const cleaned = cleanupLines(state.lines);
		if (!arraysEqual(cleaned, state.lines)) {
			state.lines = cleaned;
			state.dirty = true;
		}

		if (state.dirty) {
			const content = serializeLines(state.lines);
			await vscode.workspace.fs.writeFile(state.uri, textEncoder.encode(content));
			triggeredWrite = true;
		}
	}

	if (outsideWorkspace.length) {
		const message = `${outsideWorkspace.length} item(s) were skipped because they are outside the current workspace.`;
		if (shouldShowNotifications()) {
			vscode.window.showWarningMessage(message);
		} else {
			console.warn(`gitignore-assistant: ${message}`);
		}
	}

	if (triggeredWrite) {
		await refreshExplorerViews();
	}

	presentSummary(results, mode);
}

async function addGitignoreEntry(
	state: GitignoreState,
	target: vscode.Uri,
	workspace: vscode.WorkspaceFolder
): Promise<OperationResult> {
	const info = await buildEntryForAdd(target, workspace);
	const workspaceName = workspaceLabel(workspace);

	if (BASE_ENTRIES.includes(info.entry)) {
		return {
			entry: info.entry,
			status: 'skipped',
			workspaceName,
			detail: 'Entry is managed automatically.'
		};
	}

	const added = addEntry(state.lines, info.entry);
	if (added) {
		state.dirty = true;
		return { entry: info.entry, status: 'added', workspaceName };
	}

	return {
		entry: info.entry,
		status: 'skipped',
		workspaceName,
		detail: 'Entry already exists in .gitignore.'
	};
}

async function removeGitignoreEntry(
	state: GitignoreState,
	target: vscode.Uri,
	workspace: vscode.WorkspaceFolder
): Promise<OperationResult> {
	const info = await buildEntryForRemove(target, workspace);
	const workspaceName = workspaceLabel(workspace);
	const candidates = [info.primary, ...info.alternates];
	const existing = findMatchingEntry(state.lines, candidates);

	if (existing && BASE_ENTRIES.includes(existing)) {
		return {
			entry: existing,
			status: 'skipped',
			workspaceName,
			detail: 'This entry is managed automatically and cannot be removed.'
		};
	}

	if (existing && removeEntry(state.lines, existing)) {
		state.dirty = true;
		return { entry: existing, status: 'removed', workspaceName };
	}

	for (const candidate of candidates) {
		if (removeEntry(state.lines, candidate)) {
			state.dirty = true;
			return { entry: candidate, status: 'removed', workspaceName };
		}
	}

	return {
		entry: info.primary,
		status: 'skipped',
		workspaceName,
		detail: 'Entry not found in .gitignore.'
	};
}

async function loadOrCreateGitignore(workspace: vscode.WorkspaceFolder): Promise<GitignoreState> {
	const gitignoreUri = vscode.Uri.joinPath(workspace.uri, '.gitignore');

	try {
		const contentBuffer = await vscode.workspace.fs.readFile(gitignoreUri);
		const content = textDecoder.decode(contentBuffer);
		const lines = parseLines(content);
		const dirty = enforceBaseEntries(lines);
		return { uri: gitignoreUri, lines, dirty };
	} catch (error) {
		if (isFileNotFound(error)) {
			const lines = [...BASE_ENTRIES];
			const content = serializeLines(lines);
			await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(content));
			return { uri: gitignoreUri, lines, dirty: false };
		}
		throw error;
	}
}

async function buildEntryForAdd(target: vscode.Uri, workspace: vscode.WorkspaceFolder) {
	const relativePath = getRelativePath(target, workspace);
	const stat = await vscode.workspace.fs.stat(target);
	const isDirectory = (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
	const entry = formatGitignoreEntry(relativePath, isDirectory);
	return { entry, relativePath, isDirectory };
}

async function buildEntryForRemove(target: vscode.Uri, workspace: vscode.WorkspaceFolder) {
	const relativePath = getRelativePath(target, workspace);
	let stat: vscode.FileStat | undefined;

	try {
		stat = await vscode.workspace.fs.stat(target);
	} catch (error) {
		if (!isFileNotFound(error)) {
			throw error;
		}
	}

	const isDirectory = stat ? (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory : undefined;
	const primary = formatGitignoreEntry(relativePath, isDirectory === true);
	const alternates: string[] = [];

	if (isDirectory === true) {
		alternates.push(formatGitignoreEntry(relativePath, false));
	} else {
		alternates.push(formatGitignoreEntry(relativePath, true));
	}

	return { primary, alternates, relativePath };
}

function getRelativePath(target: vscode.Uri, workspace: vscode.WorkspaceFolder): string {
	const relative = path.relative(workspace.uri.fsPath, target.fsPath);
	if (!relative || relative === '') {
		throw new Error('Select a file or folder inside the workspace, not the workspace root.');
	}
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('Selected item is not inside the workspace.');
	}
	const normalized = relative.split(path.sep).join('/');
	if (normalized === '.gitignore') {
		throw new Error('Managing the .gitignore file itself is not supported.');
	}
	return normalized;
}

function formatGitignoreEntry(relativePath: string, isDirectory: boolean): string {
	const escaped = escapeGitignorePath(relativePath);
	if (isDirectory) {
		return escaped.endsWith('/') ? escaped : `${escaped}/`;
	}
	return escaped.endsWith('/') ? escaped.slice(0, -1) : escaped;
}

function escapeGitignorePath(value: string): string {
	return value.replace(/([ #!])/g, (match) => {
		if (match === ' ') {
			return '\\ ';
		}
		return `\\${match}`;
	});
}

function parseLines(content: string): string[] {
	if (!content) {
		return [];
	}
	const normalized = content.replace(/\r\n/g, '\n');
	const segments = normalized.split('\n');
	if (segments.length && segments[segments.length - 1] === '') {
		segments.pop();
	}
	return segments;
}

function serializeLines(lines: string[]): string {
	const cleaned = cleanupLines(lines);
	if (!cleaned.length) {
		return '';
	}
	return `${cleaned.join('\n')}\n`;
}

function cleanupLines(lines: string[]): string[] {
	const cleaned: string[] = [];
	for (const line of lines) {
		if (line.trim() === '' && cleaned.length && cleaned[cleaned.length - 1].trim() === '') {
			continue;
		}
		cleaned.push(line);
	}
	while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') {
		cleaned.pop();
	}
	return cleaned;
}

function addEntry(lines: string[], entry: string): boolean {
	if (findMatchingEntry(lines, [entry])) {
		return false;
	}
	lines.push(entry);
	return true;
}

function removeEntry(lines: string[], entry: string): boolean {
	const initialLength = lines.length;
	let removed = false;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index].trim() === entry) {
			lines.splice(index, 1);
			removed = true;
		}
	}
	return removed && lines.length !== initialLength;
}

function enforceBaseEntries(lines: string[]): boolean {
	let updated = false;
	for (let i = BASE_ENTRIES.length - 1; i >= 0; i -= 1) {
		const entry = BASE_ENTRIES[i];
		if (!findMatchingEntry(lines, [entry])) {
			lines.unshift(entry);
			updated = true;
		}
	}
	return updated;
}

function findMatchingEntry(lines: string[], candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		if (lines.some((line) => line.trim() === candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function presentSummary(results: OperationResult[], mode: 'add' | 'remove'): void {
	const successStatus = mode === 'add' ? 'added' : 'removed';
	const successCount = results.filter((result) => result.status === successStatus).length;
	const skippedCount = results.filter((result) => result.status === 'skipped').length;
	const errors = results.filter((result) => result.status === 'error');

	const messageParts: string[] = [];
	messageParts.push(`${capitalize(successStatus)} ${successCount} ${pluralizeEntry(successCount)}.`);
	if (skippedCount) {
		messageParts.push(`${skippedCount} skipped.`);
	}
	if (errors.length) {
		messageParts.push(`${errors.length} failed.`);
	}
	const message = messageParts.join(' ');

	const showNotifications = shouldShowNotifications();

	if (!showNotifications && !errors.length) {
		console.log(`gitignore-assistant: ${message}`);
		return;
	}

	if (errors.length) {
		if (showNotifications) {
			vscode.window.showErrorMessage(message);
		}
		errors.forEach((result) => {
			console.error(
				`gitignore-assistant: failed to ${mode} "${result.entry}" in workspace "${result.workspaceName}": ${result.detail ?? 'Unknown error'}`
			);
		});
		return;
	}

	if (showNotifications) {
		vscode.window.showInformationMessage(message);
	}
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
	const seen = new Set<string>();
	const unique: vscode.Uri[] = [];
	for (const uri of uris) {
		const key = uri.toString();
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(uri);
		}
	}
	return unique;
}

function arraysEqual<T>(left: T[], right: T[]): boolean {
	if (left === right) {
		return true;
	}
	if (left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
}

function workspaceLabel(workspace: vscode.WorkspaceFolder): string {
	return workspace.name ?? path.basename(workspace.uri.fsPath);
}

function toDisplayPath(workspace: vscode.WorkspaceFolder, uri: vscode.Uri): string {
	try {
		const relative = getRelativePath(uri, workspace);
		return relative;
	} catch {
		return uri.fsPath;
	}
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function pluralizeEntry(count: number): string {
	return count === 1 ? 'entry' : 'entries';
}

function shouldShowNotifications(): boolean {
	return vscode.workspace.getConfiguration('gitignoreAssistant').get<boolean>('showNotifications', true);
}

async function refreshExplorerViews(): Promise<void> {
	await Promise.allSettled([
		vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer'),
		vscode.commands.executeCommand('git.refresh')
	]);
}
