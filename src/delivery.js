function secret(env, binding) {
  const value = env[binding];
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing binding");
  return value;
}

function telegramText(event) {
  const heading = event.id ? "Work item #" + event.id : event.eventType;
  const text = [heading, event.title || event.summary].filter(Boolean).join("\n");
  const link = event.url && event.url.length < 4095 ? "\n" + event.url : "";
  return text.slice(0, 4096 - link.length) + link;
}

function channelRequest(channel, env, event) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (channel.type === "telegram") {
    if (!channel.chatId || channel.chatId === "REPLACE_WITH_CHAT_ID") throw new Error("Missing chat ID");
    const token = secret(env, channel.tokenSecret);
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid bot token");
    return {
      url: "https://api.telegram.org/bot" + token + "/sendMessage",
      headers,
      body: { chat_id: channel.chatId, text: telegramText(event), link_preview_options: { is_disabled: true } }
    };
  }
  if (channel.type !== "webhook") throw new Error("Unknown channel type");
  const url = new URL(secret(env, channel.urlSecret));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid webhook URL");
  if (channel.header) headers.set(channel.header.name, secret(env, channel.header.valueSecret));
  return { url, headers, body: event };
}

async function attempt(channel, env, notification, send, log, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reason = "configuration";
  try {
    const { url, headers, body } = channelRequest(channel, env, notification);
    reason = "network";
    const response = await send(url, {
      method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: controller.signal
    });
    if (!response.ok) reason = "http_" + response.status;
    else if (channel.type === "telegram") {
      reason = "telegram_response";
      if ((await response.json()).ok === true) reason = undefined;
    } else reason = undefined;
    if (!response.bodyUsed) await response.body?.cancel();
  } catch {
    if (controller.signal.aborted) reason = "timeout";
  } finally {
    clearTimeout(timer);
  }
  log({ channel: channel.name, outcome: reason ? "failed" : "delivered", reason });
  return !reason;
}

export async function deliver(channels, env, notification, send = fetch, log = console.log, timeoutMs = 5000) {
  const results = await Promise.all(channels.map(channel => attempt(channel, env, notification, send, log, timeoutMs)));
  return results.includes(true);
}
