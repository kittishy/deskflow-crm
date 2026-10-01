# Deskflow deployment decisions

## 2026-10-01 — personal CRM on managed free services

- Vercel hosts the Next.js application; Supabase hosts its dedicated database,
  authentication and storage. No local runtime or persistent worker is required
  for contacts, pipelines and tasks.
- Functions run in São Paulo, near the dedicated Supabase database. No Vercel
  scheduled jobs, paid integrations or paid AI provider credentials are enabled.
- Public registration is closed. The owner can create separate organizations
  and invite future testers; existing tenant isolation and roles are preserved.
- Administrative statistics and health polling run every five minutes while
  visible. Realtime and user initiated requests retain their normal behavior.
- The application strict typecheck passed independently. Vercel packaging skips
  its duplicate TypeScript worker, which stalled twice after compilation.
  `pnpm typecheck` and the upstream CI retain complete type checking.
- WhatsApp sessions, background agents and external integrations require their
  own configured services. They are not represented as operational here.
- Free quotas are shared with other projects in the Vercel account. Hobby is
  restricted to non-commercial personal use; commercialization requires a
  hosting decision before release.
