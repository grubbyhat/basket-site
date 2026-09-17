async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  let body = {};
  try { body = await response.json(); } catch { /* non-JSON error page */ }
  if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status}).`), { status: response.status, field: body.field });
  return body;
}

export const lookupX = handle => request(`/api/x/${encodeURIComponent(handle)}`);
export const prepareLaunch = payload => request('/api/launch/prepare', { method: 'POST', body: JSON.stringify(payload) });
export const sendLaunch = payload => request('/api/launch/send', { method: 'POST', body: JSON.stringify(payload) });
export const getLaunch = mint => request(`/api/launch/${encodeURIComponent(mint)}`);
export const listLaunches = (params = {}) => request(`/api/launches?${new URLSearchParams(params)}`);
export const getStats = () => request('/api/stats');
export const getHealth = () => request('/api/health');

export const readAsDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('The image could not be read.'));
  reader.readAsDataURL(file);
});
export const base64ToBytes = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
export const bytesToBase64 = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
