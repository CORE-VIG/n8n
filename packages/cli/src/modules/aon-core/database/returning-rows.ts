/**
 * TypeORM's postgres driver answers an UPDATE or DELETE that RETURNs rows with
 * `[rows, affectedCount]`, while a SELECT or INSERT answers with the rows
 * themselves. This takes either and hands back the rows.
 */
export function returningRows<T>(raw: unknown): T[] {
	if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0]) && typeof raw[1] === 'number') {
		return raw[0].filter((row): row is T => typeof row === 'object' && row !== null);
	}
	return Array.isArray(raw) ? raw.filter((row): row is T => typeof row === 'object' && row !== null) : [];
}
