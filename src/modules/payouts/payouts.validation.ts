import Joi from 'joi';

export const createAccountSchema = Joi.object({
  legalName: Joi.string().trim().min(2).max(120).required(),
  businessType: Joi.string().valid('individual', 'proprietorship').required(),
  phone: Joi.string().pattern(/^[6-9][0-9]{9}$/).required().messages({ 'string.pattern.base': 'phone must be a 10-digit Indian mobile number' }),
  pan: Joi.string().trim().uppercase().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/).required().messages({ 'string.pattern.base': 'pan must look like ABCDE1234F' }),
  accountNumber: Joi.string().pattern(/^[0-9]{9,18}$/).required().messages({ 'string.pattern.base': 'accountNumber must be 9 to 18 digits' }),
  ifsc: Joi.string().trim().uppercase().pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/).required().messages({ 'string.pattern.base': 'ifsc must look like HDFC0001234' }),
  beneficiaryName: Joi.string().trim().min(2).max(120).required(),
  address: Joi.object({
    street1: Joi.string().trim().min(2).max(100).required(),
    city: Joi.string().trim().min(2).max(60).required(),
    state: Joi.string().trim().min(2).max(60).required(),
    postalCode: Joi.string().pattern(/^[0-9]{6}$/).required(),
  }).required(),
});

export type CreateAccountInput = {
  legalName: string;
  businessType: 'individual' | 'proprietorship';
  phone: string;
  pan: string;
  accountNumber: string;
  ifsc: string;
  beneficiaryName: string;
  address: { street1: string; city: string; state: string; postalCode: string };
};
