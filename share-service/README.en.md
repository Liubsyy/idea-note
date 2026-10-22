# Idea Note Share Service

[简体中文](./README.md)

A portable Markdown sharing service with a reader, publishing API, and administrator dashboard. `renderer/` contains the same rendering implementation used by the desktop editor. Copy this entire directory to another repository to run it independently.

## Run locally

Local execution and automated tests require Node.js 24 or newer, with no Docker or Cloudflare account required. Docker is an optional deployment method. From the Idea Note repository root:

```sh
npm ci
npm run build:sharing
ADMIN_PASSWORD='a-long-random-administrator-password' npm start --workspace idea-note-share-service
```

Open `http://localhost:8787/admin`, sign in, and issue a publishing key. In Idea Note, open **Settings → Share service**, enter `http://localhost:8787` and the key, then use **Share** in the Markdown toolbar. Remote services require HTTPS; HTTP is accepted for localhost development.

Run `npm run test:sharing` from the repository root for automated verification. Cloudflare tests use local workerd and a fake B2 API without signing in or creating cloud resources.

For frontend hot reload, keep the backend running and execute `npm run dev --workspace idea-note-share-service`; visit port 1430. Do not configure a conflicting `PUBLIC_ORIGIN` during local frontend development.

To use a standalone copy, run `npm ci && npm run build` inside that copied directory. Its independent lockfile is included. Within the monorepo, use the root workspace install to keep CodeMirror and React instances unified.

## Cloudflare

Uses Workers, Static Assets, D1, and private Backblaze B2 storage. R2 is not required. D1 holds metadata; B2 holds documents and attachments.

