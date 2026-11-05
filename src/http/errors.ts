import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError, z } from "zod";

/** An error that is safe to show to the API caller. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export type ErrorBody = { error: { code: string; message: string; details?: unknown } };

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, "not_found", `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: ErrorBody = { error: { code: "internal_error", message: "Something went wrong." } };

  if (err instanceof AppError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message, details: err.details } };
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      error: { code: "validation_error", message: "Request is not valid.", details: z.flattenError(err) },
    };
  } else if (isBodyParserError(err)) {
    status = err.status;
    body = { error: { code: "bad_request", message: "Request body is not valid JSON." } };
  }

  if (status >= 500) req.log?.error({ err }, "request failed");
  res.status(status).json(body);
};

function isBodyParserError(err: unknown): err is { status: number; type: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type: unknown }).type === "entity.parse.failed" &&
    "status" in err
  );
}
