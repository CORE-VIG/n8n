const DROPPED_ELEMENTS = /<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const BLOCK_BREAKS = /<\/p>|<br\s*\/?>|<\/div>|<\/li>|<\/h[1-6]>|<h[1-6][^>]*>/gi;
const TAGS = /<[^>]+>/g;

/**
 * A page's visible text: script and style gone, tags gone, entities decoded.
 * Paragraph breaks survive because block tags turn into newlines before the
 * rest of the markup is stripped.
 */
export function htmlToText(html: string): string {
	const withoutCode = html.replace(DROPPED_ELEMENTS, ' ').replace(COMMENTS, ' ');
	const withBreaks = withoutCode.replace(BLOCK_BREAKS, '\n');
	const withoutTags = withBreaks.replace(TAGS, ' ');
	return normalizeWhitespace(decodeEntities(withoutTags));
}

/** The page's `<title>`, decoded and collapsed to one line; null when absent. */
export function extractHtmlTitle(html: string): string | null {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match) return null;
	const title = normalizeWhitespace(decodeEntities(match[1]))
		.replace(/\n+/g, ' ')
		.trim();
	return title.length > 0 ? title : null;
}

/**
 * Only the five predefined XML entities plus `&nbsp;`, decoded last-to-first
 * so a literal `&amp;lt;` in the source reads back as `&lt;`, not `<`.
 */
function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

/** Collapses runs of spaces and blank lines, but keeps one blank line as a paragraph break. */
function normalizeWhitespace(text: string): string {
	return text
		.split('\n')
		.map((line) => line.replace(/[ \t]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
