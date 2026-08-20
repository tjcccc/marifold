import type { JSONValue } from '@priest-ai/core';
import { MarifoldError } from '../errors/MarifoldError';

export const MAX_USER_INPUT_QUESTIONS = 3;
export const MAX_USER_INPUT_OPTIONS = 4;
export const MAX_USER_INPUT_CUSTOM_TEXT = 2000;

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  question: string;
  header?: string;
  /** When true, clients may select more than one option. Defaults to false. */
  multiple?: boolean;
  options: UserInputOption[];
}

export interface UserInputRequest {
  id: string;
  questions: UserInputQuestion[];
}

export type UserInputSubmissionAnswer =
  | { questionId: string; optionId: string; optionIds?: never; customText?: never }
  | { questionId: string; optionId?: never; optionIds: string[]; customText?: string }
  | { questionId: string; optionId?: never; optionIds?: never; customText: string };

export interface UserInputSubmission {
  answers: UserInputSubmissionAnswer[];
}

export interface UserInputAnswer {
  questionId: string;
  value: string;
  optionId?: string;
  optionIds?: string[];
  customText?: string;
}

export interface UserInputResponse {
  requestId: string;
  answers: UserInputAnswer[];
}

export type UserInputHandler = (
  request: UserInputRequest,
) => Promise<UserInputSubmission | undefined>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validate the model-authored question payload before any renderer sees it. */
export function parseUserInputRequest(
  requestId: string,
  input: Record<string, JSONValue>,
): UserInputRequest {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions)
      || rawQuestions.length < 1
      || rawQuestions.length > MAX_USER_INPUT_QUESTIONS) {
    throw invalid(`ask_user requires between 1 and ${MAX_USER_INPUT_QUESTIONS} questions.`);
  }

  const seenQuestionIds = new Set<string>();
  const questions = rawQuestions.map((raw, index) => {
    const item = record(raw, `questions[${index}]`);
    const id = identifier(item.id, `questions[${index}].id`);
    if (seenQuestionIds.has(id)) throw invalid(`Duplicate question id '${id}'.`);
    seenQuestionIds.add(id);
    const optionsValue = item.options;
    if (!Array.isArray(optionsValue)
        || optionsValue.length < 2
        || optionsValue.length > MAX_USER_INPUT_OPTIONS) {
      throw invalid(
        `questions[${index}].options must contain between 2 and ${MAX_USER_INPUT_OPTIONS} choices.`,
      );
    }
    const seenOptionIds = new Set<string>();
    const options = optionsValue.map((rawOption, optionIndex) => {
      const option = record(rawOption, `questions[${index}].options[${optionIndex}]`);
      const optionId = identifier(option.id, `questions[${index}].options[${optionIndex}].id`);
      if (seenOptionIds.has(optionId)) {
        throw invalid(`Duplicate option id '${optionId}' in question '${id}'.`);
      }
      seenOptionIds.add(optionId);
      return {
        id: optionId,
        label: boundedString(option.label, `questions[${index}].options[${optionIndex}].label`, 80),
        ...optionalBoundedString(
          option.description,
          `questions[${index}].options[${optionIndex}].description`,
          240,
        ),
      };
    });
    return {
      id,
      question: boundedString(item.question, `questions[${index}].question`, 500),
      ...optionalBoundedString(item.header, `questions[${index}].header`, 40, 'header'),
      ...optionalTrue(item.multiple, `questions[${index}].multiple`, 'multiple'),
      options,
    };
  });

  return { id: requestId, questions };
}

