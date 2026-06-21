/**
 * ChatPage — a normal message-bubble chat with the Diffract agent, with a
 * conversation history sidebar.
 *
 * Backend: the agent's OpenAI-compatible gateway (`/v1/chat/completions`, proxied
 * by Caddy to the in-sandbox gateway on :8642) with SSE streaming. That endpoint
 * is stateless (no server-side session id), and server sessions are tied to the
 * sandbox (destroyed on recreate), so conversations are persisted CLIENT-SIDE in
 * localStorage. That makes them survive reloads AND sandbox recreations, and lets
 * the user switch between past conversations from the sidebar. History is resent
 * to the gateway each turn (OpenAI-style).
 *
 * Attachments: users can attach images and text/data files. Images ride along as
 * OpenAI `image_url` data-URI content blocks (the model's vision path). Text/data
 * files (CSV, JSON, code, logs, MD, …) are read client-side and inlined into the
 * message text, so the agent reads them directly with any model — no server upload
 * needed. Large image/text payloads are kept in memory only (stripped from the
 * localStorage copy) so history persistence never blows the storage quota.
 *
 * Streaming is tracked PER conversation (each send owns its AbortController, keyed
 * by conversation id), so switching conversations mid-reply does NOT cancel the
 * reply — it keeps streaming into its own conversation in the background.
 *
 * Rendered persistently by App.tsx; `isActive` only drives input focus.
 */
import {
  ArrowUp,
  Command,
  FileText,
  MessageSquarePlus,
  PanelLeft,
  Paperclip,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/Markdown";
import { GatewayClient } from "@/lib/gatewayClient";
import { executeSlash } from "@/lib/slashExec";
import { cn } from "@/lib/utils";

type Role = "user" | "assistant";
type AttachmentKind = "image" | "text";
interface Attachment {
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  dataUrl?: string; // images: base64 data URI (in-memory only)
  text?: string; // text/data files: file contents (in-memory only)
  truncated?: boolean;
}
interface ChatMessage {
  role: Role;
  content: string;
  attachments?: Attachment[];
  /** Output from a slash command run via the command menu. Shown in the
   *  transcript but NEVER sent to the model (kept out of the request history). */
  system?: boolean;
}
interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

const STORE_KEY = "diffract.chat.v1";
// Caddy routes origin /v1/* -> the sandbox gateway (:8642). Leading slash keeps
// it at the origin root (NOT under the dashboard's /agent base path).
const CHAT_COMPLETIONS_URL = "/v1/chat/completions";
const MODEL = "hermes-agent";
const GREETING =
  "Hi, I'm Diffract Agent — running safely for your business. How can I help?";

interface SlashCommand {
  command: string; // includes the leading slash, e.g. "/reload-mcp"
  description: string;
}
// Shown when the gateway's own completion list is unavailable — the handful of
// gateway commands that are actually useful from the web chat.
const FALLBACK_COMMANDS: SlashCommand[] = [
  { command: "/reload-mcp", description: "Reload MCP servers and pull their tools into the agent" },
  { command: "/tools", description: "List the tools currently available to the agent" },
  { command: "/skills", description: "List the skills currently loaded" },
  { command: "/status", description: "Show agent and sandbox status" },
  { command: "/usage", description: "Show token usage for this session" },
  { command: "/model", description: "Show the active model" },
  { command: "/help", description: "List the available slash commands" },
];

// Attachment limits.
const MAX_ATTACHMENTS = 6;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB per file
const MAX_TEXT_CHARS = 200_000; // inline cap for a single text/data file
// Extensions we treat as text/data even when the browser reports a vague MIME.
const TEXT_EXT = new Set([
  "txt", "text", "md", "markdown", "rst", "tex", "log", "csv", "tsv", "json",
  "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml",
  "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "jsx", "ts", "tsx",
  "py", "rb", "go", "rs", "java", "kt", "swift", "scala", "c", "h", "cpp", "hpp",
  "cc", "cs", "php", "pl", "lua", "r", "dart", "vue", "svelte", "astro", "sh",
  "bash", "zsh", "sql", "graphql", "gql", "proto", "dockerfile", "makefile",
  "gitignore", "diff", "patch",
]);

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function classifyFile(file: File): AttachmentKind | "unsupported" {
  if (file.type.startsWith("image/")) return "image";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.type.startsWith("text/")) return "text";
  if (TEXT_EXT.has(ext)) return "text";
  if (/(json|xml|csv|yaml|javascript|ecmascript|x-sh|x-python|toml)/.test(file.type)) {
    return "text";
  }
  return "unsupported";
}

