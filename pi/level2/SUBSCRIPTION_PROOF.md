# One-run subscription CLI experiment — 2026-11-03

The operator confirmed in Claude Desktop that extra usage credits were off and the balance was $0. The runner then checked `claude auth status` for `claude.ai` / `firstParty` and Codex login status for ChatGPT. No API key or third-party provider setting was passed to either CLI. No scheduled run was enabled.

The final script ran from a disposable `level2-runs/proof6` directory outside the repository. Its durable SQLite queue recorded `propose`, `implement`, and `verify` as `verified`, each with one attempt. Claude Code CLI returned a one-turn JSON proposal for `candidate.py`; Codex CLI in read-only mode returned the exact two-line replacement. The broker wrote that exact source to the disposable fixture. A separate Python process checked the approved proposal, source hash, and arithmetic behavior. The final source SHA-256 was `ba1a531f581d2e6094e978ed6f7aca7a8d92eeb62c6e7ad73ee692f7f18bc772`, verified against the raw file bytes on Windows.

The sanitized machine-readable result is `subscription-proof.json`. It records the connection modes, stage labels, statuses, attempts, and final source hash. The original disposable workspace also holds the queue database, proposal, implementation, verification and manifest artifacts; those are not required for CI and are not committed.

Earlier disposable attempts were rejected when Codex's local policy blocked file tools or Claude's proposal fell outside the initial exact wording gate. Those were not counted as successful runs. The passing run used the same account subscriptions; no paid API provider call, production file change, deployment, or merge was made.

The proof is specific to the fixed arithmetic fixture. Codex generated source text and the broker applied it after exact validation; Codex did not directly edit the file. The verifier was a separate process under the same OS account, so it is not an authenticated independent identity. CLI subscription usage is distinct from incremental API billing. The CLI cannot enforce a hard zero-dollar subscription budget, so this one-run path requires the extra-credit switch to be checked off and remains disabled by default. The separate signed-verifier boundary has Linux-only isolation tests and simulated local keys; it is not claimed as the verifier for this Windows subscription run.

