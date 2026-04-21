export type OpperErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "AGENT_NOT_FOUND"
  | "AGENT_CONFIG_CONFLICT"
  | "AGENT_RESTORE_FAILED"
  | "API_ERROR"
  | "NETWORK_ERROR"
  | "USER_CANCELLED";

export const EXIT_CODES: Record<OpperErrorCode, number> = {
  AUTH_REQUIRED: 2,
  AUTH_EXPIRED: 2,
  AGENT_NOT_FOUND: 3,
  AGENT_CONFIG_CONFLICT: 4,
  AGENT_RESTORE_FAILED: 5,
  API_ERROR: 6,
  NETWORK_ERROR: 7,
  USER_CANCELLED: 0,
};

export class OpperError extends Error {
  constructor(
    public readonly code: OpperErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "OpperError";
  }
}
