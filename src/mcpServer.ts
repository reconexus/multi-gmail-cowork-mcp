import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAccountStore } from './accountStore.js';
import { GmailApiError, getMessage, searchMessages } from './gmail.js';
import { isReauthRequiredError } from './googleOAuth.js';
import { log } from './logger.js';
import { ALIAS_PATTERN } from './config.js';
import { toSummary, type AccountRecord } from './types.js';

const aliasSchema = z.string().regex(ALIAS_PATTERN, 'Account alias must be lowercase letters, digits, "-" or "_".');

// Matches gmail.ts's own MESSAGE_ID_PATTERN — rejected here too, at the tool-schema
// boundary, so a malformed ID (e.g. containing "../") never reaches gmail.ts at all.
const messageIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/, 'Gmail message IDs only contain letters, digits, "-" and "_".');

class AccountNotConnectedError extends Error {
  constructor(alias: string) {
    super(
      `No connected Gmail account with alias "${alias}". Connect it first via the admin page. ` +
        `This server never falls back to a different account.`,
    );
  }
}

async function resolveAccount(alias: string): Promise<AccountRecord> {
  const record = await getAccountStore().get(alias);
  if (!record) throw new AccountNotConnectedError(alias);
  return record;
}

function reauthMessage(account: AccountRecord): string {
  return (
    `Account "${account.alias}" (${account.email}) could not be accessed — its Google authorization ` +
    `appears to be expired or revoked. Reconnect it from the admin page. No other account was used.`
  );
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'multi-gmail-cowork-mcp', version: '0.1.0' });

  server.registerTool(
    'list_accounts',
    {
      title: 'List connected Gmail accounts',
      description:
        'Returns the aliases, email addresses, and connection status of every Gmail account this ' +
        'server currently has access to. Never returns tokens or secrets.',
      inputSchema: {},
    },
    async () => {
      const accounts = await getAccountStore().list();
      return jsonResult(accounts.map(toSummary));
    },
  );

  server.registerTool(
    'search_emails',
    {
      title: 'Search one Gmail account',
      description:
        'Searches a single connected Gmail account using Gmail search syntax (e.g. "from:david@example.com ' +
        'newer_than:30d"). Returns lightweight metadata (sender, subject, date, snippet) — not full bodies. ' +
        'Every result is attributed to the account alias and email address it came from.',
      inputSchema: {
        account: aliasSchema.describe('The alias of the connected Gmail account to search, e.g. "work".'),
        query: z.string().min(1).max(500).describe('Gmail search query syntax.'),
        max_results: z.number().int().min(1).max(50).default(10).describe('Maximum results to return (1-50).'),
      },
    },
    async ({ account, query, max_results }) => {
      const record = await resolveAccount(account);
      log.info('tool_search_emails', { account });
      try {
        const results = await searchMessages(record.refreshToken, query, max_results);
        return jsonResult({ account: record.alias, email: record.email, results });
      } catch (err) {
        if (err instanceof GmailApiError && isReauthRequiredError(err)) {
          return errorResult(reauthMessage(record));
        }
        log.error('tool_search_emails_failed', { account, message: (err as Error).message });
        return errorResult(`Search failed for account "${account}": ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'get_email',
    {
      title: 'Get one email',
      description:
        'Fetches the full content (headers, body, attachment metadata) of a single email from a connected ' +
        'Gmail account. The result clearly identifies which account it came from.',
      inputSchema: {
        account: aliasSchema.describe('The alias of the connected Gmail account the message belongs to.'),
        message_id: messageIdSchema.describe('The Gmail message ID, as returned by search_emails.'),
      },
    },
    async ({ account, message_id }) => {
      const record = await resolveAccount(account);
      log.info('tool_get_email', { account });
      try {
        const message = await getMessage(record.refreshToken, message_id);
        return jsonResult({ account: record.alias, email: record.email, message });
      } catch (err) {
        if (err instanceof GmailApiError && isReauthRequiredError(err)) {
          return errorResult(reauthMessage(record));
        }
        log.error('tool_get_email_failed', { account, message: (err as Error).message });
        return errorResult(`Fetching message failed for account "${account}": ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    'search_all_accounts',
    {
      title: 'Search every connected Gmail account',
      description:
        'Searches every connected Gmail account independently with the same Gmail search query. Results are ' +
        'grouped by account. If one account fails (e.g. revoked authorization), that account\'s failure is ' +
        'reported on its own — the other accounts\' results are still returned.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Gmail search query syntax.'),
        max_results_per_account: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Maximum results to return per account (1-50).'),
      },
    },
    async ({ query, max_results_per_account }) => {
      const accounts = await getAccountStore().list();
      log.info('tool_search_all_accounts', { accountCount: accounts.length });

      const outcomes = await Promise.allSettled(
        accounts.map(async (record) => ({
          account: record.alias,
          email: record.email,
          results: await searchMessages(record.refreshToken, query, max_results_per_account),
        })),
      );

      const results: { account: string; email: string; results: unknown[] }[] = [];
      const errors: { account: string; email: string; error: string }[] = [];

      outcomes.forEach((outcome, i) => {
        const record = accounts[i]!;
        if (outcome.status === 'fulfilled') {
          results.push(outcome.value);
        } else {
          const err = outcome.reason as Error;
          const message =
            err instanceof GmailApiError && isReauthRequiredError(err)
              ? 'Authorization expired or revoked — reconnect this account from the admin page.'
              : err.message;
          errors.push({ account: record.alias, email: record.email, error: message });
        }
      });

      return jsonResult({ results, errors });
    },
  );

  return server;
}
