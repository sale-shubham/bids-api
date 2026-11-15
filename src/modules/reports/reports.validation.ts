import Joi from 'joi';

export const REPORT_TARGET_TYPES = ['AUCTION', 'MEMBER', 'REVIEW', 'QUESTION'] as const;
export const REPORT_REASONS = ['COUNTERFEIT', 'PROHIBITED', 'MISLEADING', 'SPAM', 'ABUSE', 'OTHER'] as const;
export const REPORT_STATUSES = ['OPEN', 'ACTION_TAKEN', 'DISMISSED'] as const;

// POST /reports
export const createReportSchema = Joi.object({
  targetType: Joi.string()
    .valid(...REPORT_TARGET_TYPES)
    .required(),
  targetId: Joi.string().trim().min(1).max(60).required(),
  reason: Joi.string()
    .valid(...REPORT_REASONS)
    .required(),
  details: Joi.string().trim().max(1000).allow(''),
});

export type CreateReportInput = {
  targetType: (typeof REPORT_TARGET_TYPES)[number];
  targetId: string;
  reason: (typeof REPORT_REASONS)[number];
  details?: string;
};

// GET /admin/reports
export const adminListReportsQuery = Joi.object({
  status: Joi.string().valid(...REPORT_STATUSES),
  targetType: Joi.string().valid(...REPORT_TARGET_TYPES),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// PATCH /admin/reports/:id
export const resolveReportBody = Joi.object({
  status: Joi.string().valid('ACTION_TAKEN', 'DISMISSED').required(),
  note: Joi.string().trim().max(500).allow(''),
  applyToAllOpenForTarget: Joi.boolean(),
});
