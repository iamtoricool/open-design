// Shared MCP server factory — creates a configured `Server` instance
// with all tool/resource handlers wired to call the daemon API.
// Used by both the stdio `od mcp` CLI and the Streamable HTTP transport.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildProjectRawFileUrl } from '@open-design/contracts';
import { randomUUID } from 'node:crypto';

import { postCreateArtifactRequest } from './artifacts/create.js';

const SERVER_NAME = 'open-design';
const SERVER_VERSION = '0.2.0';

type JsonObject = Record<string, unknown>;
interface CatalogItem { id: string; name?: string; title?: string; description?: string; summary?: string }
interface SkillsPayload { skills?: CatalogItem[] }
interface PluginsPayload { plugins?: CatalogItem[] }
interface DesignSystemsPayload { designSystems?: CatalogItem[] }
interface ResourcePayload { skill?: { body?: string; content?: string }; designSystem?: { body?: string; content?: string }; body?: string; content?: string }
interface ProjectSummary { id: string; name: string; metadata?: JsonObject }
interface ProjectsPayload { projects?: ProjectSummary[] }
interface ProjectPayload { project?: ProjectSummary; id?: string; name?: string; metadata?: JsonObject; resolvedDir?: string }
interface ActiveContext { active?: boolean; projectId?: string; projectName?: string | null; fileName?: string | null; ageMs?: number | null }
type ResolvedProject = { id: string; name: string; source: 'uuid' | 'id' | 'exact' | 'slug' | 'substring' };
interface ProjectListCache { baseUrl: string; t: number; list: ProjectSummary[] }
interface McpArgs extends JsonObject { project?: unknown; entry?: unknown; include?: unknown; maxBytes?: unknown; path?: unknown; offset?: unknown; limit?: unknown; since?: unknown; query?: unknown; pattern?: unknown; max?: unknown; name?: unknown; content?: unknown; encoding?: unknown; artifactManifest?: unknown; confirm?: unknown; prompt?: unknown; plugin?: unknown; inputs?: unknown; agent?: unknown; model?: unknown; runId?: unknown; id?: unknown; designSystem?: unknown; skill?: unknown; includeUnavailable?: unknown }
interface ProjectFileBundleEntry { name: string; mime: string; size: number | null; content: string | null; binary: boolean }
interface BundleInput { project: ProjectPayload | ProjectSummary; entry: string; files: ProjectFileBundleEntry[]; truncated: boolean; active: ActiveContext | null; resolved?: ResolvedProject | null }
interface ErrorWithCode { message?: string; code?: string; cause?: { code?: string } }

const TEXTUAL_MIME_PATTERNS = [
  /^text\//,
  /^application\/json/,
  /^application\/xml/,
  /^application\/(x-)?javascript/,
  /^application\/typescript/,
  /^application\/yaml/,
  /^application\/toml/,
  /^application\/wasm/,
  /^application\/lua/,
  /^application\/python/,
  /^application\/ruby/,
  /^application\/shell/,
  /^application\/env/,
  /^application\/octet-stream.*charset/i,
  /^application\/x-httpd-php/,
  /^application\/x-shockwave-flash/,
  /^image\/svg\+xml/,
  /^font\/ttf/,
  /^font\/otf/,
  /^font\/woff2?/,
];

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotent: true,
  openWorld: false,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotent: false,
  openWorld: false,
} as const;

const PROJECT_ARG = {
  description:
    'Project UUID or name substring. Optional; defaults to the active project when the user has one open in OD. Active-file fallback expires after ~5 minutes of no Open Design activity.',
  type: 'string' as const,
};

