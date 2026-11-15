import { ToolErrorDetailSchema, type ToolResult } from '../../shared/agent';

/**
 * The line shown for a finished tool: the tool result's own `summary`. Failure
 * kinds that are written for the model (they name tools, arguments or ids) get
 * a plain explanation instead; the agent corrects these on its own.
 * Tool labels come from the server's `tool` event, not from this file.
 */
export function resultText(result: ToolResult): string {
  if (!result.ok) {
    const detail = ToolErrorDetailSchema.safeParse(result.detail);
    if (detail.success && detail.data.code === 'UNKNOWN_TOOL') return '代理嘗試了不支援的步驟，會改用其他方式。';
    if (detail.success && detail.data.code === 'INVALID_ARGS') return '這一步的參數不正確，代理會自行修正。';
    if (detail.success && detail.data.code === 'UNKNOWN_OBJECT') return '代理指定的物件不存在，會改用其他方式。';
  }
  return result.summary;
}
