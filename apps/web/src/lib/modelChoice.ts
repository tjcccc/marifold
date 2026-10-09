/** Split a `provider/model` choice; a bare name is a model with no provider. */
export function splitModelChoice(choice?: string): [string | undefined, string | undefined] {
  if (!choice) { return [undefined, undefined]; }
  const slash = choice.indexOf('/');
  if (slash === -1) { return [undefined, choice]; }
  return [choice.slice(0, slash), choice.slice(slash + 1)];
}
