import { Service } from '@n8n/di';
import { DataSource, In, Repository } from '@n8n/typeorm';

import { AonToolbox } from '../entities/aon-toolbox.entity';

/** What a scan of the toolbox found or a `POST /aon/toolbox/rescan` needs to write. */
export interface AonToolboxUpsertInput {
	slug: string;
	kind: string;
	name: string;
	summary: string;
	whenToUse: string | null;
	location: string;
	invocation: string | null;
	tags: string[];
	estTokens: number;
}

/**
 * The toolbox table: one row per tool, unique on `slug`. `AonToolboxService`
 * is the only caller — it owns the three rules (a scan never deletes, never
 * overwrites use, an empty field beats a guessed one) and this repository
 * just applies whatever it decides.
 */
@Service()
export class AonToolboxRepository extends Repository<AonToolbox> {
	constructor(dataSource: DataSource) {
		super(AonToolbox, dataSource.manager);
	}

	async listAll(): Promise<AonToolbox[]> {
		return await this.find({ order: { slug: 'ASC' } });
	}

	async findBySlug(slug: string): Promise<AonToolbox | null> {
		return await this.findOne({ where: { slug } });
	}

	/** A new row from a scan. `source` defaults to `'disk'`, same as the retired standalone Aon. */
	async insertFound(id: string, found: AonToolboxUpsertInput, source: string): Promise<void> {
		const now = new Date();
		await this.insert({
			id,
			slug: found.slug,
			kind: found.kind,
			name: found.name,
			summary: found.summary,
			whenToUse: found.whenToUse,
			location: found.location,
			invocation: found.invocation,
			tags: found.tags,
			estTokens: found.estTokens,
			source,
			uses: 0,
			lastUsedAt: null,
			lastUsedBy: null,
			missingSince: null,
			meta: null,
			createdAt: now,
			updatedAt: now,
		});
	}

	/**
	 * A row a rescan found again with different contents. Never touches
	 * `uses`, `lastUsedAt` or `lastUsedBy`: a scan read a file, which says
	 * nothing about whether anyone reached for it.
	 */
	async updateFound(id: string, found: AonToolboxUpsertInput): Promise<void> {
		await this.update(
			{ id },
			{
				kind: found.kind,
				name: found.name,
				summary: found.summary,
				whenToUse: found.whenToUse,
				location: found.location,
				invocation: found.invocation,
				tags: found.tags,
				estTokens: found.estTokens,
				updatedAt: new Date(),
			},
		);
	}

	/** Starts the grace clock: in scope, not found this time, not already counting. */
	async markMissing(ids: string[], when: Date): Promise<void> {
		if (ids.length === 0) return;
		await this.update({ id: In(ids) }, { missingSince: when, updatedAt: when });
	}

	/** Stops the clock: it was away, and it is back. */
	async markBack(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.update({ id: In(ids) }, { missingSince: null, updatedAt: new Date() });
	}

	/**
	 * Records that an identity reached for a tool: the one thing a scan
	 * cannot rebuild, so nothing else may write it.
	 */
	async recordUse(slug: string, actor: string): Promise<AonToolbox | null> {
		const existing = await this.findBySlug(slug);
		if (!existing) return null;
		await this.increment({ slug }, 'uses', 1);
		await this.update({ slug }, { lastUsedAt: new Date(), lastUsedBy: actor });
		return await this.findBySlug(slug);
	}
}
