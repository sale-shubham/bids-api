import { Router } from 'express';
import { asyncHandler } from '@/core/middleware/asyncHandler';
import { authenticate, optionalAuthenticate, requireActiveMember, requireRole } from '@/core/middleware/auth';
import { validate } from '@/core/middleware/validate';
import { qaLimiter } from '@/core/middleware/rateLimit';
import * as ctrl from './questions.controller';
import { answerQuestionSchema, askQuestionSchema } from './questions.validation';

// Mounted at /questions  (POST /questions/:id/answer, POST /questions/:id/hide)
export const questionsRouter = Router();
const seller = [authenticate, requireRole('MEMBER', 'SUPER_ADMIN'), requireActiveMember];
questionsRouter.post('/:id/answer', ...seller, validate(answerQuestionSchema), asyncHandler(ctrl.answer));
questionsRouter.post('/:id/hide', ...seller, asyncHandler(ctrl.hide));

// Mounted inside the auctions router  (GET|POST /auctions/:id/questions)
export const auctionQuestionsRouter = Router({ mergeParams: true });
auctionQuestionsRouter.get('/', optionalAuthenticate, asyncHandler(ctrl.list));
auctionQuestionsRouter.post(
  '/',
  authenticate,
  requireRole('MEMBER'),
  requireActiveMember,
  qaLimiter,
  validate(askQuestionSchema),
  asyncHandler(ctrl.ask),
);
