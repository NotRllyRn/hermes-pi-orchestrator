# DOX — packages/orchestrator-plugin/src/server

| File | Purpose |
| ------ | --------- |
| `index.ts` | Server C project canonicalization, bounded diagnostics, atomic worker creation, and explicit lifecycle routes. |
| `lifecycle.ts` | Bounded child review packages plus explicit merge/cherry-pick/retain integration. |
| `transactions.ts` | Durable atomic JSON transaction journal for restart-safe idempotency and lifecycle recovery. |