const TOOL_DEFS = [
  {
    name: 'list_projects',
    description: 'List every Open Design project on this daemon.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'List Open Design projects' },
  },
  {
    name: 'get_active_context',
    description:
      'Project + file the user has open in Open Design right now. Returns {active:false, hint:"..."} when no project is active so the agent can ask the user to interact with Open Design (the active context expires ~5 minutes after the last user interaction). Most tools default to this when project is omitted, so you rarely need to call this directly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'What is the user looking at?' },
  },
  {
    name: 'get_artifact',
    description:
      'PREFER THIS over multiple get_file calls. Bundles the entry file plus every sibling it references (HTML <script>/<link>/<img>/srcset, JSX import/require, CSS url()/@import) up to depth 3, skipping CDN/data URLs. include="all" returns every file in the project; include="shallow" returns just the entry.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        entry: {
          description: 'Entry file path relative to project root. Defaults to the active file or project metadata.entryFile.',
          type: 'string',
        },
        include: {
          description: '"auto" (default): BFS from entry. "all": every file. "shallow": entry only.',
          type: 'string',
          enum: ['auto', 'all', 'shallow'],
        },
        maxBytes: {
          description: 'Approximate total byte cap for text content. Defaults to 1.5MB.',
          type: 'number',
        },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Bundle a design and its dependencies' },
  },
  {
    name: 'get_project',
    description:
      'Project metadata: name, path, mime, kind, size, mtime, optional artifactManifest. Pass since=<unix-ms> to cheap-poll for changes.',
    inputSchema: {
      type: 'object', properties: { project: PROJECT_ARG }, additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Open Design project metadata' },
  },
  {
    name: 'list_files',
    description:
      'List files in a project. Pass since=<unix-ms> (e.g. since=1712345678000) to only return files modified after that timestamp — cheap polling for file changes without re-fetching every file. Returns {files:[...], since:1712345678000} so you can pass the same since value on the next poll.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        since: { description: 'Unix timestamp ms. Only return files modified after this.', type: 'number' },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List project files' },
  },
  {
    name: 'get_file',
    description:
      'Read one file from a project. Returns up to 2000 lines starting at offset (default 0). Stamps a [od:file-window ...] marker when the file is longer; page by re-calling with the next offset. Supports nested paths (e.g. "codex-product/index.html"). Project defaults to active; path defaults to active file.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        path: {
          description: 'File path relative to project root, forward slashes. Optional; defaults to the active file when project is also omitted. Active-file fallback expires after ~5 minutes of no Open Design activity.',
          type: 'string',
        },
        offset: { description: 'Line offset to start from (0-indexed).', type: 'number' },
        limit: { description: 'Max lines to return. Default 2000.', type: 'number' },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Read a project file' },
  },
  {
    name: 'search_files',
    description:
      'Full-text search inside project files. Returns matching file paths with snippets. pattern limits to a glob (e.g. "**/*.html"); max caps results. Project defaults to active.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        query: { description: 'Search query (required).', type: 'string' },
        pattern: { description: 'Glob pattern filter (e.g. "**/*.css").', type: 'string' },
        max: { description: 'Maximum results (default 20).', type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Full-text search in project files' },
  },
  {
    name: 'create_artifact',
    description:
      'Create one normal artifact entry file in the active or specified project. The entry content can be any text (HTML, JSX, CSS, Markdown, etc.) and becomes the project\'s rendered entry. Rejects existing targets — use write_file to overwrite. Optional artifactManifest configures artifact behaviour.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        name: {
          description: 'Output path relative to the project root, for example "codex-product/index.html" or "deck.html".',
          type: 'string',
        },
        content: { description: 'File content (string).', type: 'string' },
        encoding: { description: 'Content encoding (default utf8, or base64).', type: 'string', enum: ['utf8', 'base64'] },
        artifactManifest: { description: 'Optional ArtifactManifest metadata object describing how the artifact is rendered (aesthetics, background, framing, interactivity, etc.).', type: 'object' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Create a new artifact entry file' },
  },
  {
    name: 'write_file',
    description:
      'Overwrite or freshly create any project file. Use this to iterate on a file create_artifact already wrote. Supports nested paths (e.g. "codex-product/index.html" or "components/Hero.tsx").',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        path: {
          description: 'Output path relative to the project root, e.g. "deck.html" or "components/Hero.tsx".',
          type: 'string',
        },
        content: { description: 'File content (string).', type: 'string' },
        encoding: { description: 'Content encoding (default utf8, or base64).', type: 'string', enum: ['utf8', 'base64'] },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Overwrite or create a project file' },
  },
  {
    name: 'delete_file',
    description:
      'Delete one file from a project. Supports nested paths (e.g. "codex-product/index.html"). Project optional; defaults to the active project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        path: {
          description: 'Project-relative path of the file to delete.',
          type: 'string',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Delete a project file' },
  },
  {
    name: 'delete_project',
    description:
      'Permanently delete a project and all its files. Requires explicit project + confirm:true (no active-context fallback). This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { description: 'Project UUID or name (required — no active-context fallback).', type: 'string' },
        confirm: { description: 'Must be true to proceed.', type: 'boolean' },
      },
      required: ['project', 'confirm'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Permanently delete a project' },
  },
  {
    name: 'create_project',
    description:
      'Create a new empty project. Use this first when the user wants to generate into a fresh project. Defaults to skipDiscoveryBrief:true because the outer agent IS the user-facing surface — you gather requirements, then pass a precise prompt to start_run.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { description: 'Display name.', type: 'string' },
        id: { description: 'Optional project ID (alphanumeric, dots, hyphens, underscores). Auto-derived from name when omitted.', type: 'string' },
        designSystem: { description: 'Optional design system ID to associate with the project.', type: 'string' },
        skill: { description: 'Optional skill ID to associate with the project.', type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Create an empty project' },
  },
  {
    name: 'list_skills',
    description: 'List every installed skill. Skills define what Open Design can generate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'List installed skills' },
  },
  {
    name: 'list_plugins',
    description: 'List every installed plugin. Plugins define what Open Design can generate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...READ_ANNOTATIONS, title: 'List installed plugins' },
  },
  {
    name: 'list_agents',
    description:
      'Agents available for start_run.agent. Default: returns agents whose CLIs are installed (available:true). Pass includeUnavailable=true to see every registered agent including ones whose binary is not on the machine. Models truncated to 10; modelsCount carries the full total.',
    inputSchema: {
      type: 'object',
      properties: {
        includeUnavailable: { description: 'Also show agents whose CLI binary is not installed.', type: 'boolean' },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'List available agents for generation' },
  },
  {
    name: 'start_run',
    description:
      'Kick off a design generation run. The daemon spawns its own agent; returns immediately with a runId. Poll get_run(runId) every 30–60s until status is succeeded/failed/canceled. Do NOT substitute write_file as a "faster" workaround — that throws away design quality.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_ARG,
        prompt: { description: 'The generation prompt / design brief.', type: 'string' },
        skill: { description: 'Skill ID (from list_skills, or omit for the default).', type: 'string' },
        plugin: { description: 'Plugin ID (from list_plugins).', type: 'string' },
        agent: { description: 'Agent ID (from list_agents).', type: 'string' },
        model: { description: 'Model for the inner agent (from the agent\'s models list). Defaults to agent default.', type: 'string' },
        inputs: { description: 'Plugin input values as a JSON object.', type: 'object' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Start a design generation run' },
  },
  {
    name: 'get_run',
    description:
      'Poll a run. Terminal status carries: previewUrl (open in browser), agentMessage (inner agent text output), studioUrl (OD studio deep link — ALWAYS render as clickable markdown link). Non-terminal status carries eventsLogPath you can tail. The hint field tells you exactly what to do next; read it.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { description: 'Run ID from start_run.', type: 'string' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    annotations: { ...READ_ANNOTATIONS, title: 'Poll a generation run' },
  },
  {
    name: 'cancel_run',
    description: 'Abort an in-flight run.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { description: 'Run ID from start_run.', type: 'string' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    annotations: { ...WRITE_ANNOTATIONS, title: 'Cancel a generation run' },
  },
];

function ok(payload: unknown) {
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function requireString(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${name} is required (string).`);
  }
}

async function handleMcpToolCall(baseUrl: string, name: unknown, args: McpArgs) {
  try {
    switch (name) {
      case 'list_projects':
        return ok(await getJson<ProjectsPayload>(`${baseUrl}/api/projects`));
      case 'get_active_context': {
        const data = await getJson<ActiveContext>(`${baseUrl}/api/active`);
        if (!data || data.active === false) {
          return ok({
            active: false,
            hint: 'Open Design has no active project right now. The active context expires about 5 minutes after the last user interaction with Open Design, so the user may need to click into a project (or switch tabs inside one) to wake it up. Alternatively, pass project="<id-or-name>" to other tools to bypass active context entirely.',
          });
        }
        return ok(data);
      }
      case 'get_project': {
        const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
        const data = await getJson<ProjectPayload>(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
        const project = data?.project ?? data;
        const resolvedDir = typeof data?.resolvedDir === 'string' ? data.resolvedDir : null;
        const declaredEntry = project?.metadata?.entryFile ?? null;
        const entryFile = await resolveProjectEntry(baseUrl, id, declaredEntry);
        const previewUrl = rawPreviewUrl(baseUrl, id, entryFile);
        const webBase = await getWebBaseUrl(baseUrl);
        const conversationId = webBase ? await getDefaultConversationId(baseUrl, id) : null;
        const studioUrl = buildStudioUrl(webBase, id, conversationId, entryFile);
        return ok(
          withActiveEcho(
            {
              ...project,
              entryFile,
              kind: project?.metadata?.kind ?? null,
              resolvedDir,
              ...(previewUrl ? { previewUrl } : {}),
              ...(studioUrl ? { studioUrl } : {}),
            },
            active,
            resolved,
          ),
        );
      }
      case 'list_files': {
        const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
        const params = new URLSearchParams();
        if (typeof args.since === 'number' && Number.isFinite(args.since)) params.set('since', String(args.since));
        const qs = params.toString();
        const url = `${baseUrl}/api/projects/${encodeURIComponent(id)}/files${qs ? `?${qs}` : ''}`;
        return ok(withActiveEcho(await getJson(url), active, resolved));
      }
      case 'get_file': {
        const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
        let path = typeof args.path === 'string' ? args.path : '';
        if (!path && active && active.fileName) {
          path = active.fileName;
        }
        requireString(path, 'path');
        const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : 2000;
        return await getFile(baseUrl, id, path, active, resolved, offset, limit);
      }
      case 'get_artifact':
        return await getArtifact(
          baseUrl,
          args.project,
          args.entry,
          args.include,
          args.maxBytes,
        );
      case 'search_files': {
        const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
        requireString(args.query, 'query');
        const params = new URLSearchParams({ q: String(args.query) });
        if (args.pattern) params.set('pattern', String(args.pattern));
        if (args.max) params.set('max', String(args.max));
        return ok(
          withActiveEcho(
            await getJson(
              `${baseUrl}/api/projects/${encodeURIComponent(id)}/search?${params.toString()}`,
            ),
            active,
            resolved,
          ),
        );
      }
      case 'create_artifact':
        return await createArtifact(baseUrl, args);
      case 'write_file':
        return await writeFile(baseUrl, args);
      case 'delete_file':
        return await deleteFile(baseUrl, args);
      case 'delete_project':
        return await deleteProject(baseUrl, args);
      case 'create_project':
        return await createProject(baseUrl, args);
      case 'list_skills':
        return ok(await getJson<SkillsPayload>(`${baseUrl}/api/skills`));
      case 'list_plugins':
        return ok(await listPlugins(baseUrl));
      case 'list_agents':
        return ok(await listAgents(baseUrl, args.includeUnavailable === true));
      case 'start_run':
        return await startRun(baseUrl, args);
      case 'get_run':
        return await getRun(baseUrl, args);
      case 'cancel_run': {
        requireString(args.runId, 'runId');
        return ok(
          await postJson<JsonObject>(
            `${baseUrl}/api/runs/${encodeURIComponent(args.runId)}/cancel`,
            {},
          ),
        );
      }
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(formatError(err, baseUrl));
  }
}

async function writeFile(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  requireString(args.path, 'path');
  requireString(args.content, 'content');
  const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
  const url = `${baseUrl}/api/projects/${encodeURIComponent(id)}/files`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: args.path, content: args.content, encoding }),
  });
  if (!resp.ok) {
    return errorResult(await formatDaemonError(resp, url));
  }
  const json = (await resp.json()) as JsonObject;
  return ok(withActiveEcho(json, active, resolved));
}

async function deleteFile(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  requireString(args.path, 'path');
  const segments = args.path
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent);
  const url = `${baseUrl}/api/projects/${encodeURIComponent(id)}/raw/${segments.join('/')}`;
  const resp = await fetch(url, { method: 'DELETE' });
  if (!resp.ok) {
    return errorResult(await formatDaemonError(resp, url));
  }
  const json = (await resp.json()) as JsonObject;
  return ok(withActiveEcho(json, active, resolved));
}

async function deleteProject(baseUrl: string, args: McpArgs) {
  if (typeof args.project !== 'string' || args.project.length === 0) {
    return errorResult('project is required (no active-context fallback for delete_project).');
  }
  if (args.confirm !== true) {
    return errorResult('confirm:true is required to delete a project (this cannot be undone).');
  }
  const { id, resolved } = await resolveProjectArg(baseUrl, args.project);
  const url = `${baseUrl}/api/projects/${encodeURIComponent(id)}`;
  const resp = await fetch(url, { method: 'DELETE' });
  if (!resp.ok) {
    return errorResult(await formatDaemonError(resp, url));
  }
  const json = (await resp.json()) as JsonObject;
  return ok(withActiveEcho(json, null, resolved));
}

async function formatDaemonError(resp: Response, url: string): Promise<string> {
  const body = await safeText(resp);
  let detail = body || resp.statusText;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } };
    if (parsed?.error?.message) {
      detail = `${parsed.error.code ?? 'error'}: ${parsed.error.message}`;
    }
  } catch {
    // body wasn't JSON; fall through with the raw text.
  }
  return `daemon ${resp.status} on ${url}: ${detail}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) {
    throw new Error(await formatDaemonError(resp, url));
  }
  return (await resp.json()) as T;
}

async function createProject(baseUrl: string, args: McpArgs) {
  requireString(args.name, 'name');
  const id =
    typeof args.id === 'string' && args.id.length > 0
      ? args.id
      : slugifyProjectId(args.name);
  const body: JsonObject = { id, name: args.name, skipDiscoveryBrief: true };
  if (typeof args.designSystem === 'string' && args.designSystem.length > 0) {
    body.designSystemId = args.designSystem;
  }
  if (typeof args.skill === 'string' && args.skill.length > 0) {
    body.skillId = args.skill;
  }
  return ok(await postJson<JsonObject>(`${baseUrl}/api/projects`, body));
}

async function listPlugins(baseUrl: string): Promise<JsonObject> {
  const raw = await getJson<{ plugins?: JsonObject[] }>(`${baseUrl}/api/plugins`);
  const plugins = (raw?.plugins ?? []).map((p) => {
    const manifest = (p?.manifest as JsonObject | undefined) ?? {};
    const od = (manifest.od as JsonObject | undefined) ?? {};
    const result: JsonObject = {
      id: p?.id,
      title: manifest.title ?? p?.title ?? p?.id,
    };
    if (typeof manifest.description === 'string') result.description = manifest.description;
    const kind = od.taskKind ?? od.kind;
    if (typeof kind === 'string') result.kind = kind;
    if (Array.isArray(manifest.tags)) result.tags = manifest.tags;
    return result;
  });
  return { plugins };
}

async function listAgents(baseUrl: string, includeUnavailable: boolean): Promise<JsonObject> {
  const raw = await getJson<{ agents?: JsonObject[] }>(`${baseUrl}/api/agents`);
  const all = raw?.agents ?? [];
  const filtered = includeUnavailable
    ? all
    : all.filter((a) => a?.available === true);
  const MAX_MODELS = 10;
  const agents = filtered.map((a) => {
    const models = Array.isArray(a?.models) ? (a.models as unknown[]) : [];
    const out: JsonObject = {
      id: a?.id,
      name: a?.name,
      models: models.slice(0, MAX_MODELS),
      modelsCount: models.length,
    };
    if (typeof a?.version === 'string' && a.version.length > 0) out.version = a.version;
    if (includeUnavailable) {
      out.available = Boolean(a?.available);
      if (typeof a?.installUrl === 'string') out.installUrl = a.installUrl;
    }
    return out;
  });
  return { agents };
}

function slugifyProjectId(name: string): string {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) ||
    'project';
  return `${base}-${randomUUID().replace(/-/g, '').slice(0, 4)}`;
}

async function startRun(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  const body: JsonObject = { projectId: id };
  if (typeof args.prompt === 'string' && args.prompt.length > 0) {
    body.message = args.prompt;
    body.currentPrompt = args.prompt;
  }
  if (typeof args.skill === 'string' && args.skill.length > 0) body.skillId = args.skill;
  if (typeof args.plugin === 'string' && args.plugin.length > 0) body.pluginId = args.plugin;
  if (typeof args.agent === 'string' && args.agent.length > 0) body.agentId = args.agent;
  if (typeof args.model === 'string' && args.model.length > 0) body.model = args.model;
  if (args.inputs !== undefined) {
    if (args.inputs === null || typeof args.inputs !== 'object' || Array.isArray(args.inputs)) {
      throw new Error('inputs must be an object');
    }
    body.pluginInputs = args.inputs;
  }
  const created = await postJson<JsonObject>(`${baseUrl}/api/runs`, body);
  const webBase = await getWebBaseUrl(baseUrl);
  const studioUrl = buildStudioUrl(webBase, id, created?.conversationId, null);
  return ok(
    withActiveEcho(
      {
        ...created,
        ...(studioUrl ? { studioUrl } : {}),
        hint: 'Run started. Open Design generation normally takes 5–30 minutes. Polls showing status:running with no new files / unchanged file mtimes is the inner agent thinking, NOT a hang — DO NOT cancel_run out of impatience and DO NOT substitute write_file to produce the design yourself; OD\'s pipeline is what gives the result its design quality. Poll get_run(runId) every 30–60 seconds; report "still working" to the user between polls and keep waiting. On terminal status the response carries previewUrl + agentMessage which together are the canonical deliverable. When studioUrl is present, ALWAYS show it to the user as a clickable markdown link: `[Open Open Design studio](STUDIO_URL)` — never as inline code or bare text, because Codex / Cursor / Zed render markdown links as navigable in their built-in browser pane and inline code blocks are not clickable.',
      },
      active,
      resolved,
    ),
  );
}

async function getRun(baseUrl: string, args: McpArgs) {
  requireString(args.runId, 'runId');
  const status = await getJson<JsonObject>(
    `${baseUrl}/api/runs/${encodeURIComponent(args.runId)}`,
  );
  if (status.status !== 'succeeded' || typeof status.projectId !== 'string' || !status.projectId) {
    const webBase = await getWebBaseUrl(baseUrl);
    const studioUrl = buildStudioUrl(webBase, status.projectId, status.conversationId, null);
    const enriched: JsonObject = { ...status };
    if (studioUrl) enriched.studioUrl = studioUrl;
    if (typeof status.eventsLogPath === 'string' && status.eventsLogPath.length > 0) {
      enriched.hint = 'Run still in flight. Tail eventsLogPath in your own shell (e.g. `tail -n 50 -f "' + status.eventsLogPath + '"`) to see live text_delta / tool_use events from the inner agent — that is your in-flight progress signal. Keep polling get_run every 30–60s; do not cancel because file mtimes look static, that is the agent thinking between writes.';
      if (studioUrl) {
        enriched.hint += ` Once you have something to show the user, give them a clickable markdown link to studioUrl — render it as \`[Watch progress in Open Design studio](${studioUrl})\`, NEVER as inline code or bare text, so clients like Codex / Cursor / Zed make it navigable in their built-in browser pane.`;
      }
    }
    return ok(enriched);
  }
  const [previewUrl, agentMessage, webBase] = await Promise.all([
    buildRunPreviewUrl(baseUrl, status.projectId),
    fetchRunAgentMessage(baseUrl, String(status.id ?? args.runId)),
    getWebBaseUrl(baseUrl),
  ]);
  const entryFile = previewUrl
    ? decodeURIComponent(previewUrl.split('/raw/')[1] ?? '')
    : null;
  const studioUrl = buildStudioUrl(webBase, status.projectId, status.conversationId, entryFile);
  const enriched: JsonObject = { ...status };
  if (previewUrl) enriched.previewUrl = previewUrl;
  if (agentMessage) enriched.agentMessage = agentMessage;
  if (studioUrl) enriched.studioUrl = studioUrl;
  enriched.hint = previewUrl
    ? `Run finished. studioUrl (when present) is the BEST link to hand the user — it opens the OD studio page that shows the rendered design AND the chat history (your prompts and the inner agent's replies) side by side. ALWAYS render studioUrl as a clickable markdown link: \`[Open Open Design studio](STUDIO_URL)\` — never as inline code or bare text, because clients like Codex / Cursor / Zed render markdown links as navigable in their built-in browser pane and inline code blocks are not clickable. previewUrl is the raw file URL if the user only wants the rendered output. agentMessage carries the inner agent's explanation; show it alongside the link. Call get_artifact({ project: "${status.projectId}" }) when you need the source files — always pass project explicitly; omitting it falls back to the active project, which may differ. eventsLogPath, when present, holds the full inner-agent event log for forensics.`
    : 'Run finished but produced no files. The inner agent\'s output is in agentMessage — relay it to the user verbatim. Most often this is a clarifying question (e.g. a <question-form>) you should answer by calling start_run again with a more specific prompt or a chosen plugin. When studioUrl is present, show it as a clickable markdown link (`[Open Open Design studio](STUDIO_URL)`) so the user can navigate to the OD page that shows the chat history — never render it as inline code. eventsLogPath, when present, holds the full event log if you need to inspect what happened.';
  return ok(enriched);
}

async function fetchRunAgentMessage(baseUrl: string, runId: string): Promise<string | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/events`);
    if (!resp.ok) return null;
    const body = await resp.text();
    const parts: string[] = [];
    for (const block of body.split(/\n\n/)) {
      if (!block.trim()) continue;
      let eventName = '';
      let dataLine = '';
      for (const rawLine of block.split('\n')) {
        if (rawLine.startsWith('event:')) eventName = rawLine.slice(6).trim();
        else if (rawLine.startsWith('data:')) dataLine = rawLine.slice(5).trim();
      }
      if (eventName !== 'agent' || !dataLine) continue;
      try {
        const data = JSON.parse(dataLine) as { type?: string; delta?: unknown };
        if (data?.type === 'text_delta' && typeof data.delta === 'string') {
          parts.push(data.delta);
        }
      } catch {
        // Non-JSON data lines (rare) are skipped silently.
      }
    }
    const message = parts.join('');
    return message.length > 0 ? message : null;
  } catch {
    return null;
  }
}

interface WebBaseUrlCache {
  t: number;
  url: string | null;
}
const WEB_BASE_URL_TTL_MS = 5_000;
let webBaseUrlCache: WebBaseUrlCache | null = null;

export function _resetWebBaseUrlCache(): void {
  webBaseUrlCache = null;
}

async function getWebBaseUrl(daemonBaseUrl: string): Promise<string | null> {
  const now = Date.now();
  if (webBaseUrlCache && now - webBaseUrlCache.t < WEB_BASE_URL_TTL_MS) {
    return webBaseUrlCache.url;
  }
  try {
    const data = await getJson<{ webBaseUrl?: string | null }>(
      `${daemonBaseUrl}/api/mcp/install-info`,
    );
    const url =
      typeof data?.webBaseUrl === 'string' && data.webBaseUrl.length > 0
        ? data.webBaseUrl
        : null;
    webBaseUrlCache = { t: now, url };
    return url;
  } catch {
    webBaseUrlCache = { t: now, url: null };
    return null;
  }
}

function buildStudioUrl(
  webBaseUrl: string | null,
  projectId: unknown,
  conversationId: unknown,
  entryFile: unknown,
): string | null {
  if (!webBaseUrl) return null;
  if (typeof projectId !== 'string' || !projectId) return null;
  if (typeof conversationId !== 'string' || !conversationId) return null;
  const base = `${webBaseUrl}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
  if (typeof entryFile === 'string' && entryFile.length > 0) {
    const segments = entryFile
      .split('/')
      .filter((s) => s.length > 0)
      .map(encodeURIComponent)
      .join('/');
    return `${base}/files/${segments}`;
  }
  return base;
}

async function getDefaultConversationId(baseUrl: string, projectId: string): Promise<string | null> {
  try {
    const data = await getJson<{ conversations?: Array<{ id?: string }> }>(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/conversations`,
    );
    const first = Array.isArray(data?.conversations) ? data.conversations[0] : null;
    return typeof first?.id === 'string' && first.id.length > 0 ? first.id : null;
  } catch {
    return null;
  }
}

async function resolveProjectEntry(baseUrl: string, projectId: string, declared: unknown): Promise<string | null> {
  if (typeof declared === 'string' && declared.length > 0) return declared;
  try {
    const data = await getJson<{ files?: Array<{ path?: string; name?: string; kind?: string }> }>(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/files`,
    );
    const files = data?.files ?? [];
    const indexHtml = files.find((f) => f?.path === 'index.html' || f?.name === 'index.html');
    if (indexHtml?.path) return indexHtml.path;
    const htmlAtRoot = files.filter(
      (f) => typeof f?.path === 'string' && !f.path.includes('/') && f.path.toLowerCase().endsWith('.html'),
    );
    if (htmlAtRoot.length === 1 && htmlAtRoot[0]?.path) return htmlAtRoot[0].path;
    return null;
  } catch {
    return null;
  }
}

function rawPreviewUrl(baseUrl: string, projectId: string, entry: unknown): string | null {
  return buildProjectRawFileUrl(baseUrl, projectId, entry);
}

async function buildRunPreviewUrl(baseUrl: string, projectId: string): Promise<string | null> {
  try {
    const data = await getJson<ProjectPayload>(
      `${baseUrl}/api/projects/${encodeURIComponent(projectId)}`,
    );
    const project = data?.project ?? data;
    const declared = (project as { metadata?: JsonObject } | undefined)?.metadata?.entryFile;
    const entry = await resolveProjectEntry(baseUrl, projectId, declared);
    return rawPreviewUrl(baseUrl, projectId, entry);
  } catch {
    return null;
  }
}

async function createArtifact(baseUrl: string, args: McpArgs) {
  const { id, resolved, active } = await resolveProjectArg(baseUrl, args.project);
  requireString(args.name, 'name');
  requireString(args.content, 'content');
  if (
    args.artifactManifest !== undefined &&
    (args.artifactManifest === null ||
      typeof args.artifactManifest !== 'object' ||
      Array.isArray(args.artifactManifest))
  ) {
    throw new Error('artifactManifest must be an object');
  }
  const artifactManifest =
    args.artifactManifest
      ? args.artifactManifest
      : undefined;
  const payload = await postCreateArtifactRequest({
    baseUrl,
    projectId: id,
    input: {
      name: args.name,
      content: args.content,
      encoding: args.encoding === 'base64' ? 'base64' : 'utf8',
      ...(artifactManifest === undefined ? {} : { artifactManifest }),
    },
  });
  const result = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as JsonObject)
    : { result: payload };
  return ok(withActiveEcho(result, active, resolved));
}

