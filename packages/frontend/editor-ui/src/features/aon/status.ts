type BadgeTheme = 'default' | 'success' | 'warning' | 'danger' | 'primary' | 'secondary' | 'tertiary';

/** A run or agent status, as the colour it deserves. */
export function statusTheme(status: string): BadgeTheme {
	switch (status) {
		case 'done':
		case 'active':
		case 'kept':
			return 'success';
		case 'running':
		case 'queued':
		case 'claimed':
		case 'paused':
		case 'canary':
		case 'waiting':
			return 'warning';
		case 'failed':
		case 'stopped':
		case 'error':
		case 'revoked':
		case 'tripped':
			return 'danger';
		default:
			return 'default';
	}
}
