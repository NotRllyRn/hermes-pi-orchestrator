# DOX — packages/orchestrator-plugin/src/server

| File | Purpose |
| ------ | --------- |
| `index.ts` | Server C project canonicalization, bounded diagnostics, and atomic worktree + Pi-history-fork transaction routes. |
| `transactions.ts` | Durable atomic JSON transaction journal for restart-safe idempotency and uncertain-outcome refusal. |
