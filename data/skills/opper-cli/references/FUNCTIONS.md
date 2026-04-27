# CLI Function Management

Manage Opper functions from the command line.

## Calling Functions

```bash
# Basic: opper call <name> <instructions> <input>
opper call extract_entities "Extract named entities" "Tim Cook announced Apple's new office in Austin."

# With a model override
opper call --model anthropic/claude-sonnet-4.6 extract_entities "Extract named entities" "Some text..."

# Pipe input from stdin
cat document.txt | opper call summarize "Summarize this document"

# Stream the response token-by-token
opper call --stream myfunction "instructions" "input"
```

## Listing, inspecting, deleting

```bash
# List all functions (optionally filtered by name substring)
opper functions list
opper functions list extract

# Show details of a function
opper functions get extract_entities

# Delete a function
opper functions delete extract_entities
```

## Tips

- Function names should be descriptive and unique (e.g., `extract_entities`, `classify_ticket`).
- If a function doesn't exist, `call` auto-creates it on the Opper platform.
- Use `--debug` (top-level flag) to see the full request/response cycle.
- Pipe long inputs from files rather than passing them as arguments.
