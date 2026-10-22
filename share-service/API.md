# Sharing API v1

All routes are under `/api/v1`. JSON errors use `{ "error": "message" }`. Protected publishing routes require `Authorization: Bearer <publishing-key>`. Keys do not appear in public URLs.

## Publishing

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health` | Service identity and API version |
| GET | `/me` | Validate publishing key; return publisher limits and service switches |
| GET | `/shares` | List the current publisher's shares |
| GET | `/shares/:id/document` | Read an owned snapshot as `{document}` for type-safe local association; other publishers receive 404 |
| DELETE | `/shares/:id` | Revoke an owned share. Public access stops immediately; cleanup deletes the record and objects 24 hours later (see Retention) |
| POST | `/uploads` | Create a 24-hour staging upload; body `{shareId?, version?}` |
| POST | `/uploads/:id/assets` | Upload binary body; `Content-Type` and URI-encoded `X-File-Name` headers; returns `{id,name,bytes,url}` |
| POST | `/uploads/:id/commit` | Atomically publish a snapshot; return share metadata |
| GET | `/public/:id` | Anonymous metadata (without `owner`) and document; requires an active, unexpired share |
| GET | `/public/:id/assets/:assetId` | Anonymous resource; checks active share and current revision |

`POST /uploads` returns `{id, shareId, version}`. To update, pass an owned share ID and the last observed version. Upload every resource for the new revision, then commit the complete document. Asset IDs cannot be borrowed from another upload or share. Successful commits keep `shareId` and increment `version`.

Document shape:

```json
{
  "format": 1,
  "title": "Example",
  "markdown": "# Hello",
  "expiresAt": null,
  "assets": [],
  "appearance": {},
  "inputs": {},
  "results": []
}
```

`expiresAt` is a future Unix timestamp in milliseconds or `null`. `assets` lists exactly the uploaded asset IDs. `appearance` holds CSS custom-property values; reader validation blocks active CSS. `inputs` maps block IDs to current field values. `results` contains `{code,info,componentResult,inputs,inputSummary,ms}` for successful matching code; `componentResult` uses the desktop `{type,data}` protocol. Native commands, file-path identities, execution hooks, and encryption keys are excluded. Desktop publication redacts secret content before staging.

Share metadata uses `{id,title,status,version,bytes,expiresAt,createdAt,updatedAt,owner}`; the anonymous `GET /public/:id` omits `owner`. Status is `active`, `revoked`, or `hidden`; expiry is checked separately. Quotas include revoked and expired shares until cleanup purges them. Size includes the document JSON and attachments. Revoking a share that an administrator took down leaves it `hidden`.

An invalid/disabled/expired key returns 401; another publisher's share returns 404; version or quota conflicts return 409; limits return 413; disabled service capabilities return 503. Failed commits leave the previous revision readable.

### Folder snapshots (format 2)

The same upload, commit, public-read and backup routes also accept folder snapshots:

```json
{
  "format": 2,
  "title": "Project notes",
  "expiresAt": null,
  "assets": ["<uploaded asset ID>"],
  "appearance": {},
  "entries": [
    { "kind": "directory", "path": "empty" },
    { "kind": "markdown", "path": "README.md", "content": {
      "markdown": "# Welcome", "inputs": {}, "results": []
    } },
    { "kind": "file", "path": "image.png",
      "asset": "/api/v1/public/<share ID>/assets/<uploaded asset ID>",
      "mime": "image/png", "size": 123 }
  ]
}
```

IDs in the example stand for the 32-character hexadecimal IDs returned by staging and upload. Entry paths are unique, case-sensitive, forward-slash relative paths; empty segments, `.`/`..`, backslashes, colons and control characters are rejected. Every parent directory must have its own directory entry. Each file URL, MIME and byte count must match an asset in the current upload. The complete `assets` list still contains every uploaded resource, including explicitly reviewed attachments referenced outside the folder.

Markdown entries contain sanitized text and per-note input/result snapshots; desktop clients never upload the original Markdown files as downloadable assets. Local note links become `/share/:id?file=<encoded relative path>`, while image and file references become asset URLs. Missing/excluded targets remain unavailable. Ordinary files are downloadable; images and common text formats also have read-only previews. HTML and scripts display as escaped source, and SVG uses the sandboxed image endpoint.

Successful commits include `kind: "note" | "folder"`. An existing share cannot change format during an update (409). Format 1 remains supported without changes. A whole folder counts as one share; its JSON is limited to 5 MiB, and its combined JSON/assets and individual assets retain the configured limits. No database migration is required. Backups preserve both formats unchanged.

## Retention

Cleanup runs hourly (the Worker Cron Trigger or the Node timer) and on `POST /admin/cleanup`. Each run deletes, in bounded batches:

- Uploads never committed, and the objects of superseded revisions, 24 hours after their upload started.
- Revoked shares 24 hours after revocation (`updatedAt`), and shares of any status 24 hours after `expiresAt`. The record, the current document and its attachments are deleted, and the audit log gets a `share.purge` entry with actor `system`. The share ID then returns 404 everywhere and no longer counts against quotas.
- Objects older than 24 hours without a database reference, restore sessions abandoned for 24 hours, expired administrator sessions and login counters, and audit entries older than 90 days.

During the 24-hour grace period an administrator can restore a revoked share with `PUT /admin/shares/:id`, and the publisher can update an expired share with a new `expiresAt`; either change stops the purge. Shares an administrator took down (`hidden`) are kept, unless expired, until an administrator restores or deletes them. `DELETE /admin/shares/:id` removes the record at once, and the next cleanup reclaims its objects once the upload is 24 hours old.

## Administrator

`POST /admin/login` accepts `{password}` and an Origin matching the service origin; returns an HttpOnly session cookie. Each client address gets 10 attempts per 15 minutes, with IPv6 grouped per /64, and then 429 even for the correct password until the window ends; a successful login resets the count. The address is `CF-Connecting-IP` on Workers, and on Node the TCP peer, or the `X-Forwarded-For` entry appended by the outermost trusted proxy when `TRUST_PROXY` is set. All other administrator routes require this cookie. Writes additionally require matching `Origin` and `X-Share-CSRF: 1`.

| Method | Route | Body / result |
| --- | --- | --- |
| POST | `/admin/logout` | End the current session |
| GET | `/admin/overview` | Counts, storage, settings, last 100 audit entries |
| GET, POST | `/admin/publishers` | List; create with `{name}` and reveal `{id,key}` once |
| PUT | `/admin/publishers/:id` | `{name,enabled,expiresAt,maxShares,maxBytes}` |
| POST | `/admin/publishers/:id/reset` | Reveal a replacement key; preserve publisher ID |
| POST | `/admin/publishers/:id/unpublish` | Hide all publisher shares |
| GET | `/admin/shares?q=&offset=0` | Search title/ID, 100 per page |
| GET | `/admin/shares/:id/document` | Document for the administrator preview, including hidden shares. The dashboard renders it on the framed `/admin/preview/:id` page, whose CSP blocks external images |
| GET | `/admin/shares/:id/assets/:assetId` | Preview resource, including hidden shares |
| PUT | `/admin/shares/:id` | `{status:"active"\|"hidden"}` |
| DELETE | `/admin/shares/:id` | Permanently delete the record; cleanup reclaims objects |
| PUT | `/admin/settings` | `{allowCreate,allowUpdate,allowRead,maxAssetBytes,maxShareBytes}` |
| POST | `/admin/cleanup` | Run cleanup now (see Retention) |
| GET | `/admin/backup` | Stream stored ZIP entries: manifest plus objects |
| GET | `/admin/backup/manifest` | Consistent metadata snapshot as `{manifest,objects:[{key,storageKey}]}` for incremental export |
| GET | `/admin/backup/objects/:storageKey` | One binary object, administrator cookie required; supports `restore/:id/` prefixes |
| POST | `/admin/restore/start` | Begin restore into empty instance; returns `{id}` |
| PUT | `/admin/restore/:id/objects/:kind/:objectId` | Stage one binary `assets` or `documents` entry |
| POST | `/admin/restore/:id/commit` | Submit manifest; atomically apply metadata after resources |
| DELETE | `/admin/restore/:id` | Abort restore and remove staged objects |
| POST | `/admin/restore` | Small-archive compatibility endpoint; ZIP request body |

The dashboard uses `/admin/backup/manifest` followed by one `/admin/backup/objects/:storageKey` request per object, then creates the same stored ZIP format in the browser. This avoids the [Workers Free external-request limit](https://developers.cloudflare.com/workers/platform/limits/#subrequests) when B2 holds more than 50 objects. The legacy single-request `/admin/backup` remains available for Node and small Worker exports; it is subject to platform subrequest limits. Missing snapshot resources fail the export rather than producing a complete-looking archive; restart it if publication or cleanup changed resources during export.

Archives use `manifest.json` with `{format:"idea-note-share-backup",version:1,tables}` and `objects/assets/:id`, `objects/documents/:id`. Exports use uncompressed ZIP entries for bounded-memory streaming. The browser uses per-object restore; the compatibility ZIP endpoint is also subject to your hosting provider's request-size limit. Only empty-instance restore is supported; credentials and sessions are never imported.
