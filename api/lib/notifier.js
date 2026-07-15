function notificationConfig(overrides = {}) {
  return {
    botToken: overrides.botToken || process.env.POLICYPOOL_TELEGRAM_BOT_TOKEN || "",
    chatId: overrides.chatId || process.env.POLICYPOOL_TELEGRAM_CHAT_ID || "",
  };
}

export function createNotifier({
  fetchImpl = fetch,
  botToken,
  chatId,
  timeoutMs = 4_000,
} = {}) {
  const config = notificationConfig({ botToken, chatId });

  async function send(message) {
    if (!config.botToken || !config.chatId) return { sent: false, reason: "not_configured" };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: String(message || "").trim().slice(0, 3_800),
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { sent: false, reason: `telegram_http_${response.status}` };
      return { sent: true };
    } catch (error) {
      return {
        sent: false,
        reason: error instanceof Error ? error.name : "notification_failed",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { send };
}

export function reconciliationMessage({ dryRun, changes, failures, checked, generatedAt }) {
  const lines = [
    `PolicyPool reconciliation ${dryRun ? "dry run" : "update"}`,
    `Checked: ${checked}`,
    `Changes: ${changes.length}`,
    `Failures: ${failures.length}`,
  ];
  for (const change of changes.slice(0, 8)) {
    lines.push(`${change.receiptId}: ${change.from} -> ${change.to}`);
  }
  for (const failure of failures.slice(0, 5)) {
    lines.push(`${failure.receiptId}: ${failure.error}`);
  }
  lines.push(generatedAt);
  return lines.join("\n");
}
