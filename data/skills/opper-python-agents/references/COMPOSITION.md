# Multi-Agent Composition Reference (Python Agents)

Build complex systems by using agents as tools within other agents. This enables delegation, specialization, and hierarchical reasoning.

## Contents
- [Basic Composition](#basic-composition)
- [How Composition Works](#how-composition-works)
- [Multiple Specialist Agents](#multiple-specialist-agents)
- [Custom Tool Names and Descriptions](#custom-tool-names-and-descriptions)
- [Manual Agent Wrapping](#manual-agent-wrapping)
- [Multi-Level Hierarchies](#multi-level-hierarchies)
- [Structured Output in Composed Agents](#structured-output-in-composed-agents)
- [Tracing Composed Agents](#tracing-composed-agents)
- [Best Practices](#best-practices)

## Basic Composition

Use `agent.as_tool()` to convert an agent into a tool:

```python
from opper_agents import Agent, tool

@tool
def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b

@tool
def multiply(a: int, b: int) -> int:
    """Multiply two numbers."""
    return a * b

# Specialist agent
math_agent = Agent(
    name="MathAgent",
    instructions="Solve math problems step by step using available tools.",
    tools=[add, multiply],
)

# Coordinator uses the specialist as a tool
coordinator = Agent(
    name="Coordinator",
    instructions="Delegate math problems to the math specialist.",
    tools=[math_agent.as_tool()],
)

result = await coordinator.process("What is (5 + 3) * 7?")
```

## How Composition Works

1. The parent agent decides to call a child agent (via `as_tool()`)
2. The child agent receives the input and runs its own think-act loop
3. The child agent returns its final result to the parent
4. The parent uses the result to continue its own reasoning

Each child agent runs independently with its own tools, model, and iteration limit.

## Multiple Specialist Agents

```python
research_agent = Agent(
    name="ResearchAgent",
    instructions="Answer factual questions by searching for information.",
    tools=[search_web, fetch_url],
)

writing_agent = Agent(
    name="WritingAgent",
    instructions="Write clear, concise content on any topic.",
    tools=[],  # Pure LLM reasoning
)

coding_agent = Agent(
    name="CodingAgent",
    instructions="Write and debug code in Python.",
    tools=[run_python, read_file],
)

# Coordinator delegates to specialists
coordinator = Agent(
    name="ProjectManager",
    instructions="""You manage a team of specialists:
    - ResearchAgent: for finding information
    - WritingAgent: for writing content
    - CodingAgent: for programming tasks
    Delegate tasks appropriately.""",
    tools=[
        research_agent.as_tool(),
        writing_agent.as_tool(),
        coding_agent.as_tool(),
    ],
)
```

## Custom Tool Names and Descriptions

Override the default tool name/description for clarity:

```python
coordinator = Agent(
    name="Coordinator",
    tools=[
        math_agent.as_tool(),  # Uses agent name + description by default
    ],
)
```

The tool name defaults to the agent's `name` and the description uses the agent's `description`.

## Manual Agent Wrapping

For more control, wrap agents manually with `@tool`:

```python
@tool
async def ask_researcher(question: str) -> str:
    """Ask the research specialist to find information about a topic."""
    agent = Agent(
        name="Researcher",
        instructions="Research the given topic thoroughly.",
        tools=[search_web],
        model="anthropic/claude-4-sonnet",
    )
    result = await agent.process(question)
    return result
```

This pattern gives you control over:
- Agent configuration per invocation
- Custom input/output processing
- Error handling and retries

## Multi-Level Hierarchies

Agents can be nested multiple levels deep:

```python
# Level 3: Leaf agents
calculator = Agent(name="Calculator", tools=[add, multiply])
searcher = Agent(name="Searcher", tools=[search_web])

# Level 2: Department heads
math_dept = Agent(
    name="MathDepartment",
    instructions="Handle all mathematical computations.",
    tools=[calculator.as_tool()],
)

research_dept = Agent(
    name="ResearchDepartment",
    instructions="Handle all research queries.",
    tools=[searcher.as_tool()],
)

# Level 1: Top-level coordinator
ceo = Agent(
    name="CEO",
    instructions="Route requests to the appropriate department.",
    tools=[math_dept.as_tool(), research_dept.as_tool()],
)
```

## Structured Output in Composed Agents

Child agents can have their own output schemas:

```python
from pydantic import BaseModel

class MathResult(BaseModel):
    answer: float
    steps: list[str]

math_agent = Agent(
    name="MathAgent",
    instructions="Solve math and show steps.",
    tools=[add, multiply],
    output_schema=MathResult,
)

# The parent receives the structured result
coordinator = Agent(
    name="Coordinator",
    tools=[math_agent.as_tool()],
)
```

## Tracing Composed Agents

Each child agent creates its own trace span as a child of the parent's span:

```
Trace: "coordinator"
├── Span: "Coordinator" (parent agent)
│   ├── Think: "I need to solve the math problem"
│   ├── Tool: "MathAgent" → triggers child agent
│   │   ├── Span: "MathAgent" (child agent)
│   │   │   ├── Think: "I'll use add then multiply"
│   │   │   ├── Tool: "add(5, 3)" → 8
│   │   │   └── Tool: "multiply(8, 7)" → 56
│   │   └── Result: {"answer": 56, "steps": [...]}
│   └── Final: "The answer is 56"
```

## Best Practices

- **Clear descriptions**: Give each agent a clear `description` so the parent knows when to use it
- **Single responsibility**: Each agent should have one area of expertise
- **Limit depth**: 2-3 levels is usually sufficient. Deeper hierarchies add latency
- **Appropriate models**: Use faster/cheaper models for simple specialists, powerful models for coordinators
- **Error handling**: Child agent failures appear as tool errors to the parent
- **Limit iterations**: Set `max_iterations` on child agents to prevent runaway loops
- **Shared context**: Pass relevant context in the coordinator's instructions, not just the user query
