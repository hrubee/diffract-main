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
 * Rendered persistently by App.tsx; `isActive` only drives input focus.
 */
import { ArrowUp, MessageSquarePlus, PanelLeft, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

type Role = "user" | "assistant";
interface ChatMessage {
  role: Role;
  content: string;
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

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
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
  const t = (first?.content ?? "").trim().replace(/\s+/g, " ");
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

export default function ChatPage({ isActive = true }: { isActive?: boolean }) {
  const initial = loadStore();
  const [conversations, setConversations] = useState<Conversation[]>(
    initial.conversations,
  );
  const [activeId, setActiveId] = useState<string | null>(initial.activeId);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = conversations.find((c) => c.id === activeId) || null;
  const messages = active?.messages ?? [];

  // Persist on every change so reloads (and sandbox recreations) keep history.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ conversations, activeId }),
      );
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [conversations, activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversations, activeId, streaming]);

  useEffect(() => {
    if (isActive) inputRef.current?.focus();
  }, [isActive, activeId]);

  const updateConv = useCallback(
    (id: string, fn: (c: Conversation) => Conversation) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
    },
    [],
  );

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setActiveId(null);
    setInput("");
    setError(null);
    inputRef.current?.focus();
  }, []);

  const selectConv = useCallback((id: string) => {
    abortRef.current?.abort();
    setStreaming(false);
    setError(null);
    setActiveId(id);
  }, []);

  const deleteConv = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    },
    [],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setError(null);
    setInput("");

    // Ensure there's a conversation to write into.
    let convId = activeId;
    if (!convId || !conversations.some((c) => c.id === convId)) {
      convId = uid();
      const conv: Conversation = {
        id: convId,
        title: "New chat",
        messages: [],
        updatedAt: Date.now(),
      };
      setConversations((prev) => [conv, ...prev]);
      setActiveId(convId);
    }
    const cid = convId;

    const base = conversations.find((c) => c.id === cid)?.messages ?? [];
    const history: ChatMessage[] = [...base, { role: "user", content: text }];
    updateConv(cid, (c) => ({
      ...c,
      title: !c.title || c.title === "New chat" ? titleFrom(history) : c.title,
      messages: [...history, { role: "assistant", content: "" }],
      updatedAt: Date.now(),
    }));
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          stream: true,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
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
        setError(e instanceof Error ? e.message : "Something went wrong.");
        updateConv(cid, (c) => {
          const msgs = c.messages.slice();
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant" && !last.content) msgs.pop();
          return { ...c, messages: msgs };
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      if (isActive) inputRef.current?.focus();
    }
  }, [input, streaming, activeId, conversations, updateConv, isActive]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

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
                    c.id === activeId
                      ? "bg-white/10"
                      : "hover:bg-white/5",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text-primary">
                      {c.title || "New chat"}
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
                  Ask a question or describe a task to get started.
                </p>
              </div>
            )}

            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "flex",
                  m.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed text-text-primary",
                    m.role === "user"
                      ? "bg-white/10"
                      : "border border-white/10 bg-white/[0.04]",
                  )}
                >
                  {m.content ||
                    (streaming && i === messages.length - 1 ? (
                      <span className="text-text-tertiary">…</span>
                    ) : (
                      ""
                    ))}
                </div>
              </div>
            ))}

            {error && (
              <div className="text-center text-sm text-red-400">{error}</div>
            )}
          </div>
        </div>

        <div className="border-t border-white/10 px-4 py-3">
          <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
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
            {streaming ? (
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
                disabled={!input.trim()}
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
  );
}