function oneLine(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  return s.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROJECT_LIST_TTL_MS = 5000;
let projectListCache: ProjectListCache | null = null;

async function fetchProjectList(baseUrl: string): Promise<ProjectSummary[]> {
  const now = Date.now();
  if (
    projectListCache &&
    projectListCache.baseUrl === baseUrl &&
    now - projectListCache.t < PROJECT_LIST_TTL_MS
  ) {
    return projectListCache.list;
  }
  const data = await getJson<ProjectsPayload>(`${baseUrl}/api/projects`);
  const list = Array.isArray(data?.projects) ? data.projects : [];
  projectListCache = { baseUrl, t: now, list };
  return list;
}

async function resolveProjectArg(baseUrl: string, arg: unknown): Promise<{ id: string; resolved: ResolvedProject | null; active: ActiveContext | null }> {
  if (typeof arg === 'string' && arg.length > 0) {
    const resolved = await resolveProjectId(baseUrl, arg);
    return { id: resolved.id, resolved, active: null };
  }
  let active: ActiveContext;
  try {
    active = await getJson<ActiveContext>(`${baseUrl}/api/active`);
  } catch (err) {
    throw new Error(
      `project arg omitted and active context lookup failed: ${errorMessage(err)}. Pass project="<id-or-name>".`,
    );
  }
  if (!active || active.active === false || !active.projectId) {
    throw new Error(
      'project arg omitted and Open Design has no active project. The active context expires about 5 minutes after the last user interaction with Open Design - the user may need to click into a project to wake it up. Otherwise pass project="<id-or-name>".',
    );
  }
  return { id: active.projectId, resolved: null, active };
}

async function resolveProjectId(baseUrl: string, arg: unknown): Promise<ResolvedProject> {
  if (typeof arg !== 'string' || !arg) {
    throw new Error('project is required (string).');
  }
  if (UUID_RE.test(arg)) return { id: arg, name: arg, source: 'uuid' as const };

  const list = await fetchProjectList(baseUrl);
  if (list.length === 0) {
    throw new Error('no projects on this daemon');
  }

  const lower = arg.toLowerCase();
  const norm = (s: unknown): string =>
    String(s || '')
      .toLowerCase()
      .replace(/\s*\(\d+\)\s*$/, '')
      .replace(/[\s_-]+/g, '-');
  const target = norm(arg);

  const idMatch = list.find((p) => p.id === arg);
  if (idMatch) return { id: idMatch.id, name: idMatch.name, source: 'id' as const };

  const exact = list.filter((p) => String(p.name || '').toLowerCase() === lower);
  if (exact.length === 1) { const p = exact[0]!; return { id: p.id, name: p.name, source: 'exact' as const }; }

  const slugged = list.filter((p) => norm(p.name) === target);
  if (slugged.length === 1) { const p = slugged[0]!; return { id: p.id, name: p.name, source: 'slug' as const }; }

  const subs = list.filter((p) =>
    String(p.name || '').toLowerCase().includes(lower),
  );
  if (subs.length === 1) { const p = subs[0]!; return { id: p.id, name: p.name, source: 'substring' as const }; }
  if (subs.length > 1) {
    const opts = subs.map((p) => `${p.name} (${p.id})`).join(', ');
    throw new Error(
      `multiple projects match "${arg}": ${opts}. Pass the UUID instead.`,
    );
  }
  throw new Error(`no project matches "${arg}"`);
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`daemon ${resp.status} on ${url}: ${body || resp.statusText}`);
  }
  return (await resp.json()) as T;
}

