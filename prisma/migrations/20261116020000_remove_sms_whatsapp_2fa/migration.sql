-- Remove SMS phone verification, WhatsApp alerts and TOTP 2FA.
-- OtpChannel.SMS and OtpPurpose.PHONE_VERIFY stay (Postgres cannot drop enum values).

-- AlterTable
ALTER TABLE "Member" DROP COLUMN "phoneVerifiedAt",
DROP COLUMN "totpSecretEnc",
DROP COLUMN "twoFactorEnabledAt",
DROP COLUMN "whatsappOptInAt";

-- AlterTable
ALTER TABLE "NotificationPreference" DROP COLUMN "whatsapp";

-- DropTable
DROP TABLE "RecoveryCode";

