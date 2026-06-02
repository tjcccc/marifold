import { Command } from 'commander';
import { ConfigLoader, MarifoldRuntime } from '@marifold/core';

export interface RootCommandOptions {
  config?: string;
}

export function createRuntime(program: Command): MarifoldRuntime {
  const rootOptions = program.opts<RootCommandOptions>();
  const loadedConfig = new ConfigLoader().load({ configPath: rootOptions.config });
  return new MarifoldRuntime({ loadedConfig });
}
