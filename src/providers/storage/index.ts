import { S3Storage } from './s3.storage';
import type { StorageProvider } from './storage.provider';

// S3-only storage (hospital presigned-direct-to-S3 pattern).
export const storage: StorageProvider = new S3Storage();
export type { StorageProvider, StoredFile } from './storage.provider';
