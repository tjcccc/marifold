import { useCallback, useState } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import { renderSkillPrompt } from '@marifold/core';
import type { MarifoldSkill } from '@marifold/core';
import type { AppAction, AppState, NoticeTone } from '../core/appState.js';
import { bindSkillArgs, skillUsage } from '../core/skills.js';
import type { TuiRuntime } from '../core/TuiRuntime.js';
import { errorText, skillInvocation } from './appHelpers.js';
import type { useRuns } from './useRuns.js';

interface PendingSkill {
  skill: MarifoldSkill;
  supplied: Record<string, string>;
  missing: string[];
  index: number;
}

type Runs = ReturnType<typeof useRuns>;

interface SkillOptions {
  runtime: TuiRuntime;
  dispatch: Dispatch<AppAction>;
  stateRef: MutableRefObject<AppState>;
  planNextRef: MutableRefObject<boolean>;
  setPlanNext: (planNext: boolean) => void;
  notify: (text: string, tone?: NoticeTone) => void;
  runAgent: Runs['runAgent'];
}

/** `$skill` invocations: binds arguments, asks for missing variables one at a
 * time, then runs the skill as a lean agent turn (the TUI is agent-only). */
export function useSkills({ runtime, dispatch, stateRef, planNextRef, setPlanNext, notify, runAgent }: SkillOptions) {
  const [pendingSkill, setPendingSkill] = useState<PendingSkill | null>(null);

  const startSkillRun = useCallback((skill: MarifoldSkill, body: string, userInput: string, displayText: string) => {
    dispatch({ type: 'add_user', text: displayText });
    // Codex/Claude-style: the skill body is authoritative instructions (sent via
    // `instructions`, top of the system prompt), and the user's typed input is
    // the turn the model acts on. Direct skills do not receive prior session
    // turns, but their typed invocation and final output still persist there.
    const prompt = userInput.trim() || 'Follow the skill instructions above and produce the output.';
    // `/steps` armed: force a planned agent run for this skill (then disarm).
    const forcePlan = planNextRef.current;
    if (forcePlan) { setPlanNext(false); }
      // Tell the agent where the skill's bundled files live so it can read them
      // (e.g. a vars.toml of `#name` fragments) with read_file, as the skill
      // instructions direct — the agentic-tool model, like Codex/Claude.
      const dir = skill.source?.replace(/\/SKILL\.md$/, '');
      const instructions = dir
        ? [body, `This skill's bundled files are in ${dir}. When the instructions reference files such as vars.toml, read them from there with read_file.`]
        : [body];
      // Persist the invocation the user typed (e.g. `$make-… #photo1 …`) as the
      // resumable user turn, not the agent's internal objective. `lean` skips the
      // optional planning and verbose framing — a skill is a single transform,
      // so that's pure token overhead.
      void runAgent(prompt, { instructions, userTurn: displayText, lean: true, ...(forcePlan ? { forcePlan: true } : {}) });
  }, [runAgent]);

  const runSkill = useCallback((name: string, argv: string[]) => {
    let skill: MarifoldSkill | undefined;
    try {
      skill = runtime.getSkill(name, stateRef.current.profile);
    } catch (error) {
      notify(errorText(error), 'error');
      return;
    }
    if (!skill) {
      notify(`Unknown skill: $${name}. Use /skills to list installed skills.`, 'warn');
      return;
    }
    const supplied = bindSkillArgs(skill, argv);
    const { prompt, missing } = renderSkillPrompt(skill, supplied);
    if (missing.length > 0) {
      setPendingSkill({ skill, supplied, missing, index: 0 });
      notify(`${skillUsage(skill)} — enter ${missing[0]}:`, 'info');
      return;
    }
    startSkillRun(skill, prompt, argv.join(' '), skillInvocation(name, argv));
  }, [runtime, notify, startSkillRun]);

  const fillSkillVariable = useCallback((value: string) => {
    setPendingSkill(current => {
      if (!current) { return null; }
      const supplied = { ...current.supplied, [current.missing[current.index]]: value };
      const nextIndex = current.index + 1;
      if (nextIndex < current.missing.length) {
        notify(`Enter ${current.missing[nextIndex]}:`, 'info');
        return { ...current, supplied, index: nextIndex };
      }
      const { prompt, missing } = renderSkillPrompt(current.skill, supplied);
      if (missing.length > 0) {
        notify(`Missing values for: ${missing.join(', ')}`, 'warn');
        return null;
      }
      const args = current.skill.variables
        .map(variable => supplied[variable.name])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
      startSkillRun(current.skill, prompt, args.join(' '), skillInvocation(current.skill.name, args));
      return null;
    });
  }, [notify, startSkillRun]);

  return { pendingSkill, runSkill, fillSkillVariable };
}
