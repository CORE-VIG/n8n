import { describe, it, expect } from 'vitest';

import {
	checkUrl,
	ownHosts,
	renderSnapshot,
	parseLinksJsonl,
	parseInteractiveElements,
	MAX_URL_CHARS,
} from './aon-browser.service';

const OWN = ['auto.cod-a.com', '10.0.1.1'];

describe('checkUrl', () => {
	const refused: Array<[string, RegExp]> = [
		// the four shapes the port carries over from the standalone client
		['http://10.0.1.1:9030', /private or reserved/],
		['http://localhost:3000', /local name/],
		['https://user:pw@example.com', /username or password/],
		['https://auto.cod-a.com', /own host/],
		// schemes
		['ftp://example.com/x', /only http and https/],
		['file:///etc/passwd', /only http and https/],
		['javascript:alert(1)', /only http and https/],
		// local names
		['http://LOCALHOST/', /local name/],
		['http://foo.localhost/', /local name/],
		['http://printer.local/', /local name/],
		['http://db.internal/', /local name/],
		['http://intranet/', /no dot/],
		// IPv4 literals isPublicAddress refuses
		['http://127.0.0.1/', /private or reserved/],
		['http://0.0.0.0/', /private or reserved/],
		['http://10.255.255.255/', /private or reserved/],
		['http://172.16.0.1/', /private or reserved/],
		['http://172.31.255.254/', /private or reserved/],
		['http://192.168.1.1/', /private or reserved/],
		['http://169.254.169.254/latest/meta-data', /private or reserved/],
		['http://100.64.0.1/', /private or reserved/],
		['http://100.127.255.255/', /private or reserved/],
		['http://255.255.255.255/', /private or reserved/],
		// IPv6 literals isPublicAddress refuses
		['http://[::1]/', /private or reserved/],
		['http://[::]/', /private or reserved/],
		['http://[fc00::1]/', /private or reserved/],
		['http://[fd12:3456::1]/', /private or reserved/],
		['http://[fe80::1]/', /private or reserved/],
		['http://[::ffff:127.0.0.1]/', /private or reserved/],
		// own hosts, including subdomains and a private service beside this instance
		['https://api.auto.cod-a.com/', /own host/],
		['https://AUTO.COD-A.COM/anything', /own host/],
		['http://10.0.1.1:9040/mcp', /private or reserved/],
		// shape
		['', /required/],
		['   ', /required/],
		['not a url', /not a URL/],
		['http://', /not a URL/],
		[`https://example.com/${'a'.repeat(MAX_URL_CHARS)}`, /longer than/],
	];

	test.each(refused)('refuses %s', (url, why) => {
		const r = checkUrl(url, OWN);
		expect(r.ok).toBe(false);
		expect(r.ok ? '' : r.reason).toMatch(why);
	});

	const allowed: Array<[string, string]> = [
		['https://cod-a.com', 'https://cod-a.com/'],
		['https://cod-a.com/services#hero', 'https://cod-a.com/services'],
		['http://example.com/a?b=c', 'http://example.com/a?b=c'],
		['  https://Example.COM/Path  ', 'https://example.com/Path'],
		['https://[2606:2800:220:1:248:1893:25c8:1946]/', 'https://[2606:2800:220:1:248:1893:25c8:1946]/'],
		['http://8.8.8.8/', 'http://8.8.8.8/'],
		['http://11.0.0.1/', 'http://11.0.0.1/'],
		['http://172.32.0.1/', 'http://172.32.0.1/'],
		['http://100.128.0.1/', 'http://100.128.0.1/'],
		['https://sub.auto.example.com/', 'https://sub.auto.example.com/'],
	];

	test.each(allowed)('allows %s', (url, normalised) => {
		const r = checkUrl(url, OWN);
		expect(r.ok).toBe(true);
		expect(r.ok && r.url).toBe(normalised);
	});

	it('refuses non-string input', () => {
		expect(checkUrl(undefined, OWN).ok).toBe(false);
		expect(checkUrl(42, OWN).ok).toBe(false);
	});

	it('refuses a root-anchored local name the same as its unanchored form', () => {
		for (const u of ['http://localhost./', 'http://LOCALHOST./', 'http://x.internal./', 'http://x.local./']) {
			expect(checkUrl(u, OWN).ok).toBe(false);
		}
		expect(checkUrl('https://cod-a.com./', OWN).ok).toBe(true);
		expect(checkUrl('https://auto.cod-a.com./', OWN).ok).toBe(false);
	});

	it('never opens this instance itself, even with no environment configured', () => {
		expect(checkUrl('https://auto.cod-a.com', []).ok).toBe(true); // not an own host unless N8N_HOST said so
		expect(checkUrl('https://auto.cod-a.com', ['auto.cod-a.com']).ok).toBe(false);
	});
});

