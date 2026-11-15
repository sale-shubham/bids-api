import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { refreshSellerVerification } from '@/modules/members/verification.service';
import type { CreateAccountInput } from './payouts.validation';

const select = {
  status: true,
  statusReason: true,
  legalName: true,
  businessType: true,
  bankLast4: true,
  ifsc: true,
  beneficiaryName: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type PayoutAccountDTO = {
  status: string;
  statusReason: string | null;
  legalName: string;
  businessType: string;
  bankLast4: string;
  ifsc: string;
  beneficiaryName: string;
  createdAt: Date;
  updatedAt: Date;
};

export async function getAccount(sellerId: string): Promise<{ account: PayoutAccountDTO | null }> {
  const account = await prisma.sellerPayoutAccount.findUnique({ where: { sellerId }, select });
  return { account };
}

/**
 * Onboard the seller as a Razorpay Route linked account. PAN and the bank account number go to
 * Razorpay only; we keep the last 4 digits. One account per seller; a REJECTED one may be replaced.
 */
export async function createAccount(memberId: string, input: CreateAccountInput, now = new Date()) {
  const [member, existing] = await Promise.all([
    prisma.member.findUnique({ where: { id: memberId }, select: { id: true, email: true, name: true } }),
    prisma.sellerPayoutAccount.findUnique({ where: { sellerId: memberId }, select: { status: true } }),
  ]);
  if (!member) throw new AppError(401, 'UNAUTHORIZED', 'Unauthorized');
  if (existing && existing.status !== 'REJECTED') {
    throw new AppError(409, 'PAYOUT_ACCOUNT_EXISTS', 'A payout account already exists');
  }

  const { paymentProvider } = await import('@/providers/payment');
  const created = await paymentProvider.createRouteAccount({
    email: member.email,
    phone: input.phone,
    legalName: input.legalName,
    businessType: input.businessType,
    contactName: member.name,
    // A replaced (REJECTED) account needs a fresh reference id: Razorpay keeps reference ids unique.
    referenceId: existing ? `${member.id}_${now.getTime().toString(36)}` : member.id,
    pan: input.pan,
    address: input.address,
    bank: { accountNumber: input.accountNumber, ifsc: input.ifsc, beneficiaryName: input.beneficiaryName },
  });

  const data = {
    razorpayAccountId: created.accountId,
    productId: created.productId,
    status: created.status,
    statusReason: null,
    legalName: input.legalName,
    businessType: input.businessType,
    bankLast4: input.accountNumber.slice(-4),
    ifsc: input.ifsc,
    beneficiaryName: input.beneficiaryName,
  };
  const account = await prisma.sellerPayoutAccount.upsert({
    where: { sellerId: memberId },
    create: { sellerId: memberId, ...data },
    update: data,
    select,
  });
  await refreshSellerVerification(memberId, now);
  return { account };
}
