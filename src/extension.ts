import * as path from 'path';
import * as vscode from 'vscode';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');
const DEFAULT_BASE_ENTRIES = ['.DS_Store'];
const ROOT_GITIGNORE_CONTEXT = 'gitignoreAssistant.isRootGitignoreEditor';
const outputChannel = vscode.window.createOutputChannel('GitIgnore Assistant');

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
	workspace: vscode.WorkspaceFolder,
	baseEntries: string[]
) => Promise<OperationResult>;

export function activate(context: vscode.ExtensionContext) {
	const timestamp = new Date().toISOString();
	outputChannel.appendLine(`GitIgnore Assistant extension activated at ${timestamp}`);

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

	const cleanDisposable = vscode.commands.registerCommand(
		'gitignore-assistant.cleanGitignore',
		async (resourceUri: vscode.Uri | undefined) => {
			await handleCleanGitignoreCommand(resourceUri);
		}
	);

	updateRootGitignoreContext(vscode.window.activeTextEditor);
	const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
		updateRootGitignoreContext(editor);
	});
	const documentCloseDisposable = vscode.workspace.onDidCloseTextDocument(() => {
		updateRootGitignoreContext(vscode.window.activeTextEditor);
	});

	context.subscriptions.push(addDisposable, removeDisposable, cleanDisposable, activeEditorDisposable, documentCloseDisposable);
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
		}
		outputChannel.appendLine(`WARNING: ${message}`);
		return;
	}

	await performGitignoreUpdate(
		targets,
		mode,
		mode === 'add' ? addGitignoreEntry : removeGitignoreEntry
	);
}

async function handleCleanGitignoreCommand(resourceUri?: vscode.Uri): Promise<void> {
	let workspace: vscode.WorkspaceFolder | undefined;
	let gitignoreUri: vscode.Uri;

	if (resourceUri) {
		workspace = vscode.workspace.getWorkspaceFolder(resourceUri);
		if (!workspace) {
			const message = 'Clean .gitignore is only available for files inside an open workspace folder.';
			if (shouldShowNotifications()) {
				vscode.window.showWarningMessage(message);
			}
			outputChannel.appendLine(`WARNING: ${message}`);
			return;
		}
		const relative = path.relative(workspace.uri.fsPath, resourceUri.fsPath);
		if (relative !== '.gitignore') {
			const message = 'Clean .gitignore can only be run on the workspace root .gitignore file.';
			if (shouldShowNotifications()) {
				vscode.window.showWarningMessage(message);
			}
			outputChannel.appendLine(`WARNING: ${message}`);
			return;
		}
		gitignoreUri = resourceUri;
	} else {
		workspace = await pickWorkspaceFolder();
		if (!workspace) {
			return;
		}
		gitignoreUri = vscode.Uri.joinPath(workspace.uri, '.gitignore');
	}

	if (!workspace) {
		return;
	}
	let content: string;

	try {
		const buffer = await vscode.workspace.fs.readFile(gitignoreUri);
		content = textDecoder.decode(buffer);
	} catch (error) {
		if (isFileNotFound(error)) {
			const message = `.gitignore not found in workspace "${workspaceLabel(workspace)}".`;
			if (shouldShowNotifications()) {
				vscode.window.showWarningMessage(message);
			}
			outputChannel.appendLine(`WARNING: ${message}`);
			return;
		}
		throw error;
	}

	const originalLines = parseLines(content);
	const sortEntries = shouldSortWhenCleaning();
	const baseEntries = getBaseEntries(workspace);
	const result = cleanGitignoreEntries(originalLines, { sort: sortEntries }, baseEntries);
	const changed = !arraysEqual(originalLines, result.lines);

	if (!changed) {
		const message = `.gitignore is already clean.`;
		if (shouldShowNotifications()) {
			vscode.window.showInformationMessage(message);
		}
		outputChannel.appendLine(`INFO: ${message}`);
		return;
	}

	const serialized = serializeLines(result.lines);
	await vscode.workspace.fs.writeFile(gitignoreUri, textEncoder.encode(serialized));
	await refreshExplorerViews();
	presentCleaningSummary(workspace, result);
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		const message = 'Open a workspace folder to clean its .gitignore file.';
		if (shouldShowNotifications()) {
			vscode.window.showWarningMessage(message);
		}
		outputChannel.appendLine(`WARNING: ${message}`);
		return undefined;
	}
	if (folders.length === 1) {
		return folders[0];
	}
	return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select a workspace to clean its .gitignore' });
}

