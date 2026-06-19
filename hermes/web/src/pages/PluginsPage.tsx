import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Trash2, Eye, EyeOff } from "lucide-react";
import type { Translations } from "@/i18n/types";
import { Link } from "react-router-dom";
import { api, mcpHost } from "@/lib/api";
import type { HubAgentPluginRow, PluginsHubResponse, HostMcpServer } from "@/lib/api";
import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Select, SelectOption } from "@nous-research/ui/ui/components/select";
import { Switch } from "@nous-research/ui/ui/components/switch";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { CommandBlock } from "@nous-research/ui/ui/components/command-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/useToast";
import { Toast } from "@/components/Toast";
import { useI18n } from "@/i18n";
import { PluginSlot } from "@/plugins";
import { cn } from "@/lib/utils";
import { usePageHeader } from "@/contexts/usePageHeader";

/** Select value for built-in memory (`config` uses empty string). Never use `""` — UI Select maps empty value to an empty label. */
const MEMORY_PROVIDER_BUILTIN = "__hermes_memory_builtin__";

export default function PluginsPage() {
  const [hub, setHub] = useState<PluginsHubResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [installId, setInstallId] = useState("");
  const [installForce, setInstallForce] = useState(false);
  const [installEnable, setInstallEnable] = useState(true);
  const [installBusy, setInstallBusy] = useState(false);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [memorySel, setMemorySel] = useState(MEMORY_PROVIDER_BUILTIN);
  const [contextSel, setContextSel] = useState("compressor");
  const [providerBusy, setProviderBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const { toast, showToast } = useToast();
  const { t } = useI18n();
  const { setAfterTitle } = usePageHeader();

  const loadHub = useCallback(() => {
    return api
      .getPluginsHub()
      .then((h) => {
        setHub(h);
        const p = h.providers;
        setMemorySel(p.memory_provider ? p.memory_provider : MEMORY_PROVIDER_BUILTIN);
        setContextSel(p.context_engine || "compressor");
      })
      .catch(() => showToast(t.common.loading, "error"));
  }, [showToast, t.common.loading]);

  useEffect(() => {
    setLoading(true);
    void loadHub().finally(() => setLoading(false));
  }, [loadHub]);

  useEffect(() => {
    setAfterTitle(
      <Button
        ghost
        size="icon"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        disabled={loading || rescanBusy}
        onClick={() => void onRescan()}
        aria-label={t.pluginsPage.refreshDashboard}
      >
        {rescanBusy ? <Spinner /> : <RefreshCw />}
      </Button>,
    );
    return () => setAfterTitle(null);
  }, [loading, rescanBusy, setAfterTitle, t.pluginsPage.refreshDashboard]);

  const onInstall = async () => {
    const id = installId.trim();
    if (!id) {
      showToast(t.pluginsPage.installHint, "error");
      return;
    }
    setInstallBusy(true);
    try {
      const r = await api.installAgentPlugin({
        identifier: id,
        force: installForce,
        enable: installEnable,
      });
      showToast(`${r.plugin_name ?? id} installed`, "success");
      if ((r.warnings?.length ?? 0) > 0) showToast(r.warnings!.join(" "), "error");
      if ((r.missing_env?.length ?? 0) > 0)
        showToast(`${t.pluginsPage.missingEnvWarn} ${r.missing_env!.join(", ")}`, "error");
      setInstallId("");
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Install failed", "error");
    } finally {
      setInstallBusy(false);
    }
  };

  const onRescan = async () => {
    setRescanBusy(true);
    try {
      const rc = await api.rescanPlugins();
      showToast(
        `${t.pluginsPage.refreshDashboard} (${rc.count})`,
        "success",
      );
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Rescan failed", "error");
    } finally {
      setRescanBusy(false);
    }
  };

  const onSaveProviders = async () => {
    setProviderBusy(true);
    try {
      await api.savePluginProviders({
        memory_provider:
          memorySel === MEMORY_PROVIDER_BUILTIN ? "" : memorySel,
        context_engine: contextSel,
      });
      showToast(t.pluginsPage.savedProviders, "success");
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setProviderBusy(false);
    }
  };

  const setRuntimeLoading = async (name: string, fn: () => Promise<unknown>) => {
    setRowBusy(name);
    try {
      await fn();
      await loadHub();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setRowBusy(null);
    }
  };

  const rows = hub?.plugins ?? [];
  const providers = hub?.providers;

  return (
    <div className="flex flex-col gap-4">
      <PluginSlot name="plugins:top" />

      <div className={cn("flex w-full flex-col gap-8")}>

        {providers && (
          <Card>
            <CardHeader>
              <CardTitle>{t.pluginsPage.providersHeading}</CardTitle>
              <p className="text-xs tracking-[0.08em] text-text-tertiary">
                {t.pluginsPage.providersHint}
              </p>
            </CardHeader>

            <CardContent className="flex flex-col gap-6">

              <div className="grid gap-6 sm:grid-cols-2 max-w-full">
              <div className="grid gap-2 min-w-0">
                <Label htmlFor="mem-provider">{t.pluginsPage.memoryProviderLabel}</Label>

                <Select
                  id="mem-provider"
                  className="w-full"
                  value={memorySel}
                  onValueChange={setMemorySel}
                >
                  <SelectOption value={MEMORY_PROVIDER_BUILTIN}>
                    {`(${t.pluginsPage.providerDefaults})`}
                  </SelectOption>

                  {providers.memory_options.map((o) => (
                    <SelectOption key={o.name} value={o.name}>
                      {o.name}
                    </SelectOption>
                  ))}
                </Select>
              </div>

              <div className="grid gap-2 min-w-0">
                <Label htmlFor="ctx-engine">{t.pluginsPage.contextEngineLabel}</Label>

                <Select
                  id="ctx-engine"
                  className="w-full"
                  value={contextSel}
                  onValueChange={setContextSel}
                >
                  <SelectOption value="compressor">compressor</SelectOption>

                  {providers.context_options
                    .filter((o) => o.name !== "compressor")
                    .map((o) => (
                      <SelectOption key={o.name} value={o.name}>
                        {o.name}
                      </SelectOption>
                    ))}
                </Select>
              </div>
              </div>

              <Button
                className="w-fit uppercase"
                size="sm"
                disabled={providerBusy}
                onClick={() => void onSaveProviders()}
                prefix={providerBusy ? <Spinner /> : undefined}
              >
                {t.common.save}
              </Button>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t.pluginsPage.installHeading}</CardTitle>
            <p className="text-xs tracking-[0.08em] text-text-tertiary">
              {t.pluginsPage.installHint}
            </p>
          </CardHeader>


          <CardContent className="flex flex-col gap-4">

            <div className="flex flex-col gap-2">

              <Label htmlFor="install-url">{t.pluginsPage.identifierLabel}</Label>

              <Input
                className="font-mono-ui lowercase"
                id="install-url"
                placeholder="owner/repo or https://..."
                spellCheck={false}
                value={installId}
                onChange={(e) => setInstallId(e.target.value)}
              />
            </div>


            <div className="flex flex-wrap items-center gap-8">

              <div className="flex items-center gap-3">

                <Switch checked={installForce} onCheckedChange={setInstallForce} />

                <span className="text-xs tracking-[0.06em] text-text-secondary">
                  {t.pluginsPage.forceReinstall}
                </span>
              </div>

              <div className="flex items-center gap-3">

                <Switch checked={installEnable} onCheckedChange={setInstallEnable} />

                <span className="text-xs tracking-[0.06em] text-text-secondary">
                  {t.pluginsPage.enableAfterInstall}
                </span>
              </div>
            </div>

            <Button
              className="w-fit uppercase"
              size="sm"
              disabled={installBusy}
              onClick={() => void onInstall()}
              prefix={installBusy ? <Spinner /> : undefined}
            >
              {t.pluginsPage.installBtn}
            </Button>

            <p className="text-xs tracking-[0.06em] text-text-tertiary">
              {t.pluginsPage.rescanHint}
            </p>

            <p className="text-xs tracking-[0.06em] text-text-tertiary">
              {t.pluginsPage.removeHint}
            </p>
          </CardContent>
        </Card>

        <McpServersCard showToast={showToast} />

        <div className="flex flex-col gap-3">

          <h3 className="font-mondwest text-display text-xs tracking-[0.12em] text-text-secondary">
            {t.pluginsPage.pluginListHeading}
          </h3>

          {loading ? (

            <div className="flex items-center gap-2 py-8 text-xs text-text-tertiary">

              <Spinner />
              <span>{t.common.loading}</span>
            </div>
          ) : rows.length === 0 ? (

            <p className="text-xs text-text-tertiary">{t.common.noResults}</p>
          ) : (

            <ul className="flex flex-col gap-3">

              {rows.map((row: HubAgentPluginRow) => (

                <li key={row.name}>


                  <PluginRowCard
                    {...{ row, rowBusy, setRuntimeLoading, showToast, t }}
                  />

                </li>
              ))}
            </ul>
          )}
        </div>

        {(hub?.orphan_dashboard_plugins?.length ?? 0) > 0 ? (


          <div className="flex flex-col gap-3 opacity-95">

            <h3 className="font-mondwest text-display text-xs tracking-[0.12em] text-text-secondary">
              {t.pluginsPage.orphanHeading}
            </h3>

            <ul className="flex flex-col gap-2 rounded border border-current/15 p-4">

              {hub!.orphan_dashboard_plugins.map((m) => (

                <li className="text-xs text-text-secondary" key={m.name}>


                  {m.label ?? m.name} — {m.description || m.tab?.path}


                  {!m.tab?.hidden ? (


                    <Link className="ml-3 inline-flex items-center gap-1 underline" to={m.tab.path}>


                      <ExternalLink className="h-3 w-3 opacity-65" />

                      {t.pluginsPage.openTab}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <Toast toast={toast} />
      <PluginSlot name="plugins:bottom" />
    </div>
  );
}

interface PluginRowCardProps {

  row: HubAgentPluginRow;
  rowBusy: string | null;
  setRuntimeLoading: (
    name: string,
    fn: () => Promise<unknown>,
  ) => Promise<void>;

  showToast: (msg: string, variant: "success" | "error") => void;
  t: Translations;
}

function PluginRowCard(props: PluginRowCardProps) {
  const {
    row,
    rowBusy,
    setRuntimeLoading,
    showToast,
    t,
  } = props;

  const dm = row.dashboard_manifest;

  const tabPath = dm?.tab && !dm.tab.hidden ? dm.tab.override ?? dm.tab.path : null;

  const busy = rowBusy === row.name;
  const [confirmRemove, setConfirmRemove] = useState(false);

  const badgeTone =
    row.runtime_status === "enabled"
      ? "success"
      : row.runtime_status === "disabled"
        ? "destructive"
        : "outline";

  return (

    <Card className={cn(busy ? "opacity-70" : undefined)}>


      <CardContent className="flex flex-col gap-4 px-6 py-4">


        <div className="flex flex-wrap items-start justify-between gap-4">

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">

            <span className="truncate font-semibold">{row.name}</span>

            <Badge tone="outline">
              {t.pluginsPage.sourceBadge}: {row.source}
            </Badge>

            <Badge tone="outline">v{row.version || "—"}</Badge>

            <Badge tone={badgeTone}>{row.runtime_status}</Badge>

            {row.auth_required ? (
              <Badge tone="destructive">{t.pluginsPage.authRequired}</Badge>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {row.runtime_status === "enabled" ? (
              <Button
                disabled={busy}
                ghost
                size="sm"
                onClick={() => {
                  void setRuntimeLoading(row.name, async () => {
                    await api.disableAgentPlugin(row.name);
                    showToast(t.pluginsPage.disableRuntime, "success");
                  });
                }}
              >
                {t.pluginsPage.disableRuntime}
              </Button>
            ) : (
              <Button
                disabled={busy}
                ghost
                size="sm"
                onClick={() => {
                  void setRuntimeLoading(row.name, async () => {
                    await api.enableAgentPlugin(row.name);
                    showToast(t.pluginsPage.enableRuntime, "success");
                  });
                }}
              >
                {t.pluginsPage.enableRuntime}
              </Button>
            )}

            {tabPath ? (

              <Link
                className={cn(
                  "inline-flex items-center rounded-none px-3 py-1.5",
                  "border border-current/25 hover:bg-current/10",
                  "font-mondwest text-display text-xs tracking-[0.1em]",
                )}
                to={tabPath}
              >
                {t.pluginsPage.openTab}
              </Link>
            ) : null}

            {row.can_update_git ? (

              <Button
                disabled={busy}
                ghost
                size="sm"
                onClick={() => {
                  void setRuntimeLoading(row.name, async () => {
                    await api.updateAgentPlugin(row.name);
                    showToast(t.pluginsPage.updateGit, "success");
                  });
                }}
              >
                {busy ? <Spinner /> : null}
                {t.pluginsPage.updateGit}
              </Button>
            ) : null}

            {row.has_dashboard_manifest ? (
              <Button
                disabled={busy}
                ghost
                size="sm"
                title={row.user_hidden ? t.pluginsPage.showInSidebar : t.pluginsPage.hideFromSidebar}
                onClick={() => {
                  void setRuntimeLoading(row.name, async () => {
                    await api.setPluginVisibility(row.name, !row.user_hidden);
                  });
                }}
              >
                {row.user_hidden ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                {row.user_hidden ? t.pluginsPage.showInSidebar : t.pluginsPage.hideFromSidebar}
              </Button>
            ) : null}

            {row.can_remove ? (


              <Button
                destructive
                disabled={busy}
                ghost
                size="sm"
                onClick={() => setConfirmRemove(true)}
              >

                {busy ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            ) : null}
          </div>
        </div>

        {row.description ? (
          <p className="min-w-0 w-full text-xs tracking-[0.06em] text-text-secondary break-words">
            {row.description}
          </p>
        ) : null}

        {dm?.slots?.length ? (

          <p className="text-xs tracking-[0.05em] text-text-tertiary">
            {t.pluginsPage.dashboardSlots}: {dm.slots.join(", ")}
          </p>
        ) : null}

        {row.auth_required ? (
          <CommandBlock
            label={t.pluginsPage.authRequiredHint}
            code={row.auth_command}
          />
        ) : null}

        {!row.has_dashboard_manifest && !dm ? (


          <p className="text-xs italic text-text-disabled">
            {t.pluginsPage.noDashboardTab}
          </p>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirmRemove}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void setRuntimeLoading(row.name, async () => {
            await api.removeAgentPlugin(row.name);
            showToast(`${row.name} removed`, "success");
          });
        }}
        title={t.pluginsPage.removeConfirm}
        description={`This will remove the "${row.name}" plugin from your agent.`}
        destructive
        confirmLabel={t.common.delete}
      />
    </Card>
  );
}

// ── MCP Servers ───────────────────────────────────────────────────────────
// Connect / manage remote MCP servers (Zapier, Stitch, …). This drives the HOST
// Diffract control plane (diffractui /api/mcp) — see mcpHost in lib/api — because
// opening the OpenShell egress an MCP needs is a host-side action the in-sandbox
// dashboard cannot perform. Copy strings are intentionally inline (operator infra,
// not part of the translated product surface) to avoid shipping half-localised UI.
function McpServersCard({
  showToast,
}: {
  showToast: (msg: string, variant: "success" | "error") => void;
}) {
  const [servers, setServers] = useState<HostMcpServer[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(() => {
    return mcpHost
      .list()
      .then((s) => {
        setServers(s);
        setLoadErr(null);
      })
      .catch((e) => {
        setServers([]);
        setLoadErr(e instanceof Error ? e.message : "Failed to load MCP servers");
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Suggest a short name from the URL host when the user hasn't typed one.
  const onUrlChange = (v: string) => {
    setUrl(v);
    if (!name.trim()) {
      try {
        const slug = new URL(v).hostname
          .replace(/^mcp\./, "")
          .split(".")[0]
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "");
        if (slug) setName(slug);
      } catch {
        /* not a URL yet */
      }
    }
  };

  const onAdd = async () => {
    if (!url.trim()) return showToast("Enter the MCP server URL", "error");
    if (!name.trim()) return showToast("Enter a short name (a-z, 0-9, -)", "error");
    setBusy(true);
    try {
      await mcpHost.add({
        name: name.trim(),
        url: url.trim(),
        authHeader: authHeader.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      showToast(`Connected "${name.trim()}" — redeploy the agent to use it in chat`, "success");
      setName("");
      setUrl("");
      setAuthHeader("");
      setApiKey("");
      setShowAdvanced(false);
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Connect failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (n: string) => {
    setRemoving(n);
    try {
      await mcpHost.remove(n);
      showToast(`Removed "${n}"`, "success");
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Remove failed", "error");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP Servers</CardTitle>
        <p className="text-xs tracking-[0.08em] text-text-tertiary">
          Connect a remote MCP server (e.g. Zapier, Stitch) so the agent can use its tools.
          Paste the full server URL; for header-authenticated servers add the auth header + key.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="mcp-url">Server URL</Label>
          <Input
            id="mcp-url"
            className="font-mono-ui"
            spellCheck={false}
            placeholder="https://mcp.zapier.com/api/v1/connect?token=…"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="mcp-name">Name</Label>
          <Input
            id="mcp-name"
            className="font-mono-ui lowercase"
            spellCheck={false}
            placeholder="zapier"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <button
          type="button"
          className="w-fit text-xs underline text-text-tertiary hover:text-text-secondary"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "Hide header authentication" : "Header authentication (e.g. Stitch X-Goog-Api-Key)"}
        </button>

        {showAdvanced ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-hdr">Auth header</Label>
              <Input
                id="mcp-hdr"
                className="font-mono-ui"
                spellCheck={false}
                placeholder="X-Goog-Api-Key"
                value={authHeader}
                onChange={(e) => setAuthHeader(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-key">API key</Label>
              <Input
                id="mcp-key"
                type="password"
                className="font-mono-ui"
                spellCheck={false}
                placeholder="key value"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        <Button
          className="w-fit uppercase"
          size="sm"
          disabled={busy}
          onClick={() => void onAdd()}
          prefix={busy ? <Spinner /> : undefined}
        >
          Connect
        </Button>

        <div className="flex flex-col gap-2">
          {servers === null ? (
            <div className="flex items-center gap-2 py-2 text-xs text-text-tertiary">
              <Spinner />
              <span>Loading…</span>
            </div>
          ) : loadErr ? (
            <p className="text-xs text-text-tertiary">{loadErr}</p>
          ) : servers.length === 0 ? (
            <p className="text-xs text-text-tertiary">No MCP servers connected yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {servers.map((s) => (
                <li
                  key={s.name}
                  className="flex items-center justify-between gap-3 rounded border border-current/15 px-3 py-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono-ui text-sm">{s.name}</span>
                    <span className="truncate text-xs text-text-tertiary">{s.host}</span>
                  </span>
                  <Button
                    destructive
                    ghost
                    size="sm"
                    disabled={removing === s.name}
                    onClick={() => void onRemove(s.name)}
                    aria-label={`Remove ${s.name}`}
                  >
                    {removing === s.name ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs tracking-[0.06em] text-text-tertiary">
          After connecting, redeploy the agent (Diffract dashboard → Deploy) so the chat session
          picks up the new tools.
        </p>
      </CardContent>
    </Card>
  );
}
