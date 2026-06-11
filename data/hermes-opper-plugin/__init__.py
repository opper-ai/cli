"""Opper provider profile for `opper launch hermes`.

Shipped by the Opper CLI into the isolated HERMES_HOME at launch (the CLI writes
`model.provider: opper`). On every request it emits two headers:

    X-Opper-Trace-Id:        uuid5(NS, <session key>)
    X-Opper-Parent-Span-Id:  uuid5(NS, <session key>)   (same value)

X-Opper-Trace-Id groups a session's calls into one trace and drives provider
affinity (sticky provider for prompt-cache reuse across turns). Setting
X-Opper-Parent-Span-Id to the same value makes Opper auto-create a single
"session" root span and nest each turn under it, so the trace renders as one
tree instead of N sibling roots.

The session key is Hermes' own session_id when available (it rotates per
subagent and per /reset), falling back to a per-process id so one-shot runs
still share one trace.
"""

import uuid
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

# Fixed namespace -> deterministic, valid-UUID trace ids (Opper validates the
# trace_id as a UUID). The same session key always maps to the same trace id.
_NS = uuid.UUID("3f2504e0-4f89-41d3-9a0c-0305e82c3301")

# Fallback session key, stable for the lifetime of this Hermes process (one
# `opper launch`). Used when Hermes passes no session_id (e.g. one-shot `-z`
# runs) so every call in the launch still shares one trace + session root.
_PROCESS_SESSION = str(uuid.uuid4())


class OpperProfile(ProviderProfile):
    def build_api_kwargs_extras(
        self,
        *,
        session_id: str | None = None,
        **ctx: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        sid = session_id or _PROCESS_SESSION
        tid = str(uuid.uuid5(_NS, sid))
        top: dict[str, Any] = {
            "extra_headers": {
                "X-Opper-Trace-Id": tid,
                "X-Opper-Parent-Span-Id": tid,
            }
        }
        return {}, top

    def fetch_models(self, *, api_key: str | None = None, timeout: float = 8.0):
        if not self.base_url:
            return None
        return super().fetch_models(api_key=api_key, timeout=timeout)


register_provider(OpperProfile(
    name="opper",
    # Read the api key from OPPER_API_KEY (the env the CLI exports at spawn). A
    # dedicated name (vs OPENAI_API_KEY) avoids clobbering the user's real
    # OpenAI key for any other provider in the launched Hermes. Without a
    # declared key env Hermes sends a "no-key-required" placeholder and Opper
    # rejects it with 401.
    env_vars=("OPPER_API_KEY",),
    base_url="",
    default_max_tokens=65536,
))
