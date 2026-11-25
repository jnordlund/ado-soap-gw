import { deliver } from "./delivery.js";
import { parseNotification, soapResponse } from "./soap.js";

const maxBytes = 1024 * 1024;

async function readXml(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Empty body");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let xml = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RangeError("Body too large");
      }
      xml += decoder.decode(value, { stream: true });
    }
    return xml + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function handle(request, env, send = fetch, log = console.log) {
  const key = env.INBOUND_KEY;
  if (!key || new URL(request.url).pathname !== "/notify/" + key) return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  let parsed;
  try {
    parsed = parseNotification(await readXml(request));
  } catch (error) {
    return new Response(null, { status: error instanceof RangeError ? 413 : 400 });
  }
  if (!Array.isArray(env.CHANNELS) || !env.CHANNELS.length ||
      !env.CHANNELS.every(channel => typeof channel?.name === "string" && channel.name.length)) {
    log({ outcome: "failed", reason: "invalid_channel_list" });
    return soapResponse(parsed.namespace, false);
  }
  const delivered = await deliver(env.CHANNELS, env, parsed.notification, send, log);
  return soapResponse(parsed.namespace, delivered);
}

export default { fetch: (request, env) => handle(request, env) };