interface CleanGitignoreResult {
	lines: string[];
	duplicatesRemoved: number;
	emptyLinesRemoved: number;
	sortedApplied: boolean;
	baseEntriesAdded: boolean;
}

function cleanGitignoreEntries(
	lines: string[],
	options: { sort: boolean },
	baseEntries: string[]
): CleanGitignoreResult {
	const trimmed = lines.map((line) => line.trim());
	const entries = trimmed.filter((line) => line !== '');
	const emptyLinesRemoved = trimmed.length - entries.length;
	const seen = new Set<string>();
	const deduped: string[] = [];

	for (const entry of entries) {
		if (seen.has(entry)) {
			continue;
		}
		seen.add(entry);
		deduped.push(entry);
	}

	const duplicatesRemoved = entries.length - deduped.length;

	let sortedApplied = false;
	let finalEntries = deduped;
	if (options.sort) {
		const sorted = [...deduped].sort((left, right) => left.localeCompare(right));
		sortedApplied = !arraysEqual(deduped, sorted);
		finalEntries = sorted;
	}

	const baseEntriesAdded = enforceBaseEntries(finalEntries, baseEntries);

	return {
		lines: [...finalEntries],
		duplicatesRemoved,
		emptyLinesRemoved,
		sortedApplied,
		baseEntriesAdded
	};
}

function updateRootGitignoreContext(editor: vscode.TextEditor | undefined | null): void {
	const isRoot = editor ? isRootGitignoreDocument(editor.document) : false;
	void vscode.commands.executeCommand('setContext', ROOT_GITIGNORE_CONTEXT, isRoot);
}

function isRootGitignoreDocument(document: vscode.TextDocument | undefined): boolean {
	if (!document || document.uri.scheme !== 'file') {
		return false;
	}
	if (path.basename(document.uri.fsPath) !== '.gitignore') {
		return false;
	}
	const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!workspace) {
		return false;
	}
	const relative = path.relative(workspace.uri.fsPath, document.uri.fsPath);
	return relative === '.gitignore';
}

function shouldSortWhenCleaning(): boolean {
	return vscode.workspace.getConfiguration('gitignoreAssistant').get<boolean>('sortWhenCleaning', true);
}

function getBaseEntries(workspace?: vscode.WorkspaceFolder): string[] {
	const configuration = vscode.workspace.getConfiguration('gitignoreAssistant', workspace?.uri);
	const normalized = normalizeBaseEntries(configuration.get<unknown>('baseEntries'));
	if (normalized.length === 0) {
		const inspect = configuration.inspect<unknown>('baseEntries');
		const hasOverride =
			inspect?.workspaceFolderValue !== undefined ||
			inspect?.workspaceValue !== undefined ||
			inspect?.globalValue !== undefined;
		return hasOverride ? [] : [...DEFAULT_BASE_ENTRIES];
	}
	return normalized;
}

function normalizeBaseEntries(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [...DEFAULT_BASE_ENTRIES];
	}
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		if (typeof value !== 'string') {
			continue;
		}
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}
		normalized.push(trimmed);
		seen.add(trimmed);
	}
	return normalized;
}

