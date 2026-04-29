import { z } from 'zod';

const baseAction = z.object({
  summary: z.string().default(''),
});

export const listFilesActionSchema = baseAction.extend({
  type: z.literal('list_files'),
  limit: z.number().int().positive().max(500).optional(),
});

export const readFileActionSchema = baseAction.extend({
  type: z.literal('read_file'),
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const searchFilesActionSchema = baseAction.extend({
  type: z.literal('search_files'),
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
});

export const inspectRepoActionSchema = baseAction.extend({
  type: z.literal('inspect_repo'),
  query: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const readManyFilesActionSchema = baseAction.extend({
  type: z.literal('read_many_files'),
  files: z.array(z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })).min(1).max(12),
});

export const searchCodeActionSchema = baseAction.extend({
  type: z.literal('search_code'),
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
});

export const editFileActionSchema = baseAction.extend({
  type: z.literal('edit_file'),
  path: z.string().min(1),
  content: z.string().optional(),
  oldString: z.string().optional(),
  newString: z.string().optional(),
  replaceAll: z.boolean().optional(),
});

export const applyPatchActionSchema = baseAction.extend({
  type: z.literal('apply_patch'),
  patches: z.array(z.object({
    path: z.string().min(1),
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  })).min(1).max(20),
});

export const createFileActionSchema = baseAction.extend({
  type: z.literal('create_file'),
  path: z.string().min(1),
  content: z.string(),
});

export const deleteFileActionSchema = baseAction.extend({
  type: z.literal('delete_file'),
  path: z.string().min(1),
});

export const renameFileActionSchema = baseAction.extend({
  type: z.literal('rename_file'),
  fromPath: z.string().min(1),
  toPath: z.string().min(1),
});

export const runCommandActionSchema = baseAction.extend({
  type: z.literal('run_command'),
  command: z.string().min(1),
});

export const gitDiffActionSchema = baseAction.extend({
  type: z.literal('get_git_diff'),
});

export const listMcpToolsActionSchema = baseAction.extend({
  type: z.literal('list_mcp_tools'),
  server: z.string().optional(),
  tool: z.string().optional(),
});

export const callMcpToolActionSchema = baseAction.extend({
  type: z.literal('call_mcp_tool'),
  server: z.string().min(1).optional(),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(300000).optional(),
});

export const resolveMcpIntentActionSchema = baseAction.extend({
  type: z.literal('resolve_mcp_intent'),
  server: z.string().min(1).optional(),
  intent: z.string().min(1),
  knownArguments: z.record(z.unknown()).optional(),
});

export const askUserActionSchema = baseAction.extend({
  type: z.literal('ask_user'),
  question: z.string().min(1),
});

export const finishActionSchema = baseAction.extend({
  type: z.literal('finish'),
  result: z.string().min(1),
});

export const agentActionSchema = z.discriminatedUnion('type', [
  listFilesActionSchema,
  readFileActionSchema,
  searchFilesActionSchema,
  inspectRepoActionSchema,
  readManyFilesActionSchema,
  searchCodeActionSchema,
  editFileActionSchema,
  applyPatchActionSchema,
  createFileActionSchema,
  deleteFileActionSchema,
  renameFileActionSchema,
  runCommandActionSchema,
  gitDiffActionSchema,
  listMcpToolsActionSchema,
  callMcpToolActionSchema,
  resolveMcpIntentActionSchema,
  askUserActionSchema,
  finishActionSchema,
]);

export const agentResponseSchema = z.object({
  summary: z.string().default(''),
  actions: z.array(agentActionSchema).min(1),
});

export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;
