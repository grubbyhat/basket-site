async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  let body = {};
  try { body = await response.json(); } catch { /* non-JSON error page */ }
  if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status}).`), { status: response.status, field: body.field });
  return body;
}
const post = (path, payload) => request(path, { method: 'POST', body: JSON.stringify(payload) });

export const lookupX = handle => request(`/api/x/${encodeURIComponent(handle)}`);
export const prepareLaunch = payload => post('/api/launch/prepare', payload);
export const sendLaunch = payload => post('/api/launch/send', payload);
export const getLaunch = mint => request(`/api/launch/${encodeURIComponent(mint)}`);
export const inspectCoin = mint => request(`/api/coin/${encodeURIComponent(mint)}/inspect`);
export const prepareRoute = payload => post('/api/route/prepare', payload);
export const sendRoute = payload => post('/api/route/send', payload);
export const getCoin = mint => request(`/api/coin/${encodeURIComponent(mint)}`);
export const listCoins = () => request('/api/coins');
export const listLaunches = (params = {}) => request(`/api/launches?${new URLSearchParams(params)}`);
export const getStats = () => request('/api/stats');
export const getHealth = () => request('/api/health');

// Admin calls carry the token from the admin page; never stored beyond the tab.
const adminRequest = (token, path, options = {}) => request(path, { ...options, headers: { 'x-route-admin': token, ...(options.headers || {}) } });
export const adminStatus = token => adminRequest(token, '/api/admin/status');
export const adminBuyback = (token, payload) => adminRequest(token, '/api/admin/buyback', { method: 'POST', body: JSON.stringify(payload) });
export const adminBuybackRun = token => adminRequest(token, '/api/admin/buyback/run', { method: 'POST', body: '{}' });
export const adminSweep = token => adminRequest(token, '/api/admin/sweep', { method: 'POST', body: '{}' });
export const adminSetup = token => adminRequest(token, '/api/admin/setup', { method: 'POST', body: '{}' });

export const readAsDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('The image could not be read.'));
  reader.readAsDataURL(file);
});
export const base64ToBytes = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
export const bytesToBase64 = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
