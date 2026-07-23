import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Express, Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpDeps } from '../src/server-context.js';
import { registerMcpHttpRoutes } from '../src/routes/mcp-http.js';

interface Harness {
  daemon: http.Server;
  daemonUrl: string;
  mcpHttpUrl: string;
}

function createTestApp(): Express {
  const app = express();
  app.use(express.json());

  // Mock daemon API endpoints
  app.get('/api/skills', (_req: Request, res: Response) => {
    res.json({ skills: [] });
  });
  app.get('/api/design-systems', (_req: Request, res: Response) => {
    res.json({ designSystems: [] });
  });
  app.get('/api/design-systems/:id', (_req: Request, res: Response) => {
    res.json({});
  });
  app.get('/api/skills/:id', (_req: Request, res: Response) => {
    res.json({});
  });
  app.get('/api/projects', (_req: Request, res: Response) => {
    res.json({ projects: [] });
  });
  app.get('/api/active', (_req: Request, res: Response) => {
    res.json({ active: false });
  });

  const mockHttpDeps = {
    createSseResponse: () => {},
    isLocalSameOrigin: () => true,
    requireLocalDaemonRequest: () => {},
    resolvedPortRef: { current: 0 },
    sendApiError: () => {},
    sendLiveArtifactRouteError: () => {},
    sendMulterError: () => {},
  } satisfies HttpDeps;

  registerMcpHttpRoutes(app, { http: mockHttpDeps });

  return app;
}

function startServer(app: Express): Promise<Harness> {
  return new Promise((resolve) => {
    const tmp = http.createServer();
    tmp.listen(0, '127.0.0.1', () => {
      const { port } = tmp.address() as AddressInfo;
      tmp.close(() => {
        const server = app.listen(port, '127.0.0.1', () =>
          resolve({
            daemon: server,
            daemonUrl: `http://127.0.0.1:${port}`,
            mcpHttpUrl: `http://127.0.0.1:${port}/api/mcp/http`,
          }),
        );
      });
    });
  });
}

describe('MCP HTTP Transport', () => {
  let harness: Harness;

  beforeAll(async () => {
    const app = createTestApp();
    harness = await startServer(app);
  });

  afterAll(() => {
    harness?.daemon.close();
  });

  it('responds with a list of tools on initialize + tools/list', async () => {
    const initializeReq = {
      jsonrpc: '2.0',
      id: '1',
      method: 'initialize',
      params: {
        protocolVersion: '0.1.0',
        capabilities: { tools: {} },
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    };

    const initRes = await fetch(harness.mcpHttpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initializeReq),
    });

    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    await fetch(harness.mcpHttpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    const toolsReq = {
      jsonrpc: '2.0',
      id: '2',
      method: 'tools/list',
    };

    const toolsRes = await fetch(harness.mcpHttpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify(toolsReq),
    });

    expect(toolsRes.status).toBe(200);
    const toolsBody = await toolsRes.json();
    expect(toolsBody.jsonrpc).toBe('2.0');
    expect(toolsBody.result).toBeDefined();
    expect(toolsBody.result.tools).toBeInstanceOf(Array);
    expect(toolsBody.result.tools.length).toBeGreaterThan(0);
  });

  it('rejects GET requests without a session ID', async () => {
    const res = await fetch(harness.mcpHttpUrl, { method: 'GET' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Session ID');
  });

  it('rejects GET requests with an unknown session ID', async () => {
    const res = await fetch(harness.mcpHttpUrl, {
      method: 'GET',
      headers: { 'mcp-session-id': 'nonexistent-session-id' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('session not found');
  });

  it('has a valid MCP server that responds with resources/list', async () => {
    const initializeReq = {
      jsonrpc: '2.0',
      id: '1',
      method: 'initialize',
      params: {
        protocolVersion: '0.1.0',
        capabilities: { resources: {} },
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    };

    const initRes = await fetch(harness.mcpHttpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initializeReq),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    await fetch(harness.mcpHttpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });

    const resReq = {
      jsonrpc: '2.0',
      id: '2',
      method: 'resources/list',
    };

    const resRes = await fetch(harness.mcpHttpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify(resReq),
    });

    expect(resRes.status).toBe(200);
    const resBody = await resRes.json();
    expect(resBody.result.resources).toBeInstanceOf(Array);
  });
});
