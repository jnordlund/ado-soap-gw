import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/worker.js";
import { deliver } from "../src/delivery.js";

const namespace = "http://schemas.microsoft.com/TeamFoundation/2005/06/Services/Notification/03";
const sample = '<WorkItemChangedEvent><CoreFields><IntegerFields><Field><ReferenceName>System.Id</ReferenceName><OldValue>42</OldValue></Field></IntegerFields></CoreFields><ChangedFields><StringFields><Field><ReferenceName>System.Title</ReferenceName><NewValue>One &amp; two</NewValue></Field></StringFields></ChangedFields><DisplayUrl>https://example.org/42</DisplayUrl></WorkItemChangedEvent>';
const env = {
  INBOUND_KEY: "test-key", TOKEN: "123:test", URL: "https://example.org/hook", AUTH: "secret-value",
  CHANNELS: [
    { type: "telegram", name: "chat", chatId: "-123", tokenSecret: "TOKEN" },
    { type: "webhook", name: "hook", urlSecret: "URL", header: { name: "Authorization", valueSecret: "AUTH" } }
  ]
};
function request(event = sample) {
  const escaped = event.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><Notify xmlns="' +
    namespace + '"><eventXml>' + escaped + '</eventXml></Notify></s:Body></s:Envelope>';
  return new Request("https://worker.example/notify/test-key", { method: "POST", body });
}

test("delivers the same work item to a Telegram chat and an authenticated webhook", async () => {
  const calls = [];
  const logs = [];
  const response = await handle(request(), env, async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return Response.json({ ok: true });
  }, entry => logs.push(entry));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /NotifyResponse/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.text, "Work item #42\nOne & two\nhttps://example.org/42");
  assert.equal(calls[0].body.chat_id, "-123");
  assert.equal(calls[1].init.headers.get("Authorization"), env.AUTH);
  assert.deepEqual(calls[1].body, { eventType: "WorkItemChangedEvent", id: "42", title: "One & two", url: "https://example.org/42" });
  assert.deepEqual(logs.map(entry => entry.outcome), ["delivered", "delivered"]);
  assert.doesNotMatch(JSON.stringify(logs), /One & two|secret-value|test-key|123:test/);
});

test("waits for a failed channel and acknowledges partial success for a generic event", async () => {
  let finish;
  let calls = 0;
  const logs = [];
  const pending = handle(request("<BuildEvent><Summary>Build finished</Summary></BuildEvent>"), env, async (url, init) => {
    calls++;
    if (String(url).includes("telegram")) return Response.json({ ok: true });
    assert.deepEqual(JSON.parse(init.body), { eventType: "BuildEvent", summary: "Build finished" });
    return new Promise(resolve => { finish = resolve; });
  }, entry => logs.push(entry));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(logs.length, 1);
  finish(new Response(null, { status: 429 }));
  assert.equal((await pending).status, 200);
  assert.equal(logs[1].reason, "http_429");
});

test("returns a SOAP fault when every channel fails", async () => {
  const result = await handle(request(), { ...env, URL: "" }, async () => Response.json({ ok: false }), () => {});
  assert.equal(result.status, 500);
  assert.match(await result.text(), /s:Fault/);
});

test("records a timeout and makes exactly one attempt", async () => {
  const logs = [];
  let attempts = 0;
  const success = await deliver([env.CHANNELS[1]], env, { eventType: "Test" }, async (_, { signal }) => {
    attempts++;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  }, entry => logs.push(entry), 10);
  assert.equal(success, false);
  assert.equal(attempts, 1);
  assert.equal(logs[0].reason, "timeout");
});

test("rejects unauthenticated, malformed, and oversized requests before delivery", async () => {
  let sends = 0;
  const run = input => handle(input, env, () => { sends++; }, () => {});
  assert.equal((await run(new Request("https://example.org/notify/wrong"))).status, 404);
  assert.equal((await run(new Request("https://example.org/notify/test-key"))).status, 405);
  assert.equal((await run(request("<incomplete>"))).status, 400);
  assert.equal((await run(request("a".repeat(1024 * 1024)))).status, 413);
  assert.equal(sends, 0);
});
