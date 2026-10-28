export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (code, msg, d) => new AppError(400, code, msg, d);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'Not permitted') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg);
export const conflict = (code, msg, d) => new AppError(409, code, msg, d);
export const unprocessable = (code, msg, d) => new AppError(422, code, msg, d);
