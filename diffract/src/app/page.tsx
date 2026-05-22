"use client";

import { useState, useEffect } from "react";
import SetupForm from "./components/SetupForm";
import DeployProgress from "./components/DeployProgress";
import Dashboard from "./components/Dashboard";

type AppState = "loading" | "setup" | "deploying" | "dashboard";

export default function Home() {
  const [state, setState] = useState<AppState>("loading");
  const [sandboxName, setSandboxName] = useState("");
  const [deployLogs, setDeployLogs] = useState<string[]>([]);

  // Check if a sandbox already exists on load
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.status?.name) {
          setSandboxName(data.status.name);
          setState("dashboard");
        } else {
          setState("setup");
        }
      })
      .catch(() => setState("setup"));
  }, []);

  function handleDeploy(config: Record<string, string>) {
    setState("deploying");
    setDeployLogs([]);

    const params = new URLSearchParams(config);
    const eventSource = new EventSource(`/api/deploy?${params.toString()}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "log") {
        setDeployLogs((prev) => [...prev, data.message]);
      } else if (data.type === "done") {
        setSandboxName(data.sandboxName || config.sandboxName || "my-assistant");
        eventSource.close();
        setState("dashboard");
      } else if (data.type === "error") {
        setDeployLogs((prev) => [...prev, `ERROR: ${data.message}`]);
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      {state === "loading" && (
        <div className="text-nc-text-muted text-sm">Checking for existing sandboxes...</div>
      )}
      {state === "setup" && <SetupForm onDeploy={handleDeploy} />}
      {state === "deploying" && (
        <DeployProgress logs={deployLogs} />
      )}
      {state === "dashboard" && (
        <Dashboard sandboxName={sandboxName} onDestroyed={() => setState("setup")} />
      )}
    </main>
  );
}
