# Hooks Reference (Python Agents)

Hooks let you run code at specific points in the agent's lifecycle for logging, monitoring, metrics, and custom behavior.

## Contents
- [Available Hook Events](#available-hook-events)
- [Defining Hooks](#defining-hooks)
- [Registering Hooks with Agents](#registering-hooks-with-agents)
- [Loop Hooks](#loop-hooks)
- [LLM Hooks](#llm-hooks)
- [Think Hook](#think-hook)
- [Tool Hooks](#tool-hooks)
- [Practical Examples](#practical-examples)
- [AgentContext Fields](#agentcontext-fields)
- [Error Handling in Hooks](#error-handling-in-hooks)
- [Best Practices](#best-practices)

## Available Hook Events

| Event | Trigger | Payload |
|-------|---------|---------|
| `agent_start` | Agent begins processing | context, agent |
| `agent_end` | Agent finishes successfully | context, agent, result |
| `agent_error` | Agent encounters an error | context, agent, error |
| `loop_start` | Each iteration begins | context, agent |
| `loop_end` | Each iteration ends | context, agent |
| `llm_call` | Before LLM is called | context, messages |
| `llm_response` | After LLM responds | context, response |
| `think_end` | After reasoning step | context, thought |
| `tool_call` | Before tool execution | context, tool_name, args |
| `tool_result` | After tool execution | context, tool_name, result |
| `tool_error` | Tool raises an error | context, tool_name, error |

## Defining Hooks

Use the `@hook` decorator with the event name:

```python
from opper_agents import hook
from opper_agents.base.context import AgentContext
from opper_agents.base.agent import BaseAgent

@hook("agent_start")
async def on_start(context: AgentContext, agent: BaseAgent):
    print(f"Agent '{agent.name}' starting with goal: {context.goal}")

@hook("agent_end")
async def on_end(context: AgentContext, agent: BaseAgent, result):
    print(f"Agent '{agent.name}' finished. Result: {result}")

@hook("agent_error")
async def on_error(context: AgentContext, agent: BaseAgent, error: Exception):
    print(f"Agent '{agent.name}' failed: {error}")
```

## Registering Hooks with Agents

Pass hooks as a list when creating the agent:

```python
from opper_agents import Agent

agent = Agent(
    name="MyAgent",
    instructions="Do the task.",
    tools=[my_tool],
    hooks=[on_start, on_end, on_error],
)
```

## Loop Hooks

Monitor each think-act iteration:

```python
@hook("loop_start")
async def on_loop_start(context: AgentContext, agent: BaseAgent):
    print(f"  Iteration {context.iteration} starting")

@hook("loop_end")
async def on_loop_end(context: AgentContext, agent: BaseAgent):
    print(f"  Iteration {context.iteration} complete")
```

## LLM Hooks

Observe model interactions:

```python
@hook("llm_call")
async def on_llm_call(context: AgentContext, messages):
    print(f"  Calling LLM with {len(messages)} messages")

@hook("llm_response")
async def on_llm_response(context: AgentContext, response):
    print(f"  LLM responded (tokens used in this call)")
```

## Think Hook

Access the agent's reasoning:

```python
@hook("think_end")
async def on_think(context: AgentContext, thought):
    print(f"  Agent thinking: {thought[:100]}...")
```

## Tool Hooks

Monitor tool execution:

```python
@hook("tool_call")
async def on_tool_call(context: AgentContext, tool_name: str, args):
    print(f"  Calling tool: {tool_name}({args})")

@hook("tool_result")
async def on_tool_result(context: AgentContext, tool_name: str, result):
    print(f"  Tool {tool_name} returned: {str(result)[:200]}")

@hook("tool_error")
async def on_tool_error(context: AgentContext, tool_name: str, error: Exception):
    print(f"  Tool {tool_name} failed: {error}")
```

## Practical Examples

### Cost Tracking

```python
total_tokens = 0

@hook("llm_response")
async def track_tokens(context: AgentContext, response):
    global total_tokens
    tokens = getattr(response, 'usage', {})
    total_tokens += tokens.get('total_tokens', 0)
    print(f"  Total tokens so far: {total_tokens}")
```

### Execution Logging

```python
import json
from datetime import datetime

execution_log = []

@hook("agent_start")
async def log_start(context: AgentContext, agent: BaseAgent):
    execution_log.append({
        "event": "start",
        "agent": agent.name,
        "goal": context.goal,
        "timestamp": datetime.now().isoformat(),
    })

@hook("tool_result")
async def log_tool(context: AgentContext, tool_name: str, result):
    execution_log.append({
        "event": "tool_result",
        "tool": tool_name,
        "result": str(result)[:500],
        "iteration": context.iteration,
        "timestamp": datetime.now().isoformat(),
    })

@hook("agent_end")
async def log_end(context: AgentContext, agent: BaseAgent, result):
    execution_log.append({
        "event": "end",
        "agent": agent.name,
        "result": str(result)[:500],
        "timestamp": datetime.now().isoformat(),
    })
    # Save log
    with open("execution_log.json", "w") as f:
        json.dump(execution_log, f, indent=2)
```

### Progress Reporting

```python
@hook("loop_start")
async def show_progress(context: AgentContext, agent: BaseAgent):
    max_iter = agent.max_iterations or 25
    pct = (context.iteration / max_iter) * 100
    print(f"  Progress: {context.iteration}/{max_iter} ({pct:.0f}%)")
```

## AgentContext Fields

The `context` object provides:

```python
context.goal          # The current goal/input
context.iteration     # Current iteration number
context.session_id    # Unique session identifier
context.usage         # Token usage stats
```

## Error Handling in Hooks

Hooks should not raise exceptions — they run alongside the agent:

```python
@hook("tool_result")
async def safe_hook(context: AgentContext, tool_name: str, result):
    try:
        # Your monitoring logic
        send_metric(tool_name, result)
    except Exception as e:
        # Log but don't crash the agent
        print(f"Hook error (non-fatal): {e}")
```

## Best Practices

- **Keep hooks lightweight**: Don't add heavy computation that slows down the agent
- **Handle errors**: Always wrap hook logic in try/except
- **Use for observability**: Hooks are ideal for logging, metrics, and monitoring
- **Don't modify state**: Hooks should observe, not modify the agent's behavior
- **Multiple hooks per event**: You can register multiple hooks for the same event
- **Async-compatible**: All hooks should be `async def` functions
