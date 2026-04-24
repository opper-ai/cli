# Migrating from OpenRouter (Python SDK)

Replace OpenAI-compatible API calls through OpenRouter with Opper's native Python SDK.

## Contents
- [Overview](#overview)
- [Authentication](#authentication)
- [Basic Chat Completion → Task Completion](#basic-chat-completion--task-completion)
- [Structured Output](#structured-output)
- [Streaming](#streaming)
- [Model Selection and Fallbacks](#model-selection-and-fallbacks)
- [Knowledge Bases (RAG)](#knowledge-bases-rag)
- [Key Differences](#key-differences)
- [What You Gain](#what-you-gain)
- [Common Gotchas](#common-gotchas)

## Overview

OpenRouter provides an OpenAI-compatible gateway to multiple LLM providers. Opper replaces the low-level chat completions API with a task-oriented `opper.call()` interface that handles structured output, tracing, and knowledge retrieval natively.

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
import os
from opperai import Opper

opper = Opper(http_bearer=os.environ["OPPER_HTTP_BEARER"])
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

**Opper:**
```python
response = opper.call(
    name="summarize",
    instructions="Summarize the text.",
    input=article_text,
)
summary = response.message
```

The `name` parameter identifies the task for tracing and versioning. Instructions replace the system message; input replaces the user message.

## Structured Output

**OpenRouter:**
```python
response = client.chat.completions.create(
    model="anthropic/claude-sonnet-4",
    messages=[
        {"role": "system", "content": "Extract entities from the ticket."},
        {"role": "user", "content": ticket},
    ],
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

**Opper:**
```python
response = opper.call(
    name="extract_entities",
    instructions="Extract entities from the ticket.",
    input=ticket,
    output_schema={
        "type": "object",
        "properties": {
            "customer_name": {"type": "string"},
            "issue_type": {"type": "string"},
        },
        "required": ["customer_name", "issue_type"],
    },
)
entities = response.json_payload  # Already parsed, no json.loads needed
```

Key change: pass a JSON Schema dict directly to `output_schema`. The result is auto-parsed into `response.json_payload` (a dict). No `json.loads()` needed.

## Streaming

**OpenRouter:**
```python
stream = client.chat.completions.create(
    model="anthropic/claude-sonnet-4",
    messages=[
        {"role": "system", "content": "Write a story."},
        {"role": "user", "content": "A robot learning to cook"},
    ],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

**Opper:**
```python
outer = opper.stream(
    name="write_story",
    instructions="Write a story.",
    input="A robot learning to cook",
)

stream = next(value for key, value in outer if key == "result")

for event in stream:
    delta = getattr(event.data, "delta", None)
    if delta:
        print(delta, end="", flush=True)
```

Use `opper.stream()` instead of `opper.call()`. Extract the stream iterator with `next(value for key, value in outer if key == "result")`, then iterate over events.

## Model Selection and Fallbacks

**OpenRouter:**
```python
response = client.chat.completions.create(
    model="anthropic/claude-sonnet-4",
    messages=[...],
    extra_body={
        "models": [
            "anthropic/claude-sonnet-4",
            "openai/gpt-4o",
            "google/gemini-2.0-flash",
        ],
    },
)
```

**Opper:**
```python
response = opper.call(
    name="my_task",
    instructions="...",
    input="...",
    model=[
        "anthropic/claude-sonnet-4",
        "openai/gpt-4o",
        "google/gemini-2.0-flash",
    ],
)
```

Pass a list to `model` for automatic fallback. Opper tries each model in order. Works with both `opper.call()` and `opper.stream()`.

## Knowledge Bases (RAG)

OpenRouter RAG requires manual embedding, vector storage, and retrieval. Opper provides managed knowledge bases.

**OpenRouter (manual RAG):**
```python
# 1. Generate embeddings
embed_resp = client.embeddings.create(
    model="openai/text-embedding-3-small",
    input=[query] + documents,
)
# 2. Compute cosine similarity manually
# 3. Select top-k results
# 4. Pass context to completion
response = client.chat.completions.create(
    model="anthropic/claude-sonnet-4",
    messages=[
        {"role": "system", "content": "Answer using the context."},
        {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {query}"},
    ],
)
```

**Opper (managed RAG):**
```python
import time

# 1. Create a knowledge base (one-time setup)
kb = opper.knowledge.create(name=f"my_kb_{int(time.time())}")

# 2. Add documents
opper.knowledge.add(
    knowledge_base_id=kb.id,
    content="Document text here...",
    metadata={"category": "billing"},
)

# 3. Query — returns ranked results with scores
results = opper.knowledge.query(
    knowledge_base_id=kb.id,
    query="How do refunds work?",
    top_k=3,
)

# 4. Use results as context
context = "\n".join(r.content for r in results)
response = opper.call(
    name="rag_answer",
    instructions="Answer using the provided context.",
    input=f"Context:\n{context}\n\nQuestion: How do refunds work?",
)
```

No embedding model selection, vector math, or storage management needed.

## Key Differences

| Concept | OpenRouter | Opper |
|---------|-----------|-------|
| Client | `OpenAI(base_url=...)` | `Opper(http_bearer=...)` |
| Completion | `client.chat.completions.create()` | `opper.call()` |
| System message | `messages[0].role = "system"` | `instructions` parameter |
| User message | `messages[1].role = "user"` | `input` parameter |
| Structured output | `response_format.json_schema` | `output_schema` dict |
| Parse response | `json.loads(message.content)` | `response.json_payload` |
| Plain text | `message.content` | `response.message` |
| Streaming | `stream=True` on create | `opper.stream()` |
| Model fallback | `extra_body={"models": [...]}` | `model=[...]` |
| Embeddings / RAG | Manual: embed → cosine → top-k | `opper.knowledge.create/add/query` |
| Tracing | Not built-in | `parent_span_id` on every call |
| Tool calling | `tools` + `tool_calls` loop | Use `output_schema` or agent SDK |

## What You Gain

- **No JSON parsing** — structured output is auto-parsed into `json_payload`
- **Managed RAG** — knowledge bases handle embedding, indexing, and retrieval
- **Built-in tracing** — every call returns a `span_id`; link calls with `parent_span_id`
- **Model fallbacks** — first-class `model=[...]` parameter
- **Task naming** — `name` parameter enables versioning, A/B testing, and analytics
- **Cost tracking** — `response.usage` and `response.cost` on every call

## Common Gotchas

- **Verify model IDs before using them.** Opper model identifiers differ from OpenRouter's (e.g., `gcp/gemini-2.5-flash-eu` not `google/gemini-2.5-flash-lite`). Check available models at https://api.opper.ai/static/data/language_models.json or https://docs.opper.ai/capabilities/models to avoid model-not-found errors.
- Use `response.json_payload` (not `response.message`) when `output_schema` is set — `message` will be `None`
- Use `response.message` (not `response.json_payload`) when no `output_schema` is set
- The `name` parameter is required and should use `/` separators for namespacing (e.g., `"support/extract_entities"`)
- `opper.stream()` returns an outer iterator; extract the stream with `next(value for key, value in outer if key == "result")` before iterating events
- Use `getattr(event.data, "delta", None)` to safely handle keep-alive events during streaming
- Knowledge base names must be unique — append a timestamp or use a fixed name with error handling
