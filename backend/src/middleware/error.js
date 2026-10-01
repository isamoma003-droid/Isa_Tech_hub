import mongoose from 'mongoose';
import { HttpError } from '../utils/httpError.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err, req, res, _next) {
  let status = 500;
  let message = 'Something went wrong on our side';
  let details;

  if (err instanceof HttpError) {
    ({ status, message, details } = err);
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    message = `Invalid ${err.path}`;
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    message = Object.values(err.errors)[0]?.message || 'Invalid data';
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body is not valid JSON';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    message = 'Request body is too large';
  }

  if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(status).json({ error: message, ...(details ? { details } : {}) });
}