Create a **Private** B2 bucket without Object Lock and record its Bucket ID and Bucket Name. Create a bucket-restricted **Read and Write** application key; save its `keyID` and `applicationKey`. Required capabilities: `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`. Optionally restrict its name prefix to `idea-note-share/`. This adapter uses the [B2 Native API](https://www.backblaze.com/apidocs/b2-authorize-account), so no S3 endpoint, region, master key, public download domain, or browser CORS configuration is needed. Keep the bucket private: the service checks share visibility before downloading objects. Credentials belong only in server-side environment variables or Wrangler secrets.

```sh
cd share-service
npm run build
npx wrangler login
npx wrangler d1 create idea-note-share
```

Replace `database_id` in `wrangler.jsonc` with the returned D1 ID, and set `vars.B2_BUCKET_ID` and `vars.B2_BUCKET_NAME`. `B2_PREFIX` defaults to `idea-note-share/`. Give every instance a separate prefix or bucket, so cleanup cannot delete another instance's files. Prefixes must be relative folders ending in `/`, with letters, digits, underscores or hyphens in each segment.

```sh
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put B2_APPLICATION_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npm run migrate:remote
npm run deploy
```

Use a random administrator password of at least 12 characters. The secret stays in the runtime environment and is never bundled into browser assets. Use the resulting Worker origin directly or bind a custom domain.

For local Cloudflare development, copy `.dev.vars.example` to `.dev.vars` and fill in the password and B2 settings, then run `npm run migrate:local` and `npm run dev:cloudflare`. **D1 is local, but B2 still accesses real cloud storage**: use a separate development bucket or prefix. `.dev.vars` is ignored by Git. Automated tests fake B2 completely. Hourly cleanup processes at most 10 object names per Worker run and reclaims any backlog on subsequent runs, permanently removing historical versions and hide markers. Login rate limiting uses Cloudflare's `CF-Connecting-IP` header.

For an existing R2/local-disk installation, export a backup from the old service first, deploy a new instance with an empty D1/SQLite database and B2 prefix, and restore through the dashboard before switching the domain. Changing storage settings alone does not move existing files; never point the old database at an empty bucket.

## Docker or Node

```sh
cd share-service
cp .env.example .env
# Set ADMIN_PASSWORD and your external HTTPS PUBLIC_ORIGIN.
docker compose up --build -d
```

The default port is exposed on loopback only. Put an HTTPS reverse proxy in front of it. Keep the `share-data` volume when updating containers.

To use B2 on Node/Docker, set `OBJECT_STORAGE=b2` and fill in `B2_BUCKET_ID`, `B2_BUCKET_NAME`, `B2_PREFIX`, `B2_APPLICATION_KEY_ID`, and `B2_APPLICATION_KEY` in `.env`; Compose forwards these settings. SQLite remains in `share-data`, while documents and attachments go to B2. The default `OBJECT_STORAGE=local` uses local disk. Direct Node deployment accepts the same environment variables.

Direct Node deployment:

```sh
ADMIN_PASSWORD='a-long-random-password' DATA_DIR=/path/to/data PUBLIC_ORIGIN=https://share.example.com node server/node.mjs
```

`PORT` defaults to 8787; `DATA_DIR` defaults to `./data`. Set `PUBLIC_ORIGIN` to your external origin when using a reverse proxy. Browser publishing clients can use a comma-separated `ALLOWED_ORIGINS`; native desktop HTTP does not require CORS configuration.

Docker Compose defaults to `TRUST_PROXY=1`: the port is bound to the host's loopback address, so only a reverse proxy on the same host can reach it and trusting one proxy is safe. If you publish the port directly, set it to `0`. When running Node directly, `TRUST_PROXY` is unset by default, and administrator login rate limiting then uses the TCP peer address. Behind a reverse proxy that address is the proxy itself, so every visitor shares one limit and anyone can lock the administrator out by entering wrong passwords. Set `TRUST_PROXY` to the number of proxies in front of the service: `1` for a single nginx or Caddy, `2` for Cloudflare in front of nginx. The service then counts that many entries back from the end of `X-Forwarded-For` and ignores everything further left, which the client could have forged. The proxy must append to the header, for example nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. Set `TRUST_PROXY` only when the port is reachable through the proxy alone; otherwise direct clients can forge addresses to evade the limit. The service logs a warning once if it receives `X-Forwarded-For` while `TRUST_PROXY` is unset.

The initial SQLite schema is applied idempotently at startup. Future schema changes should add numbered SQL migrations and update the Node migration runner. `0002_share_kind.sql` records whether a share is a note or a folder: existing Cloudflare deployments must run `npm run migrate:remote` before deploying this version, while Node applies it at startup. Older shares get their kind filled in the first time the admin list loads them.

## Behavior

Public links use `https://your-domain/share/shareID` and remain unchanged when a share is updated.

The desktop app stores Git-project associations in the tracked `.ideanote/shares.json` at the repository root, keyed by the normalized `origin` remote and repository-relative path. Commit and sync this file, and configure the same service and publishing key on another computer to update the original links. The legacy `.idea-note/shares.json` is migrated automatically, with existing bindings at the new path taking precedence. Legacy associations migrate when sharing is opened; directories without a supported remote retain device-local associations. Keys remain on the device. Folder publication always excludes both `.ideanote` and the legacy `.idea-note` metadata directories.

Publishing keys are scoped to stable publisher IDs. Resetting a key preserves its shares. Disabling or expiring a key prevents writes while existing links remain readable. Administrators can take individual shares or all of a publisher's shares down.

Shares are permanent by default, with optional 1-, 7-, or 30-day expiry. Updates are manual, retain the link, and can preserve the current expiry. Staged uploads and version checks keep the previous publication intact on failure. Revocation, expiry, moderation, and the public-access switch block subsequent content and attachment requests. Copies already downloaded by readers cannot be recalled.

Cleanup permanently deletes a share record, its document, and its attachments 24 hours after it is revoked or expires. Until then an administrator can restore a revoked share and the publisher can update an expired share with a new expiry. Shares an administrator took down are kept, unless expired, until an administrator deletes or restores them. Cleanup runs hourly or on demand from the dashboard, and logs each deletion.

Default quotas are 100 shares and 1 GiB per publisher, 20 MiB per attachment, and 100 MiB per share. Administrators may change these within provider request limits. Revoked and expired shares count until cleanup removes them. Physical objects from administrator-deleted shares are collected by cleanup.

The reader uses the desktop editor's read-only rendering for Markdown, math, Mermaid, HTML/SVG, tables, disclosures, custom highlights, code, image sizing, and published result snapshots. Parameters are read-only and no code is executed. HTML and SVG go through the shared DOMPurify rules; the reader also removes `<style>` and form controls, and Mermaid output is sanitized the same way. The administrator preview renders on a separate `/admin/preview/shareID` page framed by the dashboard, so a share's CSS cannot cover or restyle the administration controls. That page loads no external images, so a publisher cannot tell when an administrator previews. Encrypted blocks and inline encrypted content are replaced before upload. Interpreter settings, commands, and terminal output are excluded.

Local images, attachments, and result resources are uploaded; missing files stop publication. Local Markdown links must be replaced by their own share links; other notes and directories are not recursively published. External HTTP(S) resources remain external. Review content, snapshots, and attachments before publishing.

Administrator sessions last eight hours and use HttpOnly, SameSite cookies, with Secure on HTTPS. Logins are limited to 10 attempts per client address per 15 minutes, with IPv6 grouped per /64; a successful login resets the count. Once the limit is reached even the correct password waits for the window to end, but failures from other addresses never affect the administrator. Reverse proxy deployments need `TRUST_PROXY`. Write requests require same-origin CSRF protection. Activity logs keep 90 days and the dashboard displays the latest 100 entries. API responses and share content use `no-store`; private resource access always checks the current share state.

## Backup and migration

Download a versioned ZIP from **Backups**. It includes shares, resources, publisher IDs, key digests, settings, and activity logs. It excludes administrator credentials, sessions, and desktop-local file associations. The dashboard fetches a consistent metadata snapshot and then one resource per request before generating the ZIP, avoiding the Workers Free limit of 50 external requests per invocation. Browsers supporting the file-save API write directly to the selected file; other browsers assemble the ZIP in memory. Use a browser with direct file writing for large backups.

Sign in to an **empty** target instance and restore the archive. The browser restores individual files and atomically commits metadata, avoiding one giant upload through Cloudflare. Individual resources are limited to 100 MiB and the manifest to 16 MiB. Aborting on Workers immediately removes at most 10 objects and frees the restore gate; remaining private objects are collected after 24 hours. Interrupted staging sessions expire after 24 hours. New key issuance is blocked during restoration.

Cloudflare and Node backups are interchangeable. Preserve the domain when switching instances to keep existing links. Configure the target administrator password separately.

## Tests and API

See [API.md](./API.md) for the wire protocol.

```sh
npm run build
npm run build:sharing
npm run test:sharing
npm run test:worker --workspace idea-note-share-service
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml sharing::tests
```

Service tests cover publication, isolation, quotas, version conflicts, revocation, attachment delivery, and backup restore. B2 tests cover binary checksums, token refresh, pagination, permanent version deletion, and errors. Integration tests use local workerd D1, a fake B2 API, and file-backed Node SQLite with bidirectional migration. The production Worker bundle test intercepts outbound requests to validate the B2 protocol without credentials or R2. Local port access is required. In a standalone copy, use `npm test`.

## Folder sharing

Right-click a folder or the workspace background in the desktop sidebar and choose **Share folder**. The snapshot recursively includes files and empty directories. Hidden entries and symbolic links are excluded by default and can be enabled separately; VCS internals remain excluded and cycles are reported. Review the complete manifest, redacted Markdown, parameters, results and sensitive paths before publishing. Changes after review require a fresh preview. Updates publish additions, edits and deletions together under the same link.

Readers get an expandable directory sidebar (a **Directory** toggle on narrow screens). The initial file is the root README, the first Markdown file, or the first ordinary file, in that order. File selection uses `?file=` and supports direct links, refresh and browser history. Images and common text formats have read-only previews; HTML/scripts display as escaped source and other files are downloadable. Markdown originals are never uploaded as raw attachments. Local note links navigate within the share and excluded targets stay unavailable. Administrator previews use protected resource URLs with the same layout.

Folder snapshots use `format: 2`; legacy `format: 1` notes remain supported. Uploads, lifecycle, quotas and backups are shared with notes. The JSON limit remains 5 MiB. No database migration is needed. See [API.md](./API.md) for the snapshot and publisher document-inspection endpoint.
