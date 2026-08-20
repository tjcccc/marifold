import { useEffect, useMemo, useState } from 'react';
import type {
  UserInputQuestion,
  UserInputRequest,
  UserInputSubmission,
  UserInputSubmissionAnswer,
} from '../../api/types';
import styles from './QuestionSheet.module.css';

type DraftAnswer =
  | { kind: 'option'; optionId: string }
  | { kind: 'custom'; text: string }
  | { kind: 'multiple'; optionIds: string[]; customText?: string };

export interface QuestionSheetProps {
  request: UserInputRequest;
  busy?: boolean;
  onSubmit: (submission: UserInputSubmission) => void;
}

/** One optional clarification checkpoint. The model batches up to three
 * questions; the user answers all of them locally and resumes the run with a
 * single submission. */
export function QuestionSheet({ request, busy, onSubmit }: QuestionSheetProps) {
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  useEffect(() => setDrafts({}), [request.id]);

  const complete = useMemo(
    () => request.questions.every(question => isComplete(question, drafts[question.id])),
    [drafts, request.questions],
  );

  function submit(): void {
    if (!complete || busy) return;
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

  return (
    <form
      className={styles.sheet}
      aria-label="Questions from the agent"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className={styles.heading}>A few details before I continue</div>
      {request.questions.map((question, questionIndex) => {
        const answer = drafts[question.id];
        const multipleAnswer = answer?.kind === 'multiple' ? answer : undefined;
        const customSelected = question.multiple
          ? multipleAnswer?.customText !== undefined
          : answer?.kind === 'custom';
        return (
          <fieldset key={question.id} className={styles.question} disabled={busy}>
            <legend className={styles.legend}>
              {question.header ? <span className={styles.header}>{question.header}</span> : null}
              <span>{question.question}</span>
              {question.multiple ? <span className={styles.multipleHint}>Select all that apply</span> : null}
            </legend>
            <div className={styles.options}>
              {question.options.map(option => (
                <label key={option.id} className={styles.option}>
                  <input
                    type={question.multiple ? 'checkbox' : 'radio'}
                    name={`${request.id}-${question.id}`}
                    checked={question.multiple
                      ? multipleAnswer?.optionIds.includes(option.id) ?? false
                      : answer?.kind === 'option' && answer.optionId === option.id}
                    onChange={event => {
                      const checked = event.currentTarget.checked;
                      setDrafts(current => {
                        if (!question.multiple) {
                          return {
                            ...current,
                            [question.id]: { kind: 'option', optionId: option.id },
                          };
                        }
                        const previous = asMultiple(current[question.id]);
                        const optionIds = checked
                          ? [...previous.optionIds, option.id]
                          : previous.optionIds.filter(optionId => optionId !== option.id);
                        return {
                          ...current,
                          [question.id]: { ...previous, optionIds },
                        };
                      });
                    }}
                  />
                  <span>
                    <span className={styles.optionLabel}>{option.label}</span>
                    {option.description ? <span className={styles.description}>{option.description}</span> : null}
                  </span>
                </label>
              ))}
              <label className={`${styles.option} ${styles.customOption}`}>
                <input
                  type={question.multiple ? 'checkbox' : 'radio'}
                  name={`${request.id}-${question.id}`}
                  checked={customSelected}
                  onChange={event => {
                    const checked = event.currentTarget.checked;
                    setDrafts(current => {
                      if (!question.multiple) {
                        return {
                          ...current,
                          [question.id]: { kind: 'custom', text: '' },
                        };
                      }
                      const previous = asMultiple(current[question.id]);
                      return {
                        ...current,
                        [question.id]: checked
                          ? { ...previous, customText: previous.customText ?? '' }
                          : { kind: 'multiple', optionIds: previous.optionIds },
                      };
                    });
                  }}
                />
                <span className={styles.customBody}>
                  <span className={styles.optionLabel}>Something else</span>
                  <input
                    className={styles.customInput}
                    aria-label={`Custom answer for question ${questionIndex + 1}`}
                    value={question.multiple
                      ? multipleAnswer?.customText ?? ''
                      : customSelected && answer?.kind === 'custom' ? answer.text : ''}
                    placeholder="Describe your preference"
                    maxLength={2000}
                    onFocus={() => {
                      if (!customSelected) {
                        setDrafts(current => {
                          if (question.multiple) {
                            const previous = asMultiple(current[question.id]);
                            return {
                              ...current,
                              [question.id]: { ...previous, customText: '' },
                            };
                          }
                          return {
                            ...current,
                            [question.id]: { kind: 'custom', text: '' },
                          };
                        });
                      }
                    }}
                    onChange={event => {
                      const text = event.target.value;
                      setDrafts(current => {
                        if (question.multiple) {
                          return {
                            ...current,
                            [question.id]: { ...asMultiple(current[question.id]), customText: text },
                          };
                        }
                        return {
                          ...current,
                          [question.id]: { kind: 'custom', text },
                        };
                      });
                    }}
                  />
                </span>
              </label>
            </div>
          </fieldset>
        );
      })}
      <div className={styles.actions}>
        <span className={styles.progress} aria-live="polite">
          {complete ? 'Ready to continue' : 'Answer every question to continue'}
        </span>
        <button className={styles.submit} type="submit" disabled={!complete || busy}>
          {busy ? 'Submitting…' : 'Submit answers'}
          <span className={styles.kbd}>⌘⏎</span>
        </button>
      </div>
    </form>
  );
}

function asMultiple(answer: DraftAnswer | undefined): Extract<DraftAnswer, { kind: 'multiple' }> {
  return answer?.kind === 'multiple' ? answer : { kind: 'multiple', optionIds: [] };
}

function isComplete(question: UserInputQuestion, answer: DraftAnswer | undefined): boolean {
  if (question.multiple) {
    if (answer?.kind !== 'multiple') return false;
    if (answer.customText !== undefined && !answer.customText.trim()) return false;
    return answer.optionIds.length > 0 || answer.customText !== undefined;
  }
  return answer?.kind === 'option' || (answer?.kind === 'custom' && answer.text.trim().length > 0);
}