function readFile(file: File, as: "text" | "dataURL"): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    if (as === "text") r.readAsText(file);
    else r.readAsDataURL(file);
  });
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Build the OpenAI content for a message: a plain string when there are no
// attachments, otherwise a content-block array (text + inlined text files,
// plus image_url blocks for images).
function toRequestContent(m: ChatMessage): unknown {
  const atts = m.attachments ?? [];
  if (atts.length === 0) return m.content;

  let textBlock = m.content;
  for (const a of atts) {
    if (a.kind === "text" && a.text != null) {
      textBlock +=
        `\n\nAttached file "${a.name}":\n\`\`\`\n${a.text}\n\`\`\`` +
        (a.truncated ? "\n(file truncated for length)" : "");
    }
  }

  const parts: unknown[] = [];
  if (textBlock.trim()) parts.push({ type: "text", text: textBlock });
  for (const a of atts) {
    if (a.kind === "image" && a.dataUrl) {
      parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
    }
  }
  return parts.length ? parts : m.content;
}

// Drop heavy in-memory fields (image data URIs, file text) before persisting, so
// localStorage stays small. Display metadata (name/kind/size) is kept.
function persistable(conversations: Conversation[]): Conversation[] {
  return conversations.map((c) => ({
    ...c,
    messages: c.messages.map((m) =>
      m.attachments
        ? {
            ...m,
            attachments: m.attachments.map((a) => ({
              name: a.name,
              mime: a.mime,
              kind: a.kind,
              size: a.size,
              truncated: a.truncated,
            })),
          }
        : m,
    ),
  }));
}

function loadStore(): { conversations: Conversation[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p?.conversations)) {
        return { conversations: p.conversations, activeId: p.activeId ?? null };
      }
    }
  } catch {
    /* ignore corrupt/absent store */
  }
  return { conversations: [], activeId: null };
}

function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  let t = (first?.content ?? "").trim().replace(/\s+/g, " ");
  if (!t && first?.attachments?.length) t = first.attachments[0].name;
  if (!t) return "New chat";
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Animated "agent is thinking" indicator shown until the first token streams in.
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="Agent is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary"
          style={{ animationDelay: `${i * 0.16}s`, animationDuration: "0.9s" }}
        />
      ))}
    </span>
  );
}

function AttachmentChips({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {attachments.map((a, i) =>
        a.kind === "image" && a.dataUrl ? (
          <img
            key={i}
            src={a.dataUrl}
            alt={a.name}
            className="h-16 w-16 rounded-lg border border-white/10 object-cover"
          />
        ) : (
          <span
            key={i}
            className="inline-flex max-w-[12rem] items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-text-secondary"
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{a.name}</span>
          </span>
        ),
      )}
    </div>
  );
}

