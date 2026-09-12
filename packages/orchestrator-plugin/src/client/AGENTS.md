# DOX — packages/orchestrator-plugin/src/client

| File | Purpose |
| ------ | --------- |
| `api.ts` | Typed same-origin REST client for overview, queue/steer, review, and abort. |
| `folder-encoding.ts` | UTF-8-safe base64url folder path codec for project routes. |
| `FolderOrchestratorSection.tsx` | Folder sidebar status pill linking to project orchestrator board. |
| `index.tsx` | Client claim barrel consumed by generated plugin registry. |
| `OrchestratorPanel.tsx` | Responsive project board with status, cost, attention, review, abort, and Hermes-only integration guidance. |
| `useOrchestrator.ts` | Polling/action state hook with folder/request race suppression and draft-safe failures. |