async function getFile(baseUrl: string, project: string, relPath: string, active: ActiveContext | null, resolved?: ResolvedProject | null, offset = 0, limit = 2000) {
  const segments = String(relPath)
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent);
  const url = `${baseUrl}/api/projects/${encodeURIComponent(project)}/raw/${segments.join('/')}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await safeText(resp);
    return errorResult(
      `daemon ${resp.status} on ${url}: ${body || resp.statusText}`,
    );
  }
  const mime = ((resp.headers.get('content-type') || 'application/octet-stream').split(';')[0] ?? 'application/octet-stream').trim();
  if (!isTextualMime(mime)) {
    return errorResult(
      `file at "${relPath}" has mime "${mime}"; binary content is not yet supported by od mcp. Use list_files to inspect its metadata.`,
    );
  }
  const text = await resp.text();
  const allLines = text.split('\n');
  const totalLines = allLines.length;
  const start = Math.min(offset, totalLines);
  const slice = allLines.slice(start, start + limit);
  const returnedLines = slice.length;
  const truncated = start + returnedLines < totalLines;

  const extra: string[] = [];
  if (active) extra.push(formatActiveEchoLine(active, relPath));
  if (resolved && (resolved.source === 'slug' || resolved.source === 'substring')) {
    extra.push(`[od:resolved-project id="${resolved.id}" name="${resolved.name}" via="${resolved.source}"]`);
  }
  if (truncated || start > 0) {
    const nextOffset = start + returnedLines;
    const next = truncated ? `; call get_file again with offset=${nextOffset} to read more` : '';
    extra.push(
      `[od:file-window offset=${start} returnedLines=${returnedLines} totalLines=${totalLines}${next}]`,
    );
  }
  return {
    content: [
      ...extra.map((t) => ({ type: 'text', text: t })),
      { type: 'text', text: slice.join('\n') },
    ],
  };
}

function withActiveEcho<T extends JsonObject>(payload: T, active: ActiveContext | null, resolved?: ResolvedProject | null): T & JsonObject {
  const result = active ? { ...payload, usedActiveContext: activeEchoPayload(active) } : payload;
  if (resolved && (resolved.source === 'slug' || resolved.source === 'substring')) {
    return { ...result, resolvedProject: { id: resolved.id, name: resolved.name } };
  }
  return result;
}

function activeEchoPayload(active: ActiveContext) {
  return {
    projectId: active.projectId,
    projectName: active.projectName ?? null,
    fileName: active.fileName ?? null,
    ageMs: active.ageMs ?? null,
  };
}

function formatActiveEchoLine(active: ActiveContext, resolvedPath: string): string {
  const proj = active.projectName || active.projectId;
  const note = `[od:active-context project="${proj}" file="${resolvedPath}"]`;
  return active.fileName === resolvedPath
    ? note
    : `${note} (active file: ${active.fileName ?? 'none'})`;
}

const VALID_INCLUDE_MODES = new Set(['auto', 'all', 'shallow']);
const DEFAULT_MAX_BYTES = 1_500_000;
const MAX_FILES = 200;

function totalTextBytes(files: ProjectFileBundleEntry[]): number {
  let n = 0;
  for (const f of files) {
    if (!f.binary && typeof f.content === 'string') n += f.content.length;
  }
  return n;
}

async function getArtifact(baseUrl: string, projectArg: unknown, entryArg: unknown, includeMode: unknown, maxBytesArg: unknown) {
  const include = includeMode == null || includeMode === '' ? 'auto' : includeMode;
  if (typeof include !== 'string' || !VALID_INCLUDE_MODES.has(include)) {
    return errorResult(
      `invalid include "${includeMode}"; expected one of: auto, all, shallow`,
    );
  }
  const maxBytes =
    typeof maxBytesArg === 'number' && Number.isFinite(maxBytesArg) && maxBytesArg > 0 ? maxBytesArg : DEFAULT_MAX_BYTES;

  const { id, active, resolved } = await resolveProjectArg(baseUrl, projectArg);
  const data = await getJson<ProjectPayload>(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
  const project = (data.project ?? data) as ProjectSummary;
  const explicitEntry = typeof entryArg === 'string' && entryArg.length > 0;
  const metadataEntry = typeof project.metadata?.entryFile === 'string' ? project.metadata.entryFile : undefined;
  const entry: string | undefined = explicitEntry
    ? String(entryArg)
    : (active && active.fileName) || metadataEntry;
  if (!entry) {
    return errorResult(
      `no entry file: pass entry="..." or set the project's metadata.entryFile`,
    );
  }

  if (include === 'shallow') {
    let file;
    try {
      file = await fetchProjectFile(baseUrl, id, entry);
    } catch (err) {
      return errorResult(errorMessage(err));
    }
    return okBundle({ project, entry, files: [file], truncated: false, active, resolved });
  }

  if (include === 'all') {
    const meta = await getJson<{ files?: Array<{ name: string }> }>(`${baseUrl}/api/projects/${encodeURIComponent(id)}/files`);
    const allFiles = Array.isArray(meta?.files) ? meta.files : [];
    const fetched: ProjectFileBundleEntry[] = [];
    let truncated = false;
    for (const f of allFiles) {
      if (fetched.length >= MAX_FILES || totalTextBytes(fetched) >= maxBytes) {
        truncated = true;
        break;
      }
      try {
        const remaining = maxBytes - totalTextBytes(fetched);
        fetched.push(await fetchProjectFile(baseUrl, id, f.name, remaining));
      } catch (err) {
        if (err instanceof BudgetExceededError) truncated = true;
      }
    }
    return okBundle({ project, entry, files: fetched, truncated, active, resolved });
  }

  let entryFile;
  try {
    entryFile = await fetchProjectFile(baseUrl, id, entry);
  } catch (err) {
    return errorResult(errorMessage(err));
  }
  const MAX_DEPTH = 3;
  const visited = new Set([entry]);
  const fetched = [entryFile];
  let truncated = false;
  let frontier: string[] = [];
  if (isTextualMime(entryFile.mime)) {
    frontier = extractRelativeRefs(entryFile.content || '', entry, entryFile.mime).filter(
      (r) => !visited.has(r),
    );
  }
  outer: for (let depth = 1; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const refPath of frontier) {
      if (visited.has(refPath)) continue;
      visited.add(refPath);
      if (fetched.length >= MAX_FILES || totalTextBytes(fetched) >= maxBytes) {
        truncated = true;
        break outer;
      }
      let file;
      try {
        const remaining = maxBytes - totalTextBytes(fetched);
        file = await fetchProjectFile(baseUrl, id, refPath, remaining);
      } catch (err) {
        if (err instanceof BudgetExceededError) truncated = true;
        continue;
      }
      fetched.push(file);
      if (!isTextualMime(file.mime)) continue;
      const refs = extractRelativeRefs(file.content || '', refPath, file.mime);
      for (const ref of refs) {
        if (!visited.has(ref)) next.push(ref);
      }
    }
    frontier = next;
  }
  return okBundle({ project, entry, files: fetched, truncated, active, resolved });
}

