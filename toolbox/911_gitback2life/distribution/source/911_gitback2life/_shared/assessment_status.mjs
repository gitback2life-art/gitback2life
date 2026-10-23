// Common reliability vocabulary for all 13 approved workflows. Pure classification only:
// no network calls, new permissions, caching, or additional user-facing tools.
export function coverage(completed, missing = []) {
  const verified = [...completed];
  const unverified = [...missing];
  return {
    status: unverified.length === 0 ? 'verified' : verified.length ? 'partial' : 'unverified',
    verified_checks: verified,
    unverified_checks: unverified,
    note: unverified.length ? 'Unavailable checks are unknown, not negative findings about the client or target.'
      : 'Checks completed; results describe only the evidence examined, not overall safety.',
  };
}

export function failureKind(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  if (/SCOPE_BLOCKED|GUARD_BLOCKED|EACCES|EPERM/.test(code) || /not authoriz|not permitted|out.of.scope|scope.*(?:refus|denied)/i.test(message))
    return 'permission_or_safety';
  if (/POLITE_BUDGET/.test(code) || /rate.limit|request budget|cooldown/i.test(message)) return 'request_limit';
  if (/ETIMEOUT|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENOTFOUND/.test(code) ||
      /timed out|network.*unavail|DNS.*fail|fetch failed|could not resolve/i.test(message)) return 'network_unavailable';
  if (/robots.txt.*(?:unreach|unavail|could not be verified)/i.test(message)) return 'robots_unverified';
  return 'service_or_input_error';
}

export function failureRecord(check, error) {
  return { check, kind: failureKind(error), status: 'unverified',
    reason: String(error?.code ?? error?.message ?? error ?? 'not completed').slice(0, 300) };
}
