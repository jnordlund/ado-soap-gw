# Azure DevOps SOAP gateway

Forward personal Azure DevOps notifications to Telegram chats and HTTPS webhooks with a Cloudflare Worker. Each user deploys one Worker. Azure DevOps subscription filters select the events, and the Worker sends each incoming notification to every configured channel.

For a work item, Telegram receives a readable message with the item ID, title and link when available. A webhook receives a JSON `POST` such as this one:

```json
{
  "eventType": "WorkItemChangedEvent",
  "id": "42",
  "title": "Review the build",
  "url": "https://dev.azure.com/example/demo/_workitems/edit/42"
}
```

Other event types carry the name of the XML event and its summary when present.

## Configure the channels

With Node.js 24 installed, run `npm ci` and `npm test`. The tests use simulated destinations.

In [wrangler.jsonc](wrangler.jsonc), choose a Worker name and edit `vars.CHANNELS`. The included configuration pairs a Telegram chat with a webhook. Keep at least one channel. To add a second chat or webhook, add another entry with its own name and destination.

| Channel | Configuration | Secret value |
| --- | --- | --- |
| Telegram | Set `chatId` to the destination chat ID and `tokenSecret` to a secret name such as `BOT_TOKEN`. | The bot token for a bot that can post to the chat. |
| Webhook | Set `urlSecret` to a secret name such as `WEBHOOK_URL`. | The destination’s full HTTPS URL. |
| Optional webhook header | Set `header.name` and `header.valueSecret`, or omit `header` for an unauthenticated endpoint. | The full header value, including the `Bearer ` prefix if required. |

Generate a separate inbound key with `openssl rand -hex 32`. For local development, put `INBOUND_KEY` and the secrets referenced by your channels in an ignored `.dev.vars` file, one `NAME=value` per line. Start the Worker with `npm run dev`. Requests to the local server use the destinations you configure.

## Deploy and connect Azure DevOps

1. Sign in to Cloudflare with `npx wrangler login` and deploy with `npm run deploy`.
2. Set each channel secret using `npx wrangler secret put NAME`. The example configuration uses `BOT_TOKEN`, `WEBHOOK_URL` and `WEBHOOK_AUTH`. Then run `npx wrangler secret put INBOUND_KEY` and enter the generated key.
3. In Azure DevOps, open **User settings → Notifications** and create or edit a personal subscription. Select **SOAP** under **Deliver to**. In **Address**, enter `https://<worker-host>/notify/<inbound-key>` using the hostname from deployment. Save the subscription. Anyone with this URL can send to your channels.
4. Trigger an event that matches the subscription filters and check each destination. For example, create a work item for an **A work item is created** subscription. Redeploy after changing the channel list. When rotating the inbound key, update the address in each subscription.

## Delivery and troubleshooting

The Worker makes one attempt per channel in parallel, with a five-second timeout per attempt. It waits for all attempts before replying to Azure DevOps.

| Channel outcomes | Reply to Azure DevOps |
| --- | --- |
| At least one succeeded | HTTP 200 with a SOAP acknowledgement |
| All failed | HTTP 500 with a SOAP fault |

A successful acknowledgement can therefore include a missed channel. Check the per-channel logs for its name, outcome and failure reason. The gateway has no durable queue or automatic retries.

The parser accepts UTF-8 SOAP 1.1 and 1.2 `Notify` requests up to 1 MiB, with the event XML encoded as text inside `eventXml`. A live Azure DevOps Services work-item creation subscription sent SOAP 1.2. The receiving webhook confirmed the work item ID and exact title. Telegram delivery is covered by local tests.
