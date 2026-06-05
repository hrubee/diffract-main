"use client";

import { useEffect, useState } from "react";

interface Props {
  logs: string[];
}

export default function DeployProgress({ logs }: Props) {
  // Elapsed-time counter so the wait feels monitored. We intentionally do NOT
  // render the raw deploy log lines — they expose underlying tooling/brand
  // names (nemoclaw/hermes/openshell) and command output. Logs are still
  // streamed to derive step progress and detect errors, just never shown.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const steps = [
    { label: "Preflight checks", match: "preflight" },
    { label: "Starting gateway", match: "gateway" },
    { label: "Creating secure sandbox", match: "sandbox" },
    { label: "Configuring inference", match: "inference" },
    { label: "Applying security policies", match: "polic" },
    { label: "Setting up your assistant", match: "agent" },
  ];

  function getStepStatus(step: { match: string }, index: number) {
    const matchedIndex = logs.findIndex((l) =>
      l.toLowerCase().includes(step.match)
    );
    if (matchedIndex === -1) {
      const laterStarted = steps.slice(index + 1).some((s) =>
        logs.some((l) => l.toLowerCase().includes(s.match))
      );
      if (laterStarted) return "done";
      return "pending";
    }
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
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="w-full max-w-lg animate-fade-in">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Deploying your assistant
        </h1>
        <p className="text-nc-text-muted mt-1">
          This usually takes about <span className="text-nc-text">10 minutes</span>.
          You can keep this tab open — we&apos;ll take you to your dashboard
          automatically when it&apos;s ready.
        </p>
      </div>

      {/* Step indicators (no raw command output is shown) */}
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
                {status === "done" ? "✓" : status === "active" ? "•" : ""}
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

      {!hasError ? (
        <div className="flex items-center justify-center gap-3 rounded-lg bg-nc-surface border border-nc-border px-4 py-3 text-sm text-nc-text-muted">
          <div className="w-4 h-4 border-2 border-nc-green border-t-transparent rounded-full animate-spin" />
          <span>Working on it… {mm}:{ss} elapsed</span>
        </div>
      ) : (
        <>
          <div className="rounded-lg bg-nc-danger/10 border border-nc-danger/30 px-4 py-3 text-sm text-nc-danger">
            Something went wrong while setting up your sandbox. Please try again.
          </div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 w-full py-3 rounded-lg bg-nc-danger/10 border border-nc-danger/30 text-nc-danger text-sm font-medium hover:bg-nc-danger/20 transition-all"
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}
