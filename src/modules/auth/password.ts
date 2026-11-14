// Password policy: 8–72 BYTES (bcrypt ignores anything past 72 bytes), at least
// one letter and one number. Pure function so schemas and tests share it.
export const PASSWORD_MIN_BYTES = 8;
export const PASSWORD_MAX_BYTES = 72;

export function passwordRuleError(password: string): string | null {
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < PASSWORD_MIN_BYTES) return `Password must be at least ${PASSWORD_MIN_BYTES} characters`;
  if (bytes > PASSWORD_MAX_BYTES) return `Password must be at most ${PASSWORD_MAX_BYTES} bytes`;
  if (!/\p{L}/u.test(password)) return 'Password must contain at least one letter';
  if (!/\p{N}/u.test(password)) return 'Password must contain at least one number';
  return null;
}
