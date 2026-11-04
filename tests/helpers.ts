import { join } from 'node:path';

export const FIXTURES = join(import.meta.dirname, 'fixtures');
export const PROJECTS = join(FIXTURES, 'projects');
// Real chats, trimmed by scripts/make-fixture.ts (see tests/fixtures/README.md).
export const HOME_CHAT = join(PROJECTS, 'home', '1eb4e9bd-6da2-4752-a65b-579a033add88.jsonl');
export const SWITCH_CHAT = join(PROJECTS, 'professordm', '8ec33eea-336a-48d3-a197-f5da2970144d.jsonl');
export const COMPACT_CHAT = join(PROJECTS, 'crucible', '401e8b1d-0774-48bb-9403-091741e595be.jsonl');
export const SUBAGENT_LOG = join(PROJECTS, 'crucible', '9139fb89-aedd-4bdd-bdc4-5e59a7a0b134', 'subagents', 'agent-a65cbf981b7a3134f.jsonl');
export const RENAMED_CHAT = join(PROJECTS, 'tokenmonitor', 'aeb2a777-f9b6-450c-8769-6c922545b116.jsonl');
