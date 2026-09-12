import type { AonSettingsUpdate, AonSettingsView, AonSkillInfo } from '@n8n/api-types';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/** The whole Settings › Aon page in one call: persona, model, budget, skills, parts. */
export async function getSettings(ctx: IRestApiContext) {
	return await makeRestApiRequest<AonSettingsView>(ctx, 'GET', '/aon/settings');
}

export async function updateSettings(ctx: IRestApiContext, body: AonSettingsUpdate) {
	return await makeRestApiRequest<AonSettingsView>(ctx, 'PUT', '/aon/settings', body);
}

export async function setSkillEnabled(ctx: IRestApiContext, name: string, enabled: boolean) {
	return await makeRestApiRequest<AonSkillInfo>(
		ctx,
		'PUT',
		`/aon/settings/skills/${encodeURIComponent(name)}`,
		{ enabled },
	);
}
