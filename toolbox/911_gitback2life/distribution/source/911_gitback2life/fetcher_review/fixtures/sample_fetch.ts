// Synthetic fixture for fetcher_review tests. Not real project code.
export async function fetchPage(url: string) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
  const finalUrl = new URL(res.url);
  const offDomain = finalUrl.hostname !== new URL(url).hostname;
  return { status: res.status, offDomain, body: await res.text() };
}
