import { GMAIL_MODIFY_SCOPE } from './config.js';

/** A single connected Gmail account. Persisted in the account store. */
export interface AccountRecord {
  alias: string;
  email: string;
  refreshToken: string;
  connectedAt: string;
  scopes: string[];
}

/** Safe, public view of an account — never includes refreshToken. */
export interface AccountSummary {
  alias: string;
  email: string;
  status: 'connected' | 'reauthorization_required';
}

export function toSummary(record: AccountRecord): AccountSummary {
  return {
    alias: record.alias,
    email: record.email,
    status: record.scopes.includes(GMAIL_MODIFY_SCOPE) ? 'connected' : 'reauthorization_required',
  };
}