class BudgetExceededError extends Error {}

async function fetchProjectFile(baseUrl: string, projectId: string, relPath: string, remainingBytes = Infinity): Promise<ProjectFileBundleEntry> {
  const segments = String(relPath)
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent);
  const url = `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/raw/${segments.join('/')}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await safeText(resp);
    throw new Error(`daemon ${resp.status} on ${url}: ${body || resp.statusText}`);
  }
  const mime = ((resp.headers.get('content-type') || 'application/octet-stream').split(';')[0] ?? 'application/octet-stream').trim();
  const headerSize = Number(resp.headers.get('content-length'));
  const size = Number.isFinite(headerSize) && headerSize >= 0 ? headerSize : null;
  if (!isTextualMime(mime)) {
    return { name: relPath, mime, size, content: null, binary: true };
  }
  if (size !== null && size > remainingBytes) {
    throw new BudgetExceededError(`file ${relPath} (${size} bytes) exceeds remaining budget`);
  }
  const content = await resp.text();
  return { name: relPath, mime, size: size ?? content.length, content, binary: false };
}

const HTML_REF_PATTERNS = [
  /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
  /<img\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<source\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<video\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<audio\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi,
];

const CSS_REF_PATTERNS = [
  /\burl\(\s*["']?([^"')]+)["']?\s*\)/gi,
  /@import\s+(?:url\()?\s*["']([^"')]+)["']/gi,
];

const JS_REF_PATTERNS = [
  /\bimport\s+[^'"]*?['"]([^'"]+)['"]/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const SRCSET_PATTERN = /\bsrcset=["']([^"']+)["']/gi;

function isJsLike(mime: string | undefined, fromPath: string): boolean {
  if (mime && /javascript|typescript/i.test(mime)) return true;
  return /\.(?:m?jsx?|tsx?|cjs)$/i.test(fromPath);
}

function isCssLike(mime: string | undefined, fromPath: string): boolean {
  if (mime && /^text\/css\b/i.test(mime)) return true;
  return /\.css$/i.test(fromPath);
}

function isHtmlLike(mime: string | undefined, fromPath: string): boolean {
  if (mime && /^text\/html\b/i.test(mime)) return true;
  return /\.html?$/i.test(fromPath);
}

function extractRelativeRefs(text: string, fromPath: string, fromMime: string): string[] {
  if (!text) return [];
  const refs = new Set<string>();
  const runPatterns: RegExp[] = [];
  if (isHtmlLike(fromMime, fromPath)) {
    runPatterns.push(...HTML_REF_PATTERNS, ...CSS_REF_PATTERNS);
  }
  if (isCssLike(fromMime, fromPath)) {
    runPatterns.push(...CSS_REF_PATTERNS);
  }
  if (isJsLike(fromMime, fromPath)) {
    runPatterns.push(...JS_REF_PATTERNS);
  }
  if (runPatterns.length === 0) {
    runPatterns.push(...CSS_REF_PATTERNS);
  }

  const candidates: string[] = [];
  for (const re of runPatterns) {
    for (const m of text.matchAll(re)) {
      const ref = (m[1] || '').trim();
      if (ref) candidates.push(ref);
    }
  }
  if (isHtmlLike(fromMime, fromPath)) {
    for (const m of text.matchAll(SRCSET_PATTERN)) {
      const list = m[1] || '';
      for (const part of list.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url) candidates.push(url);
      }
    }
  }

  for (const raw of candidates) {
    if (/^(?:https?:|\/\/|data:|mailto:|tel:|#)/i.test(raw)) continue;
    const dir = fromPath.includes('/')
      ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1)
      : '';
    const resolved = raw.startsWith('/') ? raw.slice(1) : dir + raw;
    const stripped = resolved.replace(/[?#].*$/, '');
    const segs = stripped.split('/').filter(Boolean);
    const out: string[] = [];
    let escaped = false;
    for (const s of segs) {
      if (s === '.') continue;
      if (s === '..') {
        if (out.length === 0) { escaped = true; break; }
        out.pop();
        continue;
      }
      out.push(s);
    }
    if (escaped || out.length === 0) continue;
    refs.add(out.join('/'));
  }
  return [...refs];
}

function okBundle(bundle: BundleInput) {
  const payload = {
    entryFile: bundle.entry,
    projectId: bundle.project?.id,
    projectName: bundle.project?.name,
    truncated: bundle.truncated === true,
    files: bundle.files.map((f) => ({
      name: f.name,
      mime: f.mime,
      size: f.size,
      binary: f.binary === true,
      content: f.binary ? null : f.content,
    })),
    manifest: bundle.project?.metadata ?? null,
  };
  return ok(withActiveEcho(payload, bundle.active, bundle.resolved));
}

function isTextualMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return TEXTUAL_MIME_PATTERNS.some((re) => re.test(mime));
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

function formatError(err: unknown, daemonUrl: string): string {
  const e = err as ErrorWithCode | null | undefined;
  const code = e && (e.cause?.code || e.code);
  const msg = errorMessage(err);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return `cannot reach the Open Design daemon at ${daemonUrl}. Is it running? Start it with \`pnpm tools-dev\`.`;
  }
  return msg;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Resource handler helpers — fetches /api/design-systems, /api/skills
