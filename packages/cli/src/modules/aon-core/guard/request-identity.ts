import type { AonGuardIdentity } from '@n8n/api-types';
import type { User } from '@n8n/db';

const AGENT_HEADER = 'x-aon-identity';
const RUN_HEADER = 'x-aon-run';
const AGENT_IDENTITY_RE = /^agent:([a-z0-9._-]+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function hasHeaderGetter(value: unknown): value is { get(name: string): string | null } {
	return isRecord(value) && typeof value.get === 'function';
}

/**
 * Reads one header off the raw HTTP request the MCP SDK hands tool handlers
 * as their second argument.
 *
 * This SDK (`@modelcontextprotocol/server` 2.0) does not carry
 * `requestInfo.headers` the way the older SDK docs describe — there is no
 * `RequestHandlerExtra.requestInfo` here at all (confirmed: nothing in
 * `node_modules/.pnpm/@modelcontextprotocol+server@2.0.0/.../dist/*.d.{m,c}ts`
 * matches `RequestHandlerExtra`). Instead, the second argument passed to a
 * tool callback is a `ServerContext` (see `createMcpHandler-*.d.ts`), whose
 * `http.req` is a WHATWG `Request` built from the raw Node request headers.
 * `packages/cli/src/modules/mcp/mcp.controller.ts` calls
 * `toNodeHandler(handler)(req, res, body)` from `@modelcontextprotocol/node`;
 * that adapter's `toWebRequest` (`node_modules/.pnpm/@modelcontextprotocol+node@2.0.0.../dist/index.mjs`)
 * builds a `Headers` object from every entry of Node's `req.headers`,
 * unfiltered, and `Server.buildContext`
 * (`node_modules/.pnpm/@modelcontextprotocol+server@2.0.0.../dist/mcp-*.mjs`)
 * puts that same `Request` on `ctx.http.req` — it already reads
 * `ctx.http?.req?.headers.get(...)` itself, for the session id. So a custom
 * header the executor sets on its HTTP request reaches this function intact,
 * just at `extra.http.req.headers.get(name)` rather than the documented
 * `extra.requestInfo.headers`.
 */
function headerValue(extra: unknown, name: string): string | undefined {
	if (!isRecord(extra)) return undefined;
	const http = extra.http;
	if (!isRecord(http)) return undefined;
	const req = http.req;
	if (!isRecord(req)) return undefined;
	const headers = req.headers;
	if (!hasHeaderGetter(headers)) return undefined;
	const value = headers.get(name);
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The identity behind one MCP tool call. The executor stamps
 * `x-aon-identity: agent:<slug>` and `x-aon-run: <runId>` on its connection
 * for an agent run; without a recognised `x-aon-identity` header (the
 * assistant window, or any other owner MCP client) this is the owner acting
 * directly — every route that reaches a tool handler already belongs to an
 * authenticated n8n user, and Aon has exactly one owner. `tierCeiling` is
 * left undefined for an agent: `AonGuardService.defaultVerdict` treats a
 * missing ceiling as 2.
 */
export function identityFromRequest(extra: unknown, _user: User): AonGuardIdentity {
	const rawIdentity = headerValue(extra, AGENT_HEADER);
	const match = rawIdentity ? AGENT_IDENTITY_RE.exec(rawIdentity) : null;
	const slug = match?.[1];
	if (slug) {
		return { kind: 'agent', name: slug, runId: headerValue(extra, RUN_HEADER) };
	}
	return { kind: 'owner', name: 'owner' };
}
