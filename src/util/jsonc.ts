import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  parse,
  parseTree,
  type Edit,
  type Node,
  type ParseError,
} from "jsonc-parser";

/** Parse a configuration object without silently accepting damaged JSONC. */
export function parseJsoncObject(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Expected a valid JSONC configuration object");
  }
  const rejectDuplicateKeys = (node: Node): void => {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value as string;
        if (keys.has(key)) throw new SyntaxError(`Duplicate JSONC configuration key: ${key}`);
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) rejectDuplicateKeys(child);
  };
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (root) rejectDuplicateKeys(root);
  return value as Record<string, unknown>;
}

/** Remove one object property without consuming comments before its siblings. */
export function deleteJsoncProperty(text: string, path: string[]): string {
  parseJsoncObject(text);
  const root = parseTree(text, [], { allowTrailingComma: true });
  const property = root && findNodeAtLocation(root, path)?.parent;
  if (!property || property.type !== "property") return text;
  const parent = property.parent;
  if (!parent?.children) return text;
  const index = parent.children.indexOf(property);
  const previous = parent.children[index - 1];
  const edits: Edit[] = [{ offset: property.offset, length: property.length, content: "" }];

  // For a non-first property remove the previous separator; otherwise remove
  // the next separator (including a sole property's optional trailing comma).
  // Only remove the comma token, leaving surrounding whitespace/comments intact.
  const scanner = createScanner(text, true);
  scanner.setPosition(previous ? previous.offset + previous.length : property.offset + property.length);
  scanner.scan();
  if (text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) === ",") {
    edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" });
  }
  return applyEdits(text, edits);
}
