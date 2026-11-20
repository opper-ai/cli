export interface NetworkPolicy {
  version: number;
  rules: Record<string, "allow" | "deny">;
}
export interface NetworkRules {
  allowedDomains: string[];
  deniedDomains: string[];
}
export function policyDirectory(): string;
export function emptyPolicy(): NetworkPolicy;
export function validateHost(value: unknown): string;
export function validatePolicy(value: unknown): NetworkPolicy;
export function readPolicy(directory?: string): NetworkPolicy;
export function changePolicy(
  version: number,
  host: string,
  action: string,
  directory?: string,
): NetworkPolicy;
export function applyPolicy(
  network: NetworkRules,
  policy: NetworkPolicy,
): NetworkRules;
