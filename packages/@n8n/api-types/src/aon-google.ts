/**
 * Types for Aon's Google access: Gmail, Calendar, Drive and Sheets, through
 * the owner's own n8n credential (`googleOAuth2Api` and its family), never a
 * separate app registration.
 */

export interface AonGoogleStatus {
	configured: boolean;
	/** The credential's own name, e.g. "Aon Google"; null when none is configured. */
	credentialName: string | null;
	/** The granted scopes, space-separated as Google returns them; empty when not configured. */
	scopes: string[];
	/** The signed-in address, read from userinfo when reachable; null otherwise. */
	email: string | null;
}
