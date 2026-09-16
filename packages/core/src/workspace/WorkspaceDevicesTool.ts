import type { AgentTool } from '../agent/ToolRegistry';

/** Keep the device inventory out of ordinary prompts; resolve it on demand. */
export class WorkspaceDevicesTool implements AgentTool {
  readonly kind = 'read' as const;
  readonly definition = {
    name: 'list_devices',
    description: 'Resolve a device-specific request by listing this workspace name, its host, the current execution device, and available devices. Use before acting on a named desktop or another device. These are workspace devices, not a list of browser clients.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
  constructor(private readonly snapshot: () => unknown) {}
  summarizeCall(): string { return 'list workspace devices'; }
  async execute() { return { content: JSON.stringify(this.snapshot()), summary: 'listed workspace devices' }; }
}
