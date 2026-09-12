import type { AuthenticatedRequest, User } from '@n8n/db';
import type { NextFunction, Response } from 'express';

/**
 * Aon belongs to the instance owner. Its memory, agents and runs are one
 * person's, not a team's, so a member account gets a 403 on every Aon route
 * that reads or changes them. Conversations and workspaces are scoped per
 * user in their own tables and do not need this.
 */
export function isAonOwner(user: User): boolean {
	const slug = user.role?.slug;
	return slug === 'global:owner' || slug === 'global:admin';
}

export function aonOwnerOnly(req: AuthenticatedRequest, res: Response, next: NextFunction) {
	if (isAonOwner(req.user)) {
		next();
		return;
	}
	res.status(403).json({ status: 'error', message: 'Aon belongs to the instance owner.' });
}
