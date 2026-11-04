# AGENTS.md

Token X-ray reads Claude Code's local logs and shows where the spend goes. Engine first, then three screens on top of it: the terminal report, the status line (`src/statusline/`) and the local dashboard.

## Commands

```bash
npm test          # node:test, runs the .ts sources directly (Node 22.18+)
npm run lint      # ESLint
npm run typecheck # tsc --noEmit
npm run verify    # all three
npm run build     # compile src/ to dist/ for npm
node src/cli/main.ts [--days N] [--json]   # run the report from source
node scripts/check-statusline.ts           # status line vs your real logs
```

## Rules that have been broken before

- **Every number comes from `src/engine/`** (`xray.ts` for the report and dashboard, `cache.ts` for the status line). Screens format, they never compute.
- **The status line never throws and stays fast.** It runs every 30 seconds under the prompt: read only the end of the log, print an empty line on any error.
- **Runtime code uses Node built-ins only.** `dependencies` stays empty; dev tools are pinned exact.
- **One response = one turn.** Claude Code logs a streamed response several times. Dedupe by `message.id` + `requestId`, keep the last copy's usage and the first copy's time. The `/compact` helper's log (`subagents/agent-acompact-*`) repeats main-chat responses, so dedupe across a chat's files too, preferring the main-chat copy.
- **Price cache writes by tier.** `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` have different rates, and cache-read multipliers differ per model. Update `src/engine/pricing.ts` from the official pricing page, never from memory.
- **Fixtures are real log lines** cut with `scripts/make-fixture.ts`. Never hand-write log shapes.
- **Read logs recursively.** Subagent logs live in `projects/<project>/<chat-id>/subagents/`.
- **Nothing leaves the machine.** No network calls; the dashboard binds to 127.0.0.1 only.
- Erasable TypeScript only (no `enum`, no parameter properties); imports use `.ts` extensions.

## Commits

`<type>(<scope>): <subject>`, for example `feat(engine): …`, `fix(cli): …`. No AI co-author trailers.
