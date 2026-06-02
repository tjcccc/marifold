import { Command } from 'commander';
import { ConfigLoader, LoadedMarifoldConfig, MarifoldRuntime } from '@marifold/core';

export interface RootCommandOptions {
  config?: string;
}

export function createRuntime(program: Command): MarifoldRuntime {
  return new MarifoldRuntime({ loadedConfig: loadConfig(program) });
}

export function loadConfig(program: Command): LoadedMarifoldConfig {
  const rootOptions = program.opts<RootCommandOptions>();
  return new ConfigLoader().load({ configPath: rootOptions.config });
}
