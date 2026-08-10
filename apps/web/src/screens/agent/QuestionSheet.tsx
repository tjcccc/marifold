import { useEffect, useMemo, useState } from 'react';
import type { UserInputRequest, UserInputSubmission } from '../../api/types';
import styles from './QuestionSheet.module.css';

type DraftAnswer =
  | { kind: 'option'; optionId: string }
  | { kind: 'custom'; text: string };

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
    () => request.questions.every(question => {
      const answer = drafts[question.id];
      return answer?.kind === 'option' || (answer?.kind === 'custom' && answer.text.trim().length > 0);
    }),
    [drafts, request.questions],
  );

  function submit(): void {
    if (!complete || busy) return;
    onSubmit({
      answers: request.questions.map(question => {
        const answer = drafts[question.id]!;
        return answer.kind === 'option'
          ? { questionId: question.id, optionId: answer.optionId }
          : { questionId: question.id, customText: answer.text.trim() };
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
        const customSelected = answer?.kind === 'custom';
        return (
          <fieldset key={question.id} className={styles.question} disabled={busy}>
            <legend className={styles.legend}>
              {question.header ? <span className={styles.header}>{question.header}</span> : null}
              <span>{question.question}</span>
            </legend>
            <div className={styles.options}>
              {question.options.map(option => (
                <label key={option.id} className={styles.option}>
                  <input
                    type="radio"
                    name={`${request.id}-${question.id}`}
                    checked={answer?.kind === 'option' && answer.optionId === option.id}
                    onChange={() => setDrafts(current => ({
                      ...current,
                      [question.id]: { kind: 'option', optionId: option.id },
                    }))}
                  />
                  <span>
                    <span className={styles.optionLabel}>{option.label}</span>
                    {option.description ? <span className={styles.description}>{option.description}</span> : null}
                  </span>
                </label>
              ))}
              <label className={`${styles.option} ${styles.customOption}`}>
                <input
                  type="radio"
                  name={`${request.id}-${question.id}`}
                  checked={customSelected}
                  onChange={() => setDrafts(current => ({
                    ...current,
                    [question.id]: { kind: 'custom', text: '' },
                  }))}
                />
                <span className={styles.customBody}>
                  <span className={styles.optionLabel}>Something else</span>
                  <input
                    className={styles.customInput}
                    aria-label={`Custom answer for question ${questionIndex + 1}`}
                    value={customSelected ? answer.text : ''}
                    placeholder="Describe your preference"
                    maxLength={2000}
                    onFocus={() => {
                      if (!customSelected) {
                        setDrafts(current => ({
                          ...current,
                          [question.id]: { kind: 'custom', text: '' },
                        }));
                      }
                    }}
                    onChange={event => setDrafts(current => ({
                      ...current,
                      [question.id]: { kind: 'custom', text: event.target.value },
                    }))}
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
