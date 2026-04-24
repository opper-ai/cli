# Knowledge Base API Reference

Complete HTTP API for creating, managing, and querying knowledge bases with semantic search.

## Contents
- [Create a Knowledge Base](#create-a-knowledge-base)
- [Add Documents](#add-documents)
- [Query (Semantic Search)](#query-semantic-search)
- [RAG Pattern](#rag-pattern)
- [File Upload](#file-upload)
- [List Knowledge Bases](#list-knowledge-bases)
- [Get Knowledge Base](#get-knowledge-base)
- [List Files](#list-files)
- [Delete a File](#delete-a-file)
- [Delete a Knowledge Base](#delete-a-knowledge-base)
- [Best Practices](#best-practices)

## Create a Knowledge Base

```bash
curl -X POST https://api.opper.ai/v2/knowledge \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my_docs", "description": "Project documentation"}'
```

Response:

```json
{"id": "kb_uuid", "name": "my_docs", "description": "Project documentation"}
```

## Add Documents

```bash
curl -X POST https://api.opper.ai/v2/knowledge/{kb_id}/add \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "doc_001",
    "content": "To reset your password, click Forgot Password on the login page.",
    "metadata": {"category": "auth", "last_updated": "2025-01-15"}
  }'
```

Fields:
- `key` (required): Unique identifier within the knowledge base. Re-adding with same key updates the document.
- `content` (required): Text content to be indexed.
- `metadata` (optional): Key-value pairs for filtering.

## Query (Semantic Search)

```bash
curl -X POST https://api.opper.ai/v2/knowledge/{kb_id}/query \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "How do I change my password?", "top_k": 3}'
```

### Filtering Results

Use `filters` to narrow results by metadata:

```bash
curl -X POST https://api.opper.ai/v2/knowledge/{kb_id}/query \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "How to reset password?",
    "top_k": 3,
    "filters": [
      {"field": "category", "operation": "=", "value": "auth"}
    ]
  }'
```

Filter format: `{"field": "metadata_key", "operation": "op", "value": "match_value"}`

Supported operations: `=`, `!=`, `>`, `<`, `>=`, `<=`, `in`

Multiple filters are combined with AND logic.

Response:

```json
[
  {
    "content": "To reset your password, click Forgot Password on the login page.",
    "score": 0.92,
    "key": "doc_001",
    "metadata": {"category": "auth"}
  },
  {
    "content": "Password requirements: minimum 8 characters, one uppercase, one number.",
    "score": 0.78,
    "key": "doc_005",
    "metadata": {"category": "auth"}
  }
]
```

## RAG Pattern

Combine knowledge base query with task completion:

```bash
# 1. Query for context
CONTEXT=$(curl -s -X POST https://api.opper.ai/v2/knowledge/{kb_id}/query \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "How to reset password?", "top_k": 3}')

# 2. Use context in a call
curl -X POST https://api.opper.ai/v2/call \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"answer_with_context\",
    \"instructions\": \"Answer using only the provided context. Cite sources.\",
    \"input\": {\"question\": \"How to reset password?\", \"context\": $CONTEXT},
    \"output_schema\": {
      \"type\": \"object\",
      \"properties\": {
        \"answer\": {\"type\": \"string\"},
        \"sources\": {\"type\": \"array\", \"items\": {\"type\": \"string\"}}
      },
      \"required\": [\"answer\", \"sources\"]
    }
  }"
```

## File Upload

Upload documents (PDF, DOCX, etc.) for automatic chunking and indexing:

```bash
# 1. Get a pre-signed upload URL
UPLOAD_INFO=$(curl -s "https://api.opper.ai/v2/knowledge/{kb_id}/upload-url?filename=manual.pdf" \
  -H "Authorization: Bearer $OPPER_API_KEY")

# 2. Upload the file to the pre-signed URL
curl -X PUT "$(echo $UPLOAD_INFO | jq -r '.url')" \
  --data-binary @manual.pdf

# 3. Register the upload
curl -X POST https://api.opper.ai/v2/knowledge/{kb_id}/upload \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"upload_id\": \"$(echo $UPLOAD_INFO | jq -r '.upload_id')\", \"filename\": \"manual.pdf\"}"
```

## List Knowledge Bases

```bash
curl https://api.opper.ai/v2/knowledge \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## Get Knowledge Base

```bash
# By ID
curl https://api.opper.ai/v2/knowledge/{kb_id} \
  -H "Authorization: Bearer $OPPER_API_KEY"

# By name
curl https://api.opper.ai/v2/knowledge/by-name/my_docs \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## List Files

```bash
curl https://api.opper.ai/v2/knowledge/{kb_id}/files \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## Delete a File

```bash
curl -X DELETE https://api.opper.ai/v2/knowledge/{kb_id}/files/{file_id} \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## Delete a Knowledge Base

```bash
curl -X DELETE https://api.opper.ai/v2/knowledge/{kb_id} \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## Best Practices

- Use descriptive `key` values for document management
- Keep documents focused — one topic per document works better for retrieval
- Add `metadata` for filtering (category, source, date)
- Use `top_k: 3` to `top_k: 5` for most queries
- Update documents by re-adding with the same `key`
- Use file upload for PDFs and office documents — they're auto-chunked
