/** Types returned by the Aon hands API: workspaces in the fenced sandbox and their files. */

export interface AonWorkspaceSummary {
	id: string;
	slug: string;
	createdAt: string;
	lastUsedAt: string;
	/** What the sandbox service says, when it answers. */
	remoteStatus: string | null;
	lastActiveAt: string | null;
}

export interface AonWorkspaceFileEntry {
	name: string;
	type: 'file' | 'directory';
	size: number | null;
}

export interface AonWorkspaceFile {
	path: string;
	text: string;
	size: number;
	truncated: boolean;
}

export interface AonHandsRunRequest {
	command: string;
	timeoutSeconds?: number;
	network?: boolean;
}

export interface AonHandsRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	executionTimeMs: number;
	timedOut: boolean;
	killed: boolean;
	success: boolean;
}
