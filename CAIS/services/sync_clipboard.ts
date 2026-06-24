import type { CaisSettings, ClipPayload } from "../types"
import { addClipFromPayload } from "../storage/clip_repository"
import { isLikelyURL, normalizeClipContent } from "../utils/common"
import { readPasteboardPayload, writeTextToPasteboard } from "./pasteboard_adapter"

declare function fetch(input: string, init?: any): Promise<any>

type RemoteClipboardDocument = {
  type?: string
  text?: string
  hasData?: boolean
  hash?: string
  updateTime?: number
  timestamp?: number
  size?: number
  dataName?: string
}

export type SyncClipboardCycleResult = {
  pulled: boolean
  pushed: boolean
  skipped: boolean
  message: string
}

let lastRemoteSignature = ""
let lastAppliedRemoteSignature = ""
let lastUploadedLocalSignature = ""

function isSyncClipboardReady(settings: CaisSettings): boolean {
  const config = settings.syncClipboard
  return Boolean(config.enabled && config.webdavUrl.trim())
}

function normalizeRemoteText(value: unknown): string {
  return normalizeClipContent(value).trim()
}

function remoteJsonUrl(settings: CaisSettings): string {
  const base = settings.syncClipboard.webdavUrl.trim().replace(/\/+$/, "")
  if (!base) return ""
  return base.endsWith("/SyncClipboard.json") ? base : `${base}/SyncClipboard.json`
}

function remoteBaseUrl(settings: CaisSettings): string {
  const jsonUrl = remoteJsonUrl(settings)
  return jsonUrl.endsWith("/SyncClipboard.json")
    ? jsonUrl.slice(0, -"/SyncClipboard.json".length)
    : jsonUrl
}

function toBase64(value: string): string {
  const buffer = (globalThis as any).Buffer
  if (buffer?.from) {
    return buffer.from(value, "utf8").toString("base64")
  }
  const encoder = (globalThis as any).TextEncoder
  const bytes: number[] = encoder
    ? Array.from(new encoder().encode(value), (item: number) => Number(item))
    : Array.from(value).map((char) => char.charCodeAt(0))
  const chars = bytes.map((item) => String.fromCharCode(item)).join("")
  const btoaFn = (globalThis as any).btoa
  if (typeof btoaFn === "function") return btoaFn(chars)
  throw new Error("当前运行环境不支持 Base64 编码")
}

function buildHeaders(settings: CaisSettings, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...extra,
  }
  const username = settings.syncClipboard.username.trim()
  const password = settings.syncClipboard.password
  if (username || password) {
    headers.Authorization = `Basic ${toBase64(`${username}:${password}`)}`
  }
  return headers
}

function localTextFromPayload(payload: ClipPayload | null): { kind: "text" | "url"; text: string; signature: string } | null {
  if (!payload || payload.kind === "image") return null
  const text = normalizeRemoteText(payload.kind === "url" ? payload.url ?? payload.text ?? "" : payload.text ?? "")
  if (!text) return null
  const kind = isLikelyURL(text) ? "url" : "text"
  return {
    kind,
    text,
    signature: `${kind}:${text}`,
  }
}

async function fetchRemoteTextFile(settings: CaisSettings, dataName: string): Promise<string> {
  const base = remoteBaseUrl(settings)
  if (!base) throw new Error("未配置 WebDAV 地址")
  const encodedName = dataName.split("/").map((part) => encodeURIComponent(part)).join("/")
  const response = await fetch(`${base}/file/${encodedName}`, {
    method: "GET",
    headers: buildHeaders(settings, { Accept: "text/plain" }),
  })
  if (!response.ok) {
    throw new Error(`SyncClipboard 文本文件拉取失败（HTTP ${response.status}）`)
  }
  return normalizeClipContent(await response.text())
}

async function resolveRemoteText(settings: CaisSettings, document: RemoteClipboardDocument): Promise<string> {
  if (document.hasData && document.dataName) {
    const fullText = normalizeRemoteText(await fetchRemoteTextFile(settings, document.dataName))
    if (fullText) return fullText
  }
  return normalizeRemoteText(document.text)
}

