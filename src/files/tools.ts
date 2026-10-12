/**
 * `session_files_list`, `session_files_read` and `session_files_view_image`: the tools an agent-sdk agent
 * reads a conversation's attachments with - the only way to read a file too long to be in the turn, and a
 * way back to an earlier upload. Read-only, and scoped to the conversation of the turn that calls them
 * (the server tells them which one - see turn.ts - so one set of tools serves every conversation).
 *
 * agent-sdk is an optional peer of this package, so the tools are built here in the shape `createTool` makes
 * them; the host adds them when it builds the agent:
 *
 * ```ts
 * const agent = createSmartAgent({ model, tools: [...myTools, ...createSessionFileTools()] });
 * ```
 */

import { z } from "zod";
import {
  SESSION_FILES_LIST_TOOL,
  SESSION_FILES_READ_TOOL,
  SESSION_FILES_VIEW_IMAGE_TOOL,
  isVisionImageMime,
} from "./config.js";
import { viewImageToolResult } from "./text.js";
import { currentTurnFiles } from "./turn.js";

/** The slice of agent-sdk's `ToolInterface` these tools fill in. */
export interface SessionFileTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  invoke: (args: Record<string, unknown>) => Promise<string>;
  call: (args: Record<string, unknown>) => Promise<string>;
  run: (args: Record<string, unknown>) => Promise<string>;
  func: (args: Record<string, unknown>) => Promise<string>;
  [key: string]: unknown;
}

export interface SessionFileToolsOptions {
  /**
   * Also offer `session_files_view_image` (default false). Needs the agent's model wrapped with
   * `withSessionImages` - a tool result is text on every provider's wire, so the wrapper is what puts the
   * image in front of the model - and `files.vision`.
   */
  viewImage?: boolean;
}

const NOT_IN_A_TURN = "Session files can only be read while the server is running a conversation.";

/** One page (1-based) of `text`; null when `page` is past the end. */
export function pageText(text: string, page: number, pageChars: number): { text: string; page: number; pages: number } | null {
  const pages = pageCount(text.length, pageChars);
  if (!Number.isInteger(page) || page < 1 || page > pages) return null;
  return { text: text.slice((page - 1) * pageChars, page * pageChars), page, pages };
}

export function pageCount(totalChars: number, pageChars: number): number {
  return Math.max(1, Math.ceil(totalChars / Math.max(1, pageChars)));
}

function makeTool(
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  func: (args: Record<string, unknown>) => Promise<string>
): SessionFileTool {
  // The shape agent-sdk's createTool produces: every calling convention it (or LangChain) may use
  return {
    name,
    description,
    schema,
    invoke: func,
    call: func,
    run: func,
    func,
    __source: "smart",
    __impl: func,
  };
}

export function createSessionFileTools(options: SessionFileToolsOptions = {}): SessionFileTool[] {
  const list = makeTool(
    SESSION_FILES_LIST_TOOL,
    "List the files attached to this conversation, with their ids. Use it to find a file before reading it.",
    z.object({}),
    async () => {
      const turn = currentTurnFiles();
      if (!turn) return NOT_IN_A_TURN;
      const files = await turn.list();
      if (files.length === 0) return "No files are attached to this conversation.";
      const rows = await Promise.all(
        files.map(async (file) => {
          const image = isVisionImageMime(file.mimeType);
          let readable = false;
          if (!image) {
            try {
              readable = (await turn.text(file)) !== null;
            } catch {
              readable = false;
            }
          }
          return {
            fileId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            readable,
            ...(image ? { image: true } : {}),
          };
        })
      );
      return JSON.stringify(rows);
    }
  );

  const read = makeTool(
    SESSION_FILES_READ_TOOL,
    "Read one page of a file attached to this conversation, as text. The result is { text, page, pages }; ask for the next page until you have what you need.",
    z.object({
      fileId: z.string().describe("The file id, from session_files_list or the attachment note."),
      page: z.number().int().min(1).optional().describe("Page number, starting at 1 (default 1)."),
    }),
    async (args) => {
      const turn = currentTurnFiles();
      if (!turn) return NOT_IN_A_TURN;
      const fileId = typeof args.fileId === "string" ? args.fileId : "";
      const record = fileId ? await turn.find(fileId) : null;
      if (!record) return `File "${fileId}" is not attached to this conversation. Use ${SESSION_FILES_LIST_TOOL} to see the files.`;
      let text: string | null;
      try {
        text = await turn.text(record);
      } catch (error) {
        console.error("[AgentServer] session_files_read failed:", error);
        return "The file could not be read right now.";
      }
      if (text === null) {
        if (isVisionImageMime(record.mimeType)) {
          return turn.viewImageTool
            ? `This file is an image; it has no text to read. Use ${SESSION_FILES_VIEW_IMAGE_TOOL} to look at it.`
            : "This file is an image; it has no text to read.";
        }
        return "This file has no readable text (it could not be converted).";
      }
      const requested = typeof args.page === "number" ? args.page : 1;
      const page = pageText(text, requested, turn.cfg.readPageChars);
      if (!page) {
        return JSON.stringify({ error: `Page ${requested} is out of range.`, pages: pageCount(text.length, turn.cfg.readPageChars) });
      }
      return JSON.stringify(page);
    }
  );

  const tools = [list, read];
  if (options.viewImage) {
    tools.push(
      makeTool(
        SESSION_FILES_VIEW_IMAGE_TOOL,
        "Look at an image attached to this conversation again. The image is shown to you in the message that follows the result. " +
          "Use it when an earlier image is no longer visible to you, or to check a detail you are unsure of.",
        z.object({
          fileId: z.string().describe("The image file id, from session_files_list or the [Attached image: ...] handle."),
        }),
        async (args) => {
          const turn = currentTurnFiles();
          if (!turn) return NOT_IN_A_TURN;
          const fileId = typeof args.fileId === "string" ? args.fileId : "";
          const record = fileId ? await turn.find(fileId) : null;
          if (!record) return `File "${fileId}" is not attached to this conversation. Use ${SESSION_FILES_LIST_TOOL} to see the files.`;
          if (!isVisionImageMime(record.mimeType)) {
            return `"${record.name}" is not an image. Use ${SESSION_FILES_READ_TOOL} to read it.`;
          }
          return viewImageToolResult(record.id, record.name);
        }
      )
    );
  }
  return tools;
}

/** The names of the tools above, for approval rules and for checking an agent has them. */
export const SESSION_FILE_TOOL_NAMES = [SESSION_FILES_LIST_TOOL, SESSION_FILES_READ_TOOL, SESSION_FILES_VIEW_IMAGE_TOOL] as const;
