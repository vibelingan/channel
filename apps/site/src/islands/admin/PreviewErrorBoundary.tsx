import { Component, type ReactNode } from 'react';

/** Keep the modal shell and Admin usable when a lazy chunk or render fails. */
export class PreviewErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="space-y-3 p-8 text-slate-700">
        <h3 className="text-lg font-semibold text-slate-900">Preview could not be loaded</h3>
        <p>Reload this page and try again. Your product has not been changed.</p>
        <button
          type="button"
          className="rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
          onClick={() => window.location.reload()}
        >
          Reload page
        </button>
      </div>
    );
  }
}
