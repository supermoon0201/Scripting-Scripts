import { Device } from "scripting"
import { DEFAULT_CAIS_SETTINGS, type CaisSettings, type KeyboardCustomAction, type KeyboardMenuBuiltinAction } from "../types"

const SETTINGS_KEY = "cais_settings_v1"
const SYNC_CLIPBOARD_PASSWORD_KEY = "sync_clipboard_password"
const SHARED_OPTIONS = { shared: true }

function getStorage(): any {
  return (globalThis as any).Storage
}

function getKeychain(): any {
  return (globalThis as any).Keychain
}

function loadSyncClipboardPassword(): string {
  const keychain = getKeychain()
  try {
    const value = keychain?.get?.(SYNC_CLIPBOARD_PASSWORD_KEY)
    return value == null ? "" : String(value)
  } catch {
    return ""
  }
}

function saveSyncClipboardPassword(password: string): void {
  const keychain = getKeychain()
  try {
    if (password) {
      keychain?.set?.(SYNC_CLIPBOARD_PASSWORD_KEY, password)
    } else {
      keychain?.remove?.(SYNC_CLIPBOARD_PASSWORD_KEY)
    }
  } catch {
  }
}

function persistSettingsRaw(raw: string): void {
  const st = getStorage()
  try {
    if (typeof st?.set === "function") {
      st.set(SETTINGS_KEY, raw)
      st.set(SETTINGS_KEY, raw, SHARED_OPTIONS)
    } else if (typeof st?.setString === "function") {
      st.setString(SETTINGS_KEY, raw)
      st.setString(SETTINGS_KEY, raw, SHARED_OPTIONS)
    }
  } catch {
  }
}

function sanitizeCustomActionMode(value: any): KeyboardCustomAction["mode"] {
  if (value === "regex" || value === "regexExtract") return "regexExtract"
  if (value === "regexRemove") return "regexRemove"
  if (value === "javascript") return "javascript"
  return "template"
}

function systemMajorVersion(): number {
  const version = String(Device.systemVersion ?? "")
  const match = version.match(/\d+/)
  return match ? Number(match[0]) : 0
}

function defaultKeyboardNativeGlassEffect(): boolean {
  return systemMajorVersion() >= 26
}

