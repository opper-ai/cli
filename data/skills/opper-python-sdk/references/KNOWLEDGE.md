# Knowledge Bases Reference (Python SDK)

Knowledge bases provide semantic search over your documents using vector embeddings. Use them for RAG (Retrieval-Augmented Generation) pipelines.

## Contents
- [Creating a Knowledge Base](#creating-a-knowledge-base)
- [Adding Documents](#adding-documents)
- [Querying (Semantic Search)](#querying-semantic-search)
- [Query with Metadata Filters](#query-with-metadata-filters)
- [RAG Pattern: Query + Call](#rag-pattern-query--call)
- [Listing Knowledge Bases](#listing-knowledge-bases)
- [Getting a Knowledge Base](#getting-a-knowledge-base)
- [Deleting Documents](#deleting-documents)
- [Deleting a Knowledge Base](#deleting-a-knowledge-base)
- [File Upload](#file-upload)
- [Document Structure](#document-structure)
- [Best Practices](#best-practices)

## Creating a Knowledge Base

```python
import os
from opperai import Opper

opper = Opper(http_bearer=os.environ["OPPER_HTTP_BEARER"])

# Create a new knowledge base
kb = opper.knowledge.create(name="support_docs")
```

## Adding Documents

```python
# Add a single document
opper.knowledge.add(
    knowledge_base_id=kb.id,
    content="To reset your password, click 'Forgot Password' on the login page.",
    metadata={"category": "auth", "source": "helpdesk"},
)

# Add multiple documents
documents = [
    {
        "content": "Billing cycles run on the 1st of each month.",
        "metadata": {"category": "billing"},
    },
    {
        "content": "To upgrade your plan, go to Settings > Subscription.",
        "metadata": {"category": "account"},
    },
]
for doc in documents:
    opper.knowledge.add(
        knowledge_base_id=kb.id,
        content=doc["content"],
        metadata=doc["metadata"],
    )
```

## Querying (Semantic Search)

```python
# Basic query - returns most relevant documents
results = opper.knowledge.query(
    knowledge_base_id=kb.id,
    query="How do I change my password?",
    top_k=3,
)

for result in results:
    print(f"Score: {result.score:.3f}")
    print(f"Content: {result.content}")
    print(f"Metadata: {result.metadata}")
    print("---")
```

## Query with Metadata Filters

```python
# Filter results by metadata
results = opper.knowledge.query(
    knowledge_base_id=kb.id,
    query="billing question",
    top_k=5,
    filters=[{"field": "category", "operation": "=", "value": "billing"}],
)
```

## RAG Pattern: Query + Call

Combine knowledge base retrieval with task completion:

```python
import os
from opperai import Opper

opper = Opper(http_bearer=os.environ["OPPER_HTTP_BEARER"])

def answer_with_context(question: str, kb_id: str) -> dict:
    # 1. Retrieve relevant context
    results = opper.knowledge.query(
        knowledge_base_id=kb_id,
        query=question,
        top_k=3,
    )

    # 2. Build context string
    context = "\n".join([
        f"[{r.metadata.get('source', 'unknown')}]: {r.content}"
        for r in results
    ])

    # 3. Call with context
    response = opper.call(
        name="answer_with_rag",
        instructions="Answer the question using only the provided context. Cite sources.",
        input=f"Context:\n{context}\n\nQuestion: {question}",
        output_schema={
            "type": "object",
            "properties": {
                "answer": {"type": "string"},
                "sources": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["answer", "sources"],
        },
    )
    return response.json_payload
```

## Listing Knowledge Bases

```python
result = opper.knowledge.list()
for kb in result.data:
    print(f"{kb.name}: {kb.id}")
```

## Getting a Knowledge Base

```python
# By name
kb = opper.knowledge.get_by_name(knowledge_base_name="support_docs")

# By ID
kb = opper.knowledge.get(knowledge_base_id="idx_123")
```

## Deleting Documents

```python
# Delete a specific document by key
opper.knowledge.delete_documents(
    knowledge_base_id=kb.id,
    filters=[{"field": "key", "operation": "=", "value": "doc_001"}],
)
```

## Deleting a Knowledge Base

```python
opper.knowledge.delete(knowledge_base_id="idx_123")
```

## File Upload

Upload files (PDF, DOCX, etc.) for automatic processing:

```python
# Get upload URL
upload_info = opper.knowledge.get_upload_url(
    knowledge_base_id=kb.id,
    filename="manual.pdf",
)

# Upload the file (use requests or similar)
import requests
with open("manual.pdf", "rb") as f:
    requests.put(upload_info.url, data=f)

# Register the upload
opper.knowledge.register_file_upload(
    knowledge_base_id=kb.id,
    file_id=upload_info.id,
    filename="manual.pdf",
    content_type="application/pdf",
)
```

## Document Structure

Each document has:
- **key**: Unique identifier within the index (used for updates/deletes)
- **content**: The text content to be indexed and searched
- **metadata**: Arbitrary key-value pairs for filtering and context

## Best Practices

- Use meaningful `key` values for document management
- Keep documents focused — one topic per document works better than large multi-topic docs
- Add relevant `metadata` for filtering (category, source, date, etc.)
- Use `top_k=3` to `top_k=5` for most queries — more results can add noise
- Use `parent_span_id` for tracing RAG pipelines
- Update documents by re-adding with the same `key`