describe('ownHosts', () => {
	it('reads every private service this instance talks to, plus its own host', () => {
		expect(
			ownHosts({
				N8N_HOST: 'auto.cod-a.com',
				AON_BROWSER_URL: 'http://10.0.1.1:9040/mcp',
				N8N_SANDBOX_SERVICE_URL: 'http://10.0.1.1:9050',
				AON_MCP_URL: 'junk',
			}).sort(),
		).toEqual(['10.0.1.1', 'auto.cod-a.com']);
	});

	it('is empty with no environment', () => {
		expect(ownHosts({})).toEqual([]);
	});
});

describe('renderSnapshot', () => {
	it('pulls the url, title and body text out of the real Obscura shape, dropping the trailing element count', () => {
		const raw =
			'URL: https://example.com/\nTitle: Example Domain\n\nExample Domain\n\nThis domain is for use in documentation examples without needing permission. Avoid use in operations.\n\nLearn more\n\n1 interactive element(s) registered. Call browser_interactive_elements to list, or pass `ref` to browser_click/browser_fill/browser_type.';
		const r = renderSnapshot(raw);
		expect(r.url).toBe('https://example.com/');
		expect(r.title).toBe('Example Domain');
		expect(r.text).toContain('This domain is for use in documentation examples');
		expect(r.text).not.toContain('interactive element(s) registered');
	});

	it('falls back to the whole body when there is no header', () => {
		const r = renderSnapshot('just some text');
		expect(r.url).toBe('');
		expect(r.title).toBe('');
		expect(r.text).toBe('just some text');
	});

	it('drops a "No interactive elements." footer too', () => {
		const raw = 'URL: https://a.example/\nTitle: A\n\nbody text\n\nNo interactive elements.';
		expect(renderSnapshot(raw).text).toBe('body text');
	});
});

describe('parseLinksJsonl', () => {
	it('parses one {text, href} object per line', () => {
		const raw = '{"text":"Learn more","href":"https://iana.org/domains/example"}\n{"text":"Home","href":"/"}';
		expect(parseLinksJsonl(raw)).toEqual([
			{ text: 'Learn more', href: 'https://iana.org/domains/example' },
			{ text: 'Home', href: '/' },
		]);
	});

	it('skips blank and malformed lines rather than throwing', () => {
		const raw = '\n{"text":"ok","href":"/ok"}\nnot json\n{"href":"/no-text"}\n{"text":"no-href"}';
		expect(parseLinksJsonl(raw)).toEqual([{ text: 'ok', href: '/ok' }]);
	});

	it('returns an empty list for empty input', () => {
		expect(parseLinksJsonl('')).toEqual([]);
	});
});

describe('parseInteractiveElements', () => {
	it('parses the fixed-column ref/tag/description line Obscura returns', () => {
		const raw = 'ref=e1    a                      "Learn more"\nref=e2    button                 "Submit"';
		expect(parseInteractiveElements(raw)).toEqual([
			{ ref: 'e1', tag: 'a', desc: 'Learn more' },
			{ ref: 'e2', tag: 'button', desc: 'Submit' },
		]);
	});

	it('ignores lines that are not the ref= shape', () => {
		expect(parseInteractiveElements('no elements found\n\nref=e9 input "Email"')).toEqual([
			{ ref: 'e9', tag: 'input', desc: 'Email' },
		]);
	});
});
