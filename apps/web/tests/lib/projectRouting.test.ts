import { describe, expect, it } from 'vitest';
import { afterLeadingMentions, commandProfiles, previewProjectRoute } from '../../src/lib/projectRouting';

const project = { lead: 'default', members: ['default', 'dev_test', 'app_tester'] };
const profiles = ['default', 'dev_test', 'app_tester', 'painter'];

describe('project routing preview', () => {
  it('follows the host rule: mentions in order, else the floor, else the Lead', () => {
    expect(previewProjectRoute('I want your thoughts, @app_tester, @dev_test', project, undefined, profiles))
      .toEqual({ speakers: ['app_tester', 'dev_test'], floor: null });
    expect(previewProjectRoute('@dev_test, which engine?', project, undefined, profiles)).toEqual({ speakers: ['dev_test'], floor: 'dev_test' });
    expect(previewProjectRoute('and for 2D?', project, 'dev_test', profiles)).toEqual({ speakers: ['dev_test'] });
    // A floor holder dismissed meanwhile hands the message to the Lead.
    expect(previewProjectRoute('and for 2D?', project, 'painter', profiles)).toEqual({ speakers: ['default'] });
  });

  it('names an uninvited profile, and leaves device mentions alone', () => {
    expect(previewProjectRoute('@painter draw it on @office', project, undefined, profiles)).toEqual({ speakers: [], uninvited: 'painter' });
    expect(previewProjectRoute('@dev_test run it on @office', project, undefined, profiles)).toEqual({ speakers: ['dev_test'], floor: 'dev_test' });
  });

  it('completes /invite with profiles off the roster and /dismiss with members but the Lead', () => {
    expect(commandProfiles('/invite @', project, profiles)).toEqual(['painter']);
    expect(commandProfiles('/dismiss @d', project, profiles)).toEqual(['dev_test', 'app_tester']);
    expect(commandProfiles('@dev_test /invite', project, profiles)).toBeUndefined();
  });

  it('finds a skill after the profiles it is addressed to', () => {
    expect(afterLeadingMentions('@dev_test, $make-prompt robot', project.members)).toBe('$make-prompt robot');
    expect(afterLeadingMentions('@office $make-prompt robot', project.members)).toBe('@office $make-prompt robot');
  });
});
