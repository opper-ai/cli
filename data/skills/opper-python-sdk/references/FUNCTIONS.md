# Functions Reference (Python SDK)

Functions are server-side managed task definitions that allow you to version, reuse, and monitor AI tasks at scale.

## Contents
- [Why Use Functions?](#why-use-functions)
- [Creating Functions](#creating-functions)
- [Calling Functions by Name](#calling-functions-by-name)
- [Listing Functions](#listing-functions)
- [Getting a Function](#getting-a-function)
- [Updating Functions](#updating-functions)
- [Deleting Functions](#deleting-functions)
- [Inline vs. Managed Functions](#inline-vs-managed-functions)
- [Function Configuration Options](#function-configuration-options)
- [Best Practices](#best-practices)

## Why Use Functions?

- **Versioning**: Track changes to instructions and schemas over time
- **Reusability**: Call the same function from multiple places
- **Monitoring**: Dashboard visibility into usage and performance
- **A/B testing**: Compare different instructions or models

## Creating Functions

```python
import os
from opperai import Opper

opper = Opper(http_bearer=os.environ["OPPER_HTTP_BEARER"])

# Create a function with full configuration
function = opper.functions.create(
    name="classify_support_ticket",
    instructions="Classify the support ticket into a category",
    input_schema={
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "The ticket text"},
        },
        "required": ["text"],
    },
    output_schema={
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "enum": ["billing", "technical", "account", "general"],
            },
            "confidence": {"type": "number"},
        },
        "required": ["category", "confidence"],
    },
    model="anthropic/claude-4-sonnet",
)
```

## Calling Functions by Name

Once created, call functions by their name:

```python
response = opper.call(
    name="classify_support_ticket",
    input={"text": "I was charged twice for my subscription"},
)
print(response.json_payload)  # {"category": "billing", "confidence": 0.95}
```

## Listing Functions

```python
functions = opper.functions.list()
for fn in functions:
    print(f"{fn.name}: {fn.description}")
```

## Getting a Function

```python
# By ID
function = opper.functions.get(function_id="fn_123")

# By name
function = opper.functions.get_by_name(name="classify_support_ticket")
```

## Updating Functions

```python
opper.functions.update(
    function_id="fn_123",
    instructions="Updated: Classify the ticket with reasoning",
    model="openai/gpt-4o",
)
```

## Deleting Functions

```python
opper.functions.delete(function_id="fn_123")
```

## Inline vs. Managed Functions

When you call `opper.call()` with a `name` that doesn't exist as a managed function, Opper automatically creates one. This is the "inline" pattern — useful for prototyping:

```python
# This creates the function on first call if it doesn't exist
response = opper.call(
    name="my_new_task",
    instructions="Do something useful",
    input="hello",
)
```

For production, explicitly create and version functions for better control.

## Function Configuration Options

```python
function = opper.functions.create(
    name="my_function",
    instructions="Task description",
    description="Human-readable description for the dashboard",
    model="anthropic/claude-4-sonnet",
    input_schema={...},
    output_schema={...},
    # Additional options
    tags={"team": "backend", "env": "production"},
)
```

## Best Practices

- Use descriptive `name` values with namespacing: `"team/component/task"`
- Always provide `instructions` that clearly describe the task
- Define both `input_schema` and `output_schema` for type safety
- Use `tags` for cost attribution and filtering in the dashboard
- Version functions by creating new ones rather than updating in production