// and builds the od:// resource URIs from the payloads.
function getResourcePayload(data: ResourcePayload): string {
  return (
    data?.skill?.body ??
    data?.skill?.content ??
    data?.designSystem?.body ??
    data?.designSystem?.content ??
    data?.body ??
    data?.content ??
    ''
  );
}

// Creates the MCP Server instance with all tool and resource handlers wired to
// proxy calls to the daemon API at `baseUrl`. The returned Server is not
// connected to any transport — call `server.connect(transport)` separately.
export type HandlerWrapper = <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) => (...args: A) => R | Promise<R>;

export function createMcpServer(
  baseUrl: string,
  wrapHandler?: HandlerWrapper,
): Server {
  const cleanedBase = baseUrl.replace(/\/$/, '');
  const wrap = wrapHandler ?? ((fn: any) => fn);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: [
        'Open Design (OD) is a local-first design workspace. The user typically',
        'has OD running on their machine; each project contains a rendered',
        'artifact (HTML/JSX/CSS) plus its source files.',
        '',
        'Active context: get_artifact, get_project, get_file, search_files,',
        'and list_files all accept project as OPTIONAL. When omitted, they',
        'default to the project the user has open in OD right now; get_file',
        'and get_artifact additionally default to the active file. So when',
        'the user says "this file" / "the design I have open" / "find X",',
        'just call the tool without project - no need to ask first. The',
        'response carries usedActiveContext so you can confirm which',
        'project/file you hit. Pass project explicitly to override.',
        '',
        'Pulling design context:',
        ' - get_artifact() - entry file PLUS every referenced sibling',
        '    (tokens CSS, JSX modules, imported assets) in one call.',
        '    PREFER THIS over multiple get_file calls when the user',
        '    wants to understand or extend a design.',
        ' - get_file(path) for a single known file. Returns up to 2000',
        '    lines starting at offset (default 0) and stamps a',
        '    [od:file-window ...] marker when the file is longer; page',
        '    by re-calling with the next offset.',
        ' - search_files(query) to find a class/component/copy string',
        '    without fetching every file.',
        ' - list_files for metadata only.',
        ' - create_artifact(name, content) to create one normal artifact',
        '    entry file in the active or specified project. It rejects',
        '    existing targets and can accept an artifactManifest sidecar.',
        ' - write_file(path, content) to overwrite or freshly create any',
        '    project file when an ArtifactManifest is not required.',
        '    Use this to iterate on a file create_artifact already wrote.',
        ' - delete_file(path) to remove one project file (nested paths ok).',
        ' - delete_project(project, confirm:true) for irreversible project',
        '    removal — requires explicit project + confirm:true.',
        ' - list_projects to discover what is available on this daemon.',
        ' - get_active_context() if you want the active project/file',
        '    explicitly without making any other tool call.',
        '',
        'To make Open Design GENERATE or refine a design (rather than just',
        'read/edit files), commission a run - you do not run skills yourself:',
        ' - list_skills / list_plugins to see what you can ask OD to make.',
        ' - list_agents when you need to pass start_run.agent — do not',
        '    guess "claude" / "codex" / "opencode"; only agents in the',
        '    returned list will actually spawn on this machine.',
        ' - create_project(name) first if you need a fresh project to',
        '    generate into; start_run requires an existing project.',
        ' - start_run(prompt, [skill], [plugin], [inputs]) kicks off generation in',
        '    the active or named project and returns a runId immediately.',
        '    Open Design spawns its own agent to do the work.',
        ' - get_run(runId) polls until status is succeeded/failed/canceled;',
        '    on success it returns a previewUrl you can open in a browser',
        '    and a hint to pull the files with get_artifact.',
        ' - cancel_run(runId) aborts an in-flight run.',
        '',
        'Generation patience: Open Design runs typically take 5–30',
        'minutes. Polls returning status:running with unchanged file',
        'mtimes is the inner agent thinking, not a hang. Do NOT cancel',
        'and substitute write_file as a "faster" workaround — that',
        'throws away the pipeline\'s design quality and is exactly the',
        'failure mode this surface is meant to avoid. Poll every 30–60',
        'seconds, tell the user "still working" between polls, and let',
        'the run finish. Only call cancel_run if the user explicitly',
        'asks you to abort.',
        '',
        'Ambiguous-format requests: words like "PPT" / "deck" / "slides" /',
        '"presentation" / "document" / "PDF" / "doc" map to two different',
        'deliverables — Open Design natively produces browser-viewable',
        'HTML/SVG (including HTML-rendered decks), but the user may want a',
        'real binary file (.pptx / .docx / .pdf) which Open Design does NOT',
        'produce and which you would have to export yourself from OD\'s',
        'output. When the user\'s request is ambiguous, ASK them which one',
        'they want before kicking off work; do not silently pick one and do',
        'not run both paths in parallel.',
        '',
        'Project arguments accept either a UUID or a name substring',
        '(e.g. "recaptr"); the server resolves the latter. When a project',
        'is matched by slug or substring the response carries',
        'resolvedProject:{id,name} so you can confirm which project was',
        'resolved. Verify with the user if the match was unexpected.',
        '',
        'Reference material is exposed as MCP resources, not tools - read',
        'od://design-systems/<id>/DESIGN.md when you need the brand spec',
        'for a design (palette, typography, voice). Skills are similarly',
        'available at od://skills/<id>/SKILL.md but are mostly relevant',
        'when the user asks about how a particular artifact was generated.',
        '',
        'When extending an Open Design design in another codebase, pull',
        'the full bundle once with get_artifact and work from those files',
        'locally - do not fetch files one-by-one if you can avoid it.',
      ].join('\n'),
    },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    wrap(async () => ({ tools: TOOL_DEFS })),
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    wrap(async () => {
      const [skillsData, dsData] = await Promise.all([
        getJson<SkillsPayload>(`${cleanedBase}/api/skills`).catch((): SkillsPayload => ({ skills: [] })),
        getJson<DesignSystemsPayload>(`${cleanedBase}/api/design-systems`).catch((): DesignSystemsPayload => ({ designSystems: [] })),
      ]);
      const resources = [
        {
          uri: 'od://focus/active',
          name: 'Active Context',
          description: 'Project + file the user has open in Open Design right now',
          mimeType: 'application/json',
        },
        {
          uri: 'od://focus/projects',
          name: 'All Projects',
          description: 'All projects on this daemon',
          mimeType: 'application/json',
        },
      ];
      for (const skill of skillsData?.skills ?? []) {
        const id = skill.id;
        if (id) {
          resources.push({
            uri: `od://skills/${encodeURIComponent(id)}/SKILL.md`,
            name: `Skill: ${skill.title ?? skill.name ?? id}`,
            description: oneLine(skill.description) ?? `Skill ${id}`,
            mimeType: 'text/markdown',
          });
        }
      }
      for (const ds of dsData?.designSystems ?? []) {
        const id = ds.id;
        if (id) {
          resources.push({
            uri: `od://design-systems/${encodeURIComponent(id)}/DESIGN.md`,
            name: `Design System: ${ds.title ?? ds.name ?? id}`,
            description: oneLine(ds.description) ?? `Design system ${id}`,
            mimeType: 'text/markdown',
          });
        }
      }
      return { resources };
    }),
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    wrap(async (req: { params: { uri: string } }) => {
      const uri = String(req.params?.uri ?? '');
      if (uri === 'od://focus/active') {
        const data = await getJson<ActiveContext>(`${cleanedBase}/api/active`);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
      }
      if (uri === 'od://focus/projects') {
        const data = await getJson<ProjectsPayload>(`${cleanedBase}/api/projects`);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
      }
  
      const skillMatch = /^od:\/\/skills\/([^/]+)\/SKILL\.md$/.exec(uri);
      if (skillMatch) {
        const id = decodeURIComponent(skillMatch[1]!);
        const data = await getJson<ResourcePayload>(`${cleanedBase}/api/skills/${encodeURIComponent(id)}`);
        const text = getResourcePayload(data);
        return { contents: [{ uri, mimeType: 'text/markdown', text }] };
      }
  
      const dsMatch = /^od:\/\/design-systems\/([^/]+)\/DESIGN\.md$/.exec(uri);
      if (dsMatch) {
        const id = decodeURIComponent(dsMatch[1]!);
        const data = await getJson<ResourcePayload>(`${cleanedBase}/api/design-systems/${encodeURIComponent(id)}`);
        const text = getResourcePayload(data);
        return { contents: [{ uri, mimeType: 'text/markdown', text }] };
      }
  
      throw new Error(`unknown resource: ${uri}`);
    }),
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    wrap(async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      const name = req.params?.name;
      const args: McpArgs = (req.params?.arguments ?? {}) as McpArgs;
      return handleMcpToolCall(cleanedBase, name, args);
    }),
  );

  return server;
}

export {
  TOOL_DEFS,
  ok,
  errorResult,
  handleMcpToolCall,
  extractRelativeRefs,
  resolveProjectId,
  resolveProjectArg,
  withActiveEcho,
  fetchProjectFile,
  getArtifact,
  getFile,
  createArtifact,
};
