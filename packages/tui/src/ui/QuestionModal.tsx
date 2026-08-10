import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { UserInputRequest, UserInputSubmission } from '@marifold/core';
import { ACCENT, ATTACHMENT, DIM } from './theme.js';

type DraftAnswer =
  | { kind: 'option'; optionId: string }
  | { kind: 'custom'; text: string };

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
    () => request.questions.every(question => {
      const answer = drafts[question.id];
      return answer?.kind === 'option' || (answer?.kind === 'custom' && answer.text.trim().length > 0);
    }),
    [drafts, request.questions],
  );

  function moveTo(index: number): void {
    const next = Math.max(0, Math.min(request.questions.length - 1, index));
    setQuestionIndex(next);
    setEditingCustom(false);
    const answer = drafts[request.questions[next].id];
    setCursor(answer?.kind === 'option'
      ? Math.max(0, request.questions[next].options.findIndex(option => option.id === answer.optionId))
      : answer?.kind === 'custom'
        ? request.questions[next].options.length
        : 0);
  }

  function advance(): void {
    const nextUnanswered = request.questions.findIndex(
      (question, index) => index > questionIndex && drafts[question.id] === undefined,
    );
    if (nextUnanswered !== -1) moveTo(nextUnanswered);
  }

  function submit(): void {
    if (!complete) return;
    onSubmit({
      answers: request.questions.map(question => {
        const answer = drafts[question.id]!;
        return answer.kind === 'option'
          ? { questionId: question.id, optionId: answer.optionId }
          : { questionId: question.id, customText: answer.text.trim() };
      }),
    });
  }

  useInput((input, key) => {
    const question = request.questions[questionIndex];
    const customIndex = question.options.length;
    if (editingCustom) {
      const current = drafts[question.id];
      const text = current?.kind === 'custom' ? current.text : '';
      if (key.escape) {
        setEditingCustom(false);
      } else if (key.return) {
        if (text.trim()) {
          setEditingCustom(false);
          advance();
        }
      } else if (key.backspace || key.delete) {
        setDrafts(value => ({ ...value, [question.id]: { kind: 'custom', text: text.slice(0, -1) } }));
      } else if (input && !key.ctrl && !key.meta && text.length < 2000) {
        setDrafts(value => ({ ...value, [question.id]: { kind: 'custom', text: text + input } }));
      }
      return;
    }

    if (key.escape) onCancel();
    else if (key.upArrow) setCursor(value => (value - 1 + customIndex + 1) % (customIndex + 1));
    else if (key.downArrow) setCursor(value => (value + 1) % (customIndex + 1));
    else if (key.leftArrow) moveTo(questionIndex - 1);
    else if (key.rightArrow || key.tab) moveTo(questionIndex + 1);
    else if (key.return) {
      if (cursor === customIndex) {
        setDrafts(value => ({
          ...value,
          [question.id]: value[question.id]?.kind === 'custom'
            ? value[question.id]
            : { kind: 'custom', text: '' },
        }));
        setEditingCustom(true);
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
        return (
          <Box key={question.id} flexDirection="column" marginTop={1}>
            <Text bold={active} color={active ? ATTACHMENT : undefined}>
              {active ? '› ' : '  '}{question.header ? `${question.header}: ` : ''}{question.question}
            </Text>
            {question.options.map((option, optionIndex) => {
              const selected = answer?.kind === 'option' && answer.optionId === option.id;
              const focused = active && !editingCustom && cursor === optionIndex;
              return (
                <Text key={option.id} color={focused ? ACCENT : DIM}>
                  {focused ? '  › ' : '    '}{selected ? '●' : '○'} {option.label}
                  {option.description ? <Text dimColor> — {option.description}</Text> : null}
                </Text>
              );
            })}
            <Text color={active && cursor === question.options.length ? ACCENT : DIM}>
              {active && cursor === question.options.length ? '  › ' : '    '}
              {answer?.kind === 'custom' ? '●' : '○'} Something else
              {answer?.kind === 'custom' && answer.text ? ` — ${answer.text}${customEditing ? '▌' : ''}` : customEditing ? ' — ▌' : ''}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={DIM}>↑↓ choose · ←→ question · Enter select · </Text>
        <Text bold color={complete ? ACCENT : DIM}>[s]ubmit</Text>
        <Text color={DIM}> · Esc cancel</Text>
      </Box>
      <Text color={complete ? ATTACHMENT : DIM}>
        {complete ? 'All answers ready.' : 'Answer every question before submitting.'}
      </Text>
    </Box>
  );
}
