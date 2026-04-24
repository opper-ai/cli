# MCP Integration Reference (Node Agents)

Connect agents to external tool providers via the Model Context Protocol (MCP). MCP servers expose tools for filesystem access, databases, APIs, and more.

## Contents
- [Basic MCP Setup](#basic-mcp-setup)
- [Transport Types](#transport-types)
- [Multiple MCP Servers](#multiple-mcp-servers)
- [Mixing MCP and Custom Tools](#mixing-mcp-and-custom-tools)
- [Docker-Based MCP Servers](#docker-based-mcp-servers)
- [Common MCP Servers](#common-mcp-servers)
- [Tool Naming](#tool-naming)
- [Lifecycle Management](#lifecycle-management)
- [Error Handling](#error-handling)
- [Best Practices](#best-practices)

## Basic MCP Setup

```typescript
import { Agent, mcp, MCPconfig } from "@opperai/agents";

// Configure an MCP server
const fsServer = MCPconfig({
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
});

// Use MCP tools in an agent
const agent = new Agent<string, string>({
  name: "FileAgent",
  instructions: "Use filesystem tools to read and manage files.",
  tools: [mcp(fsServer)],
});

const { result } = await agent.run("List all files in /tmp");
```

## Transport Types

### stdio (Local Process)

Starts the MCP server as a child process:

```typescript
const server = MCPconfig({
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"],
});
```

### HTTP SSE (Remote Server)

Connect to a remote MCP server:

```typescript
const server = MCPconfig({
  name: "remote_tools",
  transport: "http-sse",
  url: "http://localhost:8080/mcp",
});
```

### Streamable HTTP

Modern HTTP transport:

```typescript
const server = MCPconfig({
  name: "remote_tools",
  transport: "streamable-http",
  url: "http://localhost:8080/mcp",
});
```

## Multiple MCP Servers

Combine tools from multiple servers:

```typescript
const fsServer = MCPconfig({
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
});

const dbServer = MCPconfig({
  name: "sqlite",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-sqlite", "database.db"],
});

const agent = new Agent<string, string>({
  name: "DataAgent",
  instructions: "Use filesystem and database tools to answer questions.",
  tools: [mcp(fsServer), mcp(dbServer)],
});
```

## Mixing MCP and Custom Tools

Combine MCP tools with `createFunctionTool`:

```typescript
import { createFunctionTool } from "@opperai/agents";
import { z } from "zod";

const summarize = createFunctionTool(
  (input: { text: string }) => `Summary: ${input.text.slice(0, 100)}...`,
  {
    name: "summarize",
    description: "Summarize the given text",
    schema: z.object({ text: z.string() }),
  },
);

const agent = new Agent<string, string>({
  name: "ResearchAgent",
  instructions: "Read files and summarize their contents.",
  tools: [mcp(fsServer), summarize],
});
```

## Docker-Based MCP Servers

Run MCP servers in containers for isolation:

```typescript
const server = MCPconfig({
  name: "filesystem",
  transport: "stdio",
  command: "docker",
  args: [
    "run", "-i", "--rm",
    "-v", "/host/path:/container/path:ro",
    "mcp/filesystem",
  ],
});
```

## Common MCP Servers

### Filesystem

```typescript
MCPconfig({
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
});
```

### SQLite Database

```typescript
MCPconfig({
  name: "sqlite",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-sqlite", "path/to/db.sqlite"],
});
```

### Composio (Gmail, Calendar, etc.)

```typescript
MCPconfig({
  name: "composio",
  transport: "stdio",
  command: "npx",
  args: ["-y", "composio-mcp"],
  env: { COMPOSIO_API_KEY: "your-key" },
});
```

## Tool Naming

MCP tools are automatically prefixed with the server name:

```
filesystem server → filesystem_read_file, filesystem_write_file, filesystem_list_directory
sqlite server → sqlite_read_query, sqlite_write_query
```

## Lifecycle Management

MCP servers are automatically started when the agent runs and cleaned up when it finishes. No manual lifecycle management needed.

## Error Handling

```typescript
try {
  const { result } = await agent.run("Read the config file");
} catch (error) {
  console.error(`MCP operation failed: ${error.message}`);
  // Common: server not found, permission denied, timeout
}
```

## Best Practices

- **Limit permissions**: Mount filesystems as read-only (`:ro`) when possible
- **Use Docker**: Isolate MCP servers in containers for security
- **Set timeouts**: Configure reasonable timeouts for remote servers
- **Monitor usage**: Use hooks to track MCP tool invocations
- **Secure credentials**: Pass API keys via environment variables
- **One server per concern**: Keep MCP servers focused on specific capabilities
- **Test locally**: Verify MCP servers work standalone before integrating with agents
