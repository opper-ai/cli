# Migrating from OpenRouter (Opper API)

Replace raw HTTP calls to OpenRouter's OpenAI-compatible API with Opper's REST API endpoints.

## Contents
- [Overview](#overview)
- [Authentication](#authentication)
- [Basic Chat Completion → Task Completion](#basic-chat-completion--task-completion)
- [Structured Output](#structured-output)
- [Streaming](#streaming)
- [Model Selection and Fallbacks](#model-selection-and-fallbacks)
- [Raw HTTP / curl Migration](#raw-http--curl-migration)
- [Key Differences](#key-differences)
- [What You Gain](#what-you-gain)
- [Common Gotchas](#common-gotchas)

## Overview

OpenRouter exposes an OpenAI-compatible `/v1/chat/completions` endpoint. Opper replaces this with `POST /v2/call` — a task-oriented endpoint that handles structured output, tracing, and model fallbacks natively. This guide covers the HTTP-level changes for direct API consumers.

## Authentication

**OpenRouter:**
```bash
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

**Opper:**
```bash
curl https://api.opper.ai/v2/call \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## Basic Chat Completion → Task Completion

**OpenRouter:**
```bash
curl -X POST https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "messages": [
      {"role": "system", "content": "Summarize the text."},
      {"role": "user", "content": "Long article text here..."}
    ]
  }'
```

Response:
```json
{
  "choices": [{
    "message": {"role": "assistant", "content": "Summary here..."}
  }],
  "usage": {"prompt_tokens": 50, "completion_tokens": 30}
}
```

**Opper:**
```bash
curl -X POST https://api.opper.ai/v2/call \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "summarize",
    "instructions": "Summarize the text.",
    "input": "Long article text here..."
  }'
```

Response:
```json
{
  "span_id": "uuid-here",
  "message": "Summary here...",
  "cached": false,
  "usage": {"prompt_tokens": 50, "completion_tokens": 30},
  "cost": 0.00042
}
```

The `messages` array is replaced by `instructions` (system) and `input` (user). The response includes `span_id` for tracing and `cost` for tracking.

## Structured Output

**OpenRouter:**
```bash
curl -X POST https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "messages": [
      {"role": "system", "content": "Extract entities."},
      {"role": "user", "content": "Ticket text..."}
    ],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "entities",
        "strict": true,
        "schema": {
          "type": "object",
          "properties": {
            "customer_name": {"type": "string"},
            "issue_type": {"type": "string"}
          },
          "required": ["customer_name", "issue_type"],
          "additionalProperties": false
        }
      }
    }
  }'
```

Response: `choices[0].message.content` is a JSON string you must parse.

**Opper:**
```bash
curl -X POST https://api.opper.ai/v2/call \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "extract_entities",
    "instructions": "Extract entities.",
    "input": "Ticket text...",
    "output_schema": {
      "type": "object",
      "properties": {
        "customer_name": {"type": "string"},
        "issue_type": {"type": "string"}
      },
      "required": ["customer_name", "issue_type"]
    }
  }'
```

Response:
```json
{
  "span_id": "uuid-here",
  "json_payload": {
    "customer_name": "Jane Doe",
    "issue_type": "duplicate_charge"
  },
  "cached": false,
  "usage": {"prompt_tokens": 40, "completion_tokens": 20},
  "cost": 0.00035
}
```

The schema goes directly in `output_schema` (no wrapping in `response_format.json_schema`). The response `json_payload` is already a parsed JSON object.

## Streaming

**OpenRouter:**
```bash
curl -X POST https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "messages": [
      {"role": "system", "content": "Write a story."},
      {"role": "user", "content": "A robot learning to cook"}
    ],
    "stream": true
  }'
```

SSE format: `data: {"choices":[{"delta":{"content":"token"}}]}`

**Opper:**
```bash
curl -X POST https://api.opper.ai/v2/call/stream \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "write_story",
    "instructions": "Write a story.",
    "input": "A robot learning to cook"
  }'
```

SSE format: `data: {"delta":"token","span_id":"uuid","chunk_type":"text"}`

Key differences: use `/v2/call/stream` endpoint (not `stream: true` in body), add `Accept: text/event-stream` header, and event format uses `delta` directly (not nested in `choices[0].delta.content`).

## Model Selection and Fallbacks

**OpenRouter:**
```json
{
  "model": "anthropic/claude-sonnet-4",
  "messages": [...],
  "models": [
    "anthropic/claude-sonnet-4",
    "openai/gpt-4o",
    "google/gemini-2.0-flash"
  ]
}
```

**Opper:**
```json
{
  "name": "my_task",
  "instructions": "...",
  "input": "...",
  "model": [
    "anthropic/claude-sonnet-4",
    "openai/gpt-4o",
    "google/gemini-2.0-flash"
  ]
}
```

The `model` field accepts either a string or an array. When an array is provided, Opper tries each model in order.

## Raw HTTP / curl Migration

### Request body mapping

| OpenRouter field | Opper field | Notes |
|-----------------|------------|-------|
| `model` | `model` | String or string array |
| `messages[0] (system)` | `instructions` | System prompt |
| `messages[1] (user)` | `input` | Any JSON value |
| `response_format.json_schema.schema` | `output_schema` | JSON Schema object directly |
| `stream: true` | Use `/v2/call/stream` | Separate endpoint |
| `temperature` | `configuration.temperature` | Via configuration object |
| `tools` | Not available | Use agent SDKs or `output_schema` |
| `models` (fallback array) | `model` (as array) | First-class support |
| — | `name` | Required, identifies the task |
| — | `parent_span_id` | Optional, links to parent trace |
| — | `tags` | Optional, key-value metadata |

### Response body mapping

| OpenRouter field | Opper field | Notes |
|-----------------|------------|-------|
| `choices[0].message.content` | `message` | When no output_schema |
| `choices[0].message.content` (JSON string) | `json_payload` | When output_schema set; already parsed |
| `usage.prompt_tokens` | `usage.prompt_tokens` | Same structure |
| `usage.completion_tokens` | `usage.completion_tokens` | Same structure |
| — | `span_id` | Trace identifier |
| — | `cost` | Cost in USD |
| — | `cached` | Whether result was cached |

### SSE event mapping

| OpenRouter SSE | Opper SSE |
|---------------|-----------|
| `data: {"choices":[{"delta":{"content":"tok"}}]}` | `data: {"delta":"tok","span_id":"...","chunk_type":"text"}` |
| `data: [DONE]` | Stream closes |

### Knowledge base operations (replaces manual RAG)

```bash
# Create knowledge base
curl -X POST https://api.opper.ai/v2/knowledge \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "support_kb"}'

# Add document
curl -X POST https://api.opper.ai/v2/knowledge/{id}/add \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "billing_faq",
    "content": "Document text...",
    "metadata": {"category": "billing"}
  }'

# Query (replaces embeddings + cosine similarity)
curl -X POST https://api.opper.ai/v2/knowledge/{id}/query \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "How do refunds work?", "top_k": 3}'
```

## Key Differences

| Concept | OpenRouter | Opper API |
|---------|-----------|-----------|
| Base URL | `https://openrouter.ai/api/v1` | `https://api.opper.ai` |
| Completion endpoint | `POST /v1/chat/completions` | `POST /v2/call` |
| Stream endpoint | Same + `stream: true` | `POST /v2/call/stream` |
| Auth header | `Authorization: Bearer sk-or-...` | `Authorization: Bearer $OPPER_API_KEY` |
| Request body | `messages` array | `name` + `instructions` + `input` |
| Structured output | `response_format.json_schema` | `output_schema` (direct JSON Schema) |
| Response text | `choices[0].message.content` | `message` or `json_payload` |
| Embeddings | `POST /v1/embeddings` | `POST /v2/embeddings` |
| Vector search | Not available (BYO) | `POST /v2/knowledge/{id}/query` |
| Tracing | Not available | `span_id` in response, `parent_span_id` in request |

## What You Gain

- **Simpler request body** — `name` + `instructions` + `input` instead of `messages` array
- **Auto-parsed structured output** — `json_payload` is a JSON object, not a JSON string
- **Built-in tracing** — `span_id` on every response; link calls with `parent_span_id`
- **Managed RAG** — knowledge base endpoints replace manual embedding + vector search
- **Cost tracking** — `cost` field on every response
- **Model fallbacks** — `model` accepts an array natively

## Common Gotchas

- **Verify model IDs before using them.** Opper model identifiers differ from OpenRouter's (e.g., `gcp/gemini-2.5-flash-eu` not `google/gemini-2.5-flash-lite`). Check available models at https://api.opper.ai/static/data/language_models.json or https://docs.opper.ai/capabilities/models to avoid model-not-found errors.
- The `name` field is required in every `/v2/call` request — it identifies the task for tracing and versioning
- Use `message` for plain text responses and `json_payload` for structured responses — they are mutually exclusive
- Streaming uses a separate endpoint (`/v2/call/stream`), not a `stream` body parameter
- Add `Accept: text/event-stream` header for streaming requests
- SSE events use `{"delta": "..."}` format, not the OpenAI `choices[0].delta.content` nesting
- Knowledge base document keys must be unique within a base — duplicates will overwrite