function presentCleaningSummary(workspace: vscode.WorkspaceFolder, result: CleanGitignoreResult): void {
	const updates: string[] = [];
	if (result.duplicatesRemoved) {
		const suffix = result.duplicatesRemoved === 1 ? '' : 's';
		updates.push(`${result.duplicatesRemoved} duplicate${suffix}`);
	}
	if (result.emptyLinesRemoved) {
		const suffix = result.emptyLinesRemoved === 1 ? '' : 's';
		updates.push(`${result.emptyLinesRemoved} empty line${suffix}`);
	}
	if (result.sortedApplied) {
		updates.push('sorted alphabetically');
	}
	if (result.baseEntriesAdded) {
		updates.push('added base entries');
	}

	const detail = updates.length ? `: ${formatSummaryList(updates)}` : '';
	const message = `Cleaned .gitignore${detail}.`;

	if (shouldShowNotifications()) {
		vscode.window.showInformationMessage(message);
	}
	outputChannel.appendLine(`INFO: ${message}`);
}

function formatSummaryList(values: string[]): string {
	if (values.length === 1) {
		return values[0];
	}
	if (values.length === 2) {
		return `${values[0]} and ${values[1]}`;
	}
	const head = values.slice(0, -1).join(', ');
	const tail = values[values.length - 1];
	return `${head}, and ${tail}`;
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
		}
		outputChannel.appendLine(`ERROR: ${message}`);
		return;
	}

	const results: OperationResult[] = [];
	let triggeredWrite = false;

	for (const [workspace, uris] of grouped) {
		const baseEntries = getBaseEntries(workspace);
		const state = await loadOrCreateGitignore(workspace, baseEntries);

		for (const uri of uris) {
			try {
				const result = await handler(state, uri, workspace, baseEntries);
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

		state.dirty = enforceBaseEntries(state.lines, baseEntries) || state.dirty;
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
		}
		outputChannel.appendLine(`WARNING: ${message}`);
	}

	if (triggeredWrite) {
		await refreshExplorerViews();
	}

	presentSummary(results, mode);
}

async function addGitignoreEntry(
	state: GitignoreState,
	target: vscode.Uri,
	workspace: vscode.WorkspaceFolder,
	baseEntries: string[]
): Promise<OperationResult> {
	const info = await buildEntryForAdd(target, workspace);
	const workspaceName = workspaceLabel(workspace);

	if (baseEntries.includes(info.entry)) {
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
	workspace: vscode.WorkspaceFolder,
	baseEntries: string[]
): Promise<OperationResult> {
	const info = await buildEntryForRemove(target, workspace);
	const workspaceName = workspaceLabel(workspace);
	const candidates = [info.primary, ...info.alternates];
	const existing = findMatchingEntry(state.lines, candidates);

	if (existing && baseEntries.includes(existing)) {
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

async function loadOrCreateGitignore(
	workspace: vscode.WorkspaceFolder,
	baseEntries: string[]
): Promise<GitignoreState> {
	const gitignoreUri = vscode.Uri.joinPath(workspace.uri, '.gitignore');

	try {
		const contentBuffer = await vscode.workspace.fs.readFile(gitignoreUri);
		const content = textDecoder.decode(contentBuffer);
		const lines = parseLines(content);
		const dirty = enforceBaseEntries(lines, baseEntries);
		return { uri: gitignoreUri, lines, dirty };
	} catch (error) {
		if (isFileNotFound(error)) {
			const lines = [...baseEntries];
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

function enforceBaseEntries(lines: string[], baseEntries: string[]): boolean {
	let updated = false;
	for (let i = baseEntries.length - 1; i >= 0; i -= 1) {
		const entry = baseEntries[i];
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

	if (errors.length) {
		if (showNotifications) {
			vscode.window.showErrorMessage(message);
		}
		errors.forEach((result) => {
			outputChannel.appendLine(`ERROR: Failed to ${mode} "${result.entry}": ${result.detail ?? 'Unknown error'}`);
		});
		return;
	}

	if (showNotifications) {
		vscode.window.showInformationMessage(message);
	}
	outputChannel.appendLine(`INFO: ${message}`);
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
