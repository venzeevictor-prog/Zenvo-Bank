import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { validate } from '../../middleware/validate.js';
import { clearSessionCookies, requireStaff, requireUser, setSessionCookies } from '../../middleware/auth.js';
import * as auth from './auth.service.js';

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
  skip: () => !config.rateLimitEnabled, message: { error: { code: 'rate_limited', message: 'Too many requests' } } });

const password = z.string().min(12).max(128);
const registerSchema = z.object({
  email: z.email().max(254),
  password,
  fullName: z.string().trim().min(2).max(120),
  countryCode: z.string().length(2).transform(s => s.toUpperCase()),
  nationality: z.string().length(2).transform(s => s.toUpperCase()).optional(),
  preferredLanguage: z.string().min(2).max(8).default('en'),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
});
const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(128) });

export const customerAuthRouter = Router();
customerAuthRouter.use(limiter);
customerAuthRouter.post('/register', validate(registerSchema), async (req, res) => {
  res.status(201).json(await auth.register(req.validated, req.ip));
});
customerAuthRouter.post('/verify-email', validate(z.object({ token: z.string().min(10).max(200) })), async (req, res) => {
  res.json(await auth.verifyEmail(req.validated.token));
});
customerAuthRouter.post('/login', validate(loginSchema), async (req, res) => {
  const { user, session } = await auth.loginCustomer(req.validated, req.ip, req.get('user-agent'));
  setSessionCookies(res, 'customer', session.token, session.ttlMs);
  res.json({ user });
});
customerAuthRouter.post('/logout', requireUser, async (req, res) => {
  await auth.logout(req.user.session_id);
  clearSessionCookies(res, 'customer');
  res.status(204).end();
});

export const staffAuthRouter = Router();
staffAuthRouter.use(limiter);
staffAuthRouter.post('/login', validate(loginSchema), async (req, res) => {
  const { staff, session } = await auth.loginStaff(req.validated, req.ip, req.get('user-agent'));
  setSessionCookies(res, 'staff', session.token, session.ttlMs);
  res.json({ staff });
});
staffAuthRouter.post('/logout', requireStaff, async (req, res) => {
  await auth.logout(req.staff.session_id);
  clearSessionCookies(res, 'staff');
  res.status(204).end();
});
staffAuthRouter.get('/me', requireStaff, (req, res) => {
  const { id, email, full_name, permissions } = req.staff;
  res.json({ id, email, full_name, permissions: [...permissions].sort() });
});
