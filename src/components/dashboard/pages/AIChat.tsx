import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Copy,
  Loader2,
  MessageSquarePlus,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  RefreshCcw,
  Sparkles,
  Sparkle,
  StopCircle,
  Trash2,
  User,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import MessageRenderer from "../chat/MessageRenderer";
import SlashMenu, { SLASH_COMMANDS, SlashCommand } from "../chat/SlashMenu";
import { segmentsToPlainText, parseAgentStream } from "../chat/agentParser";
import DuplicateSearchResults from "../chat/DuplicateSearchResults";
import { createStreamTextAnimator, type StreamTextAnimator } from "../chat/streamTextAnimator";
import {
  COMPANY_CHAT_MODELS,
  DEFAULT_COMPANY_CHAT_MODEL,
  normalizeCompanyChatModel,
} from "../chat/companyModels";
import type { DuplicateSearchResult } from "../chat/duplicateSearchTypes";
import { Switch } from "@/components/ui/switch";

type Role = "user" | "assistant";
type ChatMode = "chat" | "duplicate-search";
interface Attachment {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  dataUrl?: string;
  size: number;
}
interface Msg {
  id: string;
  role: Role;
  content: string;
  mode?: ChatMode;
  duplicateResult?: DuplicateSearchResult;
  attachments?: Attachment[];
}
interface Conversation {
  id: string;
  title: string;
  pinned?: boolean;
  messages: Msg[];
  updatedAt: number;
}

const STORAGE_KEY = "dtsv.chat.v2";
function createId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

const newConversation = (): Conversation => ({
  id: createId(),
  title: "新对话",
  messages: [],
  updatedAt: Date.now(),
});

const newId = () => createId();

function pickPreferredAudioInputId(devices: MediaDeviceInfo[], current = "") {
  const preferred = devices.find((device) => {
    const label = device.label.toLowerCase();
    return /headset|headphone|earphone|airpods|bluetooth|耳机|耳麦/.test(label);
  });
  if (preferred?.deviceId) return preferred.deviceId;
  if (current && devices.some((device) => device.deviceId === current)) return current;
  return devices.find((device) => device.deviceId === "default")?.deviceId || devices[0]?.deviceId || "";
}

interface Props {
  moduleKey?: string;
  moduleLabel?: string;
}

