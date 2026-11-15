import { prisma } from '@/core/prisma/client';
import { issueOtpChallenge, consumeOtpChallenge } from '@/modules/auth/otp-challenge.service';
import { maskPhone } from '@/providers/sms';
import { refreshSellerVerification } from './verification.service';

// Phone verification by SMS OTP. Phones are stored as the 10-digit Indian mobile; OTP identifier is E.164.
const e164 = (phone: string) => `+91${phone}`;

export async function sendPhoneOtp(phone: string): Promise<{ sentTo: string }> {
  const to = e164(phone);
  await issueOtpChallenge(to, 'PHONE_VERIFY');
  return { sentTo: maskPhone(to) };
}

export async function verifyPhone(memberId: string, phone: string, code: string, now = new Date()) {
  await consumeOtpChallenge(e164(phone), 'PHONE_VERIFY', code);
  const current = await prisma.member.findUnique({ where: { id: memberId }, select: { phone: true } });
  // A different number than before: the WhatsApp opt-in was for the old one.
  const optOut = current?.phone !== phone ? { whatsappOptInAt: null } : {};
  await prisma.member.update({ where: { id: memberId }, data: { phone, phoneVerifiedAt: now, ...optOut } });
  await refreshSellerVerification(memberId, now);
}