async function remoteTextFromDocument(settings: CaisSettings, document: RemoteClipboardDocument | null): Promise<{ kind: "text" | "url"; text: string; signature: string } | null> {
  if (!document) return null
  const type = String(document.type ?? "text").toLowerCase()
  if (type !== "text") return null
  const text = await resolveRemoteText(settings, document)
  if (!text) return null
  const kind = isLikelyURL(text) ? "url" : "text"
  return {
    kind,
    text,
    signature: `${kind}:${text}`,
  }
}

async function fetchRemoteDocument(settings: CaisSettings): Promise<RemoteClipboardDocument | null> {
  const url = remoteJsonUrl(settings)
  if (!url) return null
  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(settings),
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`SyncClipboard 拉取失败（HTTP ${response.status}）`)
  }
  return await response.json()
}

async function uploadRemoteDocument(settings: CaisSettings, text: string): Promise<void> {
  const url = remoteJsonUrl(settings)
  if (!url) throw new Error("未配置 WebDAV 地址")
  const body = JSON.stringify({
    // SyncClipboard 协议要求类型值大小写敏感，文本必须使用 "Text"。
    type: "Text",
    text,
    // 文本直接内联到 JSON 中时，hasData 必须为 false，不能缺失 dataName。
    hasData: false,
    size: text.length,
    updateTime: Date.now(),
  })
  const response = await fetch(url, {
    method: "PUT",
    headers: buildHeaders(settings, { "Content-Type": "application/json; charset=utf-8" }),
    body,
  })
  if (!response.ok) {
    throw new Error(`SyncClipboard 上传失败（HTTP ${response.status}）`)
  }
}

async function applyRemoteClipboard(settings: CaisSettings, remote: { kind: "text" | "url"; text: string; signature: string }): Promise<void> {
  // 先写系统剪贴板，再补录到 CAIS，避免用户看见的当前剪贴板与历史不一致。
  await writeTextToPasteboard(remote.text)
  await addClipFromPayload(
    remote.kind === "url"
      ? { kind: "url", url: remote.text, text: remote.text }
      : { kind: "text", text: remote.text },
    { ...settings, captureText: true },
  )
  lastAppliedRemoteSignature = remote.signature
  lastUploadedLocalSignature = remote.signature
}

export async function syncClipboardCycle(settings: CaisSettings): Promise<SyncClipboardCycleResult> {
  if (!settings.syncClipboard.enabled) {
    return { pulled: false, pushed: false, skipped: true, message: "SyncClipboard 未启用" }
  }
  if (!isSyncClipboardReady(settings)) {
    return { pulled: false, pushed: false, skipped: true, message: "请先配置 WebDAV 地址" }
  }

  const remoteDocument = await fetchRemoteDocument(settings)
  if (remoteDocument?.hasData !== false && remoteDocument?.type && String(remoteDocument.type).toLowerCase() !== "text") {
    return { pulled: false, pushed: false, skipped: true, message: "远端当前是非文本内容，已跳过同步" }
  }
  const remote = await remoteTextFromDocument(settings, remoteDocument)
  if (remote) {
    // 远端一旦出现新签名，优先拉取，避免两个端在同一轮里互相覆盖。
    if (remote.signature !== lastRemoteSignature) {
      lastRemoteSignature = remote.signature
      if (remote.signature !== lastAppliedRemoteSignature) {
        await applyRemoteClipboard(settings, remote)
        return { pulled: true, pushed: false, skipped: false, message: "已从 SyncClipboard 拉取远端剪贴板" }
      }
    }
  }

  const local = localTextFromPayload(await readPasteboardPayload())
  if (!local) {
    return { pulled: false, pushed: false, skipped: true, message: "本地没有可同步的文本内容" }
  }
  // 这里用签名抑制远端回写后的二次上传，避免形成来回覆盖。
  if (local.signature === lastAppliedRemoteSignature || local.signature === lastUploadedLocalSignature) {
    return { pulled: false, pushed: false, skipped: true, message: "本地剪贴板已是最新状态" }
  }

  await uploadRemoteDocument(settings, local.text)
  lastUploadedLocalSignature = local.signature
  lastRemoteSignature = local.signature
  return { pulled: false, pushed: true, skipped: false, message: "已推送本地剪贴板到 SyncClipboard" }
}
