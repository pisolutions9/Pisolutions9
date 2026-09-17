# PI V1 Launch Blocker

## Objective
Restore genuine live model-backed customer answers on the public PI chat path without weakening the V1 launch gate.

## Observed failure
The prior deployed Worker passed deployment and CORS checks but live customer smoke returned deterministic recovery for all customer questions, with `providerFailure=chat_provider_rate_limited` and zero live model-backed answers.

## Current repair
- Workers AI uses the documented fast Llama 3.1 model as primary.
- Edge inference is routed through the account `default` AI Gateway.
- Edge model alternatives are attempted sequentially rather than concurrently to avoid multiplying rate-limit pressure.
- OpenAI remains a sequential fallback.
- Deterministic recovery remains emergency-only and never counts as live-model success.

## Certification rule
V1 is not launch-ready until a fresh same-commit deployment passes the live customer smoke with at least one genuine model-backed response, then the full V1 regression and release gates pass on the same release candidate.
