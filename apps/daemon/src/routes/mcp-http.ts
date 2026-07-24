import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp-server-factory.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterMcpHttpRoutesDeps extends RouteDeps<'http'> {}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
}

const sessions = new Map<string, SessionEntry>();
const SESSION_TTL_MS = 30 * 60 * 1000;

function getOrCreateSession(sessionId: string | null, daemonUrl: string): { transport: StreamableHTTPServerTransport; sessionId: string; isNew: boolean } {
  const id = sessionId ?? crypto.randomUUID();
  const existing = sessions.get(id);
  if (existing) {
    return { transport: existing.transport, sessionId: id, isNew: false };
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });
  const server = createMcpServer(daemonUrl);
  server.connect(transport as Transport).catch((err) => {
    console.error('[mcp-http] server.connect error:', err);
    sessions.delete(id);
  });
  sessions.set(id, { transport, server });
  setTimeout(() => {
    const entry = sessions.get(id);
    if (entry) {
      entry.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }, SESSION_TTL_MS);
  return { transport, sessionId: id, isNew: true };
}

export function registerMcpHttpRoutes(app: Express, ctx: RegisterMcpHttpRoutesDeps): void {
  console.log('[mcp-http] registerMcpHttpRoutes called');
  console.error('[mcp-http] stderr: registerMcpHttpRoutes called');
  process.stderr.write('[mcp-http] process.stderr: registerMcpHttpRoutes called\n');
  
  app.post('/api/mcp/http', async (req: Request, res: Response) => {
    const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;
    const host = req.headers.host ?? 'localhost';
    const protocol = (req.socket as any)?.encrypted ? 'https' : 'http';
    const daemonUrl = `${protocol}://${host}`;

    const { transport, sessionId, isNew } = getOrCreateSession(sessionIdHeader ?? null, daemonUrl);

    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp-http] handleRequest error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/api/mcp/http', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({ error: 'MCP Session ID is required for GET requests (streaming)' });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'MCP session not found' });
      return;
    }
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp-http] GET handleRequest error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });
}
