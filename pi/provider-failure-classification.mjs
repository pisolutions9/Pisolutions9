export function isFailClosedProviderFailure(result) {
  const status = Number(result?.status);
  const body = result?.body;
  if (![502, 503].includes(status) || body?.ok !== false || body?.truth !== 'unknown') return false;

  const answer = String(body?.answer || '');
  return /\b(?:cannot|could not|unable to|unavailable|will not guess|won't guess|not verified|cannot verify|could not verify)\b/i.test(answer);
}

