# CLI Index Management

Manage Opper knowledge base indexes from the command line.

## Overview

Indexes are semantic search knowledge bases. You can create, list, query, and add documents to them via the CLI.

## Commands

```bash
# List indexes (with optional pagination)
opper indexes list
opper indexes list --limit 50 --offset 0

# Get details of a specific index
opper indexes get <index-name>

# Create a new index
opper indexes create <index-name>
opper indexes create <index-name> --embedding-model <id>

# Delete an index
opper indexes delete <index-name>
```

## Adding Documents

`indexes add` takes the document content as a positional argument (or `-` to read from stdin):

```bash
# Add inline content
opper indexes add support_docs "Your document text here" --key doc1

# Add with metadata
opper indexes add support_docs "Document text" --key doc1 --metadata '{"category": "support"}'

# Read content from stdin
cat article.txt | opper indexes add support_docs - --key article-42
```

## Querying

Search an index semantically:

```bash
# Query an index
opper indexes query support_docs "How do I reset my password?"

# Limit number of results
opper indexes query support_docs "search query" --top-k 5

# Filter by metadata (JSON-encoded)
opper indexes query support_docs "search query" --filters '{"category": "support"}'
```

## Tips

- Index names should be descriptive (e.g., `support_docs`, `product_catalog`).
- Use metadata to categorize documents for filtered retrieval at query time.
- Unique keys prevent duplicate documents — re-adding with the same key updates the entry.
- Queries return results ranked by semantic similarity with scores.
