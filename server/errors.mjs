// Turns any thrown value into a readable one-line reason. Node's connection errors are often an
// AggregateError with an empty message (localhost resolves to both ::1 and 127.0.0.1), and
// fetch failures keep the useful detail in `cause`, so a bare `error.message` can be empty or vague.
// Messages from these errors name hosts and ports, never credentials.
export function describeError(error, depth = 0) {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error !== "object") return String(error) || "unknown error";
  const nested = Array.isArray(error.errors) ? error.errors.map((item) => item?.message || item?.code).filter(Boolean).join("; ") : "";
  const own = error.message || nested || error.code || error.name || "unknown error";
  if (error.cause === undefined || depth >= 4) return own;
  const cause = describeError(error.cause, depth + 1);
  return cause === "unknown error" || own.includes(cause) ? own : `${own}: ${cause}`;
}
