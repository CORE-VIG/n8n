import { Config, Env } from '../decorators';

/**
 * Aon inside n8n.
 *
 * The assistant is a Claude Code session on the owner's subscription. Nothing
 * here is an API key: the CLI authenticates from its own home directory, which
 * is mounted into the container.
 */
@Config
export class AonConfig {
	/** The Claude Code binary. */
	@Env('AON_CLAUDE_BIN')
	claudeBin: string = 'claude';

	/** The CLI's home: credentials, sessions. Mounted, owned by the n8n user. */
	@Env('AON_CLAUDE_HOME')
	claudeHome: string = '/home/node/.claude';

	/** The model band the assistant answers on: haiku | sonnet | opus. */
	@Env('AON_TALK_MODEL')
	talkModel: string = 'sonnet';

	/** Where the assistant reaches this instance's own MCP server. */
	@Env('AON_MCP_URL')
	mcpUrl: string = 'http://127.0.0.1:5678/mcp-server/http';

	/** Wall clock for one assistant turn, in milliseconds. */
	@Env('AON_TALK_TIMEOUT_MS')
	talkTimeoutMs: number = 10 * 60_000;
}
