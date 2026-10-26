import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_EXAMPLES } from '../src/contract/AgentEventExamples';

// The checked-in wire examples other-language clients test against. Rewrite
// them after an intended contract change with UPDATE_API_CONTRACT=1.
const GOLDEN = path.resolve(__dirname, '../../../docs/api/agent-events.json');

describe('API contract', () => {
  it('docs/api/agent-events.json matches the AgentEvent examples', () => {
    const expected = `${JSON.stringify(Object.values(AGENT_EVENT_EXAMPLES), null, 2)}\n`;
    if (process.env.UPDATE_API_CONTRACT === '1') { fs.writeFileSync(GOLDEN, expected); }
    expect(fs.readFileSync(GOLDEN, 'utf8')).toBe(expected);
  });
});
