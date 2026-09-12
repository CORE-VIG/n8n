type BadgeTheme = 'default' | 'success' | 'warning' | 'danger' | 'primary' | 'secondary' | 'tertiary';

/** A run or agent status, as the colour it deserves. */
export function statusTheme(status: string): BadgeTheme {
	switch (status) {
		case 'done':
		case 'active':
		case 'kept':
		case 'pass':
			return 'success';
		case 'running':
		case 'queued':
		case 'claimed':
		case 'paused':
		case 'canary':
		case 'waiting':
		case 'working':
		case 'validating':
			return 'warning';
		case 'waiting_approval':
			return 'primary';
		case 'needs_help':
			return 'danger';
		case 'failed':
		case 'stopped':
		case 'error':
		case 'revoked':
		case 'tripped':
		case 'fail':
			return 'danger';
		case 'unknown':
			return 'tertiary';
		default:
			return 'default';
	}
}
