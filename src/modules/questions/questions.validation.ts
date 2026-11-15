import Joi from 'joi';

export const askQuestionSchema = Joi.object({
  question: Joi.string().trim().min(5).max(500).required(),
});

export const answerQuestionSchema = Joi.object({
  answer: Joi.string().trim().min(1).max(1000).required(),
});