/** Validate client answers against the exact pending request. */
export function normalizeUserInputSubmission(
  request: UserInputRequest,
  value: unknown,
): UserInputSubmission {
  const body = record(value, 'submission');
  if (!Array.isArray(body.answers)) throw invalid('answers must be an array.');
  if (body.answers.length !== request.questions.length) {
    throw invalid('Every question requires an answer before submission.');
  }

  const questions = new Map(request.questions.map(question => [question.id, question]));
  const seen = new Set<string>();
  const answers = body.answers.map((raw, index): UserInputSubmissionAnswer => {
    const answer = record(raw, `answers[${index}]`);
    const questionId = identifier(answer.questionId, `answers[${index}].questionId`);
    const question = questions.get(questionId);
    if (!question) throw invalid(`Unknown question id '${questionId}'.`);
    if (seen.has(questionId)) throw invalid(`Question '${questionId}' was answered more than once.`);
    seen.add(questionId);

    if (question.multiple) {
      const hasOptionId = answer.optionId !== undefined;
      const hasOptionIds = answer.optionIds !== undefined;
      if (hasOptionId && hasOptionIds) {
        throw invalid(`Answer '${questionId}' cannot provide both optionId and optionIds.`);
      }
      if (hasOptionIds && !Array.isArray(answer.optionIds)) {
        throw invalid(`Answer '${questionId}'.optionIds must be an array.`);
      }
      const optionIds = hasOptionIds
        ? (answer.optionIds as unknown[]).map((optionId, optionIndex) => identifier(
          optionId,
          `answers[${index}].optionIds[${optionIndex}]`,
        ))
        : hasOptionId
          ? [identifier(answer.optionId, `answers[${index}].optionId`)]
          : [];
      if (new Set(optionIds).size !== optionIds.length) {
        throw invalid(`Answer '${questionId}' contains the same option more than once.`);
      }
      for (const optionId of optionIds) {
        if (!question.options.some(option => option.id === optionId)) {
          throw invalid(`Unknown option '${optionId}' for question '${questionId}'.`);
        }
      }
      const customText = answer.customText === undefined
        ? undefined
        : boundedString(
          answer.customText,
          `answers[${index}].customText`,
          MAX_USER_INPUT_CUSTOM_TEXT,
        );
      if (optionIds.length === 0 && customText === undefined) {
        throw invalid(`Answer '${questionId}' must choose at least one option or provide custom text.`);
      }
      return {
        questionId,
        optionIds,
        ...(customText !== undefined ? { customText } : {}),
      };
    }

    if (answer.optionIds !== undefined) {
      throw invalid(`Answer '${questionId}' does not allow multiple options.`);
    }
    const hasOption = typeof answer.optionId === 'string' && answer.optionId.trim().length > 0;
    const hasCustom = typeof answer.customText === 'string' && answer.customText.trim().length > 0;
    if (hasOption === hasCustom) {
      throw invalid(`Answer '${questionId}' must choose one option or provide custom text.`);
    }
    if (hasOption) {
      const optionId = identifier(answer.optionId, `answers[${index}].optionId`);
      if (!question.options.some(option => option.id === optionId)) {
        throw invalid(`Unknown option '${optionId}' for question '${questionId}'.`);
      }
      return { questionId, optionId };
    }
    return {
      questionId,
      customText: boundedString(
        answer.customText,
        `answers[${index}].customText`,
        MAX_USER_INPUT_CUSTOM_TEXT,
      ),
    };
  });
  return { answers };
}

export function resolveUserInputResponse(
  request: UserInputRequest,
  submission: UserInputSubmission,
): UserInputResponse {
  const normalized = normalizeUserInputSubmission(request, submission);
  return {
    requestId: request.id,
    answers: normalized.answers.map(answer => {
      const question = request.questions.find(item => item.id === answer.questionId)!;
      if (answer.optionIds) {
        const labels = answer.optionIds.map(optionId =>
          question.options.find(item => item.id === optionId)!.label);
        const values = answer.customText ? [...labels, answer.customText] : labels;
        return {
          questionId: question.id,
          optionIds: answer.optionIds,
          ...(answer.customText ? { customText: answer.customText } : {}),
          value: values.join(', '),
        };
      }
      if (answer.optionId) {
        const option = question.options.find(item => item.id === answer.optionId)!;
        return { questionId: question.id, optionId: option.id, value: option.label };
      }
      const customText = answer.customText!;
      return {
        questionId: question.id,
        customText,
        value: customText,
      };
    }),
  };
}

export function formatUserInputResponse(response: UserInputResponse): string {
  return [
    'The user answered the clarification questions:',
    ...response.answers.map(answer => `- ${answer.questionId}: ${answer.value}`),
  ].join('\n');
}

function invalid(message: string): MarifoldError {
  return MarifoldError.agentToolInvalid(message, 'ask_user');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw invalid(`${label} must be a stable id using letters, numbers, underscores, or hyphens.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw invalid(`${label} must be at most ${maxLength} characters.`);
  return normalized;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  key = 'description',
): Record<string, string> {
  if (value === undefined) return {};
  return { [key]: boundedString(value, label, maxLength) };
}

function optionalTrue(value: unknown, label: string, key: string): Record<string, true> {
  if (value === undefined || value === false) return {};
  if (value !== true) throw invalid(`${label} must be a boolean.`);
  return { [key]: true };
}
