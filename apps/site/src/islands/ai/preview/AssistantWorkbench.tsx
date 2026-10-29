import { useMemo, useState, useSyncExternalStore } from 'react';
import { AssistantExperience } from '../assistant/AssistantExperience';
import { initialAssistantState } from '../assistant/state';
import { createPreviewAdapter } from './preview-adapter';
import { screens, seedFor } from './scenarios';

function Preview({ scenario, journey }: { scenario: string; journey: boolean }) {
  const adapter = useMemo(() => createPreviewAdapter(scenario), [scenario]);
  const ledger = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
  const seed = useMemo(
    () => (journey ? { state: initialAssistantState('preview-conversation') } : seedFor(scenario)),
    [scenario, journey],
  );
  return (
    <>
      <AssistantExperience adapter={adapter} seed={seed} preview />
      <details className="mt-8 max-w-xl rounded-xl border border-slate-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          Local interaction evidence
        </summary>
        <p className="mt-2 text-xs text-ink-muted">
          Operation IDs and fingerprints only. No service calls or contact details are logged.
        </p>
        <pre
          data-testid="preview-ledger"
          className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs"
        >
          {JSON.stringify(ledger, null, 2)}
        </pre>
      </details>
    </>
  );
}
export function AssistantWorkbench() {
  const [selected, setSelected] = useState('welcome');
  const [journey, setJourney] = useState(false);
  const [iteration, setIteration] = useState(0);
  const screen = screens.find((item) => item.id === selected);
  if (!screen) throw new Error('Unknown preview state');
  return (
    <main className="min-h-screen bg-surface-alt p-5 text-ink sm:p-10">
      <div className="max-w-2xl">
        <p className="text-xs font-semibold tracking-widest text-brand-700">
          CHANNEL / ASSISTANT COMPONENTS
        </p>
        <h1 className="mt-3 text-2xl font-semibold">官网智能助手 · 实际组件预览</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          沿用官网界面。这里运行的是产品组件、状态与公共钩子；模拟数据，不连接模型、后台、询盘保存或邮件。正式网站仍保留原传输逻辑。
        </p>
        <label htmlFor="preview-state" className="mt-6 block text-sm font-semibold">
          查看设计状态
        </label>
        <select
          id="preview-state"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setJourney(false);
          }}
          className="mt-2 min-h-11 max-w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
        >
          {screens.map((item) => (
            <option key={item.id} value={item.id}>
              {String(item.number).padStart(2, '0')} · {item.title}
            </option>
          ))}
        </select>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setJourney(true);
              setIteration((value) => value + 1);
            }}
            className="min-h-11 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white"
          >
            Start this journey
          </button>
          <button
            type="button"
            onClick={() => {
              setJourney(false);
              setIteration((value) => value + 1);
            }}
            className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm"
          >
            Reset state
          </button>
        </div>
        <section className="mt-6 max-w-xl rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <h2 className="font-semibold">
            {screen.number}. {screen.title}
          </h2>
          <p className="mt-2">{screen.interaction_note}</p>
          <p className="mt-3 text-xs text-ink-muted">
            {journey
              ? '连续交互：在右侧输入问题，或点击建议问题，观察状态变化。'
              : '状态样例：可查看和操作当前状态。完整异步过程请点击 Start this journey。'}
          </p>
        </section>
      </div>
      <Preview key={`${selected}-${journey}-${iteration}`} scenario={selected} journey={journey} />
    </main>
  );
}
