import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  UserInputQuestion,
  UserInputRequest,
  UserInputSubmission,
  UserInputSubmissionAnswer,
} from '@marifold/core';
import { ACCENT, ATTACHMENT, DIM } from './theme.js';

type DraftAnswer =
  | { kind: 'option'; optionId: string }
  | { kind: 'custom'; text: string }
  | { kind: 'multiple'; optionIds: string[]; customText?: string };

export interface QuestionModalProps {
  request: UserInputRequest;
  onSubmit: (submission: UserInputSubmission) => void;
  onCancel: () => void;
}

/** Keyboard-first counterpart to the Web question sheet. Questions are
 * batched and the run resumes only after one complete submission. */
export function QuestionModal({ request, onSubmit, onCancel }: QuestionModalProps): React.ReactElement {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [editingCustom, setEditingCustom] = useState(false);

  useEffect(() => {
    setQuestionIndex(0);
    setCursor(0);
    setDrafts({});
    setEditingCustom(false);
  }, [request.id]);

  const complete = useMemo(
    () => request.questions.every(question => isComplete(question, drafts[question.id])),
    [drafts, request.questions],
  );

  function moveTo(index: number): void {
    const next = Math.max(0, Math.min(request.questions.length - 1, index));
    setQuestionIndex(next);
    setEditingCustom(false);
    const question = request.questions[next];
    const answer = drafts[question.id];
    if (answer?.kind === 'option') {
      setCursor(Math.max(0, question.options.findIndex(option => option.id === answer.optionId)));
    } else if (answer?.kind === 'custom') {
      setCursor(question.options.length);
    } else if (answer?.kind === 'multiple') {
      const selected = question.options.findIndex(option => answer.optionIds.includes(option.id));
      setCursor(selected >= 0 ? selected : answer.customText !== undefined ? question.options.length : 0);
    } else {
      setCursor(0);
    }
  }

  function advance(): void {
    const nextUnanswered = request.questions.findIndex(
      (question, index) => index > questionIndex && !isComplete(question, drafts[question.id]),
    );
    if (nextUnanswered !== -1) moveTo(nextUnanswered);
  }

  function submit(): void {
    if (!complete) return;
    onSubmit({
      answers: request.questions.map((question): UserInputSubmissionAnswer => {
        const answer = drafts[question.id]!;
        if (question.multiple) {
          if (answer.kind !== 'multiple') throw new Error('Incomplete multi-select answer.');
          return {
            questionId: question.id,
            optionIds: answer.optionIds,
            ...(answer.customText !== undefined ? { customText: answer.customText.trim() } : {}),
          };
        }
        if (answer.kind === 'option') return { questionId: question.id, optionId: answer.optionId };
        if (answer.kind === 'custom') {
          return { questionId: question.id, customText: answer.text.trim() };
        }
        throw new Error('Incomplete single-select answer.');
      }),
    });
  }

  useInput((input, key) => {
    const question = request.questions[questionIndex];
    const customIndex = question.options.length;
    if (editingCustom) {
      const current = drafts[question.id];
      const text = current?.kind === 'custom'
        ? current.text
        : current?.kind === 'multiple'
          ? current.customText ?? ''
          : '';
      const updateText = (next: string): void => setDrafts(value => {
        if (question.multiple) {
          return {
            ...value,
            [question.id]: { ...asMultiple(value[question.id]), customText: next },
          };
        }
        return { ...value, [question.id]: { kind: 'custom', text: next } };
      });
      if (key.escape) {
        setEditingCustom(false);
      } else if (key.return) {
        if (text.trim()) {
          setEditingCustom(false);
          advance();
        }
      } else if (key.backspace || key.delete) {
        updateText(text.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta && text.length < 2000) {
        updateText(text + input);
      }
      return;
    }

    if (key.escape) onCancel();
    else if (key.upArrow) setCursor(value => (value - 1 + customIndex + 1) % (customIndex + 1));
    else if (key.downArrow) setCursor(value => (value + 1) % (customIndex + 1));
    else if (key.leftArrow) moveTo(questionIndex - 1);
    else if (key.rightArrow || key.tab) moveTo(questionIndex + 1);
    else if (question.multiple && input === ' ') {
      if (cursor === customIndex) {
        setDrafts(value => {
          const previous = asMultiple(value[question.id]);
          return {
            ...value,
            [question.id]: previous.customText === undefined
              ? { ...previous, customText: '' }
              : { kind: 'multiple', optionIds: previous.optionIds },
          };
        });
      } else {
        setDrafts(value => ({
          ...value,
          [question.id]: toggleMultipleOption(value[question.id], question.options[cursor].id),
        }));
      }
    } else if (key.return) {
      if (cursor === customIndex) {
        setDrafts(value => {
          const current = value[question.id];
          return {
            ...value,
            [question.id]: question.multiple
              ? {
                  ...asMultiple(current),
                  customText: current?.kind === 'multiple' ? current.customText ?? '' : '',
                }
              : current?.kind === 'custom' ? current : { kind: 'custom', text: '' },
          };
        });
        setEditingCustom(true);
      } else if (question.multiple) {
        setDrafts(value => ({
          ...value,
          [question.id]: toggleMultipleOption(value[question.id], question.options[cursor].id),
        }));
      } else {
        setDrafts(value => ({
          ...value,
          [question.id]: { kind: 'option', optionId: question.options[cursor].id },
        }));
        advance();
      }
    } else if (input.toLowerCase() === 's') submit();
  });

  return (
    <Box borderStyle="round" borderColor={ACCENT} flexDirection="column" paddingX={1}>
      <Text bold color={ACCENT}>A few details before I continue</Text>
      {request.questions.map((question, index) => {
        const active = index === questionIndex;
        const answer = drafts[question.id];
        const customEditing = active && editingCustom;
        const customSelected = question.multiple
          ? answer?.kind === 'multiple' && answer.customText !== undefined
          : answer?.kind === 'custom';
        const customText = answer?.kind === 'multiple'
          ? answer.customText
          : answer?.kind === 'custom'
            ? answer.text
            : undefined;
        return (
          <Box key={question.id} flexDirection="column" marginTop={1}>
            <Text bold={active} color={active ? ATTACHMENT : undefined}>
              {active ? '› ' : '  '}{question.header ? `${question.header}: ` : ''}{question.question}
              {question.multiple ? <Text dimColor> (select all that apply)</Text> : null}
            </Text>
            {question.options.map((option, optionIndex) => {
              const selected = question.multiple
                ? answer?.kind === 'multiple' && answer.optionIds.includes(option.id)
                : answer?.kind === 'option' && answer.optionId === option.id;
              const focused = active && !editingCustom && cursor === optionIndex;
              return (
                <Text key={option.id} color={focused ? ACCENT : DIM}>
                  {focused ? '  › ' : '    '}{question.multiple ? `[${selected ? 'x' : ' '}]` : selected ? '●' : '○'} {option.label}
                  {option.description ? <Text dimColor> — {option.description}</Text> : null}
                </Text>
              );
            })}
            <Text color={active && cursor === question.options.length ? ACCENT : DIM}>
              {active && cursor === question.options.length ? '  › ' : '    '}
              {question.multiple ? `[${customSelected ? 'x' : ' '}]` : customSelected ? '●' : '○'} Something else
              {customText ? ` — ${customText}${customEditing ? '▌' : ''}` : customEditing ? ' — ▌' : ''}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={DIM}>
          {request.questions[questionIndex].multiple
            ? '↑↓ move · Space/Enter toggle · ←→ question · '
            : '↑↓ choose · ←→ question · Enter select · '}
        </Text>
        <Text bold color={complete ? ACCENT : DIM}>[s]ubmit</Text>
        <Text color={DIM}> · Esc cancel</Text>
      </Box>
      <Text color={complete ? ATTACHMENT : DIM}>
        {complete ? 'All answers ready.' : 'Answer every question before submitting.'}
      </Text>
    </Box>
  );
}

function asMultiple(answer: DraftAnswer | undefined): Extract<DraftAnswer, { kind: 'multiple' }> {
  return answer?.kind === 'multiple' ? answer : { kind: 'multiple', optionIds: [] };
}

function toggleMultipleOption(
  answer: DraftAnswer | undefined,
  optionId: string,
): Extract<DraftAnswer, { kind: 'multiple' }> {
  const previous = asMultiple(answer);
  return {
    ...previous,
    optionIds: previous.optionIds.includes(optionId)
      ? previous.optionIds.filter(id => id !== optionId)
      : [...previous.optionIds, optionId],
  };
}

function isComplete(question: UserInputQuestion, answer: DraftAnswer | undefined): boolean {
  if (question.multiple) {
    if (answer?.kind !== 'multiple') return false;
    if (answer.customText !== undefined && !answer.customText.trim()) return false;
    return answer.optionIds.length > 0 || answer.customText !== undefined;
  }
  return answer?.kind === 'option' || (answer?.kind === 'custom' && answer.text.trim().length > 0);
}
