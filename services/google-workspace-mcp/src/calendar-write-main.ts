// Optional, separately deployed write connector. The normal Google server remains read-only.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CalendarWriter, EventInput } from "./calendar-writer.js";
import { z } from "zod";
const token = readFileSync(process.env.MCP_TOKEN_FILE!, "utf8").trim();
if (!token) throw new Error("Token required");
const credentials = () => {
  const c = JSON.parse(
    readFileSync(process.env.GOOGLE_WRITE_CREDENTIALS_FILE!, "utf8"),
  );
  const account = c.accounts?.[c.primary];
  return { ...c, ...account };
};
createServer(async (req, res) => {
  const a = Buffer.from(req.headers.authorization || ""),
    b = Buffer.from(`Bearer ${token}`);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.writeHead(401).end();
    return;
  }
  if (req.url !== "/mcp" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 32000) throw new Error("Too large");
    }
    const server = new Server(
      { name: "calendar-write", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "family_calendar_create_event",
          description:
            "Create an event only on the configured Family calendar when the user asks. request_id must be stable for retries (task ID plus event name). No guests, updates or deletes.",
          inputSchema: z.toJSONSchema(EventInput) as never,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        if (params.name !== "family_calendar_create_event")
          throw new Error("Unknown tool");
        const writer = new CalendarWriter(
          process.env.GOOGLE_WRITE_CALENDAR_ID!,
          credentials(),
        );
        const result = await writer.create(params.arguments);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text", text: (e as Error).message }],
        };
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(body));
  } catch {
    if (!res.headersSent) res.writeHead(400).end();
  }
}).listen(8090, "0.0.0.0");
