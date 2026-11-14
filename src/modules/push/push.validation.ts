import Joi from 'joi';

// Exactly `PushSubscription.toJSON()` from the browser's PushManager.subscribe().
// https only: an endpoint is a URL this API later POSTs to, so anything else
// (http://169.254.169.254/…, an internal host) would be a server-side request
// forgery waiting for a member to register it.
const endpoint = Joi.string().uri({ scheme: ['https'] }).max(2000).required();

export const subscribeSchema = Joi.object({
  endpoint,
  expirationTime: Joi.any().optional(),
  keys: Joi.object({
    p256dh: Joi.string().max(255).required(),
    auth: Joi.string().max(255).required(),
  }).required(),
});

export const unsubscribeSchema = Joi.object({ endpoint });
