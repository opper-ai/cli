// Cross-package check with the installed @opperai/login dependency.
// No browser, network request, or real credential is used.
import assert from "node:assert/strict";
import { runDeviceFlow } from "../../dist/auth/device-flow.js";

const seen = [];
const prior = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  seen.push({ url: String(url), body: new URLSearchParams(init.body) });
  if (String(url).endsWith("/oauth/device")) {
    return new Response(JSON.stringify({
      device_code: "device-code", user_code: "TEST-CODE",
      verification_uri: "https://example.test/device", expires_in: 600, interval: 0,
    }), { status: 200 });
  }
  return new Response(JSON.stringify({
    api_key: "synthetic-renewed-key",
    credential_id: "456", org_id: 12,
    project_id: 34, project_uuid: "test-project-uuid", project_name: "Developer project",
    expires_at: "2030-01-01T00:00:00Z",
    user: { email: "test@example.com", name: "Test" },
  }), { status: 200 });
};

try {
  const slot = await runDeviceFlow({ renew: true, currentCredentialId: "123" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "https://api.opper.ai/oauth/device");
  assert.equal(seen[0].body.get("renew"), "true");
  assert.equal(seen[0].body.get("current_credential_id"), "123");
  assert.equal(slot.apiKey, "synthetic-renewed-key");
  assert.equal(slot.credentialId, "456");
  assert.equal(slot.orgId, 12);
  assert.equal(slot.projectId, 34);
  assert.equal(slot.projectName, "Developer project");
  assert.equal(slot.expiresAt, "2030-01-01T00:00:00Z");
  console.log("Installed shared login and CLI renewal metadata contract passed.");
} finally {
  globalThis.fetch = prior;
}
