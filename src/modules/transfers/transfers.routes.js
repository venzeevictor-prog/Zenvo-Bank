import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { badRequest } from '../../utils/errors.js';
import { verifyPin } from '../auth/auth.service.js';
import { internalTransfer, lookupRecipient } from './internal.service.js';

export const transfersRouter = Router();
transfersRouter.use(requireUser);

transfersRouter.post('/internal/lookup', validate(z.object({ identifier: z.string().regex(/^ZB\d{10}$/) })), async (req, res) => {
  res.json(await lookupRecipient(req.validated.identifier));
});

const schema = z.object({
  sourceAccountId: z.uuid(),
  recipientIdentifier: z.string().regex(/^ZB\d{10}$/),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  note: z.string().max(140).optional(),
  pin: z.string().regex(/^\d{6}$/),
});
transfersRouter.post('/internal', validate(schema), async (req, res) => {
  const key = req.get('idempotency-key');
  if (!key || key.length < 8 || key.length > 100) throw badRequest('idempotency_key_required', 'Idempotency-Key header (8-100 chars) is required');
  const { pin, ...rest } = req.validated;
  await verifyPin(req.user.id, pin); // step-up authentication
  const result = await internalTransfer({ user: req.user, ...rest, idempotencyKey: key, ip: req.ip });
  res.status(result.replayed ? 200 : 201).json(result);
});
