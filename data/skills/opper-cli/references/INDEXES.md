# CLI Index Management

Manage Opper knowledge base indexes from the command line.

## Overview

Indexes are semantic search knowledge bases. You can create, list, and manage them via the CLI.

## Commands

```bash
# List all indexes
opper indexes list

# Get details of a specific index
opper indexes get <index-name>

# Create a new index
opper indexes create <index-name>

# Delete an index
opper indexes delete <index-name>
```

## Adding Documents

Add documents to an index for semantic search:

```bash
# Add a document with key and content
opper indexes add <index-name> --key doc1 --content "Your document text here"

# Add with metadata
opper indexes add <index-name> --key doc1 --content "Document text" --metadata '{"category": "support"}'
```

## Querying

Search an index semantically:

```bash
# Query an index
opper indexes query <index-name> "How do I reset my password?"

# With top-k results
opper indexes query <index-name> "search query" --k 5
```

## Tips

- Index names should be descriptive (e.g., `support_docs`, `product_catalog`)
- Use metadata to categorize documents for filtered retrieval
- Unique keys prevent duplicate documents — re-adding with the same key updates the entry
- Queries return results ranked by semantic similarity with scores
