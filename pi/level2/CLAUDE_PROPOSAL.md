# Claude proposal provenance — final lease expiry

On 2026-11-03, the signed-in Claude desktop app returned a bounded JSON proposal in [this chat](https://claude.ai/chat/862dbcc4-05df-4275-878a-50b779d86a61). Claude explicitly said it had **not inspected** the repository. The request supplied the public draft PR link and asked for one change: a task whose second lease expires must leave `running`; the result must be idempotent and a late worker must not revive it.

Codex inspected the actual queue and implemented the proposal using its existing terminal state, `blocked`, plus an additive `failure_reason` field. Tests use an injected clock and check an unexpired final lease, final expiry, idempotence, cleared ownership, no additional claim, and rejected late completion. The existing one-attempt recovery test remains in place.

This was a real Claude **desktop chat** interaction under the existing Pro sign-in, not an Anthropic API call or a durable provider adapter. It was followed by local Codex implementation and GitHub CI. The chat response is a proposal, not independent verification. No paid API call, credit purchase, production mutation, or merge was performed.

## Follow-up proposal — terminal verifier child

In the same Claude desktop chat, a second bounded proposal addressed a depth-two verifier child reaching the terminal `blocked` state while its implementation parent waits for review. Claude again explicitly said it had not inspected the repository. Codex mapped the proposal to the actual schema: `failure_reason` is the existing reason field and `blocked` is the existing terminal state. The parent blocks in the same SQLite transaction as the verifier's terminal transition, and a `codex` `write_patch` parent requires a verified depth-two verifier child before its own successful review. The local test checks both pending and terminal child states. This remains a real desktop proposal followed by local implementation, not an unattended provider integration or an authenticated verifier.

