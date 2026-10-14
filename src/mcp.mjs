import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { GatewayClient } from './client.mjs';

const id = z.string().min(1).max(256).describe('Persistent gateway task ID.');
const workspace = z.string().min(1).max(4096).describe('Absolute local project directory, within the gateway workspace allowlist.');
const key = z.string().min(1).max(200).describe('Stable unique key for this intended action. Reuse only for the exact same request; never create a new key to retry after a timeout.');
const after = z.number().int().nonnegative().optional().describe('Last event cursor already received.');

const definitions = [
  {
    name: 'codex_health', method: 'health', readOnly: true, schema: {},
    description: 'Read gateway and Codex connection status. Does not start or install a service.',
  },
  {
    name: 'codex_models', method: 'models', readOnly: true, schema: {},
    description: 'List the local Codex model catalog. Catalog presence is not an account entitlement or quota check.',
  },
  {
    name: 'codex_bind_workspace', method: 'bind_workspace', schema: {
      workspace, threadId: z.string().min(1).max(256).optional(), model: z.string().min(1).max(200).optional(),
    },
    description: 'Bind an allowed local workspace to a persistent Codex thread, creating a thread when needed. A supplied thread must belong to this workspace. This does not submit a task.',
  },
  {
    name: 'codex_workspaces', method: 'workspaces', readOnly: true, schema: {},
    description: 'List workspace bindings and their persistent Codex thread IDs.',
  },
  {
    name: 'codex_submit', method: 'submit', idempotent: true, schema: {
      workspace,
      task: z.string().min(1).max(60_000).describe('Concrete task with acceptance criteria; delegate only work authorized by the user.'),
      idempotencyKey: key,
      constraints: z.array(z.string().min(1).max(4000)).max(40).optional(),
      output: z.enum(['text', 'json', 'artifacts']).optional(),
      model: z.string().min(1).max(200).optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
      timeoutSeconds: z.number().int().min(10).max(86_400).optional(),
    },
    description: 'Persist and enqueue one authorized task for Codex in its bound workspace. Returns a task ID, not completion. Execution uses workspace-write restrictions and never grants elevated approvals. Use codex_wait/get for progress. A timeout is not permission to submit another task.',
  },
  {
    name: 'codex_get', method: 'get', readOnly: true, schema: { id },
    description: 'Read durable task state, result, thread, and evidence. Completed means execution ended; accepted means the supervisor verified it.',
  },
  {
    name: 'codex_list', method: 'list', readOnly: true,
    schema: { limit: z.number().int().min(1).max(100).optional() },
    description: 'List recent persistent tasks. Use after an uncertain submit response to locate an existing task before any further action.',
  },
  {
    name: 'codex_wait', method: 'wait', readOnly: true, schema: {
      id, after, timeoutSeconds: z.number().int().min(1).max(50).optional(),
    },
    description: 'Long-poll stored task state/events for up to 50 seconds without spending model tokens. Continue waiting with the returned cursor when still running. This never submits, replays, or cancels a task.',
  },
  {
    name: 'codex_events', method: 'events', readOnly: true, schema: {
      id, after, limit: z.number().int().min(1).max(500).optional(),
    },
    description: 'Read an ordered page of durable task events after a cursor. Preserve the cursor to resume after reconnecting.',
  },
  {
    name: 'codex_cancel', method: 'cancel', schema: { id },
    description: 'Request cancellation of a task and interrupt an active Codex turn. An unconfirmed interrupt can leave an uncertain state; inspect it before retrying work.',
  },
  {
    name: 'codex_rework', method: 'rework', idempotent: true, schema: {
      id, feedback: z.string().min(1).max(60_000), idempotencyKey: key,
    },
    description: 'Enqueue a correction to a completed task using the same task ID, Codex thread, and workspace. Include concrete failed acceptance criteria. Requires a new stable key for this correction, not a new task.',
  },
  {
    name: 'codex_accept', method: 'accept', schema: {
      id,
      evidence: z.string().min(1).max(12_000).describe('Independent checks supporting acceptance; a Codex completion statement alone is insufficient.'),
      artifactPaths: z.array(z.string().min(1).max(4096)).max(100).optional(),
    },
    description: 'Mark a completed task accepted after independent verification of its requested outputs. Supply the checks and relevant artifact paths. Does not run checks on the supervisor’s behalf.',
  },
  {
    name: 'codex_recover', method: 'recover', schema: {
      id, note: z.string().min(1).max(4000).describe('Reason for recovery and what was checked about the interrupted task.'),
    },
    description: 'Reconcile an uncertain task against its persisted Codex thread/turn. This is not permission to replay work; inspect the returned state and evidence.',
  },
];

export function createMcpServer({ client = new GatewayClient() } = {}) {
  const server = new McpServer({ name: 'doubao-codex-gateway', version: '0.1.0' }, {
    instructions: 'Doubao supervises authorized work; Codex executes it in persistent local threads. Preserve task IDs, idempotency keys, and event cursors. Never resubmit because a wait or network call timed out. Inspect results before accepting. Tasks needing extra privileges must be reported, not approved through this gateway.',
  });
  for (const definition of definitions) {
    server.registerTool(definition.name, {
      description: definition.description,
      inputSchema: definition.schema,
      annotations: {
        readOnlyHint: Boolean(definition.readOnly),
        destructiveHint: !definition.readOnly,
        idempotentHint: Boolean(definition.readOnly || definition.idempotent),
        openWorldHint: !definition.readOnly,
      },
    }, async (params, extra) => {
      try {
        const result = await client.call(definition.method, params, { signal: extra?.signal });
        const structuredContent = { result: result ?? null };
        return {
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      } catch (error) {
        const structuredContent = {
          error: {
            code: error.code ?? 'GATEWAY_ERROR',
            message: error.message || 'Gateway request failed.',
            outcomeUnknown: Boolean(error.outcomeUnknown),
          },
        };
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      }
    });
  }
  return server;
}

export async function startMcpServer(options) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().catch(() => {
    process.stderr.write('Unable to start Doubao Codex Gateway MCP adapter.\n');
    process.exitCode = 1;
  });
}
