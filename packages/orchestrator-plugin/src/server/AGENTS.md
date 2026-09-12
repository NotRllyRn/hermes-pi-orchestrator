# DOX — packages/orchestrator-plugin/src/server

| File | Purpose |
| ------ | --------- |
| `index.ts` | Server C canonicalization, authenticated one-time dirty authorization, atomic worker creation, and bounded routes. |
| `lifecycle.ts` | Settled-only bounded child review plus explicit merge/cherry-pick/retain integration. |
| `overview.ts` | Projects primary/parallel workers, attention, and cost; routes queue/steer delivery. |
| `transactions.ts` | Durable atomic JSON transaction journal for restart-safe idempotency and lifecycle recovery. |
