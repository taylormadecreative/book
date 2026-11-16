# Optional email replies in the CRM

This is prepared code, disabled until receiving and its server configuration are set up. It does not import historical Gmail messages. Replies to older messages whose Reply-To is still Gmail continue to arrive in Gmail.

## How it works

When `CRM_INBOUND_DOMAIN` is configured and the separate `CRM_INBOUND_REPLY_TO_ENABLED` switch is exactly `true`, the mailer asks the service-only `bk_crm_email_reply_route(project_id, domain)` RPC for a project-specific address such as `reply+<random UUID>@replies.example.test`. The random route is separate from the client portal token and is never exposed by staff/client table APIs.

Resend sends a signed `email.received` webhook to `bk-inbound-email`. The function verifies the raw payload's Svix HMAC and a five-minute timestamp window, then retrieves the message from Resend using the server API key. Webhook-supplied message text is never imported. The function accepts exactly one matching route, checks the authenticated sender against that project's email, and inserts one client message through a service-only RPC. Provider event ID, received email ID, and project-scoped RFC message ID prevent duplicates. Portal replies and verified email replies both reopen the Inbox and reactivate the project's reply follow-up task.

The function requires Resend's receiving-server authentication result to report DMARC or aligned DKIM as `pass`. A matching-route message with missing/failed authentication, an unexpected sender, an unsupported sender address, or no readable text becomes a staff review task. Its body is not imported. Review the original in Resend's Receiving inbox, then complete that task; the held-message health count clears. Automatic responses and delivery-status messages are recorded as suppressed and do not create reply tasks.

Only plain text is stored in the CRM. HTML-only messages are reduced to text without rendering or network access. Replies longer than 4,000 characters are visibly clipped. Attachment-only messages tell staff to inspect the original. Attachment URLs, raw-message URLs, and remote images are never downloaded. The webhook body is limited to 64 KiB and the provider response to 512 KiB; oversized or temporary provider/database failures return a retryable error and remain in the provider inbox.

## Activation order

No DNS, Resend account, function deployment, or live email changes were performed while preparing this feature.

1. Apply the CRM foundation migration and `20261116193952_crm_inbound_email.sql` in the documented migration order.
2. Enable receiving for a dedicated subdomain or Resend-managed receiving domain. Preserve the existing Gmail/business domain's MX configuration. Follow [Resend's receiving guide](https://resend.com/docs/dashboard/receiving/introduction).
3. Deploy `bk-inbound-email` with JWT verification disabled, because requests authenticate with the webhook signature rather than a Supabase user JWT.
4. Create a Resend webhook for `email.received` targeting `https://<Supabase project>.supabase.co/functions/v1/bk-inbound-email`. See [receiving webhook setup](https://resend.com/docs/dashboard/receiving/create-receiving-webhook).
5. Set project-wide server secrets `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY`, and `CRM_INBOUND_DOMAIN`. Supabase secrets are shared by the project's Edge Functions and become available immediately. Keep `CRM_INBOUND_REPLY_TO_ENABLED` unset or `false` while configuring and verifying the receiver. Supabase supplies its URL and service-role key in the Edge Function runtime. Never place any secret in frontend configuration or the public repository.
6. After receiving and signature verification are ready, set `CRM_INBOUND_REPLY_TO_ENABLED=true`. This is the separate outgoing activation switch. Until its value is exactly `true`, newly prepared outgoing mail keeps Nelson's existing Gmail Reply-To, even when the receiving domain is configured.
7. Validate the flow using an explicitly authorized synthetic project and an inbox Nelson controls, then inspect the CRM thread, next action, and operational health. Do not use a real client's address for testing.

To stop creating outgoing aliases, unset `CRM_INBOUND_REPLY_TO_ENABLED` or set it to `false`. Keep `CRM_INBOUND_DOMAIN`, the receiving function and its webhook configured so replies to previously sent routed messages still arrive. Requests already snapshotted for delivery retain their original Reply-To while retrying, preserving provider idempotency. Arrange a controlled receiving/forwarding plan before disabling the receiver itself.

## Internal interfaces

- Service-only `bk_crm_email_reply_route(p_project, p_domain)` returns an address string.
- Service-only `bk_crm_ingest_email(p_event_id, p_email_id, p_route_token, p_domain, p_from, p_body, p_message_id)` returns an internal received/duplicate/ignored status. Public webhook responses never reveal this status or a project identity.
- Service-only `bk_crm_note_email(...)` records a held or suppressed provider message without importing its content.
- Staff-only `bk_crm_email_review(p_offset, p_limit)` returns the full pending review count and safe project/message metadata. Completing the generated review task resolves its receipt.

Protocol references: [Resend signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests), [Svix manual verification](https://docs.svix.com/receiving/verifying-payloads/how-manual), and [Resend received-email retrieval and authentication fields](https://resend.com/docs/api-reference/emails/retrieve-received-email).

## Isolated checks

```sh
deno test tests/inbound-email_test.js
node tests/inbound-email.pglite.mjs
deno check --node-modules-dir=none supabase/functions/bk-inbound-email/index.ts
```

These checks use synthetic email data and mocked provider responses. They do not send email, modify live records, or download attachments.
