# Fixtures

`projects/` is a small copy of `~/.claude/projects`. Every line is a real Claude Code log line, cut down by `scripts/make-fixture.ts`. Message text is replaced with `[redacted]`, titles are fixed strings, and `cwd` keeps only its last folder name.

| File | Source lines | What it covers |
|---|---|---|
| `home/1eb4e9bd-….jsonl` | 4, 5, 71, 75 | one response logged twice (output 5, then 410); a reload after 78 idle minutes on a 1-hour cache |
| `professordm/8ec33eea-….jsonl` | 811, 826, 828 | Sonnet 5.5 then Opus 5.5 a minute later, rewriting 287k tokens; an AI title |
| `crucible/401e8b1d-….jsonl` | 1293, 2695, 2710, 2745 | an API error placeholder; `/compact` then a model change (not a reload) |
| `crucible/9139fb89-…/subagents/agent-….jsonl` | 19 | a subagent turn on the 5-minute cache tier |
| `tokenmonitor/aeb2a777-….jsonl` | 16, 35 | a renamed chat (custom title) |

`compact-agent/projects/` is a separate mini folder: one main-chat response (line 26 of a FinRAG chat) and the copy of it that Claude Code's `/compact` helper wrote to `subagents/agent-acompact-….jsonl` (line 5). It must count once.

To add a case, find the line numbers in a real log (`grep -n`), then run:

    node scripts/make-fixture.ts <log.jsonl> <line> [<line> ...] > tests/fixtures/projects/<project>/<chat-id>.jsonl

Never write fixture lines by hand. Real logs have fields and orderings that hand-made ones miss.
