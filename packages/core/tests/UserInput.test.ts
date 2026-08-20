import { describe, expect, it } from 'vitest';
import { AskUserTool } from '../src/agent/tools/AskUserTool';
import {
  normalizeUserInputSubmission,
  parseUserInputRequest,
  resolveUserInputResponse,
} from '../src/agent/UserInput';

const input = {
  questions: [{
    id: 'style',
    header: 'Style',
    question: 'What style do you prefer?',
    options: [
      { id: 'apple', label: 'Apple', description: 'Quiet and spacious.' },
      { id: 'material', label: 'Material', description: 'Colorful and structured.' },
    ],
  }],
};

describe('ask_user input contract', () => {
  it('parses bounded questions and resolves option or custom answers', () => {
    const request = parseUserInputRequest('call_1', input);
    expect(request).toMatchObject({ id: 'call_1', questions: [{ id: 'style' }] });

    expect(resolveUserInputResponse(request, {
      answers: [{ questionId: 'style', optionId: 'apple' }],
    })).toEqual({
      requestId: 'call_1',
      answers: [{ questionId: 'style', optionId: 'apple', value: 'Apple' }],
    });

    expect(resolveUserInputResponse(request, {
      answers: [{ questionId: 'style', customText: 'A warm paper-like style' }],
    }).answers[0]).toEqual({
      questionId: 'style',
      customText: 'A warm paper-like style',
      value: 'A warm paper-like style',
    });
  });

  it('rejects malformed model questions and incomplete or forged submissions', () => {
    expect(() => parseUserInputRequest('call_1', { questions: [] })).toThrow(/between 1 and 3/);
    expect(() => parseUserInputRequest('call_1', {
      questions: [input.questions[0], input.questions[0]],
    })).toThrow(/Duplicate question id/);

    const request = parseUserInputRequest('call_1', input);
    expect(() => normalizeUserInputSubmission(request, { answers: [] })).toThrow(/Every question/);
    expect(() => normalizeUserInputSubmission(request, {
      answers: [{ questionId: 'style', optionId: 'unknown' }],
    })).toThrow(/Unknown option/);
    expect(() => normalizeUserInputSubmission(request, {
      answers: [{ questionId: 'style', optionId: 'apple', customText: 'both' }],
    })).toThrow(/choose one option or provide custom text/);
  });

  it('describes optional use and batches questions in the tool contract', () => {
    const tool = new AskUserTool();
    expect(tool.definition.description).toContain('When to use:');
    expect(tool.definition.description).toContain('When NOT to use:');
    expect(tool.definition.description).toContain('Batch');
    expect(tool.summarizeCall(input)).toBe('ask the user 1 clarification question');
  });
});
