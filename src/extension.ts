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
	const sortEntries = shouldSortWhenCleaning(workspace);
	const removeEmptyLines = shouldRemoveEmptyLines(workspace);
	const removeComments = shouldRemoveComments(workspace);
	const trailingSlash = shouldUseTrailingSlashForFolders(workspace);
	const baseEntries = getBaseEntries(workspace);
	const result = await cleanGitignoreEntries(
		originalLines,
		{
			sort: sortEntries,
			removeEmptyLines,
			removeComments,
			trailingSlashForFolders: trailingSlash,
			workspace
		},
		baseEntries
	);
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
	commentsRemoved: number;
}

async function cleanGitignoreEntries(
	lines: string[],
	options: {
		sort: boolean;
		removeEmptyLines: boolean;
		removeComments: boolean;
		trailingSlashForFolders: boolean;
		workspace?: vscode.WorkspaceFolder;
	},
	baseEntries: string[]
): Promise<CleanGitignoreResult> {
	const trimmed = lines.map((line) => line.trim());
	const isComment = (line: string) => line.startsWith('#');
	const isEmpty = (line: string) => line === '';

	const originalEmptyCount = trimmed.filter(isEmpty).length;
	const originalCommentCount = trimmed.filter(isComment).length;

	const keptLines = trimmed.filter((line) => {
		if (options.removeEmptyLines && isEmpty(line)) {
			return false;
		}
		if (options.removeComments && isComment(line)) {
			return false;
		}
		return true;
	});

	type EntryMeta = { hasFolderSyntax: boolean; existsAsDirectory?: boolean };
	const metaByKey = new Map<string, EntryMeta>();
	const toKey = (line: string) => stripAnchorsAndSlashes(line);

	const keysToDetect = new Set<string>();
	for (const line of keptLines) {
		if (isEmpty(line) || isComment(line) || isPatternLine(line)) {
			continue;
		}
		const key = toKey(line);
		const current = metaByKey.get(key) ?? { hasFolderSyntax: false };
		if (line.endsWith('/')) {
			current.hasFolderSyntax = true;
		}
		metaByKey.set(key, current);
		// Always detect to distinguish real directories from symlinks
		if (options.workspace) {
			keysToDetect.add(key);
		}
	}

	if (options.workspace && keysToDetect.size) {
		const detections = await detectDirectoriesForKeys(keysToDetect, options.workspace);
		for (const [key, isDir] of detections) {
			const meta = metaByKey.get(key);
			if (meta) {
				meta.existsAsDirectory = isDir;
			}
		}
	}

	const normalized: string[] = [];
	const seenEntryKeys = new Set<string>();
	const seenPatternKeys = new Set<string>();
	const firstVariantByKey = new Map<string, { trailingSlash: boolean; anchored: boolean }>();
	let duplicatesRemoved = 0;

	for (const line of keptLines) {
		if (isEmpty(line)) {
			normalized.push('');
			continue;
		}
		if (isComment(line)) {
			normalized.push(line);
			continue;
		}
		if (isPatternLine(line)) {
			if (seenPatternKeys.has(line)) {
				duplicatesRemoved += 1;
				continue;
			}
			seenPatternKeys.add(line);
			normalized.push(line);
			continue;
		}

		const key = toKey(line);
		const variant = { trailingSlash: line.endsWith('/'), anchored: line.startsWith('/') };
		if (seenEntryKeys.has(key)) {
			const first = firstVariantByKey.get(key);
			const onlyTrailingSlashDiff =
				!!first && first.trailingSlash !== variant.trailingSlash && options.trailingSlashForFolders === false;
			if (!onlyTrailingSlashDiff) {
				duplicatesRemoved += 1;
			}
			continue;
		}

		const meta = metaByKey.get(key);
		// Prioritize filesystem check: if explicitly false (like symlinks), treat as file
		const isFolderForKey = meta?.existsAsDirectory === true ||
		                       (meta?.existsAsDirectory === undefined && !!meta?.hasFolderSyntax);
		firstVariantByKey.set(key, variant);
		seenEntryKeys.add(key);

		const canonical = buildCanonicalFromKey(key, isFolderForKey, variant, options);
		normalized.push(canonical);
	}

	const commentsRemoved = options.removeComments ? originalCommentCount : 0;
	const emptyLinesRemoved = options.removeEmptyLines ? originalEmptyCount : 0;

	const baseApplied = [...normalized];
	const baseEntriesAdded = enforceBaseEntries(baseApplied, baseEntries);

	let finalLines = baseApplied;
	let sortedApplied = false;
	if (options.sort) {
		const sorted = [...baseApplied].sort((left, right) => left.localeCompare(right));
		sortedApplied = !arraysEqual(baseApplied, sorted);
		finalLines = sorted;
	}

	const preparedLines = options.removeEmptyLines
		? cleanupLines(finalLines, { collapseEmpty: true, trimTrailing: true })
		: [...finalLines];

	return {
		lines: preparedLines,
		duplicatesRemoved,
		emptyLinesRemoved,
		sortedApplied,
		baseEntriesAdded,
		commentsRemoved
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

function shouldSortWhenCleaning(workspace?: vscode.WorkspaceFolder): boolean {
	return vscode.workspace
		.getConfiguration('gitignoreAssistant', workspace?.uri)
		.get<boolean>('sortWhenCleaning', false);
}

function shouldRemoveEmptyLines(workspace?: vscode.WorkspaceFolder): boolean {
	return vscode.workspace
		.getConfiguration('gitignoreAssistant', workspace?.uri)
		.get<boolean>('removeEmptyLines', false);
}

function shouldRemoveComments(workspace?: vscode.WorkspaceFolder): boolean {
	return vscode.workspace
		.getConfiguration('gitignoreAssistant', workspace?.uri)
		.get<boolean>('removeComments', false);
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
	if (result.commentsRemoved) {
		const suffix = result.commentsRemoved === 1 ? '' : 's';
		updates.push(`${result.commentsRemoved} comment${suffix}`);
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
		}
	}

	if (outsideWorkspace.length) {
		const message = `${outsideWorkspace.length} item(s) were skipped because they are outside the current workspace.`;
		if (shouldShowNotifications()) {
			vscode.window.showWarningMessage(message);
		}
		outputChannel.appendLine(`WARNING: ${message}`);
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
	// Git treats symlinks as files, not directories, so don't add trailing slash
	const isDirectory = isRealDirectory(stat);
	const entry = formatGitignoreEntry(relativePath, isDirectory, workspace);
	return { entry, relativePath, isDirectory };
}

function isSymbolicLink(stat: vscode.FileStat): boolean {
	return (stat.type & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;
}

function isRealDirectory(stat: vscode.FileStat): boolean {
	const isDir = (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
	const isSymlink = (stat.type & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;
	// Git treats symlinks as files, not directories, so exclude them
	return isDir && !isSymlink;
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

	const isDirectory = stat ? isRealDirectory(stat) : undefined;
	const primary = formatGitignoreEntry(relativePath, isDirectory === true, workspace);
	const alternates: string[] = [];

	if (isDirectory === true) {
		// Match common variants
		alternates.push(formatGitignoreEntry(relativePath, false, workspace)); // as file
		const escaped = escapeGitignorePath(relativePath);
		const withTrailing = escaped.endsWith('/') ? escaped : `${escaped}/`;
		alternates.push(withTrailing); // non-root anchored folder
		alternates.push(`/${withTrailing}`); // root anchored folder
		alternates.push(escaped); // non-root anchored folder without trailing slash
		alternates.push(`/${escaped}`); // root anchored without trailing slash
	} else {
		alternates.push(formatGitignoreEntry(relativePath, true, workspace)); // as folder
		const escaped = escapeGitignorePath(relativePath);
		const withTrailing = escaped.endsWith('/') ? escaped : `${escaped}/`;
		alternates.push(withTrailing); // non-root anchored with slash
		alternates.push(`/${withTrailing}`); // root anchored with slash
		alternates.push(escaped); // non-root anchored file
		alternates.push(`/${escaped}`); // root anchored file
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

function formatGitignoreEntry(relativePath: string, isDirectory: boolean, workspace?: vscode.WorkspaceFolder): string {
	const escaped = escapeGitignorePath(relativePath);
	const trailingSlash = shouldUseTrailingSlashForFolders(workspace);
	const addLeadingSlash = shouldAddWithLeadingSlash(workspace);
	const rootLevel = isRootLevelPath(relativePath);
	const core = escaped.replace(/^\/+/g, '');
	const isRootDotfile = !isDirectory && rootLevel && core.startsWith('.');

	let normalized = isDirectory
		? (() => {
			const withoutTrailing = core.replace(/\/+$/g, '');
			return trailingSlash ? `${withoutTrailing}/` : withoutTrailing;
		})()
		: core.replace(/\/+$/g, '');

	if (addLeadingSlash && !isRootDotfile) {
		normalized = normalized.startsWith('/') ? normalized : `/${normalized}`;
	} else {
		normalized = normalized.replace(/^\/+/g, '');
	}

	if (!isDirectory) {
		normalized = normalized.replace(/\/+$/g, '');
	}

	return normalized;
}

function isRootLevelPath(relativePath: string): boolean {
	return !relativePath.includes('/');
}

function escapeGitignorePath(value: string): string {
	return value.replace(/([ #!])/g, (match) => {
		if (match === ' ') {
			return '\\ ';
		}
		return `\\${match}`;
	});
}

function shouldUseTrailingSlashForFolders(workspace?: vscode.WorkspaceFolder): boolean {
	return vscode.workspace
		.getConfiguration('gitignoreAssistant', workspace?.uri)
		.get<boolean>('trailingSlashForFolders', true);
}

function shouldAddWithLeadingSlash(workspace?: vscode.WorkspaceFolder): boolean {
	return vscode.workspace
		.getConfiguration('gitignoreAssistant', workspace?.uri)
		.get<boolean>('addWithLeadingSlash', true);
}

function isPatternLine(line: string): boolean {
	// Treat as pattern if it contains globbing or negation characters
	return /(^!|\*|\?|\[|\]|\*\*)/.test(line);
}

function stripAnchorsAndSlashes(line: string): string {
	// Remove leading slash (anchor) and trailing slashes for keying
	let value = line.replace(/^\/+/, '');
	value = value.replace(/\/+$/, '');
	return value;
}

function buildCanonicalFromKey(
	key: string,
	isFolder: boolean,
	variant: { trailingSlash: boolean; anchored: boolean },
	options: { trailingSlashForFolders: boolean }
): string {
	if (isPatternLine(key)) {
		return key;
	}

	const rootDotfile = !isFolder && !key.includes('/') && key.startsWith('.');
	const normalizedKey = key.replace(/\/+$/g, '');

	if (isFolder) {
		const anchoredBase = variant.anchored ? `/${normalizedKey}` : normalizedKey;
		if (options.trailingSlashForFolders || variant.trailingSlash) {
			return anchoredBase.endsWith('/') ? anchoredBase : `${anchoredBase}/`;
		}
		return anchoredBase.replace(/\/+$/g, '');
	}

	if (rootDotfile) {
		return normalizedKey;
	}

	const anchoredBase = variant.anchored ? `/${normalizedKey}` : normalizedKey;
	return anchoredBase.replace(/\/+$/g, '');
}

async function detectDirectoriesForKeys(keys: Set<string>, workspace: vscode.WorkspaceFolder): Promise<Map<string, boolean | undefined>> {
	const results = new Map<string, boolean | undefined>();
	await Promise.all(
		Array.from(keys).map(async (key) => {
			const unescaped = unescapeGitignorePath(key);
			const uri = vscode.Uri.joinPath(workspace.uri, unescaped);
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				// Return true for real directories, false for symlinks/files
				results.set(key, isRealDirectory(stat));
			} catch {
				// File doesn't exist - return undefined to preserve user's syntax
				results.set(key, undefined);
			}
		})
	);
	return results;
}

function unescapeGitignorePath(value: string): string {
	return value.replace(/\\([ #!])/g, '$1');
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
	if (!lines.length) {
		return '';
	}
	return `${lines.join('\n')}\n`;
}

function cleanupLines(
	lines: string[],
	options: { collapseEmpty?: boolean; trimTrailing?: boolean } = {}
): string[] {
	const collapseEmpty = options.collapseEmpty ?? true;
	const trimTrailing = options.trimTrailing ?? true;
	const cleaned: string[] = [];
	for (const line of lines) {
		if (collapseEmpty && line.trim() === '' && cleaned.length && cleaned[cleaned.length - 1].trim() === '') {
			continue;
		}
		cleaned.push(line);
	}
	if (trimTrailing) {
		while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') {
			cleaned.pop();
		}
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
