import {
  App,
  Button,
  Row,
  Select,
  Spacer,
  State,
  Textarea,
  TextResult,
  defineSkillApp,
  registerModel,
  registerSkill,
  trigger,
  useSkill,
} from '@marifold/core';

const targetLanguages = [
  'Chinese',
  'English',
  'Japanese',
  'Korean',
  'French',
  'German',
  'Spanish',
] as const;

const source = State('');
const targetLanguage = State('English');
const result = State('');

const translationModel = registerModel(
  'ollama/maternion/hy-mt2:1.8b',
  { think: false },
);

const translationSkill = registerSkill('translate', {
  result: TextResult({ trim: true }),
});

const translate = useSkill(translationModel, translationSkill, {
  parameters: {
    source_text: source,
    target_language: targetLanguage,
  },
  output: result,
  memory: false,
  history: false,
  profileContext: false,
});

trigger(translate, {
  onChange: [source, targetLanguage],
  debounce: 1_000,
  concurrency: 'latest',
});

export default defineSkillApp({
  app: {
    name: 'translator',
    title: 'Marifold Translation',
    version: '1.0.0',
    description: 'Translate text with a dedicated local model.',
  },
  ui: App([
    Row([
      Select('Translate to', targetLanguage, {
        options: targetLanguages,
        grow: true,
      }),
    ]),
    Row([
      Textarea('Input', source, {
        grow: true,
        placeholder: 'Enter text to translate',
      }),
      Textarea('Result', result, {
        grow: true,
        editable: false,
        copyable: true,
      }),
    ], {
      gap: 'large',
      responsive: 'stack',
    }),
    Row([
      Spacer(),
      Button('Translate', {
        trigger: translate,
        emphasis: 'primary',
      }),
      Spacer(),
    ]),
  ]),
});
