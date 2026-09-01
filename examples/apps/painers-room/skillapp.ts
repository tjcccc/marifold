import {
  App,
  AttachmentState,
  Attachments,
  Button,
  Column,
  Row,
  Select,
  State,
  Textarea,
  TextResult,
  defineSkillApp,
  registerProfile,
  useProfileSkill,
} from '@marifold/core';

const idea = State('');
const result = State('');
const references = AttachmentState();

const promptMakers = [
  { label: 'GPT Image', value: 'make-gpt-image-prompt' },
  { label: 'Grok Imagine', value: 'make-grok-imagine-prompt' },
  { label: 'Krea 2', value: 'make-krea2-prompt' },
  { label: 'Midjourney', value: 'make-midjourney-prompt' },
  { label: 'Nano Banana', value: 'make-nano-banana-prompt' },
  { label: 'Seedance', value: 'make-seedance-video-prompt' },
  { label: 'Z-Image', value: 'make-z-image-prompt' },
] as const;

const promptMaker = State('make-gpt-image-prompt');

const painter = registerProfile('painter', {
  memory: false,
  history: false,
});

const promptResult = TextResult({ trim: true });

const makePrompt = useProfileSkill(painter, promptMaker, {
  skills: promptMakers,
  input: idea,
  attachments: references,
  stripSkillName: true,
  output: result,
  result: promptResult,
});

export default defineSkillApp({
  app: {
    name: 'painers-room',
    title: "Painer's Room",
    version: '1.0.0',
    description: "Use Painter's installed prompt-making Skills without duplicating their instructions.",
  },
  ui: App([
    Column([
      Row([
        Select('Prompt maker', promptMaker, {
          options: promptMakers,
          grow: true,
        }),
      ]),
      Row([
        Textarea('Idea', idea, {
          grow: true,
          rows: 4,
          placeholder: 'Describe the image or video prompt you want to create',
        }),
        Button('Make', {
          trigger: makePrompt,
          emphasis: 'primary',
          alignToField: true,
        }),
      ], {
        gap: 'medium',
        responsive: 'stack',
      }),
      Row([
        Attachments('Attachments', references, { grow: true }),
      ]),
      Row([
        Textarea('Prompt', result, {
          grow: true,
          rows: 10,
          autoGrow: true,
          editable: false,
          copyable: true,
        }),
      ]),
    ], {
      gap: 'large',
    }),
  ]),
});
