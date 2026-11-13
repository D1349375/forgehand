import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_INSTRUCTIONS } from '../../server/agent';
import {
  argsShapeText, createToolRegistry, defineTool, getTool, listTools, generateDesign,
  type ToolDefinition,
} from '../../server/tools';
import { ok } from '../../server/tools/helpers';

const SIX_TOOLS = ['generate_design', 'edit_design', 'select_parts', 'get_project_state', 'explode_view', 'wear_on_arm'];

const fakeTool = (over: Partial<ToolDefinition<Record<string, never>>> = {}): ToolDefinition<Record<string, never>> => ({
  name: 'fake_tool',
  category: 'test',
  description: 'a fake tool.',
  args: z.strictObject({}),
  side: 'server',
  scope: 'project',
  effects: 'read-only',
  run: async () => ok('fake_tool', 'ok', null),
  ...over,
});

describe('createToolRegistry', () => {
  it('returns the registered definition from getTool and undefined for an unknown name', () => {
    const registry = createToolRegistry();
    const tool = registry.defineTool(fakeTool({ name: 'a' }));
    expect(registry.getTool('a')).toBe(tool);
    expect(registry.getTool('b')).toBeUndefined();
    expect(registry.getTool('constructor')).toBeUndefined();
  });

  it('throws when a name is registered twice and keeps the first definition', () => {
    const registry = createToolRegistry();
    const first = registry.defineTool(fakeTool({ name: 'dup' }));
    expect(() => registry.defineTool(fakeTool({ name: 'dup', description: 'second' }))).toThrow(/dup/);
    expect(registry.getTool('dup')).toBe(first);
    expect(registry.listTools()).toHaveLength(1);
  });

  it('lists tools in registration order and filters by scope and side', () => {
    const registry = createToolRegistry();
    registry.defineTool(fakeTool({ name: 'project_server', scope: 'project', side: 'server' }));
    registry.defineTool(fakeTool({ name: 'project_client', scope: 'project', side: 'client' }));
    registry.defineTool(fakeTool({ name: 'home_server', scope: 'home', side: 'server' }));
    registry.defineTool(fakeTool({ name: 'home_client', scope: 'home', side: 'client' }));

    const names = (filter?: Parameters<typeof registry.listTools>[0]) => registry.listTools(filter).map(tool => tool.name);
    expect(names()).toEqual(['project_server', 'project_client', 'home_server', 'home_client']);
    expect(names({ scope: 'project', side: 'server' })).toEqual(['project_server']);
    expect(names({ scope: 'project' })).toEqual(['project_server', 'project_client']);
    expect(names({ side: 'client' })).toEqual(['project_client', 'home_client']);
    expect(names({ scope: 'home', side: 'client' })).toEqual(['home_client']);
  });
});

describe('default registry', () => {
  it('holds exactly the six working tools, all project-scope server tools, in the order the model sees them', () => {
    expect(listTools().map(tool => tool.name)).toEqual(SIX_TOOLS);
    expect(listTools({ scope: 'project', side: 'server' }).map(tool => tool.name)).toEqual(SIX_TOOLS);
    expect(listTools({ scope: 'home' })).toEqual([]);
    expect(listTools({ side: 'client' })).toEqual([]);
  });

  it('refuses to register an existing tool name again', () => {
    expect(() => defineTool(fakeTool({ name: 'generate_design' }))).toThrow(/generate_design/);
    expect(getTool('generate_design')).toBe(generateDesign);
    expect(listTools()).toHaveLength(SIX_TOOLS.length);
  });

  it('gives every tool a description, a strict args schema and declared effects', () => {
    for (const tool of listTools()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(tool.args.safeParse({ unexpected: true }).success, tool.name).toBe(false);
    }
    expect(Object.fromEntries(listTools().map(tool => [tool.name, tool.effects]))).toEqual({
      generate_design: 'writes-scene',
      edit_design: 'writes-scene',
      select_parts: 'writes-scene',
      get_project_state: 'read-only',
      explode_view: 'writes-scene',
      wear_on_arm: 'uses-camera',
    });
  });
});

describe('argsShapeText', () => {
  it('renders each tool argument with its type', () => {
    const shape = (name: string) => argsShapeText(getTool(name)!.args);
    expect(shape('generate_design')).toBe('prompt: string');
    expect(shape('edit_design')).toBe('instruction: string');
    expect(shape('select_parts')).toBe('partIds: string[]');
    expect(shape('get_project_state')).toBe('');
    expect(shape('explode_view')).toBe('amount: number');
    expect(shape('wear_on_arm')).toBe('enabled: boolean');
  });

  it('marks optional arguments', () => {
    expect(argsShapeText(z.strictObject({ a: z.string(), b: z.number().optional() }))).toBe('a: string, b?: number');
  });
});

describe('generated tool list in AGENT_INSTRUCTIONS', () => {
  const section = AGENT_INSTRUCTIONS.split('Available tools:\n')[1]!.split('\nRules:')[0]!;
  const lines = section.split('\n').filter(line => line.trim());

  it('lists exactly the six tools, in registration order, as `- name(args): description`', () => {
    expect(lines).toEqual(listTools({ scope: 'project', side: 'server' })
      .map(tool => `- ${tool.name}(${argsShapeText(tool.args)}): ${tool.description}`));
    expect(lines.map(line => /^- (\w+)\(/.exec(line)![1])).toEqual(SIX_TOOLS);
  });

  it('tells the model that wear_on_arm shows a stand-in cuff, not the user design', () => {
    const line = lines.find(entry => entry.startsWith('- wear_on_arm('))!;
    expect(line).toContain('stand-in cuff');
    expect(line).toContain("not the user's design");
  });

  it('does not mention tools that are not registered', () => {
    expect(AGENT_INSTRUCTIONS).not.toContain('estimate_weight_cost');
    expect(AGENT_INSTRUCTIONS).not.toContain('check_feasibility');
  });

  it('explains the argsJson convention and keeps the existing rules', () => {
    expect(AGENT_INSTRUCTIONS).toContain('argsJson');
    expect(AGENT_INSTRUCTIONS).toContain('Rules:\n- Use real tool results.');
    expect(AGENT_INSTRUCTIONS).toContain('If the scene is empty (no model), only generate_design and get_project_state will work');
  });
});
