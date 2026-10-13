import { MarifoldError } from '../errors/MarifoldError';
import type { ProfileModelSetting } from '../config/ConfigSchema';

/** The `model` value that follows the global default model. */
export const PROFILE_DEFAULT_MODEL = 'default';

export interface ProfileModel {
  provider?: string;
  model?: string;
  setting: ProfileModelSetting;
}

/**
 * Read a profile's model choice: `model = "provider/model"` (split at the first
 * `/`, since model IDs may contain one), `model = "default"`, nothing (also the
 * default), or the older `provider` + `model` pair, which keeps working.
 */
export function parseProfileModel(name: string, provider: string | undefined, model: string | undefined): ProfileModel {
  if (provider !== undefined) {
    if (!model || model === PROFILE_DEFAULT_MODEL) {
      throw MarifoldError.profileInvalid(`Profile '${name}' sets provider without a model in profile.toml; use model = "${provider}/<model>" or model = "default".`, name);
    }
    return { provider, model, setting: 'legacy' };
  }
  if (model === undefined) { return { setting: 'unset' }; }
  if (model === PROFILE_DEFAULT_MODEL) { return { setting: 'default' }; }
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw MarifoldError.profileInvalid(`Profile '${name}' has model = "${model}" in profile.toml; use "provider/model" (for example "ollama/gemma4:e4b") or "default".`, name);
  }
  return { provider: model.slice(0, slash), model: model.slice(slash + 1), setting: 'pinned' };
}

/** The single `model` value written for a choice; no pin means the default. */
export function profileModelValue(provider?: string, model?: string): string {
  return provider && model ? `${provider}/${model}` : PROFILE_DEFAULT_MODEL;
}
