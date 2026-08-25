import type { OAuth2Client } from 'google-auth-library';
import { clientForRefreshToken } from './googleOAuth.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
}

interface GmailListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

// Gmail message/thread IDs are hex strings in practice, but this is deliberately a
// little more permissive while still rejecting anything that could act as a path
// separator or traversal segment when interpolated into a Gmail API URL path.
const MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export class InvalidMessageIdError extends Error {
  constructor(messageId: string) {
    super(`Invalid Gmail message ID: "${messageId}".`);
  }
}

/**
 * Validates AND percent-encodes a caller-supplied Gmail message ID before it is
 * interpolated into a request path. Defense in depth against path-segment
 * injection (e.g. "../settings/forwardingAddresses") reaching a Gmail API
 * endpoint other than the one a tool is meant to call — validated here even
 * though callers also validate at the MCP tool-schema layer, because message
 * IDs can originate from email content an LLM just read (indirect prompt
 * injection), not only from a manually typed argument.
 */
function encodeMessageId(messageId: string): string {
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    throw new InvalidMessageIdError(messageId);
  }
  return encodeURIComponent(messageId);
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function gmailFetch<T>(
  client: OAuth2Client,
  path: string,
  params: Record<string, string | number | string[] | undefined>,
  request: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Gmail access token.');

  const url = new URL(`${GMAIL_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method: request.method ?? 'GET', headers, body });
  if (!res.ok) {
    throw new GmailApiError(`Gmail API request to ${path} failed with HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

function headerLookup(headers: GmailHeader[] | undefined, name: string): string {
  const found = headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  sizeEstimate?: number;
}

interface ExtractedBody {
  text?: string;
  html?: string;
  attachments: AttachmentMeta[];
}

/** Recursively walks a (possibly multipart) message payload for the body text/html and attachment metadata. */
function extractBody(payload: GmailMessagePart | undefined): ExtractedBody {
  const result: ExtractedBody = { attachments: [] };

  function walk(part: GmailMessagePart | undefined): void {
    if (!part) return;
    if (part.filename) {
      result.attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeEstimate: part.body?.size,
      });
    }
    if (part.mimeType === 'text/plain' && part.body?.data && result.text === undefined) {
      result.text = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && part.body?.data && result.html === undefined) {
      result.html = decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) walk(child);
  }

  walk(payload);
  return result;
}

export interface SearchResultItem {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date'];

export async function searchMessages(
  refreshToken: string,
  query: string,
  maxResults: number,
): Promise<SearchResultItem[]> {
  const client = clientForRefreshToken(refreshToken);
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 50);

  const list = await gmailFetch<GmailListResponse>(client, '/messages', { q: query, maxResults: capped });
  const ids = list.messages ?? [];

  const messages = await Promise.all(
    ids.map((m) =>
      gmailFetch<GmailMessage>(client, `/messages/${encodeMessageId(m.id)}`, {
        format: 'metadata',
        metadataHeaders: METADATA_HEADERS,
      }),
    ),
  );

  return messages.map((msg) => ({
    id: msg.id,
    threadId: msg.threadId,
    from: headerLookup(msg.payload?.headers, 'From'),
    to: headerLookup(msg.payload?.headers, 'To'),
    subject: headerLookup(msg.payload?.headers, 'Subject'),
    date: headerLookup(msg.payload?.headers, 'Date'),
    snippet: msg.snippet ?? '',
  }));
}

export interface FullMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  body: { text?: string; html?: string };
  attachments: AttachmentMeta[];
}

export async function getMessage(refreshToken: string, messageId: string): Promise<FullMessage> {
  const client = clientForRefreshToken(refreshToken);
  const msg = await gmailFetch<GmailMessage>(client, `/messages/${encodeMessageId(messageId)}`, { format: 'full' });
  const body = extractBody(msg.payload);

  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    from: headerLookup(msg.payload?.headers, 'From'),
    to: headerLookup(msg.payload?.headers, 'To'),
    cc: headerLookup(msg.payload?.headers, 'Cc'),
    subject: headerLookup(msg.payload?.headers, 'Subject'),
    date: headerLookup(msg.payload?.headers, 'Date'),
    snippet: msg.snippet ?? '',
    body: { text: body.text, html: body.html },
    attachments: body.attachments,
  };
}

export interface ComposeMessageInput {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body: string;
}

export interface GmailWriteResult {
  id?: string;
  threadId?: string;
  labelIds?: string[];
}

export interface GmailDraftResult {
  id?: string;
  message?: GmailWriteResult;
}

function rejectHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${field} must not contain line breaks.`);
}

function normalizeRecipients(value: string | undefined, field: string, required: boolean): string | undefined {
  if (!value) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  rejectHeaderInjection(value, field);
  const recipients = value
    .split(',')
    .map((recipient) => recipient.trim())
    .filter(Boolean);
  if (recipients.length === 0 || recipients.some((recipient) => !/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(recipient))) {
    throw new Error(`${field} must contain one or more comma-separated email addresses.`);
  }
  return recipients.join(', ');
}

function encodeSubject(subject: string): string {
  rejectHeaderInjection(subject, 'subject');
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function buildRawMessage(input: ComposeMessageInput, requireRecipient: boolean): string {
  if (input.body.length > 100_000) throw new Error('body is too large (maximum 100,000 characters).');
  const to = normalizeRecipients(input.to, 'to', requireRecipient);
  const cc = normalizeRecipients(input.cc, 'cc', false);
  const bcc = normalizeRecipients(input.bcc, 'bcc', false);
  const subject = encodeSubject(input.subject ?? '');
  const body = input.body.replace(/\r\n?|\n/g, '\r\n');
  const headers = [
    ...(to ? [`To: ${to}`] : []),
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

export async function sendMessage(refreshToken: string, input: ComposeMessageInput): Promise<GmailWriteResult> {
  return gmailFetch<GmailWriteResult>(
    clientForRefreshToken(refreshToken),
    '/messages/send',
    {},
    { method: 'POST', body: { raw: buildRawMessage(input, true) } },
  );
}

export async function createDraft(refreshToken: string, input: ComposeMessageInput): Promise<GmailDraftResult> {
  return gmailFetch<GmailDraftResult>(
    clientForRefreshToken(refreshToken),
    '/drafts',
    {},
    { method: 'POST', body: { message: { raw: buildRawMessage(input, false) } } },
  );
}
