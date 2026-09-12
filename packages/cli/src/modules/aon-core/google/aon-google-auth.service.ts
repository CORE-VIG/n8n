import type { AonGoogleStatus } from '@n8n/api-types';
import type { CredentialsEntity, User } from '@n8n/db';
import { CredentialsRepository, ProjectRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { Credentials } from 'n8n-core';

/**
 * How Aon reaches Google: one credential the owner makes in n8n's own
 * Credentials page, of type `googleOAuth2Api` (or one of the services that
 * extend it: `gmailOAuth2`, `googleCalendarOAuth2Api`, `googleDriveOAuth2Api`,
 * `googleSheetsOAuth2Api`), decrypted and refreshed the same way n8n's own
 * `CredentialsHelper` and `requestOAuth2` do for a node — except there is no
 * node or workflow here, so this talks to Google's token endpoint directly
 * with `fetch` and writes the refreshed token back with the same
 * `Credentials.setData`/`updateData` n8n itself uses.
 */

export const AON_GOOGLE_CREDENTIAL_NAME = 'Aon Google';

/** `googleOAuth2Api` plus every credential type that `extends` it. */
const GOOGLE_CREDENTIAL_TYPES = new Set([
	'googleOAuth2Api',
	'gmailOAuth2',
	'googleCalendarOAuth2Api',
	'googleDriveOAuth2Api',
	'googleSheetsOAuth2Api',
]);

export const GOOGLE_REQUIRED_SCOPES = [
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/calendar',
	'https://www.googleapis.com/auth/drive',
	'https://www.googleapis.com/auth/spreadsheets',
	'https://www.googleapis.com/auth/userinfo.email',
];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
/** Refresh a little before Google would reject the token, not the instant it expires. */
const REFRESH_MARGIN_MS = 60_000;

export class GoogleNotConfigured extends Error {
	constructor(
		message = `Google is not connected: open the "${AON_GOOGLE_CREDENTIAL_NAME}" credential in Credentials (type Google OAuth2 API, scopes: ${GOOGLE_REQUIRED_SCOPES.join(' ')}) and finish the sign-in with Google.`,
	) {
		super(message);
		this.name = 'GoogleNotConfigured';
	}
}

/** The exact line every Google tool answers with when nothing is configured yet — a normal state, not an error to fix in code. */
export const GOOGLE_NOT_CONNECTED_MESSAGE = new GoogleNotConfigured().message;

interface GoogleOAuthTokenData {
	access_token: string;
	refresh_token?: string;
	expires_in?: string;
	n8n_expires_at?: string;
	scope?: string;
	token_type?: string;
}

interface GoogleCredentialData {
	clientId: string;
	clientSecret?: string;
	accessTokenUrl: string;
	scope?: string;
	oauthTokenData?: GoogleOAuthTokenData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
	const body: unknown = await response.json().catch(() => ({}));
	return isRecord(body) ? body : {};
}

@Service()
export class AonGoogleAuthService {
	/** De-dupes a concurrent refresh of the same credential within this process. */
	private readonly refreshing = new Map<string, Promise<string>>();

	constructor(
		private readonly credentialsRepository: CredentialsRepository,
		private readonly projectRepository: ProjectRepository,
	) {}

	/** Configured means signed in: a credential row alone (no token yet) is "not connected" for every tool. */
	async isConfigured(user: User): Promise<boolean> {
		const credential = await this.findCredential(user);
		if (!credential) return false;
		const data = await this.decrypt(credential);
		return Boolean(data.oauthTokenData?.access_token || data.oauthTokenData?.refresh_token);
	}

	/** A valid access token, refreshing and persisting it first if it is close to expiring. */
	async accessToken(user: User): Promise<string> {
		const credential = await this.findCredential(user);
		if (!credential) throw new GoogleNotConfigured();
		return await this.tokenFor(credential);
	}

	async status(user: User): Promise<AonGoogleStatus> {
		const credential = await this.findCredential(user);
		if (!credential) return { configured: false, credentialName: null, scopes: [], email: null };

		const data = await this.decrypt(credential);
		const scopes = (data.scope ?? '')
			.split(' ')
			.map((scope) => scope.trim())
			.filter(Boolean);

		let email: string | null = null;
		if (data.oauthTokenData?.access_token) {
			try {
				const token = await this.tokenFor(credential);
				email = await this.fetchEmail(token);
			} catch {
				email = null;
			}
		}

		const signedIn = Boolean(data.oauthTokenData?.access_token || data.oauthTokenData?.refresh_token);
		return { configured: signedIn, credentialName: credential.name, scopes, email };
	}

	// --- the credential ---------------------------------------------------

	/**
	 * The owner's own credential: one named "Aon Google" of type
	 * `googleOAuth2Api`, or else the oldest credential of the Google family
	 * in their personal project. Scoped to the caller's own project, the same
	 * way every other Aon tool reads what belongs to the person using it.
	 */
	private async findCredential(user: User): Promise<CredentialsEntity | null> {
		const project = await this.projectRepository.getPersonalProjectForUser(user.id);
		if (!project) return null;

		const named = await this.credentialsRepository.findByNameAndTypeInProject(
			AON_GOOGLE_CREDENTIAL_NAME,
			'googleOAuth2Api',
			project.id,
		);
		if (named.length > 0) return named[0];

		const all = await this.credentialsRepository.findAllCredentialsForProject(project.id);
		const family = all
			.filter((candidate) => GOOGLE_CREDENTIAL_TYPES.has(candidate.type))
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
		return family[0] ?? null;
	}

	private async decrypt(credential: CredentialsEntity): Promise<GoogleCredentialData> {
		const wrapper = new Credentials<GoogleCredentialData>(
			{ id: credential.id, name: credential.name },
			credential.type,
			credential.data,
		);
		return await wrapper.getData();
	}

	// --- the token ----------------------------------------------------------

	private async tokenFor(credential: CredentialsEntity): Promise<string> {
		const pending = this.refreshing.get(credential.id);
		if (pending) return pending;
		const promise = this.resolveToken(credential).finally(() => {
			this.refreshing.delete(credential.id);
		});
		this.refreshing.set(credential.id, promise);
		return promise;
	}

	private async resolveToken(credential: CredentialsEntity): Promise<string> {
		const data = await this.decrypt(credential);
		const token = data.oauthTokenData;
		if (!token?.access_token) {
			throw new GoogleNotConfigured(
				`The "${credential.name}" credential has not finished sign-in yet. Open it in Credentials and complete the Google consent screen.`,
			);
		}
		if (this.stillValid(token)) return token.access_token;
		if (!token.refresh_token) {
			throw new GoogleNotConfigured(
				`The "${credential.name}" credential has no refresh token stored. Reconnect it in Credentials and consent again.`,
			);
		}
		return await this.refresh(credential, data, token);
	}

	private stillValid(token: GoogleOAuthTokenData): boolean {
		const expiresAt = numberField({ n8n_expires_at: token.n8n_expires_at }, 'n8n_expires_at');
		if (expiresAt === undefined) return false;
		return expiresAt - REFRESH_MARGIN_MS > Date.now();
	}

	private async refresh(
		credential: CredentialsEntity,
		data: GoogleCredentialData,
		token: GoogleOAuthTokenData,
	): Promise<string> {
		const url = data.accessTokenUrl || TOKEN_URL;
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: data.clientId,
					client_secret: data.clientSecret ?? '',
					grant_type: 'refresh_token',
					refresh_token: token.refresh_token ?? '',
				}).toString(),
				signal: AbortSignal.timeout(20_000),
			});
		} catch (error) {
			throw new GoogleNotConfigured(
				`Google could not be reached to refresh the token: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const body = await readJsonBody(response);
		const accessToken = stringField(body, 'access_token');
		if (!response.ok || !accessToken) {
			const errorCode = stringField(body, 'error');
			const detail =
				errorCode === 'invalid_grant'
					? 'the grant was revoked or expired — reconnect the credential in Credentials and consent again'
					: (stringField(body, 'error_description') ?? errorCode ?? `HTTP ${response.status}`);
			throw new GoogleNotConfigured(`Google refused to refresh the token: ${detail}`);
		}

		const expiresIn = numberField(body, 'expires_in');
		const refreshedScope = stringField(body, 'scope');
		// Google returns a refresh token only on first consent; every later
		// refresh omits it, so the stored one is kept unless a new one arrives.
		const refreshedRefreshToken = stringField(body, 'refresh_token');
		const nextToken: GoogleOAuthTokenData = {
			...token,
			access_token: accessToken,
			...(expiresIn !== undefined
				? { expires_in: String(expiresIn), n8n_expires_at: String(Date.now() + expiresIn * 1000) }
				: {}),
			...(refreshedRefreshToken ? { refresh_token: refreshedRefreshToken } : {}),
			...(refreshedScope ? { scope: refreshedScope } : {}),
		};
		await this.persist(credential, nextToken);
		return accessToken;
	}

	/** Persisted the same way `CredentialsHelper.updateCredentialsOauthTokenData` writes a refreshed token. */
	private async persist(credential: CredentialsEntity, oauthTokenData: GoogleOAuthTokenData): Promise<void> {
		const wrapper = new Credentials<GoogleCredentialData>(
			{ id: credential.id, name: credential.name },
			credential.type,
			credential.data,
		);
		await wrapper.updateData({ oauthTokenData });
		const toSave = wrapper.getDataToSave();
		await this.credentialsRepository.update(
			{ id: credential.id, type: credential.type },
			{ data: toSave.data, updatedAt: new Date() },
		);
	}

	private async fetchEmail(token: string): Promise<string | null> {
		try {
			const response = await fetch(USERINFO_URL, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) return null;
			const body = await readJsonBody(response);
			return stringField(body, 'email') ?? null;
		} catch {
			return null;
		}
	}
}
