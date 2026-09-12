import { getBrowserId } from '@n8n/constants';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/**
 * The window's ears and mouth: whether the host sidecar is up, one clip
 * transcribed, one reply spoken. Mirrors `/aon/voice/*` on the backend,
 * which is itself a thin guarded caller of the sidecar — nothing here
 * reasons, it just carries bytes.
 */

export interface AonVoiceStatus {
	configured: boolean;
	online: boolean;
}

export async function getVoiceStatus(context: IRestApiContext) {
	return await makeRestApiRequest<AonVoiceStatus>(context, 'GET', '/aon/voice/status');
}

/** One recorded clip in, its words back. */
export async function transcribeVoice(context: IRestApiContext, audio: Blob, fileName: string) {
	const formData = new FormData();
	formData.append('audio', audio, fileName);
	return await makeRestApiRequest<{ text: string }>(context, 'POST', '/aon/voice/transcribe', formData);
}

/**
 * Text in, spoken audio back. Bypasses `makeRestApiRequest`: that helper
 * always unwraps a JSON `{ data }` envelope, and this response is raw audio
 * bytes with the sidecar's own content-type, not JSON.
 */
export async function speakText(
	context: IRestApiContext,
	text: string,
): Promise<{ blob: Blob; mime: string }> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'push-ref': context.pushRef,
	};
	if (context.baseUrl.startsWith('/')) headers['browser-id'] = getBrowserId();

	const response = await fetch(`${context.baseUrl}/aon/voice/speak`, {
		method: 'POST',
		headers,
		credentials: 'include',
		body: JSON.stringify({ text }),
	});

	if (!response.ok) {
		let message = `Speaking failed (${response.status})`;
		try {
			const body: unknown = await response.json();
			if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
				message = body.message;
			}
		} catch {
			// the error body was not JSON; the status-based message above stands
		}
		throw new Error(message);
	}

	const blob = await response.blob();
	return { blob, mime: response.headers.get('content-type') ?? 'audio/mpeg' };
}
