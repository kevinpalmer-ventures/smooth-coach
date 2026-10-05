// Drives the sign-in flow against a running server and the fake provider, and calls the API.
export function cookieValue(response, name) {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  return header ? header.slice(name.length + 1).split(";")[0] : null;
}

export async function startSignIn(server, provider, { user, tamper } = {}) {
  if (user) provider.user = user;
  provider.next = tamper ?? {};
  const login = await fetch(`${server.url}/api/auth/login`, { redirect: "manual" });
  const loginCookie = cookieValue(login, "smooth_coach_login");
  const authorize = await fetch(login.headers.get("location"), { redirect: "manual" });
  return { loginCookie, callbackUrl: authorize.headers.get("location") };
}

export function finishSignIn(callbackUrl, loginCookie) {
  return fetch(callbackUrl, { redirect: "manual", headers: loginCookie ? { cookie: `smooth_coach_login=${loginCookie}` } : {} });
}

export async function signIn(server, provider, user) {
  const { loginCookie, callbackUrl } = await startSignIn(server, provider, { user });
  const callback = await finishSignIn(callbackUrl, loginCookie);
  const session = cookieValue(callback, "smooth_coach_session");
  if (callback.status !== 302 || !session) throw new Error(`sign-in failed with HTTP ${callback.status}: ${await callback.text()}`);
  return { cookie: `smooth_coach_session=${session}`, callback };
}

export async function api(server, pathname, { cookie, method = "GET", json, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  if (form) body = form;
  const response = await fetch(`${server.url}${pathname}`, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, data };
}
