import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAdminRouter } from './adminRouter.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { mcpBearerAuth } from './mcpAuth.js';
import { createMcpServer } from './mcpServer.js';
import { createOAuthCallbackRouter } from './oauthCallback.js';

const config = loadConfig();
const app = express();
app.disable('x-powered-by');

// No auth: used by Cloud Run / uptime checks. Returns no sensitive information.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use((req, res, next) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const start = Date.now();
  res.on('finish', () => {
    log.info('http_request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// Human admin UI — connect/disconnect Gmail accounts. Protected by HTTP Basic Auth.
app.use('/admin', createAdminRouter());

// Google's redirect target after a user approves (or denies) Gmail access for one alias.
app.use('/oauth', createOAuthCallbackRouter());

// The MCP endpoint Claude talks to. Stateless Streamable HTTP: a fresh MCP server
// and transport per request, so any Cloud Run instance can serve any request with
// no session affinity required. Gated by mcpBearerAuth (see mcpAuth.ts).
app.post('/mcp', express.json(), mcpBearerAuth(), async (req, res) => {
  try {
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error('mcp_request_failed', { message: (err as Error).message });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/mcp', mcpBearerAuth(), (_req, res) => {
  res
    .status(405)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed in stateless mode.' }, id: null });
});
app.delete('/mcp', mcpBearerAuth(), (_req, res) => {
  res
    .status(405)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed in stateless mode.' }, id: null });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(config.port, () => {
  log.info('server_started', {
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    tokenStore: config.tokenStore,
    writeToolsEnabled: config.enableWriteTools,
  });
});
