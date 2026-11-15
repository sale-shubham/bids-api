import type { PayoutStatus } from '@prisma/client';

// Route product activation_status -> our PayoutStatus.
export function mapActivationStatus(status: string | undefined | null): PayoutStatus {
  switch (status) {
    case 'activated':
      return 'ACTIVE';
    case 'needs_clarification':
      return 'NEEDS_CLARIFICATION';
    case 'suspended':
      return 'SUSPENDED';
    case 'rejected':
      return 'REJECTED';
    default:
      return 'PENDING'; // requested, under_review, unknown
  }
}
