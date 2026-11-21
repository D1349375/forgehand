import { useState } from 'react';
import type { AgentRun } from './useAgentRun';
import type { AgentRunStatus } from './run-reducer';

const statusText: Record<AgentRunStatus, string> = {
  idle: '尚未執行。',
  running: '代理正在處理，可隨時取消。',
  done: '已完成。',
  error: '執行未完成。',
  cancelled: '已取消；已套用的變更仍保留，可用「復原」還原。',
};

/**
 * The agent conversation panel: one instruction box, the live progress log, the
 * final reply, and cancel. The parent owns the run (`useAgentRun`) so it can also
 * read `agent.active` to disable manual controls while a run is going.
 */
export function AgentPanel({ agent, disabled = false }: { agent: AgentRun; disabled?: boolean }) {
  const [draft, setDraft] = useState('');
  const running = agent.status === 'running';
  const blocked = disabled && !running;

  const submit = () => {
    const text = draft.trim();
    if (!text || running || disabled) return;
    setDraft('');
    void agent.run(text);
  };

  return <section className="panel agent-panel" aria-label="代理對話" data-testid="agent-panel">
    <span className="eyebrow">AGENT</span><h2>交給代理處理</h2>
    <p className="muted">用一句話交代任務，代理會自己選擇步驟，並逐步回報進度。</p>
    <form onSubmit={event => { event.preventDefault(); submit(); }}>
      <label htmlFor="agent-instruction">任務指示</label>
      <textarea id="agent-instruction" value={draft} maxLength={4000} rows={3} disabled={running}
        onChange={event => setDraft(event.target.value)}
        placeholder="例如：生成一個手持掃描器，再把握把改成橘色並展開爆炸圖" />
      <div className="input-meta"><span>代理會依序生成、修改、選取或展開零件</span><span>{draft.length}/4000</span></div>
      <div className="button-group">
        <button className="button primary" type="submit" disabled={running || disabled || !draft.trim()}>執行 <span aria-hidden="true">↗</span></button>
        {running && <button className="button ghost" type="button" onClick={agent.cancel}>取消</button>}
      </div>
    </form>
    <div className="generation-status" aria-live="polite" role="status">
      <span className={`status-dot ${running ? 'pulsing' : ''}`} /><span>{statusText[agent.status]}</span>
    </div>
    {blocked && <p className="small-muted" data-testid="agent-blocked">生成或修改進行中，完成或取消後才能交給代理。</p>}
    {agent.instruction && agent.status !== 'idle' && <p className="agent-sent"><span>你的指示</span>{agent.instruction}</p>}
    {agent.log.length > 0 && <ol className="agent-log" aria-label="執行進度" data-testid="agent-log">
      {agent.log.map(entry => <li key={entry.id} className={`agent-log-item ${entry.kind} ${entry.ok === false ? 'failed' : ''}`}>
        {entry.label && <strong>{entry.label}</strong>}
        {entry.kind === 'result' && <span className="agent-result-state">{entry.ok ? '完成' : '未完成'}</span>}
        <span>{entry.text}</span>
      </li>)}
    </ol>}
    {agent.reply && <div className="notice success" data-testid="agent-reply"><strong>代理回覆</strong><p>{agent.reply}</p></div>}
    {agent.error && <div className="notice warning" role="alert" data-testid="agent-error"><p>{agent.error}</p></div>}
  </section>;
}
