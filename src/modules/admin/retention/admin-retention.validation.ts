import Joi from 'joi';

// Manual trigger (POST /admin/retention/purge) — same job the daily schedule
// runs, with optional one-off overrides for testing/incident response.
export const purgeRetentionSchema = Joi.object({
  otpChallengeDays: Joi.number().integer().min(1).max(365),
  sessionInactiveDays: Joi.number().integer().min(1).max(365),
});
