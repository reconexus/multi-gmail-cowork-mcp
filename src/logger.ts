import { loadConfig } from './config.js';

/**
 * Structured, safe-by-default logging.
 *
 * Deliberately has no "verbose" mode that logs tokens, credentials, email bodies,
 * subjects, or sender/recipient addresses — that redaction is not configurable,
 * so flipping LOG_LEVEL to debug can never leak Gmail content or secrets.
 */

type LogFields = Record<string, string | number | boolean | undefined>;

function write(level: 'info' | 'error' | 'debug', event: string, fields: LogFields = {}): void {
  const config = loadConfig();
  if (level === 'debug' && config.logLevel !== 'debug') return;

  const line = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  error: (event: string, fields?: LogFields) => write('error', event, fields),
  debug: (event: string, fields?: LogFields) => write('debug', event, fields),
};
