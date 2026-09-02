const SKILL_APP_TERMS = [
  '技能应用',
  '技能 app',
  'スキルアプリ',
  '스킬 앱',
] as const;

export interface SkillAppBuilderGuideOptions {
  profile: string;
  appsDir: string;
}

/** Cheap lazy trigger for natural-language SkillApp creation requests. */
export function mentionsSkillApps(prompt: string): boolean {
  const normalized = prompt.normalize('NFKC').toLowerCase();
  return /(^|[^\p{L}\p{N}_])skill[\s-]*apps?([^\p{L}\p{N}_]|$)/u.test(normalized)
    || SKILL_APP_TERMS.some(term => normalized.includes(term));
}

/** Path-aware instructions that make the protected builder available without
 * requiring users to know or type its explicit `$skillapp-builder` name. */
export function buildSkillAppBuilderGuide(options: SkillAppBuilderGuideOptions): string {
  return `## Internal $skillapp-builder guide

This request concerns designing, creating, or updating a Marifold SkillApp.

- The active profile is ${JSON.stringify(options.profile)} and the configured App directory is ${JSON.stringify(options.appsDir)}.
- Call inspect_skill_apps first. Its current component signatures, canonical templates, bundle rules, existing Apps, profiles, and effective Skills are authoritative. Adapt the matching template instead of probing App directories or arbitrary host paths for examples.
- Help turn a rough idea into a focused workflow and layout. Infer obvious details; use ask_user to batch only essential decisions that materially change the result.
- Keep skillapp.ts declarative and use only the static builders reported by inspect_skill_apps. Do not use shell_exec, write_file, or arbitrary project files to create an App.
- Download represents one renderer-created text file with a stable filename declared in skillapp.ts. Multiple declared Download components may expose multiple static text downloads. Do not use it for binary files, per-run filenames, or dynamic file collections; explain that artifact-output limit when it is essential to the request.
- Prefer an existing profile Skill when it fits. Use interactive: true only with one fixed profile Agent Skill and never combine it with an automatic trigger.
- A SkillApp that makes SkillApps should invoke the protected skillapp-builder Skill interactively so its runtime can ask questions and request approval.
- Submit one complete bundle through manage_skill_app. Create must refuse collisions; update is allowed only when the user explicitly requested replacement. The tool validates and atomically installs the bundle after approval. Correct exact validation feedback, but stop after two corrected failures instead of repeatedly submitting variants.
- Claim success only after manage_skill_app succeeds. The service does not need a restart.`;
}
