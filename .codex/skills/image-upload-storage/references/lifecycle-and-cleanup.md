# Lifecycle And Cleanup

## Metadata Shape

Every storage-backed upload should have durable metadata similar to:

```ts
interface MediaObject {
  id: string;
  purpose: string;
  status: 'pending' | 'active' | 'failed' | 'deleted';
  storageProvider: string;
  storagePath: string;
  storageFileId?: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  checksumSha256?: string;
  ownerId?: string;
  ownerCollection?: string;
  visibility: 'private' | 'public' | 'internal';
  uploadIntentId?: string;
  uploadSecretHash?: string;
  uploadExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

Use server-managed storage paths. Keep original filenames as display metadata,
not path authority.

## Intent And Finalize

Intent creation:

- Validate purpose/type/declared size before minting credentials.
- Choose the exact storage path server-side.
- Store a pending row with TTL, expected metadata, and a one-time secret hash
  when public clients can create intents.
- For public/anonymous clients, reserve or rate-limit before issuing a storage
  credential; roll back the reservation if credential attachment fails.
- Return only the upload credential fields the browser needs.

Upload:

- Browser uploads bytes directly to storage.
- Progress and retry UX belong on the client, but client metadata is advisory.

Finalize:

- Load the pending row and validate expiry, purpose, actor, path prefix, and
  one-time secret before touching storage.
- Claim finalization once. Concurrent callers must lose before any large storage
  read, delete, or owner mutation.
- Recompute size, checksum, and cheap type/magic-byte checks from stored bytes or
  provider metadata. Never trust the client-declared size as authoritative.
- Create or update the owning business record, then activate the media row.
- If a later step fails, compensate so the API does not report success while
  leaving unowned active bytes.
- If the provider cannot bind object size in the upload credential, claim first,
  then re-read/recompute and reject/delete over-cap landed objects server-side.

## Cleanup Rules

Cleanup is product behavior, not background tidying.

- Expired `pending` rows must be swept and their objects deleted.
- Failed validation should mark the row `failed`, best-effort delete the object,
  and leave a retryable/operator-visible state if deletion fails.
- Deleting a media record should delete the object first when privacy matters;
  only mark metadata deleted after confirmed object deletion.
- Inspect per-object delete results. Do not assume a batch delete succeeded just
  because the request returned 200.
- Never over-delete on partial failure. Pair each row to one object and report
  failures.
- Ref-counted public media must separate unlinking from hard delete.
- Fallback cleanup paths should emit logs/counters; otherwise a broken fast path
  can remain hidden behind compatibility behavior.

## Delivery

Public delivery:

- Gate by publish state, owner/reference, and visibility.
- Keep public routes separate from admin/private preview routes.

Private preview/download:

- Prefer authenticated app routes for durable private access.
- Short-lived signed/temp URLs are acceptable only as an explicit contract.
- Browser UIs should fetch private bytes as `Blob`, render or save with
  `URL.createObjectURL(blob)`, and revoke object URLs when replaced or unmounted.
- Do not store temp URLs in metadata.

## Migration

For legacy base64-to-storage migrations:

- Keep old base64 reads until the storage path is proven.
- Validate and decode base64 in batches.
- Write storage object and metadata first; keep rollback metadata.
- Do not delete old bytes until the rollback window closes.
- Skip corrupt records without stopping the whole batch, and record them.
