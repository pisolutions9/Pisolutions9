# PI V1 Launch Blocker

## Objective
Restore genuine live model-backed customer answers without weakening the V1 launch gate.

## Observed blocker
Deployment and CORS pass, but live customer smoke currently falls back to deterministic recovery with `providerFailure=chat_provider_rate_limited`, producing zero live-model answers.

## Execution rule
Diagnose the actual provider/model failure, implement the smallest reliable fix, test it, run regression, and repeat until the live customer path passes. Deterministic recovery must remain an emergency fallback and must never count as live-model success.

## Next path
1. Inspect Workers AI invocation and configured model behavior.
2. Use documented, available model configuration.
3. If rate/capacity remains the blocker, evaluate AI Gateway routing/observability.
4. Keep CORS, security, owner-only gates, and live-model launch criteria intact.
5. Certify only after same-commit live customer smoke and regression gates pass.
