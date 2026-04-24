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

export const editFileActionSchema = baseAction.extend({
  type: z.literal('edit_file'),
  path: z.string().min(1),
  content: z.string().optional(),
  oldString: z.string().optional(),
  newString: z.string().optional(),
  replaceAll: z.boolean().optional(),
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
  editFileActionSchema,
  createFileActionSchema,
  deleteFileActionSchema,
  renameFileActionSchema,
  runCommandActionSchema,
  gitDiffActionSchema,
  askUserActionSchema,
  finishActionSchema,
]);

export const agentResponseSchema = z.object({
  summary: z.string().default(''),
  actions: z.array(agentActionSchema).min(1),
});

export type AgentAction = z.infer<typeof agentActionSchema>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;
