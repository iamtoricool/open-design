import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server-factory.js';

const MCP_STDIO_IDLE_EXIT_MS = 30 * 60 * 1000;

interface RunMcpOptions { daemonUrl: string | URL }

interface McpIdleExitControllerOptions {
  idleMs: number;
  onIdle: () => void;
}

export function _createMcpIdleExitController({
  idleMs,
  onIdle,
}: McpIdleExitControllerOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;
  let disposed = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (disposed) return;
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      if (inFlight > 0) {
        schedule();
        return;
      }
      disposed = true;
      onIdle();
    }, idleMs);
  };

  schedule();

  return {
    noteActivity() {
      schedule();
    },
    async trackRequest<T>(fn: () => T | Promise<T>): Promise<T> {
      if (disposed) {
        return fn();
      }
      inFlight += 1;
      schedule();
      try {
        return await fn();
      } finally {
        inFlight -= 1;
        if (inFlight === 0) {
          schedule();
        }
      }
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

export async function runMcpStdio({ daemonUrl }: RunMcpOptions): Promise<void> {
  const baseUrl = String(daemonUrl).replace(/\/$/, '');
  let closeTransportForIdle: (() => void) | null = null;
  const idleExit = _createMcpIdleExitController({
    idleMs: MCP_STDIO_IDLE_EXIT_MS,
    onIdle: () => closeTransportForIdle?.(),
  });
  const withMcpActivity =
    <Args extends unknown[], Result>(handler: (...args: Args) => Result | Promise<Result>) =>
      (...args: Args) =>
        idleExit.trackRequest(() => handler(...args));

  const server = createMcpServer(baseUrl, withMcpActivity);

  const transport = new StdioServerTransport();
  try {
    closeTransportForIdle = () => {
      void transport.close().catch(() => {});
    };
    await server.connect(transport);

    const sdkOnMessage = transport.onmessage;
    transport.onmessage = (...args) => {
      idleExit.noteActivity();
      sdkOnMessage?.(...args);
    };

    await new Promise<void>((resolve) => {
      const sdkOnClose = transport.onclose;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        idleExit.dispose();
        resolve();
      };
      transport.onclose = () => {
        sdkOnClose?.();
        done();
      };
      const closeTransportForStdin = () => {
        void transport.close().catch(() => done());
      };
      process.stdin.once('end', closeTransportForStdin);
      process.stdin.once('close', closeTransportForStdin);
    });
  } finally {
    idleExit.dispose();
    closeTransportForIdle = null;
  }
}

export {
  handleMcpToolCall,
  _resetWebBaseUrlCache,
  resolveProjectId,
  resolveProjectArg,
  withActiveEcho,
  fetchProjectFile,
  getArtifact,
  getFile,
  extractRelativeRefs,
  createArtifact,
} from './mcp-server-factory.js';
