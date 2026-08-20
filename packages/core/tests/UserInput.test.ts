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

  it('resolves multi-select options with optional custom text', () => {
    const request = parseUserInputRequest('call_multi', {
      questions: [{
        id: 'outputs',
        question: 'Which outputs should I create?',
        multiple: true,
        options: [
          { id: 'report', label: 'Report' },
          { id: 'slides', label: 'Slides' },
          { id: 'sheet', label: 'Spreadsheet' },
        ],
      }],
    });
    expect(request.questions[0].multiple).toBe(true);

    expect(normalizeUserInputSubmission(request, {
      answers: [{ questionId: 'outputs', optionId: 'report' }],
    })).toEqual({
      answers: [{ questionId: 'outputs', optionIds: ['report'] }],
    });
    expect(resolveUserInputResponse(request, {
      answers: [{
        questionId: 'outputs',
        optionIds: ['report', 'slides'],
        customText: 'A plain-text summary',
      }],
    })).toEqual({
      requestId: 'call_multi',
      answers: [{
        questionId: 'outputs',
        optionIds: ['report', 'slides'],
        customText: 'A plain-text summary',
        value: 'Report, Slides, A plain-text summary',
      }],
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
    expect(() => normalizeUserInputSubmission(request, {
      answers: [{ questionId: 'style', optionIds: ['apple', 'material'] }],
    })).toThrow(/does not allow multiple options/);

    const multiple = parseUserInputRequest('call_multi', {
      questions: [{ ...input.questions[0], multiple: true }],
    });
    expect(() => normalizeUserInputSubmission(multiple, {
      answers: [{ questionId: 'style', optionIds: ['apple', 'apple'] }],
    })).toThrow(/same option more than once/);
    expect(() => normalizeUserInputSubmission(multiple, {
      answers: [{ questionId: 'style', optionIds: [] }],
    })).toThrow(/at least one option/);
    expect(() => parseUserInputRequest('call_1', {
      questions: [{ ...input.questions[0], multiple: 'yes' }],
    })).toThrow(/multiple must be a boolean/);
  });

  it('describes optional use and batches questions in the tool contract', () => {
    const tool = new AskUserTool();
    expect(tool.definition.description).toContain('When to use:');
    expect(tool.definition.description).toContain('When NOT to use:');
    expect(tool.definition.description).toContain('Batch');
    expect(tool.definition.description).toContain('multiple');
    expect(tool.definition.parameters.properties.questions.items.properties).toHaveProperty('multiple');
    expect(tool.summarizeCall(input)).toBe('ask the user 1 clarification question');
  });
});
