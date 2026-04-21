import { describe, it, expect } from "vitest";
import { OpperError, EXIT_CODES } from "../src/errors.js";

describe("OpperError", () => {
  it("carries code, message, and optional hint", () => {
    const e = new OpperError("AUTH_REQUIRED", "Not logged in", "Run opper login.");
    expect(e.code).toBe("AUTH_REQUIRED");
    expect(e.message).toBe("Not logged in");
    expect(e.hint).toBe("Run opper login.");
    expect(e.name).toBe("OpperError");
  });

  it("is an Error subclass", () => {
    const e = new OpperError("API_ERROR", "upstream");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("EXIT_CODES", () => {
  it("maps every known code", () => {
    expect(EXIT_CODES.AUTH_REQUIRED).toBe(2);
    expect(EXIT_CODES.AUTH_EXPIRED).toBe(2);
    expect(EXIT_CODES.AGENT_NOT_FOUND).toBe(3);
    expect(EXIT_CODES.AGENT_CONFIG_CONFLICT).toBe(4);
    expect(EXIT_CODES.AGENT_RESTORE_FAILED).toBe(5);
    expect(EXIT_CODES.API_ERROR).toBe(6);
    expect(EXIT_CODES.NETWORK_ERROR).toBe(7);
    expect(EXIT_CODES.USER_CANCELLED).toBe(0);
  });
});
