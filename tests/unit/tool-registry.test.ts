import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_INSTRUCTIONS } from '../../server/agent';
import {
  argsShapeText, createToolRegistry, defineTool, getTool, listTools, generateDesign,
  type ToolDefinition,
} from '../../server/tools';
import { ok } from '../../server/tools/helpers';

const TOOLS = [
  'generate_design', 'edit_design', 'select_parts', 'get_project_state', 'explode_view',
  'set_active_object', 'set_transform', 'remove_object',
  'create_joint', 'update_joint', 'remove_joint', 'pull_out_part', 'set_material', 'wear_on_arm', 'set_camera_image', 'prepare_export',
];

const fakeTool = (over: Partial<ToolDefinition<Record<string, never>>> = {}): ToolDefinition<Record<string, never>> => ({
  name: 'fake_tool',
  label: '測試工具',
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

  it.each([['an empty label', ''], ['a label of 41 characters', 'x'.repeat(41)]])('rejects %s', (_name, label) => {
    const registry = createToolRegistry();
    expect(() => registry.defineTool(fakeTool({ name: 'bad_label', label }))).toThrow(/bad_label/);
    expect(registry.getTool('bad_label')).toBeUndefined();
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
  it('holds exactly the sixteen working tools, all project-scope server tools, in the order the model sees them', () => {
    expect(listTools().map(tool => tool.name)).toEqual(TOOLS);
    expect(listTools({ scope: 'project', side: 'server' }).map(tool => tool.name)).toEqual(TOOLS);
    expect(listTools({ scope: 'home' })).toEqual([]);
    expect(listTools({ side: 'client' })).toEqual([]);
  });

  it('gives every tool a Traditional Chinese label of 1 to 40 characters', () => {
    for (const tool of listTools()) {
      expect(tool.label.length, tool.name).toBeGreaterThanOrEqual(1);
      expect(tool.label.length, tool.name).toBeLessThanOrEqual(40);
    }
    expect(Object.fromEntries(listTools().map(tool => [tool.name, tool.label]))).toEqual({
      generate_design: '生成設計',
      edit_design: '修改設計',
      select_parts: '選取零件',
      get_project_state: '檢視目前狀態',
      explode_view: '爆炸圖',
      set_active_object: '切換物件',
      set_transform: '移動物件',
      remove_object: '移除物件',
      create_joint: '建立接合',
      update_joint: '設定接合',
      remove_joint: '移除接合',
      pull_out_part: '拉出零件',
      set_material: '設定材料',
      wear_on_arm: '護臂試戴',
      set_camera_image: '鏡頭畫面',
      prepare_export: '準備匯出',
    });
  });

  it('refuses to register an existing tool name again', () => {
    expect(() => defineTool(fakeTool({ name: 'generate_design' }))).toThrow(/generate_design/);
    expect(getTool('generate_design')).toBe(generateDesign);
    expect(listTools()).toHaveLength(TOOLS.length);
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
      set_active_object: 'writes-scene',
      set_transform: 'writes-scene',
      remove_object: 'writes-scene',
      create_joint: 'writes-scene',
      update_joint: 'writes-scene',
      remove_joint: 'writes-scene',
      pull_out_part: 'writes-scene',
      set_material: 'writes-scene',
      wear_on_arm: 'uses-camera',
      set_camera_image: 'uses-camera',
      prepare_export: 'read-only',
    });
  });
});

describe('argsShapeText', () => {
  it('renders each tool argument with its type', () => {
    const shape = (name: string) => argsShapeText(getTool(name)!.args);
    expect(shape('generate_design')).toBe('prompt: string, detail?: string | null');
    expect(shape('edit_design')).toBe('instruction: string, objectId?: string | null');
    expect(shape('select_parts')).toBe('partIds: string[], objectId?: string | null');
    expect(shape('get_project_state')).toBe('objectId?: string | null');
    expect(shape('explode_view')).toBe('amount: number, objectId?: string | null');
    expect(shape('set_active_object')).toBe('objectId: string');
    expect(shape('set_transform')).toBe('objectId: string, position?: object | null, rotation?: object | null');
    expect(shape('remove_object')).toBe('objectId: string');
    expect(shape('create_joint')).toBe('a: object, b: object');
    expect(shape('update_joint')).toBe('jointId: string, load?: string | null, disassembly?: string | null, method?: unknown | null, confirmed?: boolean | null');
    expect(shape('remove_joint')).toBe('jointId: string');
    expect(shape('pull_out_part')).toBe('partId: string, objectId?: string | null');
    expect(shape('set_material')).toBe('objectId: string, material: string | null');
    expect(shape('wear_on_arm')).toBe('enabled: boolean');
    expect(shape('set_camera_image')).toBe('visible: boolean');
    expect(shape('prepare_export')).toBe('scope: string | null, objectId: string | null');
  });

  it('marks optional arguments', () => {
    expect(argsShapeText(z.strictObject({ a: z.string(), b: z.number().optional() }))).toBe('a: string, b?: number');
  });
});

describe('generated tool list in AGENT_INSTRUCTIONS', () => {
  const section = AGENT_INSTRUCTIONS.split('Available tools:\n')[1]!.split('\nRules:')[0]!;
  const lines = section.split('\n').filter(line => line.trim());

  it('lists exactly the sixteen tools, in registration order, as `- name(args): description`', () => {
    expect(lines).toEqual(listTools({ scope: 'project', side: 'server' })
      .map(tool => `- ${tool.name}(${argsShapeText(tool.args)}): ${tool.description}`));
    expect(lines.map(line => /^- (\w+)\(/.exec(line)![1])).toEqual(TOOLS);
  });

  it('tells the model that wear_on_arm shows a stand-in cuff, not the user design', () => {
    const line = lines.find(entry => entry.startsWith('- wear_on_arm('))!;
    expect(line).toContain('stand-in cuff');
    expect(line).toContain("not the user's design");
  });

  it('has one line per tool, sixteen in all', () => {
    expect(lines).toHaveLength(16);
  });
  it('does not mention tools that are not registered', () => {
    expect(AGENT_INSTRUCTIONS).not.toContain('estimate_weight_cost');
    expect(AGENT_INSTRUCTIONS).not.toContain('check_feasibility');
  });

  it('explains the argsJson convention and keeps the existing rules', () => {
    expect(AGENT_INSTRUCTIONS).toContain('argsJson');
    expect(AGENT_INSTRUCTIONS).toContain('Rules:\n- Use real tool results.');
    expect(AGENT_INSTRUCTIONS).toContain('If the workspace is empty, only generate_design and get_project_state work; other tools return NO_MODEL.');
  });
});
