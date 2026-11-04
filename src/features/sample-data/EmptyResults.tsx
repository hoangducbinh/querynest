import { Terminal } from "lucide-react";

export function EmptyResults() {
  return (
    <div className="grid-scroll" tabIndex={0} aria-label="Query result data">
      <div className="results-empty">
        <Terminal size={22} />
        <p>Run a query to explore your data</p>
        <small>Results stay in your browser.</small>
      </div>
    </div>
  );
}
