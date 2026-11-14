// S3 storage abstraction (hospital presigned-direct-to-S3 pattern).
export interface StoredFile {
  key: string;
  url: string;
}

export interface StorageProvider {
  save(buffer: Buffer, ext: string): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  url(key: string): string;

  // Presigned direct-upload support. keyFor builds a deterministic object key
  // under `folder`; presignPut returns a short-lived PUT URL the browser uploads
  // the raw bytes to directly (Content-Type must match `type`).
  keyFor(folder: string, ext: string): string;
  presignPut(key: string, type: string, expiresIn?: number): Promise<string>;

  // Short-lived READ URL (default 15 min) for objects that must NOT be publicly
  // reachable — private documents (security
  // safeguards). Minted fresh on every read; never persisted. Public catalog
  // images keep using the permanent url() above.
  presignGet(key: string, expiresIn?: number): Promise<string>;

  // Only public URLs are persisted (e.g. Auction images) — this
  // reverses url() to recover the S3 key when deleting.
  keyFromUrl(url: string): string;
  // Wipes every object under `prefix` (e.g. a whole auction's S3 folder on delete).
  deleteByPrefix(prefix: string): Promise<void>;
}
