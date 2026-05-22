"use client";

import { useState } from "react";

const PROVIDERS = [
  { key: "nvidia", label: "NVIDIA Endpoints", icon: "N", models: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-nano-30b-a3b"], keyLabel: "NVIDIA API Key", keyHint: "nvapi-...", keyUrl: "https://build.nvidia.com/settings/api-keys" },
  { key: "openai", label: "OpenAI", icon: "O", models: ["gpt-5.4", "gpt-5.4-mini", "gpt-4.1", "gpt-4.1-mini"], keyLabel: "OpenAI API Key", keyHint: "sk-...", keyUrl: "https://platform.openai.com/api-keys" },
  { key: "anthropic", label: "Anthropic", icon: "A", models: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"], keyLabel: "Anthropic API Key", keyHint: "sk-ant-...", keyUrl: "https://console.anthropic.com/settings/keys" },
  { key: "gemini", label: "Google Gemini", icon: "G", models: ["gemini-2.5-flash", "gemini-2.5-pro"], keyLabel: "Gemini API Key", keyHint: "", keyUrl: "https://aistudio.google.com/app/apikey" },
  { key: "custom", label: "OpenAI Compatible", icon: "C", models: [], keyLabel: "API Key", keyHint: "", keyUrl: "" },
];

const POLICY_PRESETS = [
  { key: "pypi", label: "PyPI", desc: "Python packages", suggested: true },
  { key: "npm", label: "npm", desc: "Node packages", suggested: true },
  { key: "github", label: "GitHub", desc: "GitHub API access", suggested: false },
  { key: "discord", label: "Discord", desc: "Discord bot", suggested: false },
  { key: "slack", label: "Slack", desc: "Slack bot", suggested: false },
  { key: "telegram", label: "Telegram", desc: "Telegram bot", suggested: false },
  { key: "jira", label: "Jira", desc: "Jira Cloud", suggested: false },
  { key: "huggingface", label: "HuggingFace", desc: "ML models", suggested: false },
  { key: "docker", label: "Docker", desc: "Container registry", suggested: false },
  { key: "brave", label: "Brave Search", desc: "Web search", suggested: false },
  { key: "outlook", label: "Outlook", desc: "Microsoft email", suggested: false },
  { key: "brew", label: "Homebrew", desc: "macOS packages", suggested: false },
];

interface Props {
  onDeploy: (config: Record<string, string>) => void;
}

export default function SetupForm({ onDeploy }: Props) {
  const [provider, setProvider] = useState("nvidia");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDERS[0].models[0] || "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [sandboxName, setSandboxName] = useState("");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [policies, setPolicies] = useState<string[]>(["pypi", "npm"]);
  const [showKey, setShowKey] = useState(false);

  // Messaging
  const [telegramToken, setTelegramToken] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [slackToken, setSlackToken] = useState("");

  const selectedProvider = PROVIDERS.find((p) => p.key === provider)!;

  function handleProviderChange(key: string) {
    setProvider(key);
    const p = PROVIDERS.find((pr) => pr.key === key)!;
    setModel(p.models[0] || "");
    setShowKey(false);
    setApiKey("");
  }

  function togglePolicy(key: string) {
    setPolicies((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const config: Record<string, string> = {
      provider,
      model,
      apiKey,
      sandboxName: sandboxName || "",
      policies: policies.join(","),
    };
    if (customEndpoint) config.endpoint = customEndpoint;
    if (telegramToken) config.telegramToken = telegramToken;
    if (discordToken) config.discordToken = discordToken;
    if (slackToken) config.slackToken = slackToken;
    onDeploy(config);
  }

  const isValid = apiKey.length > 0 && (provider !== "custom" || customEndpoint.length > 0);

  return (
    <div className="w-full max-w-lg animate-fade-in">
      {/* Header */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-nc-green/10 border border-nc-green/20 mb-4">
          <span className="text-3xl font-bold text-nc-green">D</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Diffract</h1>
        <p className="text-nc-text-muted mt-1">Deploy a secure AI agent in seconds</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Provider Selection */}
        <div>
          <label className="block text-sm font-medium text-nc-text-muted mb-3">
            Provider
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PROVIDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => handleProviderChange(p.key)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                  provider === p.key
                    ? "border-nc-green bg-nc-green/10 text-nc-green"
                    : "border-nc-border bg-nc-surface text-nc-text-muted hover:border-nc-text-dim hover:bg-nc-surface-hover"
                }`}
              >
                <span
                  className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold ${
                    provider === p.key
                      ? "bg-nc-green text-black"
                      : "bg-nc-border text-nc-text-dim"
                  }`}
                >
                  {p.icon}
                </span>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* API Key */}
        <div>
          <label className="block text-sm font-medium text-nc-text-muted mb-2">
            {selectedProvider.keyLabel}
          </label>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={selectedProvider.keyHint || "Enter API key"}
              className="w-full px-4 py-3 rounded-lg bg-nc-surface border border-nc-border text-nc-text placeholder:text-nc-text-dim focus:outline-none focus:border-nc-green focus:ring-1 focus:ring-nc-green/30 transition-all font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-nc-text-dim hover:text-nc-text-muted text-xs"
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          {selectedProvider.keyUrl && (
            <a
              href={selectedProvider.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-nc-text-dim hover:text-nc-green mt-1.5 inline-block transition-colors"
            >
              Get an API key &rarr;
            </a>
          )}
        </div>

        {/* Custom Endpoint (only for custom provider) */}
        {provider === "custom" && (
          <div>
            <label className="block text-sm font-medium text-nc-text-muted mb-2">
              Endpoint URL
            </label>
            <input
              type="url"
              value={customEndpoint}
              onChange={(e) => setCustomEndpoint(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
              className="w-full px-4 py-3 rounded-lg bg-nc-surface border border-nc-border text-nc-text placeholder:text-nc-text-dim focus:outline-none focus:border-nc-green focus:ring-1 focus:ring-nc-green/30 transition-all font-mono text-sm"
            />
          </div>
        )}

        {/* Advanced Section */}
        <div className="border border-nc-border rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm text-nc-text-muted hover:text-nc-text hover:bg-nc-surface-hover transition-all"
          >
            <span>Advanced Settings</span>
            <span className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`}>
              &#9662;
            </span>
          </button>

          {showAdvanced && (
            <div className="px-4 pb-4 space-y-5 border-t border-nc-border bg-nc-surface/50">
              {/* Model */}
              <div className="pt-4">
                <label className="block text-sm font-medium text-nc-text-muted mb-2">
                  Model
                </label>
                {selectedProvider.models.length > 0 ? (
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg bg-nc-surface border border-nc-border text-nc-text focus:outline-none focus:border-nc-green transition-all text-sm"
                  >
                    {selectedProvider.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Enter model ID"
                    className="w-full px-4 py-3 rounded-lg bg-nc-surface border border-nc-border text-nc-text placeholder:text-nc-text-dim focus:outline-none focus:border-nc-green focus:ring-1 focus:ring-nc-green/30 transition-all text-sm"
                  />
                )}
              </div>

              {/* Sandbox Name */}
              <div>
                <label className="block text-sm font-medium text-nc-text-muted mb-2">
                  Sandbox Name
                </label>
                <input
                  type="text"
                  value={sandboxName}
                  onChange={(e) => setSandboxName(e.target.value)}
                  placeholder="Auto-generated if empty"
                  className="w-full px-4 py-3 rounded-lg bg-nc-surface border border-nc-border text-nc-text placeholder:text-nc-text-dim focus:outline-none focus:border-nc-green focus:ring-1 focus:ring-nc-green/30 transition-all text-sm"
                />
              </div>

              {/* Policy Presets */}
              <div>
                <label className="block text-sm font-medium text-nc-text-muted mb-2">
                  Network Policies
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {POLICY_PRESETS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => togglePolicy(p.key)}
                      className={`px-2.5 py-2 rounded-md border text-xs font-medium transition-all ${
                        policies.includes(p.key)
                          ? "border-nc-green/50 bg-nc-green/10 text-nc-green"
                          : "border-nc-border bg-nc-surface text-nc-text-dim hover:border-nc-text-dim"
                      }`}
                      title={p.desc}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Messaging Channels */}
              <div>
                <label className="block text-sm font-medium text-nc-text-muted mb-2">
                  Messaging Channels
                </label>
                <div className="space-y-2">
                  <div>
                    <input
                      type="password"
                      value={telegramToken}
                      onChange={(e) => setTelegramToken(e.target.value)}
                      placeholder="Telegram Bot Token (optional)"
                      className="w-full px-4 py-2.5 rounded-lg bg-nc-surface border border-nc-border text-nc-text placeholder:text-nc-text-dim focus:outline-none focus:border-nc-green focus:ring-1 focus:ring-nc-green/30 transition-all text-sm"
                    />
                  </div>
                  <div>
                    <input
                      type="password"
                      value={discordToken}
                      onChange={(e) => setDiscordToken(e.target.value)}
                      placeholder="Discord Bot Token (optional)"
                      className="w-full px-4 py-2.5 rounded-lg bg-nc-surface border border-nc-border text-nc-text placeholder:text-nc-text-dim focus:outline-none focus:border-nc-green focus:ring-1 focus:ring-nc-green/30 transition-all text-sm"
                    />
                  </div>
                  <div>
                    <input
                      type="password"
                      value={slackToken}
                      onChange={(e) => setSlackToken(e.target.value)}
                      placeholder="Slack Bot Token (optional)"
                      className="w-full px-4 py-2.5 rounded-lg bg-nc-surface border border-nc-border text-nc-text placeholder:text-nc-text-dim focus:outline-none focus:border-nc-green focus:ring-1 focus:ring-nc-green/30 transition-all text-sm"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Deploy Button */}
        <button
          type="submit"
          disabled={!isValid}
          className={`w-full py-3.5 rounded-lg font-semibold text-sm transition-all ${
            isValid
              ? "bg-nc-green text-black hover:bg-nc-green-dark active:scale-[0.98] animate-pulse-glow"
              : "bg-nc-border text-nc-text-dim cursor-not-allowed"
          }`}
        >
          Deploy
        </button>
      </form>
    </div>
  );
}
