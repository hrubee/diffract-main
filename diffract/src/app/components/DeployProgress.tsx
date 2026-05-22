"use client";

import { useEffect, useRef } from "react";

interface Props {
  logs: string[];
}

export default function DeployProgress({ logs }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const steps = [
    { label: "Preflight checks", match: "preflight" },
    { label: "Starting gateway", match: "gateway" },
    { label: "Creating sandbox", match: "sandbox" },
    { label: "Configuring inference", match: "inference" },
    { label: "Applying policies", match: "polic" },
    { label: "Setting up agent", match: "agent" },
  ];

  function getStepStatus(step: { match: string }, index: number) {
    const matchedIndex = logs.findIndex((l) =>
      l.toLowerCase().includes(step.match)
    );
    if (matchedIndex === -1) {
      // Check if a later step has started
      const laterStarted = steps.slice(index + 1).some((s) =>
        logs.some((l) => l.toLowerCase().includes(s.match))
      );
      if (laterStarted) return "done";
      return "pending";
    }
    // Check if next step has started
    const nextStep = steps[index + 1];
    if (nextStep) {
      const nextMatched = logs.some((l) =>
        l.toLowerCase().includes(nextStep.match)
      );
      if (nextMatched) return "done";
    }
    return "active";
  }

  const hasError = logs.some((l) => l.startsWith("ERROR:"));

  return (
    <div className="w-full max-w-lg animate-fade-in">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Deploying</h1>
        <p className="text-nc-text-muted mt-1">Setting up your secure sandbox</p>
      </div>

      {/* Step indicators */}
      <div className="space-y-2 mb-6">
        {steps.map((step, i) => {
          const status = getStepStatus(step, i);
          return (
            <div key={step.label} className="flex items-center gap-3">
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                  status === "done"
                    ? "bg-nc-success text-black"
                    : status === "active"
                    ? "bg-nc-green/20 border-2 border-nc-green text-nc-green"
                    : "bg-nc-border text-nc-text-dim"
                }`}
              >
                {status === "done" ? "\u2713" : status === "active" ? "\u2022" : ""}
              </div>
              <span
                className={`text-sm ${
                  status === "done"
                    ? "text-nc-text-muted"
                    : status === "active"
                    ? "text-nc-text font-medium"
                    : "text-nc-text-dim"
                }`}
              >
                {step.label}
              </span>
              {status === "active" && (
                <div className="w-4 h-4 border-2 border-nc-green border-t-transparent rounded-full animate-spin" />
              )}
            </div>
          );
        })}
      </div>

      {/* Log output */}
      <div
        ref={scrollRef}
        className="h-48 overflow-y-auto rounded-lg bg-nc-surface border border-nc-border p-4 font-mono text-xs leading-5"
      >
        {logs.map((log, i) => (
          <div
            key={i}
            className={
              log.startsWith("ERROR:")
                ? "text-nc-danger"
                : log.startsWith("WARN:")
                ? "text-nc-warning"
                : "text-nc-text-muted"
            }
          >
            {log}
          </div>
        ))}
        {!hasError && logs.length > 0 && (
          <div className="inline-block w-2 h-4 bg-nc-green/60 animate-pulse" />
        )}
      </div>

      {hasError && (
        <button
          onClick={() => window.location.reload()}
          className="mt-4 w-full py-3 rounded-lg bg-nc-danger/10 border border-nc-danger/30 text-nc-danger text-sm font-medium hover:bg-nc-danger/20 transition-all"
        >
          Retry
        </button>
      )}
    </div>
  );
}
