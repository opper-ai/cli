# Migrating from OpenRouter (Python Agent SDK)

Replace OpenRouter tool/function calling patterns with Opper's agent framework for autonomous multi-step workflows.

## Contents
- [Overview](#overview)
- [Authentication](#authentication)
- [Basic Chat Completion → Task Completion](#basic-chat-completion--task-completion)
- [Structured Output](#structured-output)
- [Streaming](#streaming)
- [Model Selection and Fallbacks](#model-selection-and-fallbacks)
- [Tool Calling → Agent Tools](#tool-calling--agent-tools)
- [Key Differences](#key-differences)
- [What You Gain](#what-you-gain)
- [Common Gotchas](#common-gotchas)

## Overview

OpenRouter provides OpenAI-compatible tool/function calling where you manually manage the tool call loop (send tools, parse tool_calls, execute functions, send results back). Opper's agent SDK replaces this with declarative tool definitions and an autonomous `agent.process()` loop that handles multi-step reasoning automatically.

## Authentication

**OpenRouter:**
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key="sk-or-...",
)
```

**Opper:**
```python
# Agent SDK uses OPPER_HTTP_BEARER from environment automatically
import os
os.environ["OPPER_HTTP_BEARER"] = "your-key"
```

## Basic Chat Completion → Task Completion

**OpenRouter:**
```python
response = client.chat.completions.create(
    model="anthropic/claude-sonnet-4",
    messages=[
        {"role": "system", "content": "Summarize the text."},
        {"role": "user", "content": article_text},
    ],
)
summary = response.choices[0].message.content
```

**Opper (agent for simple tasks):**
```python
from opper_agents import Agent

agent = Agent(
    name="Summarizer",
    instructions="Summarize the text.",
)
summary = await agent.process(article_text)
```

## Structured Output

**OpenRouter:**
```python
response = client.chat.completions.create(
    model="anthropic/claude-sonnet-4",
    messages=[...],
    response_format={
        "type": "json_schema",
        "json_schema": {
            "name": "ticket_entities",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "customer_name": {"type": "string"},
                    "issue_type": {"type": "string"},
                },
                "required": ["customer_name", "issue_type"],
                "additionalProperties": False,
            },
        },
    },
)
entities = json.loads(response.choices[0].message.content)
```

**Opper (Pydantic model):**
```python
from pydantic import BaseModel, Field
from opper_agents import Agent

class TicketEntities(BaseModel):
    customer_name: str = Field(description="Customer's full name")
    issue_type: str = Field(description="Type of issue reported")

agent = Agent(
    name="EntityExtractor",
    instructions="Extract entities from the support ticket.",
    output_schema=TicketEntities,
)
entities: TicketEntities = await agent.process(ticket)
print(entities.customer_name)  # Typed access
```

The agent returns a validated Pydantic model instance directly.

## Streaming

Agent processing does not use the same streaming pattern as the SDK. For streaming responses within an agent context, configure the agent with streaming hooks or use the underlying SDK's `opper.stream()`.

## Model Selection and Fallbacks

**OpenRouter:**
```python
response = client.chat.completions.create(
    model="anthropic/claude-sonnet-4",
    messages=[...],
    extra_body={
        "models": ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
    },
)
```

**Opper:**
```python
agent = Agent(
    name="MyAgent",
    instructions="...",
    model="anthropic/claude-sonnet-4",  # Set model on the agent
)
```

Set the `model` parameter on the Agent constructor.

## Tool Calling → Agent Tools

This is the biggest change. OpenRouter requires you to manually manage the tool call loop. Opper agents handle it automatically.

**OpenRouter (manual tool loop):**
```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string"},
                },
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "route_ticket",
            "description": "Route a ticket to a team.",
            "parameters": {
                "type": "object",
                "properties": {
                    "team": {"type": "string"},
                    "priority": {"type": "string"},
                },
                "required": ["team", "priority"],
            },
        },
    },
]

# You must implement the tool dispatch loop yourself
messages = [
    {"role": "system", "content": "Help the user. Use tools as needed."},
    {"role": "user", "content": user_input},
]

while True:
    response = client.chat.completions.create(
        model="anthropic/claude-sonnet-4",
        messages=messages,
        tools=tools,
    )

    msg = response.choices[0].message
    if not msg.tool_calls:
        break  # No more tool calls, done

    messages.append(msg)
    for tool_call in msg.tool_calls:
        args = json.loads(tool_call.function.arguments)
        if tool_call.function.name == "get_weather":
            result = get_weather_impl(args["city"])
        elif tool_call.function.name == "route_ticket":
            result = route_ticket_impl(args["team"], args["priority"])
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": result,
        })

final_answer = messages[-1]["content"]
```

**Opper (declarative tools + autonomous loop):**
```python
from opper_agents import Agent, tool

@tool
def get_weather(city: str) -> str:
    """Get weather for a city."""
    return f"Weather in {city}: 22°C, sunny"

@tool
def route_ticket(team: str, priority: str) -> str:
    """Route a ticket to a team."""
    return f"Routed to {team} with {priority} priority"

agent = Agent(
    name="SupportAgent",
    instructions="Help the user. Use tools as needed.",
    tools=[get_weather, route_ticket],
    max_iterations=10,
)

result = await agent.process(user_input)
```

The `@tool` decorator extracts the function signature and docstring for the LLM. The agent runs the tool loop autonomously — calling tools, collecting results, and reasoning until it reaches a final answer.

**Multi-tool agent with structured output:**
```python
from pydantic import BaseModel
from opper_agents import Agent, tool

class TicketResolution(BaseModel):
    response: str
    team: str
    priority: str

@tool
def lookup_customer(account_id: str) -> str:
    """Look up customer details by account ID."""
    return f"Customer: Jane Doe, Plan: Pro, Status: Active"

@tool
def check_billing(account_id: str) -> str:
    """Check recent billing transactions for an account."""
    return f"Last charge: $49.99 on 2025-01-15, duplicate detected"

agent = Agent(
    name="BillingAgent",
    instructions=(
        "Investigate the billing issue using the available tools, "
        "then provide a resolution with team routing."
    ),
    tools=[lookup_customer, check_billing],
    output_schema=TicketResolution,
)

resolution: TicketResolution = await agent.process(
    "Account AC-4821 was charged twice for Pro subscription"
)
print(f"Route to: {resolution.team} ({resolution.priority})")
print(f"Response: {resolution.response}")
```

## Key Differences

| Concept | OpenRouter | Opper Agent SDK |
|---------|-----------|----------------|
| Client | `OpenAI(base_url=...)` | `Agent(name=..., instructions=...)` |
| Tool definition | `tools` JSON array | `@tool` decorated functions |
| Tool dispatch | Manual while loop | Automatic via `agent.process()` |
| Tool arguments | `json.loads(tool_call.function.arguments)` | Passed as typed function params |
| Tool results | Append `{"role": "tool", ...}` message | Return value from function |
| Structured output | `response_format.json_schema` | `output_schema=PydanticModel` |
| Parse response | `json.loads(message.content)` | Typed Pydantic instance |
| Multi-step reasoning | Manual message accumulation | Automatic with `max_iterations` |
| Model selection | `model` string + `extra_body.models` | `model` on Agent constructor |

## What You Gain

- **No tool dispatch loop** — the agent handles tool calling, result collection, and multi-step reasoning
- **Type-safe tools** — `@tool` decorator extracts types from function signatures
- **Pydantic output** — structured results are validated Pydantic instances, not raw dicts
- **Built-in tracing** — every agent run creates a trace with all tool calls visible
- **Iteration control** — `max_iterations` prevents runaway loops
- **Composability** — agents can call other agents for complex workflows

## Common Gotchas

- **Verify model IDs before using them.** Opper model identifiers differ from OpenRouter's (e.g., `gcp/gemini-2.5-flash-eu` not `google/gemini-2.5-flash-lite`). Check available models at https://api.opper.ai/static/data/language_models.json or https://docs.opper.ai/capabilities/models to avoid model-not-found errors.
- `agent.process()` is async — use `await agent.process(...)` or `asyncio.run()`
- Tool functions must have type annotations and a docstring (the docstring becomes the tool description for the LLM)
- The `@tool` decorator must be from `opper_agents`, not a custom decorator
- `output_schema` accepts a Pydantic model class, not a JSON Schema dict (unlike the SDK's `opper.call()`)
- If you don't need multi-step tool calling, consider using `opper.call()` from the Python SDK with `output_schema` instead
