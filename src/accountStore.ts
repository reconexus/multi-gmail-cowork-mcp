import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import type { AccountRecord } from './types.js';

export interface AccountStore {
  list(): Promise<AccountRecord[]>;
  get(alias: string): Promise<AccountRecord | undefined>;
  upsert(record: AccountRecord): Promise<void>;
  remove(alias: string): Promise<AccountRecord | undefined>;
}

const CACHE_TTL_MS = 30_000;

interface VersionedAccounts {
  accounts: AccountRecord[];
  /** Resource name of the version this array was read from, e.g. ".../versions/3". */
  versionName: string | undefined;
}

/**
 * Backed by a single Secret Manager secret holding a JSON array of accounts.
 * Secret Manager versions are immutable, so "updating" means adding a new version.
 *
 * Two admin actions (e.g. connecting two accounts back-to-back, possibly on two
 * different Cloud Run instances) can race: both read the same starting array,
 * both write independently, and one write's account is logically lost from the
 * final array (the standard lost-update problem for unsynchronized
 * read-modify-write — Secret Manager has no compare-and-swap primitive to
 * prevent this, and adding real distributed locking is out of proportion for a
 * single-admin tool used a few times a month). What this class does guarantee:
 * a race can lose an *update*, but it can never permanently *destroy* a
 * concurrently-written version's data — cleanup only ever destroys the exact
 * version a write was based on, never "every other version", so an orphaned
 * version's payload remains recoverable via `gcloud secrets versions list`
 * even if it drops out of the logical "latest" array. A concurrent write is
 * also logged (account_store_possible_concurrent_write) so it's observable.
 */
class SecretManagerAccountStore implements AccountStore {
  private client = new SecretManagerServiceClient();
  private secretPath: string;
  private cache: { accounts: AccountRecord[]; fetchedAt: number } | undefined;

  constructor(projectId: string, secretName: string) {
    this.secretPath = `projects/${projectId}/secrets/${secretName}`;
  }

  private async readLatest(): Promise<VersionedAccounts> {
    try {
      const [version] = await this.client.accessSecretVersion({
        name: `${this.secretPath}/versions/latest`,
      });
      const data = version.payload?.data;
      const accounts = data
        ? (JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')) as AccountRecord[])
        : [];
      return { accounts, versionName: version.name ?? undefined };
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      // gRPC NOT_FOUND: secret exists but has no versions yet.
      if (code === 5) return { accounts: [], versionName: undefined };
      throw err;
    }
  }

  async list(): Promise<AccountRecord[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.accounts;
    }
    const { accounts } = await this.readLatest();
    this.cache = { accounts, fetchedAt: Date.now() };
    return accounts;
  }

  async get(alias: string): Promise<AccountRecord | undefined> {
    const accounts = await this.list();
    return accounts.find((a) => a.alias === alias);
  }

  /**
   * Reads fresh (never the cache — this is the write path, staleness here is
   * exactly what causes lost updates), applies `mutate`, and writes the result
   * as a new secret version.
   */
  private async write(mutate: (current: AccountRecord[]) => AccountRecord[]): Promise<void> {
    const { accounts: current, versionName: basedOnVersion } = await this.readLatest();
    const next = mutate(current);

    const payload = Buffer.from(JSON.stringify(next), 'utf8');
    const [newVersion] = await this.client.addSecretVersion({
      parent: this.secretPath,
      payload: { data: payload },
    });
    this.cache = { accounts: next, fetchedAt: Date.now() };

    // Destroy only the specific version this write was based on — never a blind
    // "every other enabled version" sweep, which could destroy a version a
    // concurrent write just created moments ago, permanently losing its data.
    if (basedOnVersion && basedOnVersion !== newVersion.name) {
      try {
        await this.client.destroySecretVersion({ name: basedOnVersion });
      } catch (err) {
        log.error('account_store_version_cleanup_failed', { message: (err as Error).message });
      }
    }

    // Best-effort observability: if any other ENABLED version still exists after
    // our own write, a concurrent write likely raced this one. Can't be
    // prevented without external locking (see class doc), but worth surfacing.
    try {
      const [versions] = await this.client.listSecretVersions({ parent: this.secretPath });
      const otherEnabled = versions.filter((v) => v.name !== newVersion.name && v.state === 'ENABLED');
      if (otherEnabled.length > 0) {
        log.error('account_store_possible_concurrent_write', { staleVersionCount: otherEnabled.length });
      }
    } catch {
      // Non-fatal — purely observability.
    }
  }

  async upsert(record: AccountRecord): Promise<void> {
    await this.write((current) => [...current.filter((a) => a.alias !== record.alias), record]);
  }

  async remove(alias: string): Promise<AccountRecord | undefined> {
    const existing = await this.get(alias);
    if (!existing) return undefined;
    let removed: AccountRecord | undefined;
    await this.write((current) => {
      removed = current.find((a) => a.alias === alias);
      return current.filter((a) => a.alias !== alias);
    });
    return removed ?? existing;
  }
}

/**
 * Local-development-only store, backed by a gitignored JSON file. Never selected
 * when NODE_ENV=production (config.ts refuses to load that way).
 */
class FileAccountStore implements AccountStore {
  private filePath: string;

  constructor() {
    this.filePath = join(process.cwd(), '.local', 'accounts.json');
  }

  private readAll(): AccountRecord[] {
    if (!existsSync(this.filePath)) return [];
    return JSON.parse(readFileSync(this.filePath, 'utf8')) as AccountRecord[];
  }

  private writeAll(accounts: AccountRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(accounts, null, 2), 'utf8');
  }

  async list(): Promise<AccountRecord[]> {
    return this.readAll();
  }

  async get(alias: string): Promise<AccountRecord | undefined> {
    return this.readAll().find((a) => a.alias === alias);
  }

  async upsert(record: AccountRecord): Promise<void> {
    const accounts = this.readAll().filter((a) => a.alias !== record.alias);
    accounts.push(record);
    this.writeAll(accounts);
  }

  async remove(alias: string): Promise<AccountRecord | undefined> {
    const accounts = this.readAll();
    const existing = accounts.find((a) => a.alias === alias);
    if (!existing) return undefined;
    this.writeAll(accounts.filter((a) => a.alias !== alias));
    return existing;
  }
}

let store: AccountStore | undefined;

export function getAccountStore(): AccountStore {
  if (store) return store;
  const config = loadConfig();
  store =
    config.tokenStore === 'file'
      ? new FileAccountStore()
      : new SecretManagerAccountStore(config.gcpProjectId, config.accountsSecretName);
  return store;
}