function sanitizeSettings(raw: any): CaisSettings {
  const monitorIntervalMs = Number(raw?.monitorIntervalMs ?? DEFAULT_CAIS_SETTINGS.monitorIntervalMs)
  const maxItems = Number(raw?.maxItems ?? DEFAULT_CAIS_SETTINGS.maxItems)
  const appContentLineLimit = Number(raw?.appContentLineLimit ?? DEFAULT_CAIS_SETTINGS.appContentLineLimit)
  const keyboardMaxItems = Number(raw?.keyboardMaxItems ?? DEFAULT_CAIS_SETTINGS.keyboardMaxItems)
  const syncIntervalMs = Number(raw?.syncClipboard?.syncIntervalMs ?? DEFAULT_CAIS_SETTINGS.syncClipboard.syncIntervalMs)
  const defaultBuiltins = DEFAULT_CAIS_SETTINGS.keyboardMenu.builtins
  const rawBuiltins = raw?.keyboardMenu?.builtins ?? {}
  const builtinKeys = Object.keys(defaultBuiltins) as KeyboardMenuBuiltinAction[]
  const builtins = builtinKeys.reduce((result, key) => {
    result[key] = Boolean(rawBuiltins[key] ?? defaultBuiltins[key])
    return result
  }, {} as Record<KeyboardMenuBuiltinAction, boolean>)
  const builtinOrder = Array.isArray(raw?.keyboardMenu?.builtinOrder)
    ? raw.keyboardMenu.builtinOrder
      .filter((key: any) => builtinKeys.includes(key))
      .map((key: any) => key as KeyboardMenuBuiltinAction)
    : undefined
  const customActions = Array.isArray(raw?.keyboardMenu?.customActions)
    ? raw.keyboardMenu.customActions
      .map((item: any): KeyboardCustomAction => ({
        id: String(item?.id ?? `custom_${Date.now()}`),
        title: String(item?.title ?? "").trim(),
        mode: sanitizeCustomActionMode(item?.mode),
        template: String(item?.template ?? ""),
        regex: String(item?.regex ?? ""),
        regexRemoveAll: Boolean(item?.regexRemoveAll ?? false),
        script: String(item?.script ?? ""),
        enabled: Boolean(item?.enabled ?? true),
      }))
      .filter((item: KeyboardCustomAction) => item.title && (
        item.mode === "template" ? item.template :
        item.mode === "javascript" ? item.script :
        item.regex
      ))
      .slice(0, 12)
    : []
  return {
    captureText: Boolean(raw?.captureText ?? DEFAULT_CAIS_SETTINGS.captureText),
    captureImages: Boolean(raw?.captureImages ?? DEFAULT_CAIS_SETTINGS.captureImages),
    monitorIntervalMs: Math.max(100, Math.min(10000, monitorIntervalMs || DEFAULT_CAIS_SETTINGS.monitorIntervalMs)),
    duplicatePolicy: raw?.duplicatePolicy === "skip" ? "skip" : "bump",
    maxItems: Math.max(50, Math.min(800, maxItems || DEFAULT_CAIS_SETTINGS.maxItems)),
    appContentLineLimit: Math.max(1, Math.min(12, appContentLineLimit || DEFAULT_CAIS_SETTINGS.appContentLineLimit)),
    keyboardShowTitle: Boolean(raw?.keyboardShowTitle ?? DEFAULT_CAIS_SETTINGS.keyboardShowTitle),
    keyboardNativeGlassEffect: Boolean(raw?.keyboardNativeGlassEffect ?? defaultKeyboardNativeGlassEffect()),
    showRimeKeyboardSwitch: Boolean(raw?.showRimeKeyboardSwitch ?? DEFAULT_CAIS_SETTINGS.showRimeKeyboardSwitch),
    inputClicks: Boolean(raw?.hapticEngineClicks ?? DEFAULT_CAIS_SETTINGS.hapticEngineClicks)
      ? false
      : Boolean(raw?.inputClicks ?? DEFAULT_CAIS_SETTINGS.inputClicks),
    hapticEngineClicks: Boolean(raw?.hapticEngineClicks ?? DEFAULT_CAIS_SETTINGS.hapticEngineClicks),
    keyboardMaxItems: [10, 20, 30, 40, 50].includes(keyboardMaxItems) ? keyboardMaxItems : DEFAULT_CAIS_SETTINGS.keyboardMaxItems,
    syncClipboard: {
      enabled: Boolean(raw?.syncClipboard?.enabled ?? DEFAULT_CAIS_SETTINGS.syncClipboard.enabled),
      webdavUrl: String(raw?.syncClipboard?.webdavUrl ?? DEFAULT_CAIS_SETTINGS.syncClipboard.webdavUrl).trim(),
      username: String(raw?.syncClipboard?.username ?? DEFAULT_CAIS_SETTINGS.syncClipboard.username).trim(),
      password: String(raw?.syncClipboard?.password ?? DEFAULT_CAIS_SETTINGS.syncClipboard.password),
      syncIntervalMs: Math.max(200, Math.min(10000, syncIntervalMs || DEFAULT_CAIS_SETTINGS.syncClipboard.syncIntervalMs)),
    },
    keyboardMenu: {
      builtins,
      builtinOrder,
      customActions,
    },
  }
}

export function loadSettings(): CaisSettings {
  const st = getStorage()
  try {
    const raw = st?.get?.(SETTINGS_KEY, SHARED_OPTIONS) ?? st?.getString?.(SETTINGS_KEY, SHARED_OPTIONS)
    if (raw != null) return loadSettingsFromRaw(raw)
  } catch {
  }
  try {
    const raw = st?.get?.(SETTINGS_KEY) ?? st?.getString?.(SETTINGS_KEY)
    if (raw != null) return loadSettingsFromRaw(raw)
  } catch {
  }
  return mergePasswordFromKeychain(sanitizeSettings({}))
}

export function saveSettings(settings: CaisSettings): CaisSettings {
  const fixed = sanitizeSettings(settings)
  saveSyncClipboardPassword(fixed.syncClipboard.password)
  const raw = JSON.stringify(stripSyncClipboardPassword(fixed))
  persistSettingsRaw(raw)
  return fixed
}

function stripSyncClipboardPassword(settings: CaisSettings): CaisSettings {
  return {
    ...settings,
    syncClipboard: {
      ...settings.syncClipboard,
      password: "",
    },
  }
}

function mergePasswordFromKeychain(settings: CaisSettings): CaisSettings {
  return {
    ...settings,
    syncClipboard: {
      ...settings.syncClipboard,
      password: loadSyncClipboardPassword(),
    },
  }
}

function loadSettingsFromRaw(raw: any): CaisSettings {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
  const legacyPassword = String(parsed?.syncClipboard?.password ?? "")
  if (legacyPassword) {
    // 兼容旧版本：首次读到明文密码时，立即迁移到 Keychain 并从普通设置中移除。
    saveSyncClipboardPassword(legacyPassword)
    const migrated = {
      ...parsed,
      syncClipboard: {
        ...(parsed?.syncClipboard ?? {}),
        password: "",
      },
    }
    persistSettingsRaw(JSON.stringify(migrated))
    return mergePasswordFromKeychain(sanitizeSettings(migrated))
  }
  return mergePasswordFromKeychain(sanitizeSettings(parsed))
}
