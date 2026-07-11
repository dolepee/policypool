import { isBytes32 } from "./utils.js";

const OKX_TASK_ORIGIN = "https://www.okx.ai";
const MAX_TASK_PAGE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export class OkxTaskPageError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "OkxTaskPageError";
    this.code = code;
  }
}

export function parseOkxTaskReference(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new OkxTaskPageError("okx_task_reference_required");

  let taskId = raw;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new OkxTaskPageError("okx_task_reference_invalid");
    }
    if (parsed.protocol !== "https:" || !["okx.ai", "www.okx.ai"].includes(parsed.hostname)) {
      throw new OkxTaskPageError("okx_task_host_not_allowed");
    }
    const match = parsed.pathname.match(/^\/(?:[a-z-]+\/)?tasks\/(\d+)\/?$/i);
    if (!match) throw new OkxTaskPageError("okx_task_url_invalid");
    taskId = match[1];
  }

  if (!/^\d{1,12}$/.test(taskId)) throw new OkxTaskPageError("okx_task_id_invalid");
  const numericTaskId = Number(taskId);
  if (!Number.isSafeInteger(numericTaskId) || numericTaskId <= 0) {
    throw new OkxTaskPageError("okx_task_id_invalid");
  }
  return numericTaskId;
}

function extractTaskDetail(html, expectedTaskId) {
  const match = String(html).match(/<script[^>]*\bid=["']appState["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new OkxTaskPageError("okx_task_state_missing");

  let state;
  try {
    state = JSON.parse(match[1]);
  } catch {
    throw new OkxTaskPageError("okx_task_state_invalid");
  }
  const detail = state?.appContext?.initialProps?.TaskDetailData;
  if (!detail || Number(detail.taskId) !== expectedTaskId) {
    throw new OkxTaskPageError("okx_task_detail_mismatch");
  }
  return detail;
}

function findJobId(commands) {
  for (const command of Array.isArray(commands) ? commands : []) {
    const match = String(command).match(/\bTask ID:\s*(0x[a-fA-F0-9]{64})\b/i);
    if (match && isBytes32(match[1])) return match[1].toLowerCase();
  }
  throw new OkxTaskPageError("okx_task_onchain_id_missing");
}

function timelineTime(detail, label) {
  const entry = (Array.isArray(detail.timeline) ? detail.timeline : [])
    .find((item) => String(item?.label || "").trim().toLowerCase() === label.toLowerCase());
  const timestamp = Number(entry?.time);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function parseOkxTaskPage(html, expectedTaskId) {
  const detail = extractTaskDetail(html, expectedTaskId);
  const openedAtMs = timelineTime(detail, "Open") || Number(detail.createTime);
  const acceptedAtMs = timelineTime(detail, "Accepted");
  if (!Number.isFinite(openedAtMs) || openedAtMs <= 0) {
    throw new OkxTaskPageError("okx_task_open_timestamp_missing");
  }
  if (!Number.isFinite(acceptedAtMs) || acceptedAtMs <= 0) {
    throw new OkxTaskPageError("okx_task_acceptance_timestamp_missing");
  }

  const description = String(detail.description || "").trim();
  if (!description) throw new OkxTaskPageError("okx_task_description_missing");

  return {
    publicTaskId: String(expectedTaskId),
    publicUrl: `${OKX_TASK_ORIGIN}/tasks/${expectedTaskId}`,
    jobId: findJobId(detail.acceptCommands),
    title: String(detail.title || `OKX task ${expectedTaskId}`).trim(),
    description,
    tokenSymbol: String(detail.tokenSymbol || "").trim(),
    tokenAmount: String(detail.tokenAmount || "").trim(),
    status: Number(detail.status),
    displayStatus: Number(detail.displayStatus),
    openedAt: new Date(openedAtMs).toISOString(),
    acceptedAt: new Date(acceptedAtMs).toISOString(),
    plannedAt: Number(detail.plannedTime) > 0
      ? new Date(Number(detail.plannedTime)).toISOString()
      : null,
    buyerAgentName: String(detail.buyerAgentInfo?.agentName || "").trim() || null,
  };
}

export async function fetchOkxTaskPage(reference, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = 3,
} = {}) {
  if (typeof fetchImpl !== "function") throw new OkxTaskPageError("okx_task_fetch_unavailable");
  const taskId = parseOkxTaskReference(reference);
  const url = `${OKX_TASK_ORIGIN}/tasks/${taskId}`;
  let lastError;

  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        cache: "no-store",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "cache-control": "no-cache",
          "user-agent": "PolicyPool-Coverage-Preflight/0.2",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new OkxTaskPageError(`okx_task_fetch_failed:${response.status}`);
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_TASK_PAGE_BYTES) {
        throw new OkxTaskPageError("okx_task_page_too_large");
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_TASK_PAGE_BYTES) {
        throw new OkxTaskPageError("okx_task_page_too_large");
      }
      return parseOkxTaskPage(new TextDecoder().decode(buffer), taskId);
    } catch (error) {
      if (error instanceof OkxTaskPageError) lastError = error;
      else if (error?.name === "AbortError") lastError = new OkxTaskPageError("okx_task_fetch_timeout");
      else lastError = new OkxTaskPageError(
        "okx_task_fetch_failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastError || new OkxTaskPageError("okx_task_fetch_failed");
}
