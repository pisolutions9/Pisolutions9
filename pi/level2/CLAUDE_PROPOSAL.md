# Claude proposal provenance — final lease expiry

On 2026-11-03, the signed-in Claude desktop app returned a bounded JSON proposal in [this chat](https://claude.ai/chat/862dbcc4-05df-4275-878a-50b779d86a61). Claude explicitly said it had **not inspected** the repository. The request supplied the public draft PR link and asked for one change: a task whose second lease expires must leave `running`; the result must be idempotent and a late worker must not revive it.

Codex inspected the actual queue and implemented the proposal using its existing terminal state, `blocked`, plus an additive `failure_reason` field. Tests use an injected clock and check an unexpired final lease, final expiry, idempotence, cleared ownership, no additional claim, and rejected late completion. The existing one-attempt recovery test remains in place.

This was a real Claude **desktop chat** interaction under the existing Pro sign-in, not an Anthropic API call or a durable provider adapter. It was followed by local Codex implementation and GitHub CI. The chat response is a proposal, not independent verification. No paid API call, credit purchase, production mutation, or merge was performed.