const AIChat = ({ moduleKey, moduleLabel }: Props) => {
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Conversation[];
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch {}
    return [newConversation()];
  });
  const [activeId, setActiveId] = useState<string>(() => conversations[0].id);
  const [input, setInput] = useState("");
  const [interactionMode, setInteractionMode] = useState<ChatMode>("chat");
  const [chatContextEnabled, setChatContextEnabled] = useState(false);
  const [model, setModel] = useState(DEFAULT_COMPANY_CHAT_MODEL);
  const [streaming, setStreaming] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingMsgVal, setEditingMsgVal] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [selectedAudioInputId, setSelectedAudioInputId] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const streamAnimatorRef = useRef<StreamTextAnimator | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];
  const isEmpty = active.messages.length === 0;

  // persist
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    } catch {}
  }, [conversations]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [active?.messages]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  useEffect(() => {
    const close = () => setMenuId(null);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("click", close);
      mediaRecorderRef.current = null;
      stopMediaStream();
      streamAnimatorRef.current?.stop();
      streamAnimatorRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadAudioInputDevices = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const inputs = devices.filter((device) => device.kind === "audioinput");
        setSelectedAudioInputId((current) => pickPreferredAudioInputId(inputs, current));
      } catch {
        if (!cancelled) setSelectedAudioInputId("");
      }
    };

    loadAudioInputDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", loadAudioInputDevices);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", loadAudioInputDevices);
    };
  }, []);

  useEffect(() => {
    if (interactionMode !== "duplicate-search") {
      return;
    }

    void fetch("/api/duplicate-search/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "duplicate-search-mode" }),
    }).catch(() => undefined);
  }, [interactionMode]);

  const sortedConvos = useMemo(() => {
    return [...conversations].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      return b.updatedAt - a.updatedAt;
    });
  }, [conversations]);

  const updateActive = (fn: (c: Conversation) => Conversation) =>
    setConversations((prev) => prev.map((c) => (c.id === activeId ? fn(c) : c)));

  const handleNew = () => {
    const c = newConversation();
    setConversations((prev) => [c, ...prev]);
    setActiveId(c.id);
    setInput("");
    setAttachments([]);
  };

  const stop = () => {
    abortRef.current?.abort();
    activeRequestRef.current = null;
    abortRef.current = null;
    streamAnimatorRef.current?.stop();
    streamAnimatorRef.current = null;
    setStreaming(false);
  };

  // ----- file handling -----
  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const adds: Attachment[] = [];
    for (const f of Array.from(files).slice(0, 5)) {
      if (f.size > 8 * 1024 * 1024) continue;
      const isImg = f.type.startsWith("image/");
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      let dataUrl: string | undefined;
      if (isImg || isPdf) {
        dataUrl = await new Promise<string>((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.readAsDataURL(f);
        });
      }
      adds.push({
        id: newId(),
        name: f.name,
        kind: isImg ? "image" : "file",
        mimeType: f.type || (isPdf ? "application/pdf" : "application/octet-stream"),
        dataUrl,
        size: f.size,
      });
    }
    setAttachments((prev) => [...prev, ...adds]);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData.files?.length) {
      handleFiles(e.clipboardData.files);
    }
  };

  const stopMediaStream = (stream = mediaStreamRef.current) => {
    stream?.getTracks?.().forEach((track) => track.stop());
    if (stream === mediaStreamRef.current) {
      mediaStreamRef.current = null;
    }
  };

  const blobToBase64 = async (blob: Blob) => {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const marker = result.indexOf(",");
        resolve(marker >= 0 ? result.slice(marker + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error("Failed to read audio blob"));
      reader.readAsDataURL(blob);
    });
  };

  const transcribeAudioBlob = async (blob: Blob) => {
    const response = await fetch("/api/ai/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio: await blobToBase64(blob),
        mime: blob.type || "audio/webm",
      }),
    });

    const payload = await response.json().catch(async () => ({
      error: (await response.text().catch(() => "")) || "语音转写失败，请重试。",
    }));

    if (!response.ok || typeof payload?.text !== "string" || !payload.text.trim()) {
      throw new Error(payload?.error || "语音转写失败，请重试。");
    }

    return payload.text.trim();
  };

  const startVoiceRecording = async () => {
    if (recording || transcribing) return;

    setVoiceError("");

    if (typeof MediaRecorder !== "function" || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError("当前浏览器不支持语音输入。");
      return;
    }

    try {
      const audioConstraint = selectedAudioInputId
        ? { deviceId: { exact: selectedAudioInputId } }
        : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = async () => {
        const chunks = audioChunksRef.current.slice();
        audioChunksRef.current = [];
        mediaRecorderRef.current = null;
        stopMediaStream(stream);

        const blob = new Blob(chunks, { type: chunks[0]?.type || recorder.mimeType || "audio/webm" });
        if (!blob.size) {
          return;
        }

        setTranscribing(true);
        try {
          const transcript = await transcribeAudioBlob(blob);
          setInput((prev) => (prev.trim() ? `${prev}${prev.endsWith("\n") ? "" : "\n"}${transcript}` : transcript));
          setVoiceError("");
          setTimeout(() => taRef.current?.focus(), 0);
        } catch (error) {
          setVoiceError(error instanceof Error && error.message ? error.message : "语音转写失败，请重试。");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      setRecording(true);
    } catch {
      stopMediaStream();
      setVoiceError("无法访问麦克风，请检查浏览器权限。");
    }
  };

  const stopVoiceRecording = () => {
    if (!recording) return;

    setRecording(false);
    mediaRecorderRef.current?.stop();
  };

  // ----- slash menu -----
  const onInputChange = (val: string) => {
    setInput(val);
    const line = val.split("\n").pop() ?? "";
    if (line.startsWith("/")) {
      setSlashOpen(true);
      setSlashQuery(line.slice(1));
    } else {
      setSlashOpen(false);
    }
  };

  const pickSlash = (c: SlashCommand) => {
    setInput(c.prompt);
    setSlashOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
  };

  // ----- core send -----
  const buildGatewayMessages = (history: Msg[]) =>
    history.map((m) => {
      if (m.role === "user" && m.attachments?.some((a) => a.dataUrl && (a.kind === "image" || a.mimeType === "application/pdf"))) {
        const parts: any[] = [{ type: "text", text: m.content || "(附件)" }];
        for (const a of m.attachments) {
          if (a.kind === "image" && a.dataUrl) {
            parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
          }
          if (a.kind === "file" && a.mimeType === "application/pdf" && a.dataUrl) {
            parts.push({
              type: "file_data",
              file_data: {
                name: a.name,
                mime_type: a.mimeType,
                url: a.dataUrl,
              },
            });
          }
        }
        return { role: "user", content: parts };
      }
      return { role: m.role, content: m.content };
    });

  const buildDuplicateFallbackSummary = (result: DuplicateSearchResult) => {
    const normalizeText = (value: string | undefined, maxLength = 120) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);

    const buildConfidenceLevel = (score: number | undefined) => {
      const numeric = Number(score || 0);
      if (numeric >= 8) {
        return "高置信";
      }
      if (numeric >= 6) {
        return "中等置信";
      }
      if (numeric >= 4) {
        return "低置信";
      }
      return "弱相关";
    };

    const collectEvidence = (candidate: DuplicateSearchResult["candidates"][number]) =>
      Array.isArray(candidate.evidenceSnippets)
        ? candidate.evidenceSnippets
            .map((item) => normalizeText(item, 100))
            .filter(Boolean)
            .slice(0, 2)
        : [];

    const head = [
      `检索完成：返回 ${result.candidates.length} 条候选`,
      `模型阶段：${result.modelPhase}`,
      `反馈样本：${result.feedbackCount}`,
    ];

    if (!result.candidates.length) {
      return `${head.join(" · ")}\n\n未找到足够相似的问题，请补充项目、PU、现象关键词后重试。`;
    }

    const topCandidate = result.candidates[0];
    const topEvidence = collectEvidence(topCandidate);
    const topSnippet = normalizeText(topCandidate.snippet, 120);
    const topConfidenceLevel = buildConfidenceLevel(topCandidate.score1to10);

    return [
      head.join(" · "),
      "",
      `最可能重复票: ${topCandidate.ticketId || "N/A"}。标题“${topCandidate.name || "Untitled"}”，置信度: ${topConfidenceLevel}。`,
      topSnippet ? `现象匹配: ${topSnippet}` : "现象匹配: 当前候选缺少足够摘要信息。",
      topEvidence.length
        ? `评论分析: ${topEvidence.join("；")}`
        : "评论分析: 当前候选缺少足够 comments 证据。",
      "建议: 优先核对标题、comments 分析过程和关键日志是否一致。",
    ].join("\n");
  };

  const runStream = async (history: Msg[], assistantMsgId: string) => {
    setStreaming(true);
    const controller = new AbortController();
    const requestId = newId();
    activeRequestRef.current = requestId;
    abortRef.current = controller;
    streamAnimatorRef.current?.stop();
    if (!chatContextEnabled) {
      updateActive((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === assistantMsgId ? { ...m, content: "正在生成回答…" } : m,
        ),
        updatedAt: Date.now(),
      }));
    }
    const contextStr = moduleLabel
      ? `User is currently viewing the "${moduleLabel}" module (key: ${moduleKey}). Reference this module in <cite> when relevant.`
      : undefined;

    try {
      const url = "/api/ai/chat";
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: buildGatewayMessages(history),
          model,
          context: contextStr,
          useDefectContext: chatContextEnabled,
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        const err = await resp.json().catch(() => ({ error: "请求失败" }));
        updateActive((c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: `⚠️ ${err.error || "请求失败，请稍后再试。"}` }
              : m,
          ),
        }));
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      let done = false;
      const animator = createStreamTextAnimator({
        onUpdate: (nextText) => {
          acc = nextText;
          updateActive((c) => ({
            ...c,
            messages: c.messages.map((m) =>
              m.id === assistantMsgId ? { ...m, content: nextText } : m,
            ),
            updatedAt: Date.now(),
          }));
        },
      });
      streamAnimatorRef.current = animator;

      while (!done) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") {
            done = true;
            break;
          }
          try {
            const parsed = JSON.parse(json);
            if (parsed?.type === "status" && typeof parsed?.message === "string") {
              updateActive((c) => ({
                ...c,
                messages: c.messages.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: parsed.message }
                    : m,
                ),
                updatedAt: Date.now(),
              }));
              continue;
            }

            if (parsed?.type === "context" && parsed?.result) {
              updateActive((c) => ({
                ...c,
                messages: c.messages.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, duplicateResult: parsed.result as DuplicateSearchResult }
                    : m,
                ),
                updatedAt: Date.now(),
              }));
              continue;
            }

            if (parsed?.type === "error" && typeof parsed?.message === "string") {
              updateActive((c) => ({
                ...c,
                messages: c.messages.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: `⚠️ ${parsed.message}` }
                    : m,
                ),
                updatedAt: Date.now(),
              }));
              continue;
            }

            const chunk = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (chunk) {
              animator.push(chunk);
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }

      await animator.finish();
    } catch (e: any) {
      if (e.name !== "AbortError") {
        updateActive((c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantMsgId ? { ...m, content: "⚠️ 连接中断，请重试。" } : m,
          ),
        }));
      }
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        streamAnimatorRef.current = null;
        setStreaming(false);
        abortRef.current = null;
      }
    }
  };

  const runDuplicateSearch = async (queryText: string, assistantMsgId: string) => {
    setStreaming(true);
    const controller = new AbortController();
    const requestId = newId();
    activeRequestRef.current = requestId;
    abortRef.current = controller;
    streamAnimatorRef.current?.stop();
    updateActive((c) => ({
      ...c,
      messages: c.messages.map((message) =>
        message.id === assistantMsgId
          ? {
              ...message,
              content: "正在检索历史重复问题…",
              mode: "duplicate-search",
            }
          : message,
      ),
      updatedAt: Date.now(),
    }));

    try {
      const response = await fetch("/api/duplicate-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: queryText,
          top_k: 8,
          model,
        }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        result?: DuplicateSearchResult;
      };

      if (!response.ok || !payload.success || !payload.result) {
        throw new Error(payload.error || "重复问题检索失败");
      }

      const summaryText = payload.result.summaryText || buildDuplicateFallbackSummary(payload.result);
      const animator = createStreamTextAnimator({
        onUpdate: (nextText) => {
          updateActive((c) => ({
            ...c,
            messages: c.messages.map((message) =>
              message.id === assistantMsgId
                ? {
                    ...message,
                    content: nextText,
                    mode: "duplicate-search",
                  }
                : message,
            ),
            updatedAt: Date.now(),
          }));
        },
      });
      streamAnimatorRef.current = animator;
      animator.push(summaryText);
      await animator.finish();
      if (controller.signal.aborted) {
        return;
      }

      updateActive((c) => ({
        ...c,
        messages: c.messages.map((message) =>
          message.id === assistantMsgId
            ? {
                ...message,
                content: summaryText,
                mode: "duplicate-search",
                duplicateResult: payload.result,
              }
            : message,
        ),
        updatedAt: Date.now(),
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }

      const message = error instanceof Error ? error.message : "重复问题检索失败";
      updateActive((c) => ({
        ...c,
        messages: c.messages.map((item) =>
          item.id === assistantMsgId
            ? {
                ...item,
                content: `⚠️ ${message}`,
                mode: "duplicate-search",
              }
            : item,
        ),
      }));
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        streamAnimatorRef.current = null;
        setStreaming(false);
        abortRef.current = null;
      }
    }
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if ((!content && attachments.length === 0) || streaming) return;

    const userMsg: Msg = {
      id: newId(),
      role: "user",
      content,
      mode: interactionMode,
      attachments:
        interactionMode === "chat" && attachments.length ? attachments : undefined,
    };
    const assistantMsg: Msg = {
      id: newId(),
      role: "assistant",
      content: "",
      mode: interactionMode,
    };
    const history = [...active.messages, userMsg];
    updateActive((c) => ({
      ...c,
      title: c.messages.length === 0 && content ? content.slice(0, 28) : c.title,
      messages: [...history, assistantMsg],
      updatedAt: Date.now(),
    }));
    setInput("");
    setAttachments([]);
    setSlashOpen(false);
    if (interactionMode === "duplicate-search") {
      await runDuplicateSearch(content, assistantMsg.id);
      return;
    }

    await runStream(history, assistantMsg.id);
  };

  const regenerate = async () => {
    if (streaming) return;
    const msgs = active.messages;
    // find last assistant and drop it
    let lastAsst = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") { lastAsst = i; break; }
    if (lastAsst < 0) return;
    const trimmed = msgs.slice(0, lastAsst);
    const lastUserMessage = [...trimmed].reverse().find((message) => message.role === "user");
    const retryMode = lastUserMessage?.mode || "chat";
    const assistantMsg: Msg = { id: newId(), role: "assistant", content: "", mode: retryMode };
    updateActive((c) => ({ ...c, messages: [...trimmed, assistantMsg], updatedAt: Date.now() }));
    if (retryMode === "duplicate-search" && lastUserMessage) {
      await runDuplicateSearch(lastUserMessage.content, assistantMsg.id);
      return;
    }

    await runStream(trimmed, assistantMsg.id);
  };

  const editUserMessage = async (msgId: string) => {
    const idx = active.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const trimmed = active.messages.slice(0, idx);
    const newUser: Msg = { ...active.messages[idx], content: editingMsgVal };
    const retryMode = newUser.mode || "chat";
    const assistantMsg: Msg = { id: newId(), role: "assistant", content: "", mode: retryMode };
    const history = [...trimmed, newUser];
    updateActive((c) => ({ ...c, messages: [...history, assistantMsg], updatedAt: Date.now() }));
    setEditingMsgId(null);
    setEditingMsgVal("");
    if (retryMode === "duplicate-search") {
      await runDuplicateSearch(newUser.content, assistantMsg.id);
      return;
    }

    await runStream(history, assistantMsg.id);
  };

  // ----- conversation management -----
  const renameConvo = (id: string, title: string) =>
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: title || "新对话" } : c)));

  const deleteConvo = (id: string) => {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (next.length === 0) {
        const n = newConversation();
        setActiveId(n.id);
        return [n];
      }
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  };

  const togglePin = (id: string) =>
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));

  // ----- UI helpers -----
  const lastSeg = (m: Msg) => parseAgentStream(m.content);

  return (
    <div className="-m-6 flex h-[calc(100vh-64px)] overflow-hidden">
      {/* Conversation list */}
      <aside className="hidden w-[260px] flex-col border-r border-border bg-muted/30 lg:flex">
        <div className="p-3">
          <button
            onClick={handleNew}
            className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-secondary"
          >
            <span className="flex items-center gap-2">
              <MessageSquarePlus className="h-4 w-4" /> 新对话
            </span>
            <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              ⌘N
            </kbd>
          </button>
        </div>
        <div className="px-3 pb-2">
          <p className="filter-label px-1">会话</p>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {sortedConvos.map((c) => (
            <div
              key={c.id}
              className={`group relative flex items-center gap-1 rounded-md px-1 ${
                c.id === activeId ? "bg-primary/10" : "hover:bg-muted"
              }`}
            >
              {renameId === c.id ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => {
                    renameConvo(c.id, renameVal.trim());
                    setRenameId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      renameConvo(c.id, renameVal.trim());
                      setRenameId(null);
                    }
                    if (e.key === "Escape") setRenameId(null);
                  }}
                  className="my-1 w-full rounded bg-background px-1.5 py-1 text-sm outline-none ring-1 ring-primary/40"
                />
              ) : (
                <button
                  onClick={() => setActiveId(c.id)}
                  className={`flex flex-1 items-center gap-1.5 truncate py-2 pl-1.5 text-left text-sm transition-colors ${
                    c.id === activeId ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                  }`}
                >
                  {c.pinned && <Pin className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{c.title || "新对话"}</span>
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuId(menuId === c.id ? null : c.id);
                }}
                className="mr-1 hidden h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground group-hover:flex"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
              {menuId === c.id && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-1 top-9 z-20 w-36 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl"
                >
                  <MenuItem
                    icon={c.pinned ? PinOff : Pin}
                    onClick={() => {
                      togglePin(c.id);
                      setMenuId(null);
                    }}
                  >
                    {c.pinned ? "取消置顶" : "置顶"}
                  </MenuItem>
                  <MenuItem
                    icon={Pencil}
                    onClick={() => {
                      setRenameId(c.id);
                      setRenameVal(c.title);
                      setMenuId(null);
                    }}
                  >
                    重命名
                  </MenuItem>
                  <MenuItem
                    icon={Trash2}
                    destructive
                    onClick={() => {
                      deleteConvo(c.id);
                      setMenuId(null);
                    }}
                  >
                    删除
                  </MenuItem>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <span className="leading-tight">
              本地智能检索与聊天
              <br />
              <span className="text-[10px]">qgate 缺陷上下文 · 实时流式</span>
            </span>
          </div>
        </div>
      </aside>

      {/* Main chat area */}
      <div className="flex flex-1 flex-col bg-background">
        {/* Top bar */}
        <div className="flex items-center justify-between border-b border-border px-6 py-3">
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center rounded-lg border border-border bg-muted/40 p-1">
              <button
                type="button"
                onClick={() => setInteractionMode("chat")}
                aria-pressed={interactionMode === "chat"}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  interactionMode === "chat"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                AI Chat
              </button>
              <button
                type="button"
                onClick={() => setInteractionMode("duplicate-search")}
                aria-pressed={interactionMode === "duplicate-search"}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  interactionMode === "duplicate-search"
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Duplicate Search
              </button>
            </div>
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight text-foreground">
                DTSV Intelligence
              </p>
              <p className="text-[11px] text-muted-foreground">
                数据分析智能体 · 可视化推理与工具调用
              </p>
            </div>
          </div>
          <select
            value={model}
            onChange={(e) => setModel(normalizeCompanyChatModel(e.target.value))}
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-secondary focus:border-primary"
          >
            {COMPANY_CHAT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {isEmpty ? (
            <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-8 text-center"
              >
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/60 shadow-lg shadow-primary/20">
                  <Sparkles className="h-5 w-5 text-primary-foreground" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight text-foreground">
                  {interactionMode === "duplicate-search"
                    ? "输入现象，检索历史重复问题"
                    : "你好，今天要分析什么？"}
                </h2>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {interactionMode === "duplicate-search"
                    ? "切到 Duplicate Search 后，输入现象、项目、PU 或关键日志，系统会优先检索历史缺陷。"
                    : "输入 <kbd className=\"rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]\">/</kbd> 调用预设命令，或直接提问。"}
                </p>
              </motion.div>
              <div className="grid w-full gap-2 sm:grid-cols-2">
                {SLASH_COMMANDS.slice(0, 4).map((s, i) => (
                  <motion.button
                    key={s.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05 * i }}
                    onClick={() => send(s.prompt)}
                    className="group rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-primary/40 hover:shadow-sm"
                  >
                    <div className="mb-1.5 flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                      <s.icon className="h-3.5 w-3.5" />
                    </div>
                    <p className="text-sm font-medium text-foreground">{s.label.replace("/", "")}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {s.prompt}
                    </p>
                  </motion.button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
              <AnimatePresence initial={false}>
                {active.messages.map((m, i) => {
                  const isLastAsst =
                    m.role === "assistant" && i === active.messages.length - 1;
                  return (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="group flex gap-3"
                    >
                      <div
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                          m.role === "user"
                            ? "bg-secondary text-foreground"
                            : "bg-gradient-to-br from-primary to-primary/60 text-primary-foreground"
                        }`}
                      >
                        {m.role === "user" ? <User className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                      </div>
                      <div className="min-w-0 flex-1 pt-0.5">
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {m.role === "user"
                            ? "你"
                            : m.mode === "duplicate-search"
                              ? "Duplicate Search"
                              : "DTSV Intelligence"}
                        </p>

                        {/* attachments */}
                        {m.attachments && m.attachments.length > 0 && (
                          <div className="mb-2 flex flex-wrap gap-2">
                            {m.attachments.map((a) =>
                              a.kind === "image" && a.dataUrl ? (
                                <img
                                  key={a.id}
                                  src={a.dataUrl}
                                  alt={a.name}
                                  className="max-h-40 rounded-lg border border-border"
                                />
                              ) : (
                                <div
                                  key={a.id}
                                  className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
                                >
                                  <Paperclip className="h-3 w-3" />
                                  {a.name}
                                </div>
                              ),
                            )}
                          </div>
                        )}

                        {/* body */}
                        {editingMsgId === m.id ? (
                          <div className="space-y-2">
                            <textarea
                              value={editingMsgVal}
                              onChange={(e) => setEditingMsgVal(e.target.value)}
                              rows={3}
                              className="w-full resize-none rounded-lg border border-primary/40 bg-card p-2.5 text-sm outline-none"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => editUserMessage(m.id)}
                                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                              >
                                重发
                              </button>
                              <button
                                onClick={() => setEditingMsgId(null)}
                                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        ) : m.role === "assistant" && m.content === "" && streaming && isLastAsst ? (
                          m.duplicateResult ? (
                            <div className="space-y-3">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <TypingDots />
                                <span>已获取 qgate 相关缺陷，正在生成回答…</span>
                              </div>
                              <DuplicateSearchResults
                                result={m.duplicateResult}
                                allowFeedback={m.mode === "duplicate-search"}
                              />
                            </div>
                          ) : (
                            <TypingDots />
                          )
                        ) : m.role === "assistant" ? (
                          <div className="space-y-3">
                            <MessageRenderer content={m.content} streaming={streaming && isLastAsst} />
                            {m.duplicateResult ? (
                              <DuplicateSearchResults
                                result={m.duplicateResult}
                                allowFeedback={m.mode === "duplicate-search"}
                              />
                            ) : null}
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                            {m.content}
                          </p>
                        )}

                        {/* actions */}
                        {!editingMsgId && (
                          <div className="mt-1.5 flex h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            {m.role === "assistant" ? (
                              <>
                                <CopyBtn
                                  text={segmentsToPlainText(lastSeg(m)) || m.content}
                                />
                                {isLastAsst && !streaming && (
                                  <ActionBtn icon={RefreshCcw} label="重新生成" onClick={regenerate} />
                                )}
                              </>
                            ) : (
                              <>
                                <CopyBtn text={m.content} />
                                <ActionBtn
                                  icon={Pencil}
                                  label="编辑"
                                  onClick={() => {
                                    setEditingMsgId(m.id);
                                    setEditingMsgVal(m.content);
                                  }}
                                />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-background px-6 py-4">
          <div className="mx-auto max-w-3xl">
            {/* context chip */}
            {moduleLabel && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <div
                  role="group"
                  aria-label="输入上下文"
                  className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 transition-colors ${
                    chatContextEnabled
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border bg-muted text-muted-foreground"
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    <Sparkle className="h-2.5 w-2.5 text-primary" />
                    上下文：<span className="font-medium text-foreground">{moduleLabel}</span>
                  </span>
                  {interactionMode === "chat" ? (
                    <label className="inline-flex items-center gap-1.5 pl-1 text-muted-foreground">
                      <span className="h-3 w-px bg-border" aria-hidden="true" />
                      <span className="font-medium text-foreground">缺陷上下文</span>
                      <Switch
                        aria-label="缺陷上下文"
                        checked={chatContextEnabled}
                        onCheckedChange={setChatContextEnabled}
                        className="scale-75"
                      />
                    </label>
                  ) : null}
                </div>
              </div>
            )}

            {/* attachment preview */}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="group/att relative flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
                  >
                    {a.kind === "image" && a.dataUrl ? (
                      <img src={a.dataUrl} className="h-6 w-6 rounded object-cover" alt="" />
                    ) : (
                      <Paperclip className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span className="max-w-[140px] truncate">{a.name}</span>
                    <button
                      onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}
                      className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {(voiceError || transcribing) && (
              <p className="mb-2 text-xs text-muted-foreground">
                {transcribing ? "正在转写语音…" : voiceError}
              </p>
            )}

            <div className="relative flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-primary/50 focus-within:shadow-md">
              {slashOpen && (
                <SlashMenu
                  query={slashQuery}
                  onPick={pickSlash}
                  onClose={() => setSlashOpen(false)}
                />
              )}
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,.pdf,.csv,.txt,.json,.md"
                hidden
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                onClick={recording ? stopVoiceRecording : startVoiceRecording}
                disabled={transcribing}
                aria-label={recording ? "停止录音" : "开始录音"}
                className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                title={recording ? "停止录音" : transcribing ? "语音转写中" : "开始录音"}
              >
                {transcribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : recording ? (
                  <StopCircle className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={interactionMode === "duplicate-search"}
                className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={interactionMode === "duplicate-search" ? "Duplicate Search 暂不支持附件" : "附件 (图片 / 文件)"}
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !slashOpen) {
                    e.preventDefault();
                    send();
                  }
                  if (e.key === "Escape") setSlashOpen(false);
                }}
                rows={1}
                placeholder={interactionMode === "duplicate-search"
                  ? "输入现象、项目、PU 或关键日志，检索是否已有重复缺陷…"
                  : "提问数据、要求总结，或输入 / 调用命令…  (Shift + Enter 换行)"}
                className="max-h-[200px] min-h-[28px] flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
              />
              {streaming ? (
                <button
                  onClick={stop}
                  aria-label="停止生成"
                  className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background transition-opacity hover:opacity-90"
                  title="停止生成"
                >
                  <StopCircle className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={() => send()}
                  disabled={!input.trim() && attachments.length === 0}
                  aria-label="发送"
                  className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-all hover:bg-primary/90 disabled:opacity-40"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              {interactionMode === "duplicate-search"
                ? "Duplicate Search 会独立返回重复缺陷候选与摘要。"
                : chatContextEnabled
                  ? "当前 AI Chat 已开启缺陷上下文，会先检索 qgate 相关缺陷再生成回答。"
                  : "当前 AI Chat 为纯聊天模式，不自动引入 duplicate search 或 qgate 缺陷上下文。"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

// ----- small sub-components -----

const TypingDots = () => (
  <div className="flex h-6 items-center gap-1">
    {[0, 1, 2].map((i) => (
      <motion.span
        key={i}
        className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
        animate={{ opacity: [0.2, 1, 0.2] }}
        transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }}
      />
    ))}
  </div>
);

const ActionBtn = ({
  icon: Icon,
  label,
  onClick,
}: {
  icon: any;
  label: string;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    title={label}
    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
  >
    <Icon className="h-3.5 w-3.5" />
  </button>
);

const CopyBtn = ({ text }: { text: string }) => {
  const [done, setDone] = useState(false);
  return (
    <ActionBtn
      icon={done ? Check : Copy}
      label={done ? "已复制" : "复制"}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    />
  );
};

const MenuItem = ({
  icon: Icon,
  children,
  onClick,
  destructive,
}: {
  icon: any;
  children: any;
  onClick: () => void;
  destructive?: boolean;
}) => (
  <button
    onClick={onClick}
    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
      destructive ? "text-destructive" : "text-foreground"
    }`}
  >
    <Icon className="h-3.5 w-3.5" />
    {children}
  </button>
);

export default AIChat;
