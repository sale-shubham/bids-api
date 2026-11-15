import { env } from '@/core/config/env';
import { StubSms } from './stub.sms';
import { Msg91Sms } from './msg91.sms';
import type { SmsProvider } from './sms.provider';

export const smsProvider: SmsProvider = env.sms.driver === 'msg91' ? new Msg91Sms() : new StubSms();

export type { SmsProvider } from './sms.provider';
export { maskPhone } from './sms.provider';
