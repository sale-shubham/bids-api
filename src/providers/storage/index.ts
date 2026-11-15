import { S3Storage } from './s3.storage';
import type { StorageProvider } from './storage.provider';

// S3-only storage (presigned direct-to-S3 uploads).
export const storage: StorageProvider = new S3Storage();
export type { StorageProvider, StoredFile } from './storage.provider';