export default function ChatPage({ isActive = true }: { isActive?: boolean }) {
  const initial = loadStore();
  const [conversations, setConversations] = useState<Conversation[]>(
    initial.conversations,
  );
  const [activeId, setActiveId] = useState<string | null>(initial.activeId);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Ids of conversations currently streaming a reply (supports background streams).
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // One AbortController per in-flight conversation, so streams are independent.
  const abortControllers = useRef<Map<string, AbortController>>(new Map());
  // Latest activeId, for async callbacks that must not read a stale closure.
  const activeIdRef = useRef<string | null>(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Slash-command menu state + a lazily-connected gateway client (only opened
  // when the user opens the menu or runs a command).
  const [menuOpen, setMenuOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [cmdsLoading, setCmdsLoading] = useState(false);
  const [runningCmd, setRunningCmd] = useState<string | null>(null);
  const gwRef = useRef<GatewayClient | null>(null);
  const gwSessionRef = useRef<string>("");
  const cmdsLoadedRef = useRef(false);
  useEffect(() => () => gwRef.current?.close(), []);

  const active = conversations.find((c) => c.id === activeId) || null;
  const messages = active?.messages ?? [];
  const activeStreaming = activeId != null && streamingIds.has(activeId);

  // Persist on every change so reloads (and sandbox recreations) keep history.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ conversations: persistable(conversations), activeId }),
      );
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [conversations, activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversations, activeId, streamingIds]);

  useEffect(() => {
    if (isActive) inputRef.current?.focus();
  }, [isActive, activeId]);

  const updateConv = useCallback(
    (id: string, fn: (c: Conversation) => Conversation) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
    },
    [],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      const accepted: Attachment[] = [];
      for (const f of list) {
        if (pending.length + accepted.length >= MAX_ATTACHMENTS) {
          setError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
          break;
        }
        const kind = classifyFile(f);
        if (kind === "unsupported") {
          setError(
            `"${f.name}" isn't supported yet — attach images or text/data files (CSV, JSON, code, logs, Markdown).`,
          );
          continue;
        }
        if (f.size > MAX_FILE_BYTES) {
          setError(`"${f.name}" is too large (max ${fmtSize(MAX_FILE_BYTES)}).`);
          continue;
        }
        try {
          if (kind === "image") {
            const dataUrl = await readFile(f, "dataURL");
            accepted.push({ name: f.name, mime: f.type || "image/*", kind, size: f.size, dataUrl });
          } else {
            let text = await readFile(f, "text");
            let truncated = false;
            if (text.length > MAX_TEXT_CHARS) {
              text = text.slice(0, MAX_TEXT_CHARS);
              truncated = true;
            }
            accepted.push({
              name: f.name,
              mime: f.type || "text/plain",
              kind,
              size: f.size,
              text,
              truncated,
            });
          }
        } catch {
          setError(`Couldn't read "${f.name}".`);
        }
      }
      if (accepted.length) {
        setError(null);
        setPending((p) => [...p, ...accepted]);
      }
    },
    [pending.length],
  );

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) void addFiles(e.target.files);
      e.target.value = ""; // allow re-selecting the same file
    },
    [addFiles],
  );

  const removePending = useCallback((i: number) => {
    setPending((p) => p.filter((_, idx) => idx !== i));
  }, []);

  // Switching conversations must NOT abort an in-flight reply — it keeps
  // streaming into its own conversation in the background.
  const newChat = useCallback(() => {
    setActiveId(null);
    setInput("");
    setPending([]);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const selectConv = useCallback((id: string) => {
    setError(null);
    setActiveId(id);
  }, []);

  const deleteConv = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    abortControllers.current.get(id)?.abort(); // stop its stream if any
    abortControllers.current.delete(id);
    setStreamingIds((prev) => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }, []);

  const sendMessage = useCallback(async (text: string, attachments: Attachment[]) => {
    if (!text && attachments.length === 0) return;

    // Resolve the target conversation; block only if THAT conversation is busy.
    let cid = activeIdRef.current;
    if (cid && streamingIds.has(cid)) return;
    if (!cid || !conversations.some((c) => c.id === cid)) {
      cid = uid();
      const conv: Conversation = {
        id: cid,
        title: "New chat",
        messages: [],
        updatedAt: Date.now(),
      };
      setConversations((prev) => [conv, ...prev]);
      setActiveId(cid);
    }

    setError(null);

    const base = conversations.find((c) => c.id === cid)?.messages ?? [];
    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      ...(attachments.length ? { attachments } : {}),
    };
    const history: ChatMessage[] = [...base, userMsg];
    updateConv(cid, (c) => ({
      ...c,
      title: !c.title || c.title === "New chat" ? titleFrom(history) : c.title,
      messages: [...history, { role: "assistant", content: "" }],
      updatedAt: Date.now(),
    }));
    setStreamingIds((prev) => new Set(prev).add(cid));

    const ac = new AbortController();
    abortControllers.current.set(cid, ac);
    try {
      const res = await fetch(CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          stream: true,
          messages: history
            .filter((m) => !m.system)
            .map((m) => ({ role: m.role, content: toRequestContent(m) })),
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (HTTP ${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            const delta = json?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              acc += delta;
              updateConv(cid, (c) => {
                const msgs = c.messages.slice();
                msgs[msgs.length - 1] = { role: "assistant", content: acc };
                return { ...c, messages: msgs, updatedAt: Date.now() };
              });
            }
          } catch {
            /* keep-alive / partial frame */
          }
        }
      }
      if (!acc) {
        updateConv(cid, (c) => {
          const msgs = c.messages.slice();
          msgs[msgs.length - 1] = { role: "assistant", content: "(no response)" };
          return { ...c, messages: msgs };
        });
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      if (!aborted) {
        // Surface the error only when the user is looking at this conversation.
        if (activeIdRef.current === cid) {
          setError(e instanceof Error ? e.message : "Something went wrong.");
        }
        updateConv(cid, (c) => {
          const msgs = c.messages.slice();
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant" && !last.content) msgs.pop();
          return { ...c, messages: msgs };
        });
      }
    } finally {
      abortControllers.current.delete(cid);
      setStreamingIds((prev) => {
        if (!prev.has(cid)) return prev;
        const n = new Set(prev);
        n.delete(cid);
        return n;
      });
    }
  }, [conversations, streamingIds, updateConv]);

  const send = useCallback(() => {
    const text = input.trim();
    const attachments = pending;
    if (!text && attachments.length === 0) return;
    if (activeId && streamingIds.has(activeId)) return;
    setInput("");
    setPending([]);
    void sendMessage(text, attachments);
  }, [input, pending, activeId, streamingIds, sendMessage]);

  // --- Slash-command menu --------------------------------------------------
  // The web chat is stateless (client-side history), but the in-sandbox gateway
  // still speaks the TUI JSON-RPC dialect, so slash commands (/reload-mcp, /tools,
  // …) run there exactly as they do in the Terminal tab.
  const ensureGateway = useCallback(async (): Promise<GatewayClient> => {
    let gw = gwRef.current;
    if (!gw) {
      gw = new GatewayClient();
      gwRef.current = gw;
    }
    if (gw.state !== "open") await gw.connect();
    if (!gwSessionRef.current) {
      try {
        const r = await gw.request<{ session_id?: string }>("session.create");
        if (r?.session_id) gwSessionRef.current = r.session_id;
      } catch {
        /* some commands are session-less — run with an empty session id */
      }
    }
    return gw;
  }, []);

  const loadCommands = useCallback(async () => {
    setCmdsLoading(true);
    try {
      const gw = await ensureGateway();
      const r = await gw.request<{
        items?: { display?: string; text?: string; meta?: string }[];
      }>("complete.slash", { text: "/" });
      const items = (r?.items ?? [])
        .map((it) => ({
          command: (it.display || (it.text ? `/${it.text}` : "")).trim(),
          description: (it.meta ?? "").trim(),
        }))
        .filter((c) => c.command.startsWith("/"));
      if (items.length) {
        setCommands(items);
        cmdsLoadedRef.current = true;
      } else {
        setCommands(FALLBACK_COMMANDS);
      }
    } catch {
      setCommands((prev) => (prev.length ? prev : FALLBACK_COMMANDS));
    } finally {
      setCmdsLoading(false);
    }
  }, [ensureGateway]);

  const openMenu = useCallback(() => {
    const next = !menuOpen;
    setMenuOpen(next);
    if (next && !cmdsLoadedRef.current && !cmdsLoading) void loadCommands();
  }, [menuOpen, cmdsLoading, loadCommands]);

  const runCommand = useCallback(
    async (command: string) => {
      setMenuOpen(false);
      setRunningCmd(command);

      // Make sure there's a conversation to show the command output in.
      let cid = activeIdRef.current;
      if (!cid || !conversations.some((c) => c.id === cid)) {
        cid = uid();
        const conv: Conversation = {
          id: cid,
          title: command,
          messages: [],
          updatedAt: Date.now(),
        };
        setConversations((prev) => [conv, ...prev]);
        setActiveId(cid);
      }
      const targetId = cid;
      const appendSystem = (content: string) =>
        updateConv(targetId, (c) => ({
          ...c,
          messages: [
            ...c.messages,
            { role: "assistant" as const, content, system: true },
          ],
          updatedAt: Date.now(),
        }));

      appendSystem(`▶ ${command}`);
      try {
        const gw = await ensureGateway();
        await executeSlash({
          command,
          sessionId: gwSessionRef.current,
          gw,
          callbacks: {
            sys: (text) => appendSystem(text),
            send: (message) => sendMessage(message, []),
          },
        });
      } catch (e) {
        appendSystem(`error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setRunningCmd(null);
      }
    },
    [conversations, ensureGateway, sendMessage, updateConv],
  );

  const stop = useCallback(() => {
    if (activeId) abortControllers.current.get(activeId)?.abort();
  }, [activeId]);

  const canSend = (input.trim().length > 0 || pending.length > 0) && !activeStreaming;

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Conversation sidebar */}
      {showList && (
        <aside className="flex w-60 shrink-0 flex-col border-r border-white/10">
          <div className="p-2">
            <button
              type="button"
              onClick={newChat}
              className="flex w-full items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-text-primary transition-colors hover:border-white/30 hover:bg-white/5"
            >
              <MessageSquarePlus className="h-4 w-4" /> New chat
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conversations.length === 0 ? (
              <p className="px-2 py-3 text-xs text-text-tertiary">
                No conversations yet.
              </p>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => selectConv(c.id)}
                  className={cn(
                    "group mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                    c.id === activeId ? "bg-white/10" : "hover:bg-white/5",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      {streamingIds.has(c.id) && (
                        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-midground" />
                      )}
                      <span className="block truncate text-sm text-text-primary">
                        {c.title || "New chat"}
                      </span>
                    </span>
                    <span className="block text-[0.7rem] text-text-tertiary">
                      {relTime(c.updatedAt)}
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label="Delete conversation"
                    onClick={(e) => deleteConv(c.id, e)}
                    className="shrink-0 rounded p-1 text-text-tertiary opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>
      )}

      {/* Chat column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setShowList((v) => !v)}
            aria-label="Toggle conversation list"
            className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-white/5 hover:text-text-primary"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-medium text-text-primary">Diffract Agent</span>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {messages.length === 0 && (
              <div className="mt-12 text-center">
                <p className="text-base text-text-primary">{GREETING}</p>
                <p className="mt-2 text-sm text-text-tertiary">
                  Ask a question, attach a file, or describe a task to get started.
                </p>
              </div>
            )}

            {messages.map((m, i) => {
              if (m.system) {
                return (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 font-mono text-xs leading-relaxed text-text-secondary">
                      {m.content}
                    </div>
                  </div>
                );
              }
              const isLastAssistant =
                m.role === "assistant" && i === messages.length - 1;
              const thinking = isLastAssistant && activeStreaming && !m.content;
              return (
                <div
                  key={i}
                  className={cn(
                    "flex",
                    m.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[85%] break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed text-text-primary",
                      m.role === "user"
                        ? "whitespace-pre-wrap bg-white/10"
                        : "border border-white/10 bg-white/[0.04]",
                    )}
                  >
                    {m.attachments?.length ? (
                      <AttachmentChips attachments={m.attachments} />
                    ) : null}
                    {thinking ? (
                      <TypingDots />
                    ) : m.role === "assistant" ? (
                      // Render markdown so **bold**/*italic*/lists/code show as
                      // formatting, not raw asterisks. Caret while streaming.
                      <Markdown
                        content={m.content}
                        streaming={isLastAssistant && activeStreaming}
                      />
                    ) : (
                      m.content
                    )}
                  </div>
                </div>
              );
            })}

            {error && (
              <div className="text-center text-sm text-red-400">{error}</div>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 px-4 py-3">
          <div className="relative mx-auto w-full max-w-3xl">
            {/* Slash-command menu popover */}
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute bottom-full left-0 z-20 mb-2 w-80 max-w-[calc(100%-1rem)] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
                  <div className="border-b border-border px-3 py-2">
                    <p className="text-sm font-medium text-text-primary">
                      Slash commands
                    </p>
                    <p className="text-xs text-text-tertiary">
                      Click a command to run it in the sandbox.
                    </p>
                  </div>
                  <div className="max-h-72 overflow-y-auto p-1.5">
                    {cmdsLoading && commands.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-text-tertiary">
                        Loading commands…
                      </p>
                    ) : (
                      commands.map((c) => (
                        <button
                          key={c.command}
                          type="button"
                          onClick={() => void runCommand(c.command)}
                          disabled={runningCmd != null}
                          className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="font-mono text-sm text-text-primary">
                              {c.command}
                            </span>
                            <span className="shrink-0 text-[0.6rem] uppercase tracking-wide text-text-tertiary">
                              click to run command
                            </span>
                          </span>
                          {c.description && (
                            <span className="text-xs text-text-tertiary">
                              {c.description}
                            </span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Pending attachment chips */}
            {pending.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {pending.map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 py-1 pl-2 pr-1 text-xs text-text-secondary"
                  >
                    {a.kind === "image" && a.dataUrl ? (
                      <img src={a.dataUrl} alt="" className="h-5 w-5 rounded object-cover" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate">{a.name}</span>
                    <span className="shrink-0 text-text-tertiary">{fmtSize(a.size)}</span>
                    <button
                      type="button"
                      onClick={() => removePending(i)}
                      aria-label={`Remove ${a.name}`}
                      className="shrink-0 rounded p-0.5 text-text-tertiary hover:text-text-primary"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
              }}
              className={cn(
                "flex items-end gap-2 rounded-xl",
                dragOver && "ring-2 ring-midground ring-offset-2 ring-offset-background",
              )}
            >
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,text/*,.csv,.tsv,.json,.jsonl,.md,.markdown,.log,.yaml,.yml,.toml,.ini,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.sh,.sql,.env,.conf"
                className="hidden"
                onChange={onPick}
              />
              <button
                type="button"
                onClick={openMenu}
                aria-label="Slash commands"
                title="Run a slash command in the sandbox"
                className={cn(
                  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-text-secondary transition-colors hover:text-text-primary",
                  menuOpen
                    ? "border-white/30 bg-white/5 text-text-primary"
                    : "border-white/10 hover:border-white/30",
                )}
              >
                <Command
                  className={cn("h-4 w-4", runningCmd && "animate-pulse")}
                />
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach files"
                title="Attach images or text/data files"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 text-text-secondary transition-colors hover:border-white/30 hover:text-text-primary"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Message Diffract Agent…"
                className="max-h-40 min-h-[2.75rem] flex-1 resize-none rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-midground focus:outline-none"
              />
              {activeStreaming ? (
                <button
                  type="button"
                  onClick={stop}
                  aria-label="Stop"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/15 text-text-secondary transition-colors hover:text-text-primary"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!canSend}
                  aria-label="Send"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-midground text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
