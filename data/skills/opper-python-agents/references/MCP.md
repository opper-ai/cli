# MCP Integration Reference (Python Agents)

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

```python
from opper_agents import Agent, mcp, MCPServerConfig

# Configure an MCP server
server = MCPServerConfig(
    name="filesystem",
    transport="stdio",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
)

# Use MCP tools in an agent
agent = Agent(
    name="FileAgent",
    instructions="Use filesystem tools to read and write files.",
    tools=[mcp(server)],
)

result = await agent.process("List all files in /tmp")
```

## Transport Types

### stdio (Local Process)

Starts the MCP server as a child process:

```python
server = MCPServerConfig(
    name="filesystem",
    transport="stdio",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-filesystem", "/home/user/docs"],
)
```

### HTTP SSE (Remote Server)

Connect to a remote MCP server over HTTP:

```python
server = MCPServerConfig(
    name="remote_tools",
    transport="http-sse",
    url="http://localhost:8080/mcp",
)
```

### Streamable HTTP

Modern HTTP transport with bidirectional streaming:

```python
server = MCPServerConfig(
    name="remote_tools",
    transport="streamable-http",
    url="http://localhost:8080/mcp",
)
```

## Multiple MCP Servers

Combine tools from multiple servers:

```python
fs_server = MCPServerConfig(
    name="filesystem",
    transport="stdio",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-filesystem", "/data"],
)

db_server = MCPServerConfig(
    name="sqlite",
    transport="stdio",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-sqlite", "database.db"],
)

agent = Agent(
    name="DataAgent",
    instructions="Use filesystem and database tools to answer questions.",
    tools=[mcp(fs_server), mcp(db_server)],
)
```

## Mixing MCP and Custom Tools

Combine MCP tools with your own `@tool` functions:

```python
from opper_agents import tool

@tool
def summarize(text: str) -> str:
    """Summarize the given text."""
    # Your summarization logic
    return f"Summary: {text[:100]}..."

agent = Agent(
    name="ResearchAgent",
    instructions="Read files and summarize their contents.",
    tools=[mcp(fs_server), summarize],
)
```

## Docker-Based MCP Servers

Run MCP servers in Docker containers for isolation:

```python
server = MCPServerConfig(
    name="filesystem",
    transport="stdio",
    command="docker",
    args=[
        "run", "-i", "--rm",
        "-v", "/host/path:/container/path:ro",
        "mcp/filesystem",
    ],
)
```

## Common MCP Servers

### Filesystem

```python
MCPServerConfig(
    name="filesystem",
    transport="stdio",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
)
```

### SQLite Database

```python
MCPServerConfig(
    name="sqlite",
    transport="stdio",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-sqlite", "path/to/db.sqlite"],
)
```

### Composio (Gmail, Calendar, etc.)

```python
MCPServerConfig(
    name="composio",
    transport="stdio",
    command="npx",
    args=["-y", "composio-mcp"],
    env={"COMPOSIO_API_KEY": "your-key"},
)
```

## Tool Naming

MCP tools are automatically prefixed with the server name to avoid conflicts:

```
filesystem server → filesystem_read_file, filesystem_write_file, filesystem_list_directory
sqlite server → sqlite_read_query, sqlite_write_query
```

## Lifecycle Management

MCP servers are automatically started when the agent runs and cleaned up when it finishes. No manual lifecycle management needed.

## Error Handling

```python
from opper_agents import Agent, mcp, MCPServerConfig

try:
    result = await agent.process("Read the config file")
except Exception as e:
    print(f"MCP operation failed: {e}")
    # Common errors: server not found, permission denied, timeout
```

## Best Practices

- **Limit permissions**: Mount filesystems as read-only when possible
- **Use Docker**: Isolate MCP servers in containers for security
- **Set timeouts**: Configure reasonable timeouts for remote servers
- **Monitor usage**: Use hooks to track MCP tool invocations
- **Secure credentials**: Pass API keys via environment variables, not arguments
- **One server per concern**: Don't overload a single MCP server with too many capabilities
