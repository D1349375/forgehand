import { ToolErrorDetailSchema, type LegacyToolResult } from '../../shared/agent';

/** Friendly Traditional Chinese names for tools. The UI never shows a raw tool name. */
const TOOL_LABELS: Record<string, string> = {
  generate_design: '生成設計',
  edit_design: '修改設計',
  select_parts: '選取零件',
  get_project_state: '檢視目前狀態',
  explode_view: '爆炸圖',
  wear_on_arm: '護臂試戴',
};

export const UNKNOWN_TOOL_LABEL = '其他步驟';

export function toolLabel(tool: string): string {
  return Object.hasOwn(TOOL_LABELS, tool) ? TOOL_LABELS[tool]! : UNKNOWN_TOOL_LABEL;
}

/**
 * The line shown for a finished tool: the tool result's own `summary`. Two
 * failure kinds are written for the model and name tools and arguments, so they
 * get a plain explanation instead; the agent corrects these on its own.
 */
export function resultText(result: LegacyToolResult): string {
  if (!result.ok) {
    const detail = ToolErrorDetailSchema.safeParse(result.detail);
    if (detail.success && detail.data.code === 'UNKNOWN_TOOL') return '代理嘗試了不支援的步驟，會改用其他方式。';
    if (detail.success && detail.data.code === 'INVALID_ARGS') return '這一步的參數不正確，代理會自行修正。';
  }
  return result.summary;
}
