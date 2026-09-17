# V1 live model routing fix

The launch blocker was live customer smoke producing only deterministic recovery after the Worker deployment.

This fix makes the edge path lower-load and gateway-aware:
- use the documented fast Llama 3.1 model as the primary edge model;
- route Workers AI inference through the account's `default` AI Gateway;
- use sequential edge-model alternatives instead of firing every model concurrently;
- preserve OpenAI as a sequential fallback;
- keep deterministic recovery as an emergency path only;
- keep the launch gate requirement that at least one customer response is genuinely model-backed.

The change must be certified by a fresh same-commit deployment and live customer smoke.