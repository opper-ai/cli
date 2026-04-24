# Tools Reference (Python Agents)

Tools give agents the ability to interact with the world. Define tools with the `@tool` decorator and provide them to agents.

## Contents
- [Basic Tool Definition](#basic-tool-definition)
- [Tool with Complex Parameters](#tool-with-complex-parameters)
- [Tool with Pydantic Schema](#tool-with-pydantic-schema)
- [Async Tools](#async-tools)
- [Tool Return Values](#tool-return-values)
- [Tool Error Handling](#tool-error-handling)
- [Tool Execution Context](#tool-execution-context)
- [Using Tools with Agents](#using-tools-with-agents)
- [Tool Naming](#tool-naming)
- [Best Practices](#best-practices)

## Basic Tool Definition

```python
from opper_agents import tool

@tool
def search_web(query: str) -> str:
    """Search the web for information about a topic."""
    # Your implementation here
    return f"Results for: {query}"

@tool
def calculate(expression: str) -> float:
    """Evaluate a mathematical expression."""
    return eval(expression)  # Use a safe evaluator in production
```

## Tool with Complex Parameters

Use type hints for structured input:

```python
from typing import List, Optional

@tool
def send_email(to: str, subject: str, body: str, cc: Optional[List[str]] = None) -> str:
    """Send an email to the specified recipient."""
    # Implementation
    return f"Email sent to {to}"
```

## Tool with Pydantic Schema

For complex inputs, use Pydantic models:

```python
from pydantic import BaseModel, Field

class SearchParams(BaseModel):
    query: str = Field(description="The search query")
    max_results: int = Field(default=5, description="Maximum results to return")
    filters: dict = Field(default_factory=dict, description="Optional filters")

@tool
def advanced_search(params: SearchParams) -> List[dict]:
    """Perform an advanced search with filters and pagination."""
    return [{"title": "Result", "url": "https://example.com"}]
```

## Async Tools

For I/O-bound operations (HTTP requests, database queries, file I/O):

```python
import httpx

@tool
async def fetch_url(url: str) -> str:
    """Fetch the content of a URL."""
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
        return response.text[:2000]

@tool
async def query_database(sql: str) -> List[dict]:
    """Execute a SQL query and return results."""
    # Async database query
    async with get_db_connection() as conn:
        results = await conn.fetch(sql)
        return [dict(row) for row in results]
```

## Tool Return Values

Tools can return various types:

```python
@tool
def get_number() -> int:
    """Return a number."""
    return 42

@tool
def get_data() -> dict:
    """Return structured data."""
    return {"key": "value", "count": 10}

@tool
def get_list() -> List[str]:
    """Return a list of items."""
    return ["item1", "item2", "item3"]
```

## Tool Error Handling

Handle errors gracefully — the agent will see the error message:

```python
@tool
def divide(a: float, b: float) -> float:
    """Divide two numbers."""
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b

@tool
async def fetch_api(endpoint: str) -> dict:
    """Fetch data from an API endpoint."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(endpoint, timeout=10)
            response.raise_for_status()
            return response.json()
    except httpx.TimeoutException:
        raise RuntimeError(f"Timeout fetching {endpoint}")
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"HTTP {e.response.status_code} from {endpoint}")
```

## Tool Execution Context

Tools receive execution context when the agent calls them:

```python
@tool
def context_aware_tool(query: str) -> str:
    """A tool that can access execution context."""
    # Context is available via the agent's execution
    # agent_name, iteration, span_id are tracked automatically
    return f"Processed: {query}"
```

## Using Tools with Agents

```python
from opper_agents import Agent

agent = Agent(
    name="ResearchBot",
    instructions="Use tools to research and answer questions.",
    tools=[search_web, fetch_url, calculate],
    max_iterations=10,
)

result = await agent.process("What is the population of Tokyo?")
```

## Tool Naming

The tool name defaults to the function name. The LLM uses both the name and docstring to decide when to call it:

```python
@tool
def get_current_weather(city: str, unit: str = "celsius") -> dict:
    """Get the current weather for a city.

    Args:
        city: The city name (e.g., "Paris", "Tokyo")
        unit: Temperature unit - "celsius" or "fahrenheit"
    """
    return {"city": city, "temp": 22, "unit": unit, "condition": "sunny"}
```

## Best Practices

- **Clear docstrings**: The agent relies on docstrings to understand tool purpose. Be specific.
- **Descriptive names**: Use verb_noun format: `search_web`, `get_weather`, `send_email`
- **Type hints**: Always provide type hints for parameters and return values.
- **Error messages**: Raise exceptions with helpful messages — the agent uses them to recover.
- **Focused tools**: Each tool should do one thing well. Don't create Swiss-army-knife tools.
- **Async for I/O**: Use `async` for any tool that does network or file I/O.
- **Limit count**: 5-10 tools per agent is optimal. Use multi-agent composition for more.
- **Validate inputs**: Check inputs early and raise clear errors for invalid values.
